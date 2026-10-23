import { defaultAbiCoder, Interface } from '@ethersproject/abi';
import { JsonRpcProvider } from '@ethersproject/providers';
import { useRef } from 'react';

import { WrappedMarket } from '@constants/wrappedMarkets';
import CometAbi from '@helpers/abis/Comet';
import ERC20Abi from '@helpers/abis/ERC20';
import WrappedCometAbi from '@helpers/abis/WrappedCometERC4626';
import { LendingRoute } from '@helpers/lendingRoute';
import { MAX_UINT256 } from '@helpers/numbers';
import { describeWalletError } from '@helpers/walletErrors';
import { WrappedActionIdentity, WrappedBlockReason, WrappedStep, WrappedStepCheck } from '@helpers/wrappedActions';
import { BlockWait, DEFAULT_BLOCK_WAIT, getRedeemBuffer, waitForBlock } from '@helpers/wrappedPositions';
import {
  planWrappedWithdrawal,
  recheckWithdrawal,
  WithdrawalPlan,
  WithdrawalQuote,
  WithdrawalRecheck,
  WithdrawalRequest,
  WithdrawalReview,
  WithdrawalSnapshot,
} from '@helpers/wrappedWithdrawals';
import { SettledTransaction } from '@types';

import type { WrappedActionController } from './useWrappedAction';

/** The ids of a wrapped supply's steps, in the order they can come. */
export const WRAPPED_SUPPLY_STEP_IDS = Object.freeze({
  reset: 'reset-allowance',
  approve: 'approve',
  supply: 'supply',
} as const);

const baseTokenInterface = new Interface(ERC20Abi);
const wrapperInterface = new Interface(WrappedCometAbi);
const cometInterface = new Interface(CometAbi);

/**
 * Base tokens whose `approve` reverts when it changes one nonzero allowance to another, by chain
 * and lower-case address. An insufficient nonzero allowance of one of these is reset to zero
 * before the approval.
 */
const ZERO_FIRST_APPROVAL_TOKENS: Readonly<Record<number, ReadonlySet<string>>> = Object.freeze({
  // USDT on Ethereum.
  1: new Set(['0xdac17f958d2ee523a2206206994597c13d831ec7']),
});

/** Whether the token's allowance has to be reset to zero before it is changed to another nonzero amount. */
function requiresAllowanceReset(chainId: number, tokenAddress: string): boolean {
  return ZERO_FIRST_APPROVAL_TOKENS[chainId]?.has(tokenAddress.toLowerCase()) ?? false;
}

/**
 * An amount at least this large is shown as unlimited. An allowance this large is an unlimited
 * approval, and no wallet balance comes near it.
 */
const UNLIMITED_AMOUNT = 2n ** 128n;

const AMOUNT_INPUT = /^(\d*)(?:\.(\d*))?$/;

/**
 * The raw base-token amount a typed decimal stands for, in units of `decimals`: "1234.567891" is
 * 1234567891 with 6 decimals. Only ASCII digits and one decimal point are accepted, with no more
 * fraction digits than `decimals`, so the amount is never rounded. Anything else is undefined.
 */
export function parseExactUnits(input: string, decimals: number): bigint | undefined {
  const match = AMOUNT_INPUT.exec(input);
  if (match === null) return undefined;
  const [, whole, fraction = ''] = match;
  if ((whole === '' && fraction === '') || fraction.length > decimals) return undefined;
  const fractionUnits = fraction.padEnd(decimals, '0');
  return (
    BigInt(whole === '' ? '0' : whole) * 10n ** BigInt(decimals) + BigInt(fractionUnits === '' ? '0' : fractionUnits)
  );
}

/** `value` in units of `decimals`, with every decimal shown and the whole part grouped: 1,234.567891. */
export function formatExactUnits(value: bigint, decimals: number): string {
  const magnitude = value < 0n ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = (magnitude / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = decimals > 0 ? `.${(magnitude % scale).toString().padStart(decimals, '0')}` : '';
  return `${value < 0n ? '-' : ''}${whole}${fraction}`;
}

/** Why a wrapped supply or withdrawal could not be reviewed. Its message is shown to the user. */
class WrappedReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WrappedReviewError';
  }
}

/** The account's base-token balance and its allowance to the wrapper, read at one block. */
export type SupplyFunds = { blockNumber: number; walletBalance: bigint; allowance: bigint };

/** The calls a wrapped supply or withdrawal makes to the configured chain's public provider. */
export type WrappedReadProvider = Pick<JsonRpcProvider, 'call' | 'getBlockNumber'>;

/**
 * The newest block in which one of the account's wrapper transactions was mined, as the wallet's
 * node reported its receipt, or undefined when none has settled in this session.
 */
export function newestReceiptBlock(settled: readonly SettledTransaction[]): number | undefined {
  return settled.reduce<number | undefined>((newest, { outcome }) => {
    if (outcome.status === 'replaced' || typeof outcome.receipt.blockNumber !== 'number') return newest;
    return newest === undefined || outcome.receipt.blockNumber > newest ? outcome.receipt.blockNumber : newest;
  }, undefined);
}

/**
 * How many more times a read or a simulation that failed without revert data is made: a
 * load-balanced provider can answer from a node still behind the block another node gave.
 */
const CALL_RETRIES = 2;

/** Why a read gave up waiting for the provider. Callers add what the user can do next. */
const PROVIDER_BEHIND = "This market's network has not shown your last wrapped transaction yet.";

/**
 * Makes `read` at one block that is at least `minBlock`, the block of the account's newest settled
 * wrapper transaction. Otherwise a read just after a confirmed transaction can miss it. For example,
 * a fresh supply review then asks for an approval again. A provider that does not reach the block
 * in time fails the read.
 *
 * A load-balanced provider can answer a read from a node still behind the block number another
 * node gave, and that node fails a read pinned to the block. A failed read is made again, from the
 * provider's newest block, up to `CALL_RETRIES` times.
 */
async function readAtBlock<T>(
  provider: WrappedReadProvider,
  minBlock: number | undefined,
  wait: BlockWait,
  read: (blockNumber: number) => Promise<T>
): Promise<T> {
  for (let retries = 0; ; retries++) {
    const blockNumber = await waitForBlock(provider, minBlock, wait);
    if (blockNumber === undefined) throw new WrappedReviewError(PROVIDER_BEHIND);
    try {
      return await read(blockNumber);
    } catch (error) {
      if (retries >= CALL_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait.intervalMs));
    }
  }
}

/** Reads the account's base-token balance and its allowance to the wrapper, both at one block, as `readAtBlock` pins it. */
function readSupplyFunds(
  provider: WrappedReadProvider,
  identity: WrappedActionIdentity,
  minBlock: number | undefined,
  wait: BlockWait = DEFAULT_BLOCK_WAIT
): Promise<SupplyFunds> {
  return readAtBlock(provider, minBlock, wait, async (blockNumber) => {
    const read = (method: 'balanceOf' | 'allowance', args: string[]) =>
      provider
        .call({ to: identity.baseTokenAddress, data: baseTokenInterface.encodeFunctionData(method, args) }, blockNumber)
        .then((result) => BigInt(baseTokenInterface.decodeFunctionResult(method, result)[0].toString()));
    const [walletBalance, allowance] = await Promise.all([
      read('balanceOf', [identity.account]),
      read('allowance', [identity.account, identity.wrapperAddress]),
    ]);
    return { blockNumber, walletBalance, allowance };
  });
}

/** The reads a wrapped supply makes through the configured chain's public provider. */
export type WrappedSupplyReads = {
  /** The balance and allowance at a block no older than the account's last settled wrapper transaction. */
  readFunds: () => Promise<SupplyFunds>;
  /** An `eth_call` at a block. */
  call: (request: { from: string; to: string; data: string }, blockNumber: number) => Promise<string>;
  /** How long to wait before a call that failed without revert data is made again. */
  retryIntervalMs: number;
};

const ERROR_STRING_SELECTOR = '0x08c379a0';
const PANIC_SELECTOR = '0x4e487b71';

/** The revert data an error carries. Ethers keeps it in `data`, sometimes on a nested error. */
function revertData(error: unknown): string | undefined {
  const queue: unknown[] = [error];
  for (let visited = 0; queue.length > 0 && visited < 8; visited++) {
    const current = queue.shift();
    if (typeof current !== 'object' || current === null) continue;
    const { data, error: inner, cause } = current as { data?: unknown; error?: unknown; cause?: unknown };
    if (typeof data === 'string' && /^0x[0-9a-f]{8}/i.test(data)) return data;
    queue.push(inner, cause);
  }
  return undefined;
}

/** A revert as its reason string, a panic code, one of the wrapper's own errors, or its selector. */
function describeRevertData(data: string): string {
  const selector = data.slice(0, 10).toLowerCase();
  try {
    if (selector === ERROR_STRING_SELECTOR) return String(defaultAbiCoder.decode(['string'], `0x${data.slice(10)}`)[0]);
    if (selector === PANIC_SELECTOR) return `Panic(${defaultAbiCoder.decode(['uint256'], `0x${data.slice(10)}`)[0]})`;
    return wrapperInterface.parseError(data).signature;
  } catch {
    return `revert data ${selector}`;
  }
}

type CallFailure = { code?: unknown; message?: unknown; reason?: unknown; status?: unknown; error?: unknown };

/** The error and the errors ethers wraps it around, outermost first. */
function failureChain(error: unknown): CallFailure[] {
  const chain: CallFailure[] = [];
  for (let current = error; typeof current === 'object' && current !== null && chain.length < 8; ) {
    if (chain.includes(current as CallFailure)) break;
    chain.push(current as CallFailure);
    current = (current as CallFailure).error;
  }
  return chain;
}

/** The node's own JSON-RPC error inside ethers' wrappers, which carries a numeric code. */
function nodeError(error: unknown): CallFailure | undefined {
  return failureChain(error).find(({ code }) => typeof code === 'number');
}

/**
 * Why a call through the provider failed. Ethers reports every `eth_call` that fails without
 * revert data as a revert without a reason string, a timeout or a rate limit included, and wraps
 * the provider's own error. The node's error says what happened, so it is described when there is
 * one. Otherwise ethers' short `reason` is, with an HTTP failure's `status`: ethers' `message`
 * also lists the request, with the account and call data, the response headers and the URL.
 */
function describeCallFailure(error: unknown): string {
  const fromNode = nodeError(error);
  if (fromNode !== undefined) return describeWalletError(fromNode);
  const chain = failureChain(error);
  const withReason = [...chain].reverse().find(({ reason }) => typeof reason === 'string' && reason !== '');
  if (withReason === undefined) return describeWalletError(chain[chain.length - 1] ?? error);
  const status = chain.find((failure) => typeof failure.status === 'number')?.status;
  return status === undefined ? String(withReason.reason) : `${String(withReason.reason)}, status ${status}`;
}

/**
 * Whether a call reverted. A revert with data carries it. A node that reports a revert without
 * data, as USDT's failed `require` gives, says so in its error's message.
 */
function isRevert(error: unknown): boolean {
  if (revertData(error) !== undefined) return true;
  const message = nodeError(error)?.message;
  return typeof message === 'string' && /revert/i.test(message);
}

/** Why a simulation failed: the revert it carries, or why the call failed. */
function describeSimulationFailure(error: unknown): string {
  const data = revertData(error);
  return data === undefined ? describeCallFailure(error) : describeRevertData(data);
}

/** The calls a simulation makes: an `eth_call` at a block, and the wait before one is made again. */
type SimulationReads = Pick<WrappedSupplyReads, 'call' | 'retryIntervalMs'>;

/**
 * Simulates `request` with an `eth_call` at `blockNumber`. A call that fails without revert data,
 * as from a node still behind the block, is made again up to `CALL_RETRIES` times. A revert at a
 * fixed block repeats, so it is never simulated again. Rejects with the last failure.
 */
async function simulateAtBlock(
  reads: SimulationReads,
  request: { from: string; to: string; data: string },
  blockNumber: number
): Promise<string> {
  for (let retries = 0; ; retries++) {
    try {
      return await reads.call(request, blockNumber);
    } catch (error) {
      if (isRevert(error) || retries >= CALL_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, reads.retryIntervalMs));
    }
  }
}

/**
 * Simulates `supplyAndWrap(amount)` from the account with an `eth_call` at `blockNumber`, just
 * before the wallet is asked to sign it. The call must return a positive number of shares. Ethers
 * returns a revert's data as the call's result, so the result is decoded rather than trusted. A
 * failed simulation refuses the step. Nothing else is tried in its place.
 */
async function simulateSupplyAndWrap(
  reads: SimulationReads,
  identity: WrappedActionIdentity,
  amount: bigint,
  blockNumber: number
): Promise<WrappedStepCheck> {
  const refuse = (detail: string): WrappedStepCheck => ({
    ok: false,
    message: `Simulating the supply from your account failed (${detail}), so your wallet was not asked to sign it.`,
  });
  const request = {
    from: identity.account,
    to: identity.wrapperAddress,
    data: wrapperInterface.encodeFunctionData('supplyAndWrap', [amount]),
  };
  let result: string;
  try {
    result = await simulateAtBlock(reads, request, blockNumber);
  } catch (error) {
    return refuse(describeSimulationFailure(error));
  }
  let shares: bigint;
  try {
    shares = BigInt(wrapperInterface.decodeFunctionResult('supplyAndWrap', result)[0].toString());
  } catch (error) {
    return refuse(describeSimulationFailure(error));
  }
  return shares > 0n ? { ok: true } : refuse('it mints no shares');
}

function isSameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isMarketOf(market: WrappedMarket, identity: WrappedActionIdentity): boolean {
  return (
    market.chainId === identity.chainId &&
    isSameAddress(market.cometAddress, identity.cometAddress) &&
    isSameAddress(market.wrapperAddress, identity.wrapperAddress) &&
    isSameAddress(market.baseTokenAddress, identity.baseTokenAddress)
  );
}

/** The allowance a step expects before it is signed: exactly one amount, or at least one. */
type AllowanceRule = { exactly: bigint } | { atLeast: bigint };

export type PrepareWrappedSupplyInput = {
  identity: WrappedActionIdentity;
  market: WrappedMarket;
  /** In raw base-token units. */
  amount: bigint;
  symbol: string;
  reads: WrappedSupplyReads;
};

/**
 * Reads the account's wallet balance and allowance to the wrapper again and builds the steps of a
 * wrapped supply of `amount`:
 * - When the allowance covers the amount, the wrapper's `supplyAndWrap(amount)` alone.
 * - Otherwise the base token's `approve(wrapper, amount)` first. For a token such as USDT, whose
 *   `approve` refuses to change one nonzero allowance to another, a nonzero allowance is first
 *   reset with `approve(wrapper, 0)`.
 *
 * The amount must be positive and within the wallet balance just read. The approval is for exactly
 * the amount, never more. Before each signature, its step reads the balance and allowance again.
 * The step stops, and the user reviews again, when the balance is below the amount or the
 * allowance is not the one the plan expects:
 * - before a reset, or an approval with no reset before it, exactly the allowance read at review
 * - before an approval after a reset, zero
 * - before the supply, at least the amount
 *
 * The supply is then simulated from the account, at the block of that read.
 */
export async function prepareWrappedSupply({
  identity,
  market,
  amount,
  symbol,
  reads,
}: PrepareWrappedSupplyInput): Promise<{ amount: bigint; steps: WrappedStep[] }> {
  if (identity.type !== 'supply' || !isMarketOf(market, identity)) {
    throw new WrappedReviewError('The wrapper for this market changed. Review the supply again.');
  }
  if (amount <= 0n) throw new WrappedReviewError('Enter an amount greater than 0.');
  if (amount >= MAX_UINT256) throw new WrappedReviewError('An unlimited amount cannot be supplied or approved.');

  const formatAmount = (value: bigint) =>
    value >= UNLIMITED_AMOUNT
      ? `an unlimited amount of ${symbol}`
      : `${formatExactUnits(value, market.baseDecimals)} ${symbol}`;
  let funds: SupplyFunds;
  try {
    funds = await reads.readFunds();
  } catch (error) {
    if (error instanceof WrappedReviewError) throw new WrappedReviewError(`${error.message} Try again in a moment.`);
    throw new WrappedReviewError(
      `Your wallet balance and allowance could not be read (${describeCallFailure(error)}). Try again in a moment.`
    );
  }
  if (amount > funds.walletBalance) {
    throw new WrappedReviewError(`The amount is more than the ${formatAmount(funds.walletBalance)} in your wallet.`);
  }

  const checkBefore = (rule: AllowanceRule, shouldSimulate: boolean) => async (): Promise<WrappedStepCheck> => {
    let fundsBeforeSigning: SupplyFunds;
    try {
      fundsBeforeSigning = await reads.readFunds();
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof WrappedReviewError
            ? `${error.message} Review the supply again in a moment.`
            : `Your wallet balance and allowance could not be read again (${describeCallFailure(error)}).`,
      };
    }
    if (fundsBeforeSigning.walletBalance < amount) {
      const held = formatAmount(fundsBeforeSigning.walletBalance);
      return { ok: false, message: `Your wallet now holds ${held}, less than this supply. Review the supply again.` };
    }
    const { allowance } = fundsBeforeSigning;
    if ('exactly' in rule ? allowance !== rule.exactly : allowance < rule.atLeast) {
      return {
        ok: false,
        message: `The wrapper's allowance is now ${formatAmount(
          allowance
        )}, not what this review expected. Review the supply again.`,
      };
    }
    return shouldSimulate
      ? simulateSupplyAndWrap(reads, identity, amount, fundsBeforeSigning.blockNumber)
      : { ok: true };
  };

  const approval = (id: string, approvedAmount: bigint, description: string, rule: AllowanceRule): WrappedStep => ({
    id,
    kind: 'approve',
    description,
    request: {
      to: identity.baseTokenAddress,
      data: baseTokenInterface.encodeFunctionData('approve', [identity.wrapperAddress, approvedAmount]),
    },
    check: checkBefore(rule, false),
  });

  const steps: WrappedStep[] = [];
  const allowanceAtReview = funds.allowance;
  if (allowanceAtReview < amount) {
    const isResetFirst = allowanceAtReview > 0n && requiresAllowanceReset(identity.chainId, identity.baseTokenAddress);
    if (isResetFirst) {
      steps.push(
        approval(WRAPPED_SUPPLY_STEP_IDS.reset, 0n, `Reset the ${symbol} allowance for the wrapper to 0`, {
          exactly: allowanceAtReview,
        })
      );
    }
    steps.push(
      approval(WRAPPED_SUPPLY_STEP_IDS.approve, amount, `Approve ${formatAmount(amount)} for the wrapper`, {
        exactly: isResetFirst ? 0n : allowanceAtReview,
      })
    );
  }
  steps.push({
    id: WRAPPED_SUPPLY_STEP_IDS.supply,
    kind: 'supply-and-wrap',
    description: `Supply ${formatAmount(amount)} through the wrapper`,
    request: { to: identity.wrapperAddress, data: wrapperInterface.encodeFunctionData('supplyAndWrap', [amount]) },
    check: checkBefore({ atLeast: amount }, true),
  });
  return { amount, steps };
}

/** The id of a wrapped withdrawal's one step. */
export const WRAPPED_WITHDRAW_STEP_ID = 'withdraw';

/** The account's wrapper position and the market figures an exit is quoted from, at one block. */
export type WithdrawalRead = { blockNumber: number; snapshot: WithdrawalSnapshot };

/**
 * Reads, at one block as `readAtBlock` pins it, what `unwrapAndWithdraw` prices an exit from: the
 * account's shares, the wrapper's `totalSupply`, its Comet balance, which is its `totalAssets()`,
 * and Comet's stored supply index. It also reads Comet's withdraw pause and the base token Comet
 * holds, which decide whether Comet can pay the exit.
 */
function readWithdrawalSnapshot(
  provider: WrappedReadProvider,
  identity: WrappedActionIdentity,
  baseDecimals: number,
  minBlock: number | undefined,
  wait: BlockWait
): Promise<WithdrawalRead> {
  return readAtBlock(provider, minBlock, wait, async (blockNumber) => {
    const read = (to: string, contract: Interface, method: string, args: readonly unknown[] = []) =>
      provider
        .call({ to, data: contract.encodeFunctionData(method, args) }, blockNumber)
        .then((result) => contract.decodeFunctionResult(method, result));
    const [shares, totalSupply, totalAssets, totalsBasic, withdrawPause, cometCash] = await Promise.all([
      read(identity.wrapperAddress, wrapperInterface, 'balanceOf', [identity.account]),
      read(identity.wrapperAddress, wrapperInterface, 'totalSupply'),
      read(identity.cometAddress, cometInterface, 'balanceOf', [identity.wrapperAddress]),
      read(identity.cometAddress, cometInterface, 'totalsBasic'),
      read(identity.cometAddress, cometInterface, 'isWithdrawPaused'),
      read(identity.baseTokenAddress, baseTokenInterface, 'balanceOf', [identity.cometAddress]),
    ]);
    const [isWithdrawPaused] = withdrawPause;
    if (typeof isWithdrawPaused !== 'boolean') throw new Error('Comet returned no withdraw pause state.');
    return {
      blockNumber,
      snapshot: {
        shares: BigInt(shares[0].toString()),
        totalSupply: BigInt(totalSupply[0].toString()),
        totalAssets: BigInt(totalAssets[0].toString()),
        baseSupplyIndex: BigInt(totalsBasic[0].baseSupplyIndex.toString()),
        baseDecimals,
        cometCash: BigInt(cometCash[0].toString()),
        isWithdrawPaused,
      },
    };
  });
}

/** The reads a wrapped withdrawal makes through the configured chain's public provider. */
export type WrappedWithdrawalReads = {
  /** The position and market figures at a block no older than the account's last settled wrapper transaction. */
  readSnapshot: () => Promise<WithdrawalRead>;
  /** An `eth_call` at a block. */
  call: (request: { from: string; to: string; data: string }, blockNumber: number) => Promise<string>;
  /** How long to wait before a call that failed without revert data is made again. */
  retryIntervalMs: number;
};

/** The name of the wrapper's, OpenZeppelin's or Comet's error that `data` encodes, if it is one of theirs. */
function exitErrorName(data: string): string | undefined {
  for (const contract of [wrapperInterface, cometInterface]) {
    try {
      return contract.parseError(data).name;
    } catch {
      // Not one of this contract's errors.
    }
  }
  return undefined;
}

/** What an exit's revert means, and what the user can do about it. */
function describeExitRevert(data: string, symbol: string): string {
  if (data.slice(0, 10).toLowerCase() === ERROR_STRING_SELECTOR) {
    const reason = describeRevertData(data);
    return /exceeds balance/i.test(reason)
      ? `the market does not hold enough ${symbol} to pay it now (${reason}). Withdraw a smaller amount, or try again later`
      : reason;
  }
  switch (exitErrorName(data)) {
    case 'ZeroAssetsTransferred':
      return "these shares are worth no more than the wrapper's rounding buffer, so the wrapper refuses to withdraw them (ZeroAssetsTransferred). Withdraw a larger amount, or choose Everything";
    case 'ExcessiveAssetsDebited':
      return 'Comet would take more from the wrapper than these shares cover, and the wrapper refuses that so that its other holders do not pay for it (ExcessiveAssetsDebited). Try again in a few minutes, or with a different amount';
    case 'ZeroSharesBurned':
      return 'the withdrawal burns no shares (ZeroSharesBurned)';
    case 'ERC20InsufficientBalance':
      return 'your account holds fewer wrapped shares than this withdrawal burns (ERC20InsufficientBalance). Review the withdrawal again';
    case 'Paused':
      return "withdrawals from this market are paused (Comet's Paused). Nothing can be withdrawn until they resume";
    case 'TransferOutFailed':
      return `the market could not pay out the ${symbol} (TransferOutFailed). It may not hold enough cash now. Withdraw a smaller amount, or try again later`;
    default:
      return describeRevertData(data);
  }
}

/**
 * Why an exit's simulation failed. A revert is explained by its error. A revert without data is
 * what a USDT transfer the market cannot pay gives. Any other failure did not run the exit.
 */
function describeExitFailure(error: unknown, symbol: string): string {
  const data = revertData(error);
  if (data !== undefined) return describeExitRevert(data, symbol);
  if (isRevert(error)) {
    return `it reverted without a reason (${describeCallFailure(
      error
    )}). The market may not hold enough ${symbol} to pay it now. Withdraw a smaller amount, or try again later`;
  }
  return `it could not be run (${describeCallFailure(error)}). Try again in a moment`;
}

/**
 * Simulates `unwrapAndWithdraw(shares)` from the account with an `eth_call` at `blockNumber`, just
 * before the wallet is asked to sign it. The call must pay `expectedCash`, which the quote of the
 * same block pays. Ethers returns a revert's data as the call's result, so the result is decoded
 * rather than trusted. A failed simulation refuses the step. Nothing else is tried in its place,
 * and never Comet's own `withdraw`, which opens a borrow when the account has too little supplied.
 */
async function simulateUnwrapAndWithdraw(
  reads: SimulationReads,
  identity: WrappedActionIdentity,
  shares: bigint,
  blockNumber: number,
  expectedCash: bigint,
  formatAmount: (value: bigint) => string,
  symbol: string
): Promise<WrappedStepCheck> {
  const refuse = (detail: string): WrappedStepCheck => ({
    ok: false,
    message: `Simulating the withdrawal from your account failed: ${detail}. Your wallet was not asked to sign it.`,
  });
  const request = {
    from: identity.account,
    to: identity.wrapperAddress,
    data: wrapperInterface.encodeFunctionData('unwrapAndWithdraw', [shares]),
  };
  let result: string;
  try {
    result = await simulateAtBlock(reads, request, blockNumber);
  } catch (error) {
    return refuse(describeExitFailure(error, symbol));
  }
  let paidCash: bigint;
  try {
    paidCash = BigInt(wrapperInterface.decodeFunctionResult('unwrapAndWithdraw', result)[0].toString());
  } catch (error) {
    return refuse(describeExitFailure(error, symbol));
  }
  if (paidCash !== expectedCash) {
    return refuse(
      `it pays ${formatAmount(paidCash)}, not the ${formatAmount(
        expectedCash
      )} this page worked out from the same block. Review the withdrawal again`
    );
  }
  return { ok: true };
}

/** Why an exit cannot be reviewed as asked, and what the user can ask for instead. It never lowers the amount itself. */
function revisionMessage(
  plan: Extract<WithdrawalPlan, { status: 'needs-revision' }>,
  request: WithdrawalRequest,
  snapshot: WithdrawalSnapshot,
  formatAmount: (value: bigint) => string,
  symbol: string
): string {
  const { limits } = plan;
  switch (plan.reason) {
    case 'no-shares':
      return `You hold no wrapped ${symbol} to withdraw.`;
    case 'paused':
      return 'Withdrawals from this market are paused, so nothing can be withdrawn now. Try again once they resume.';
    case 'dust':
      return `Your wrapped position is worth no more than the wrapper's rounding buffer of ${formatAmount(
        getRedeemBuffer(snapshot.baseSupplyIndex)
      )}, so the wrapper refuses to withdraw it (ZeroAssetsTransferred).`;
    case 'no-amount':
      return 'Enter an amount greater than 0.';
    case 'exceeds-position': {
      const fullExit = limits.canExitFully
        ? ` Or choose Everything to withdraw your whole position, about ${formatAmount(limits.fullExitCash)}.`
        : '';
      const asked = request.kind === 'partial' ? formatAmount(request.cash) : formatAmount(limits.fullExitCash);
      return `You asked for ${asked}, more than your wrapped position pays now. Enter at most ${formatAmount(
        limits.maxPartialCash
      )}.${fullExit}`;
    }
    case 'exceeds-liquidity':
      return request.kind === 'full'
        ? `A full exit pays about ${formatAmount(limits.fullExitCash)}, but the market holds only ${formatAmount(
            snapshot.cometCash
          )} now. Withdraw at most ${formatAmount(limits.maxPartialCash)} as an amount, or try again later.`
        : `The market holds only ${formatAmount(snapshot.cometCash)} now, so it cannot pay ${formatAmount(
            request.cash
          )}. Enter at most ${formatAmount(limits.maxPartialCash)}, or try again later.`;
  }
}

/** Why a reviewed exit stopped before its signature, and what the user can do. */
function changeMessage(
  recheck: Extract<WithdrawalRecheck, { status: 'changed' }>,
  quote: WithdrawalQuote,
  snapshot: WithdrawalSnapshot,
  formatAmount: (value: bigint) => string
): string {
  switch (recheck.reason) {
    case 'shares-changed':
      return quote.kind === 'full'
        ? 'Your wrapped balance changed since the review, so this full exit no longer burns exactly all your shares. Review the withdrawal again.'
        : 'Your wrapped balance is now below the shares this withdrawal burns. Review the withdrawal again.';
    case 'paused':
      return 'Withdrawals from this market are now paused. Nothing can be withdrawn until they resume.';
    case 'dust':
      return "These shares are now worth no more than the wrapper's rounding buffer, so the wrapper would refuse the withdrawal (ZeroAssetsTransferred). Review the withdrawal again.";
    case 'cash-fell':
      return `This withdrawal now pays about ${formatAmount(recheck.cash)}, less than the ${formatAmount(
        quote.cash
      )} you reviewed. Review it again.`;
    case 'exceeds-liquidity':
      return `The market now holds only ${formatAmount(snapshot.cometCash)}, less than the ${formatAmount(
        recheck.cash
      )} this withdrawal pays. Review a smaller amount, or try again later.`;
  }
}

export type PrepareWrappedWithdrawalInput = {
  identity: WrappedActionIdentity;
  market: WrappedMarket;
  request: WithdrawalRequest;
  /** The full-exit cash the page showed before the review, which the review shows next to the new quote. */
  shownCash: bigint | undefined;
  symbol: string;
  reads: WrappedWithdrawalReads;
};

/**
 * Reads the account's position and the market again, at the newest block that shows the account's
 * last settled wrapper transaction, and quotes a wrapped exit through `unwrapAndWithdraw(shares)`.
 * A full exit burns every share read. A partial exit burns the fewest shares that pay the requested
 * cash. An exit that cannot pay what was asked is refused with what the user can ask for instead:
 * an amount the position and the market can pay, or the full exit. It is never lowered here.
 *
 * Before the signature, the step reads again and stops when the share balance, the pause, the
 * cash the shares pay or the market's cash no longer allows the reviewed exit. It then simulates
 * the exit from the account at that block. The method has no minimum amount and no deadline, and
 * the simulation enforces neither: the wrapper computes the cash when the transaction runs.
 */
export async function prepareWrappedWithdrawal({
  identity,
  market,
  request,
  shownCash,
  symbol,
  reads,
}: PrepareWrappedWithdrawalInput): Promise<{ amount: bigint; steps: WrappedStep[]; withdrawal: WithdrawalReview }> {
  if (identity.type !== 'withdraw' || !isMarketOf(market, identity)) {
    throw new WrappedReviewError('The wrapper for this market changed. Review the withdrawal again.');
  }
  if (request.kind === 'partial' && request.cash <= 0n) throw new WrappedReviewError('Enter an amount greater than 0.');

  const formatAmount = (value: bigint) => `${formatExactUnits(value, market.baseDecimals)} ${symbol}`;
  let read: WithdrawalRead;
  try {
    read = await reads.readSnapshot();
  } catch (error) {
    if (error instanceof WrappedReviewError) throw new WrappedReviewError(`${error.message} Try again in a moment.`);
    throw new WrappedReviewError(
      `Your wrapped position could not be read (${describeCallFailure(error)}). Try again in a moment.`
    );
  }
  const plan = planWrappedWithdrawal(request, read.snapshot);
  if (plan.status === 'needs-revision') {
    throw new WrappedReviewError(revisionMessage(plan, request, read.snapshot, formatAmount, symbol));
  }
  const { quote } = plan;

  const checkBeforeExit = async (): Promise<WrappedStepCheck> => {
    let latest: WithdrawalRead;
    try {
      latest = await reads.readSnapshot();
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof WrappedReviewError
            ? `${error.message} Review the withdrawal again in a moment.`
            : `Your wrapped position could not be read again (${describeCallFailure(error)}).`,
      };
    }
    const recheck = recheckWithdrawal(quote, latest.snapshot);
    if (recheck.status === 'changed') {
      return { ok: false, message: changeMessage(recheck, quote, latest.snapshot, formatAmount) };
    }
    return simulateUnwrapAndWithdraw(
      reads,
      identity,
      quote.shares,
      latest.blockNumber,
      recheck.cash,
      formatAmount,
      symbol
    );
  };

  const step: WrappedStep = {
    id: WRAPPED_WITHDRAW_STEP_ID,
    kind: 'unwrap-and-withdraw',
    description:
      quote.kind === 'full'
        ? `Withdraw all your wrapped ${symbol}, about ${formatAmount(quote.cash)}`
        : `Withdraw ${formatAmount(quote.cash)} from the wrapper`,
    request: {
      to: identity.wrapperAddress,
      data: wrapperInterface.encodeFunctionData('unwrapAndWithdraw', [quote.shares]),
    },
    check: checkBeforeExit,
  };
  return {
    amount: quote.shares,
    steps: [step],
    withdrawal: { request, quote, shownCash, blockNumber: read.blockNumber },
  };
}

export type WriteWrappedState = {
  /**
   * Starts a fresh review of a wrapped supply of `amount`, in raw base-token units. Returns why it
   * was refused, if it was. The review reads the wallet balance and allowance again, and each step
   * is signed only after its own confirmation, through the wrapper action lifecycle.
   */
  supply: (amount: bigint) => WrappedBlockReason | undefined;
  /**
   * Starts a fresh review of a wrapped withdrawal: an amount of base-token cash, or the whole
   * position. Returns why it was refused, if it was. The review reads the position again and quotes
   * the exit. `shownCash` is the full-exit cash the page showed, which the review compares with the
   * new quote.
   */
  withdraw: (request: WithdrawalRequest, shownCash?: bigint) => WrappedBlockReason | undefined;
};

/** The wrapped writes outside the wrapped route. */
export const IDLE_WRITE_WRAPPED_STATE: WriteWrappedState = Object.freeze<WriteWrappedState>({
  supply: () => 'not-wrapped',
  withdraw: () => 'not-wrapped',
});

export type UseWriteWrappedStateOptions = {
  action: Pick<WrappedActionController, 'start' | 'recovered'>;
  route: LendingRoute;
  /** The configured chain's public provider. The supply's reads and simulation go through it. */
  readProvider: WrappedReadProvider | undefined;
  /** The selected market's base asset symbol, for the steps' descriptions. */
  baseSymbol: string | undefined;
  blockWait?: BlockWait;
};

/**
 * The wrapped route's writes, straight from the wallet: a wrapped supply through `supplyAndWrap`,
 * and a wrapped withdrawal through `unwrapAndWithdraw`. They never use the standard queue, the
 * Bulker, Permit2, a permit, a Comet manager permission or Comet's own `withdraw`.
 */
export function useWriteWrappedState({
  action,
  route,
  readProvider,
  baseSymbol,
  blockWait = DEFAULT_BLOCK_WAIT,
}: UseWriteWrappedStateOptions): WriteWrappedState {
  // A form or dialog can keep `supply` from an earlier render, and steps read when they are
  // confirmed, so both read the live values.
  const live = useRef({ action, route, readProvider, baseSymbol, blockWait });
  live.current = { action, route, readProvider, baseSymbol, blockWait };

  const supply = (amount: bigint): WrappedBlockReason | undefined => {
    const current = live.current;
    if (current.route.kind !== 'wrapped' || current.route.market === undefined) return 'not-wrapped';
    const { market } = current.route;
    const provider = current.readProvider;
    const symbol = current.baseSymbol ?? 'base token';
    return current.action.start('supply', async (identity) => {
      if (provider === undefined) {
        throw new WrappedReviewError("This market's network cannot be read right now. Try again in a moment.");
      }
      return prepareWrappedSupply({
        identity,
        market,
        amount,
        symbol,
        reads: {
          // Each read waits for the provider to show this account's newest settled wrapper
          // transaction, such as the approval a review's previous step just confirmed.
          readFunds: () =>
            readSupplyFunds(
              provider,
              identity,
              newestReceiptBlock(live.current.action.recovered.settled),
              live.current.blockWait
            ),
          call: (request, blockNumber) => provider.call(request, blockNumber),
          retryIntervalMs: live.current.blockWait.intervalMs,
        },
      });
    });
  };

  const withdraw = (request: WithdrawalRequest, shownCash?: bigint): WrappedBlockReason | undefined => {
    const current = live.current;
    if (current.route.kind !== 'wrapped' || current.route.market === undefined) return 'not-wrapped';
    const { market } = current.route;
    const provider = current.readProvider;
    const symbol = current.baseSymbol ?? 'base token';
    return current.action.start('withdraw', async (identity) => {
      if (provider === undefined) {
        throw new WrappedReviewError("This market's network cannot be read right now. Try again in a moment.");
      }
      return prepareWrappedWithdrawal({
        identity,
        market,
        request,
        shownCash,
        symbol,
        reads: {
          // Each read waits for the provider to show this account's newest settled wrapper
          // transaction, such as an exit that just confirmed.
          readSnapshot: () =>
            readWithdrawalSnapshot(
              provider,
              identity,
              market.baseDecimals,
              newestReceiptBlock(live.current.action.recovered.settled),
              live.current.blockWait
            ),
          call: (callRequest, blockNumber) => provider.call(callRequest, blockNumber),
          retryIntervalMs: live.current.blockWait.intervalMs,
        },
      });
    });
  };

  return { supply, withdraw };
}
