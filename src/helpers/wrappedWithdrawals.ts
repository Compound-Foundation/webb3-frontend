import { getFullExitCash, getGrossAssets, getRedeemBuffer } from '@helpers/wrappedPositions';

/**
 * What a wrapped exit is quoted from, all read at one block. `unwrapAndWithdraw(shares)` reads the
 * same figures when it runs. So a quote matches a simulation of the exit at that block.
 */
export type WithdrawalSnapshot = {
  /** The account's wrapper shares. */
  shares: bigint;
  /** Wrapper shares in existence. */
  totalSupply: bigint;
  /** The wrapper's Comet balance, which is its `totalAssets()`, in base units. */
  totalAssets: bigint;
  /** Comet's stored supply index, as `totalsBasic()` reports it. */
  baseSupplyIndex: bigint;
  baseDecimals: number;
  /** The base token Comet holds, in base units. Comet's `withdrawTo` cannot pay more. */
  cometCash: bigint;
  isWithdrawPaused: boolean;
};

/** A wrapped exit as the user asks for it: an amount of base-token cash, or the whole position. */
export type WithdrawalRequest = { kind: 'partial'; cash: bigint } | { kind: 'full' };

/** A wrapped exit quoted at one snapshot. Amounts other than `shares` are in base units. */
export type WithdrawalQuote = {
  kind: 'partial' | 'full';
  /** The shares `unwrapAndWithdraw` burns. */
  shares: bigint;
  /** What the shares are worth: `shares × (totalAssets + 1) ÷ (totalSupply + 10^(18 − baseDecimals))`, rounded down. */
  grossAssets: bigint;
  /** What the wrapper holds back from the exit: `baseSupplyIndex ÷ 10^15 + 2`, rounded down. */
  redeemBuffer: bigint;
  /** What the exit pays to the wallet: `grossAssets − redeemBuffer`. */
  cash: bigint;
  /**
   * Whether a partial exit leaves shares worth no more than the buffer. The wrapper refuses to exit
   * those on their own, so they can only leave with more shares.
   */
  leavesDust: boolean;
};

/**
 * A wrapped exit as its review shows it: what the user asked for, the quote and the block it was
 * read at. The signed call carries only `quote.shares`, and the submission guard holds the two
 * together.
 */
export type WithdrawalReview = {
  request: WithdrawalRequest;
  quote: WithdrawalQuote;
  blockNumber: number;
};

/** What the account's position can pay at a snapshot, in base units. */
export type WithdrawalLimits = {
  /** What a full exit pays, before the pause and Comet's cash are applied. Zero for a position worth no more than the buffer. */
  fullExitCash: bigint;
  /** The most a partial exit can pay now. Zero while Comet withdrawals are paused. */
  maxPartialCash: bigint;
  /** Whether a full exit can pay now: withdrawals run, it pays something, and Comet holds that much. */
  canExitFully: boolean;
};

/** Why an exit cannot be quoted as asked. The plan does not lower the amount to resolve any of them. */
export type WithdrawalRevisionReason =
  /** The account holds no shares. */
  | 'no-shares'
  /** Comet withdrawals are paused, and the wrapper's exit withdraws from Comet. */
  | 'paused'
  /** The whole position is worth no more than the buffer. The wrapper refuses its exit with `ZeroAssetsTransferred`. */
  | 'dust'
  /** The requested cash is zero. */
  | 'no-amount'
  /** The requested cash is more than the account's shares pay. */
  | 'exceeds-position'
  /** The exit pays more than Comet holds. */
  | 'exceeds-liquidity';

export type WithdrawalPlan =
  | { status: 'ready'; quote: WithdrawalQuote; limits: WithdrawalLimits }
  | { status: 'needs-revision'; reason: WithdrawalRevisionReason; limits: WithdrawalLimits };

/** A reviewed exit checked against a newer snapshot. `cash` is what its shares pay at that snapshot. */
export type WithdrawalRecheck =
  | { status: 'ready'; cash: bigint }
  | {
      status: 'changed';
      reason: 'shares-changed' | 'paused' | 'dust' | 'cash-fell' | 'cash-rose' | 'exceeds-liquidity';
      cash: bigint;
    };

/**
 * The most a partial exit's cash can rise between its review and its signature, in basis points
 * (hundredths of a percent) of the reviewed cash. A larger rise stops the exit for a fresh review.
 * Interest raises what the same shares pay every block, and a user can leave a review open for
 * minutes before confirming it. At a supply rate of 10% a year, 10 basis points (0.1%) is about
 * 3.6 days of interest. At that rate, interest alone stops an exit only when its review stays open
 * that long. A larger rise within hours then has another cause, such as a donation to the wrapper.
 */
export const PARTIAL_EXIT_CASH_RISE_TOLERANCE_BPS = 10n;

/** The wrapper's virtual shares: `10^(18 − baseDecimals)`, which OpenZeppelin's ERC-4626 conversions add to `totalSupply`. */
function virtualShares(baseDecimals: number): bigint {
  return 10n ** BigInt(18 - baseDecimals);
}

/**
 * The cash `shares` pay through `unwrapAndWithdraw` at the snapshot: their value rounded down,
 * less the buffer. Shares worth no more than the buffer pay nothing, because the wrapper refuses
 * their exit with `ZeroAssetsTransferred`.
 */
export function getExitCash(shares: bigint, snapshot: WithdrawalSnapshot): bigint {
  const grossAssets = getGrossAssets(shares, snapshot.totalSupply, snapshot.totalAssets, snapshot.baseDecimals);
  return getFullExitCash(grossAssets, getRedeemBuffer(snapshot.baseSupplyIndex));
}

/**
 * The fewest shares whose exit pays at least `cash` at the snapshot. The shares must be worth at
 * least `cash + buffer`, so the result is
 * `ceil((cash + buffer) × (totalSupply + 10^(18 − baseDecimals)) ÷ (totalAssets + 1))`.
 *
 * The wrapper's public `convertToShares` rounds down. It can return one share too few, and then
 * the exit pays one base unit less than `cash`.
 */
export function getSharesForCash(cash: bigint, snapshot: WithdrawalSnapshot): bigint {
  if (cash <= 0n) throw new RangeError('A withdrawal pays a positive amount of cash.');
  const grossNeeded = cash + getRedeemBuffer(snapshot.baseSupplyIndex);
  const dividend = grossNeeded * (snapshot.totalSupply + virtualShares(snapshot.baseDecimals));
  const divisor = snapshot.totalAssets + 1n;
  return (dividend + divisor - 1n) / divisor;
}

/**
 * The most shares whose exit pays no more than `cash`: the shares worth at most `cash + buffer`,
 * `floor(((cash + buffer + 1) × (totalSupply + 10^(18 − baseDecimals)) − 1) ÷ (totalAssets + 1))`.
 */
function getMaxSharesForCash(cash: bigint, snapshot: WithdrawalSnapshot): bigint {
  const grossLimit = cash + getRedeemBuffer(snapshot.baseSupplyIndex);
  const dividend = (grossLimit + 1n) * (snapshot.totalSupply + virtualShares(snapshot.baseDecimals)) - 1n;
  return dividend / (snapshot.totalAssets + 1n);
}

/**
 * What the account's position can pay at the snapshot. A partial exit can pay at most the full
 * exit's cash, and at most what the largest number of shares Comet's cash covers pays. Both are
 * cash the exit of some number of shares pays exactly, so a partial exit of that amount is quoted
 * without rounding past it.
 */
export function getWithdrawalLimits(snapshot: WithdrawalSnapshot): WithdrawalLimits {
  const fullExitCash = snapshot.shares > 0n ? getExitCash(snapshot.shares, snapshot) : 0n;
  if (snapshot.isWithdrawPaused) return { fullExitCash, maxPartialCash: 0n, canExitFully: false };
  if (fullExitCash <= snapshot.cometCash) {
    return { fullExitCash, maxPartialCash: fullExitCash, canExitFully: fullExitCash > 0n };
  }
  const maxPartialCash = getExitCash(getMaxSharesForCash(snapshot.cometCash, snapshot), snapshot);
  return { fullExitCash, maxPartialCash, canExitFully: false };
}

/** Thrown when a quote fails its own check. Nothing is signed from it. */
export class WithdrawalQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WithdrawalQuoteError';
  }
}

function quoteFor(kind: WithdrawalQuote['kind'], shares: bigint, snapshot: WithdrawalSnapshot): WithdrawalQuote {
  const grossAssets = getGrossAssets(shares, snapshot.totalSupply, snapshot.totalAssets, snapshot.baseDecimals);
  const redeemBuffer = getRedeemBuffer(snapshot.baseSupplyIndex);
  const sharesLeft = snapshot.shares - shares;
  return {
    kind,
    shares,
    grossAssets,
    redeemBuffer,
    cash: getFullExitCash(grossAssets, redeemBuffer),
    leavesDust: sharesLeft > 0n && getExitCash(sharesLeft, snapshot) === 0n,
  };
}

/**
 * Quotes a wrapped exit at one snapshot. A full exit burns every share the snapshot holds. A
 * partial exit burns the fewest shares that pay the requested cash.
 *
 * An exit that cannot pay what was asked needs a revision: a smaller amount, or the full exit when
 * `limits.canExitFully`. The plan never lowers the amount itself. The reasons are:
 * - the account holds no shares
 * - Comet withdrawals are paused
 * - the position is worth no more than the buffer
 * - the amount is zero
 * - the amount is above what the shares pay
 * - the exit pays more than Comet holds
 */
export function planWrappedWithdrawal(request: WithdrawalRequest, snapshot: WithdrawalSnapshot): WithdrawalPlan {
  const limits = getWithdrawalLimits(snapshot);
  const revise = (reason: WithdrawalRevisionReason): WithdrawalPlan => ({ status: 'needs-revision', reason, limits });
  if (snapshot.shares <= 0n) return revise('no-shares');
  if (snapshot.isWithdrawPaused) return revise('paused');
  if (limits.fullExitCash === 0n) return revise('dust');

  let quote: WithdrawalQuote;
  if (request.kind === 'full') {
    quote = quoteFor('full', snapshot.shares, snapshot);
  } else {
    if (request.cash <= 0n) return revise('no-amount');
    const shares = getSharesForCash(request.cash, snapshot);
    if (shares > snapshot.shares) return revise('exceeds-position');
    quote = quoteFor('partial', shares, snapshot);
    // The wrapper's rounding-down conversion checks the rounded-up shares: they pay the amount,
    // and one share fewer does not. Let G = cash + buffer, S = totalSupply + 10^(18 − baseDecimals)
    // and A = totalAssets + 1. Then floor(s × A ÷ S) ≥ G holds exactly when s ≥ ceil(G × S ÷ A), so
    // this check cannot fail. It keeps a quote from review if a later change breaks the rounding.
    if (quote.cash < request.cash || getExitCash(shares - 1n, snapshot) >= request.cash) {
      throw new WithdrawalQuoteError(
        'This amount could not be quoted exactly, so it was not reviewed. Enter another amount, or choose Everything.'
      );
    }
  }
  if (quote.cash > snapshot.cometCash) return revise('exceeds-liquidity');
  return { status: 'ready', quote, limits };
}

/**
 * Checks a reviewed exit against a newer snapshot, just before it is signed. The exit burns the
 * reviewed shares, so it stops when:
 * - a full exit's share balance changed, or a partial exit's balance is below its shares
 * - Comet withdrawals are paused
 * - the shares are now worth no more than the buffer
 * - the shares now pay less than the reviewed cash
 * - a partial exit's shares now pay more than `PARTIAL_EXIT_CASH_RISE_TOLERANCE_BPS` above the
 *   reviewed cash
 * - Comet holds less than they pay
 *
 * A full exit passes however much more its shares pay, because it still burns exactly the balance
 * the user chose to withdraw. The same shares pay more as interest accrues. They pay less only when
 * the wrapper's assets per share fall or the buffer rises.
 */
export function recheckWithdrawal(quote: WithdrawalQuote, snapshot: WithdrawalSnapshot): WithdrawalRecheck {
  const cash = getExitCash(quote.shares, snapshot);
  const change = (reason: Extract<WithdrawalRecheck, { status: 'changed' }>['reason']): WithdrawalRecheck => ({
    status: 'changed',
    reason,
    cash,
  });
  const isShareBalanceChanged =
    quote.kind === 'full' ? snapshot.shares !== quote.shares : snapshot.shares < quote.shares;
  if (isShareBalanceChanged) return change('shares-changed');
  if (snapshot.isWithdrawPaused) return change('paused');
  if (cash === 0n) return change('dust');
  if (cash < quote.cash) return change('cash-fell');
  // The rise is more than the tolerance when (cash − quote.cash) × 10,000 > quote.cash × tolerance.
  // Both sides are whole numbers, so the comparison does not round.
  const isAboveRiseTolerance = (cash - quote.cash) * 10_000n > quote.cash * PARTIAL_EXIT_CASH_RISE_TOLERANCE_BPS;
  if (quote.kind === 'partial' && isAboveRiseTolerance) return change('cash-rose');
  if (cash > snapshot.cometCash) return change('exceeds-liquidity');
  return { status: 'ready', cash };
}

/**
 * Quotes a reviewed exit's shares again at a newer snapshot. The shares stay the reviewed ones.
 * Their value, the buffer, the cash and whether they leave dust come from the newer snapshot.
 */
export function requoteWithdrawal(quote: WithdrawalQuote, snapshot: WithdrawalSnapshot): WithdrawalQuote {
  return quoteFor(quote.kind, quote.shares, snapshot);
}
