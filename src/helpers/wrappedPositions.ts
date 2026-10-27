import type { JsonRpcProvider } from '@ethersproject/providers';
import { BigNumber } from 'ethers';
import { Contract, ContractCall } from 'ethers-multicall';

import { WRAPPED_MARKET_REGISTRY, WrappedMarket, WrappedMarketRegistry } from '@constants/wrappedMarkets';
import CometAbi from '@helpers/abis/Comet';
import ERC20Abi from '@helpers/abis/ERC20';
import WrappedCometAbi from '@helpers/abis/WrappedCometERC4626';
import { addsDirectBaseSupply } from '@helpers/actions';
import { LendingRoute } from '@helpers/lendingRoute';
import { getTokenValue } from '@helpers/numbers';
import { Action, CometState, Currency, StateType } from '@types';

/** The wrapper's divisor for Comet's supply index in its redeem buffer. */
const BASE_INDEX_SCALE = 10n ** 15n;
/** The wrapper's allowance for what one Comet transfer can lose to rounding, in base units. */
const COMET_TRANSFER_LOSS = 2n;

/** A read that produced no trustworthy position. The UI shows the error, and never shows zero for it. */
export class WrappedPositionReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'WrappedPositionReadError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** The figures a position's arithmetic used, all from the same block. */
export type WrappedPositionSnapshot = {
  /** Wrapper shares in existence, in share units. */
  totalSupply: bigint;
  /** The wrapper's Comet balance, which is its `totalAssets()`, in base units. */
  totalAssets: bigint;
  /** Comet's stored supply index, as `totalsBasic()` reports it. */
  baseSupplyIndex: bigint;
};

/**
 * One account's position in one wrapper. Shares use `shareDecimals` (18). Every other amount
 * is in base-token units (`baseDecimals`, 6 for the three Ethereum wrappers).
 */
export type WrappedPosition = {
  shares: bigint;
  shareDecimals: number;
  /** What the shares are worth, as the wrapper's `convertToAssets` rounds it: down. */
  grossAssets: bigint;
  baseDecimals: number;
  /** The base token in the account's wallet, which is what it has available to supply. */
  baseWalletBalance: bigint;
  /** The base-token allowance the account has given the wrapper. */
  wrapperAllowance: bigint;
  /** The base units the wrapper holds back from every exit. */
  redeemBuffer: bigint;
  /** The cash a full exit pays at this snapshot: the gross value less the buffer, or zero. */
  fullExitCash: bigint;
  /** Whether Comet withdrawals, which every wrapper exit makes, are paused. */
  isWithdrawPaused: boolean;
  snapshot: WrappedPositionSnapshot;
};

/**
 * How a read waits for the configured chain's provider to reach a block: how many times it asks
 * again, and how often. `attempts × intervalMs` also bounds the wait's elapsed time, including
 * time spent waiting for the provider to answer.
 */
export type BlockWait = { attempts: number; intervalMs: number };

/** At most half a minute: a few Ethereum blocks. */
export const DEFAULT_BLOCK_WAIT: BlockWait = Object.freeze({ attempts: 20, intervalMs: 1_500 });

/**
 * The provider's newest block, once it is at least `minBlock`. The transaction manager learns of a
 * receipt from the wallet's node, and the configured chain's provider can trail that node, so a
 * read made just after a transaction settles waits for the provider to reach the transaction's
 * block. Undefined when the provider has not reached it after `wait.attempts` more tries, or within
 * `wait.attempts × wait.intervalMs` of the first request, whichever comes first. A request still
 * unanswered at that time counts as not reaching the block.
 */
export async function waitForBlock(
  provider: Pick<JsonRpcProvider, 'getBlockNumber'>,
  minBlock: number | undefined,
  wait: BlockWait = DEFAULT_BLOCK_WAIT
): Promise<number | undefined> {
  if (minBlock === undefined) return provider.getBlockNumber();
  const deadline = Date.now() + wait.attempts * wait.intervalMs;
  // Settles as `pending` does, or with undefined at the deadline if `pending` has not settled by then.
  const beforeDeadline = <T>(pending: Promise<T>) =>
    new Promise<T | undefined>((resolve, reject) => {
      const timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()));
      pending.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });

  let blockNumber = await beforeDeadline(provider.getBlockNumber());
  for (let attempt = 1; blockNumber !== undefined && blockNumber < minBlock; attempt++) {
    if (attempt > wait.attempts) return undefined;
    await beforeDeadline(new Promise((resolve) => setTimeout(resolve, wait.intervalMs)));
    blockNumber = await beforeDeadline(provider.getBlockNumber());
  }
  return blockNumber;
}

/** The one method of an `ethers-multicall` provider that reads a batch in a single call. */
export type MulticallReader = { all: (calls: ContractCall[]) => Promise<unknown[]> };

/**
 * What `shares` are worth in base units. This is OpenZeppelin's ERC-4626 conversion with the
 * wrapper's decimals offset, rounded down, as the wrapper's public `convertToAssets` returns it.
 */
export function getGrossAssets(shares: bigint, totalSupply: bigint, totalAssets: bigint, baseDecimals: number) {
  const virtualShares = 10n ** BigInt(18 - baseDecimals);
  return (shares * (totalAssets + 1n)) / (totalSupply + virtualShares);
}

/** The base units the wrapper withholds from an exit at this supply index. */
export function getRedeemBuffer(baseSupplyIndex: bigint) {
  return baseSupplyIndex / BASE_INDEX_SCALE + COMET_TRANSFER_LOSS;
}

/**
 * The cash a full exit pays. The wrapper refuses an exit worth no more than the buffer, so such
 * a position has no cash to withdraw.
 */
export function getFullExitCash(grossAssets: bigint, redeemBuffer: bigint) {
  return grossAssets > redeemBuffer ? grossAssets - redeemBuffer : 0n;
}

/**
 * The dollar value of a base-unit amount, in the base token's decimals. It uses the app's own
 * conversion with the market's 8-decimal base price, which values USDC at one dollar.
 */
export function getWrappedPositionValueInDollars(
  grossAssets: bigint,
  baseAssetPriceInDollars: bigint,
  baseSymbol: string
) {
  return getTokenValue(grossAssets, Currency.USD, baseAssetPriceInDollars, baseSymbol);
}

/**
 * The base units a wrapped position adds to the dashboard's headline balance: its gross value,
 * not its exit cash. Undefined without a position, or when the wrapper's base decimals differ
 * from the market's `baseDecimals`. Otherwise the headline adds amounts of different scales.
 */
export function getHeadlineWrappedValue(position: WrappedPosition | undefined, baseDecimals: number) {
  if (position === undefined || position.baseDecimals !== baseDecimals) return undefined;
  return position.grossAssets;
}

function toBigInt(value: unknown, name: string): bigint {
  if (BigNumber.isBigNumber(value)) return value.toBigInt();
  throw new WrappedPositionReadError(`The wrapper read returned no number for ${name}.`);
}

/**
 * Reads `account`'s position in `market`'s wrapper. Every figure comes from one multicall, so
 * one block. The read fails, rather than returning zero, when the batch fails or the wrapper
 * does not hold the configured Comet.
 */
export async function readWrappedPosition(
  multicall: MulticallReader,
  market: WrappedMarket,
  account: string
): Promise<WrappedPosition> {
  const wrapper = new Contract(market.wrapperAddress, WrappedCometAbi);
  const comet = new Contract(market.cometAddress, CometAbi);
  const baseToken = new Contract(market.baseTokenAddress, ERC20Abi);

  let results: unknown[];
  try {
    results = await multicall.all([
      wrapper.balanceOf(account),
      wrapper.totalSupply(),
      wrapper.asset(),
      comet.balanceOf(market.wrapperAddress),
      comet.totalsBasic(),
      comet.isWithdrawPaused(),
      baseToken.balanceOf(account),
      baseToken.allowance(account, market.wrapperAddress),
    ]);
  } catch (error) {
    throw new WrappedPositionReadError('The wrapper position could not be read.', { cause: error });
  }

  const [
    sharesResult,
    totalSupplyResult,
    asset,
    totalAssetsResult,
    totalsBasic,
    isWithdrawPaused,
    walletResult,
    allowanceResult,
  ] = results;
  if (typeof asset !== 'string' || asset.toLowerCase() !== market.cometAddress.toLowerCase()) {
    throw new WrappedPositionReadError('The wrapper does not hold the configured market.');
  }
  if (typeof isWithdrawPaused !== 'boolean') {
    throw new WrappedPositionReadError('The wrapper read returned no withdrawal pause state.');
  }

  const shares = toBigInt(sharesResult, 'shares');
  const totalSupply = toBigInt(totalSupplyResult, 'totalSupply');
  const totalAssets = toBigInt(totalAssetsResult, 'totalAssets');
  const baseSupplyIndex = toBigInt((totalsBasic as { baseSupplyIndex?: unknown })?.baseSupplyIndex, 'baseSupplyIndex');
  const grossAssets = getGrossAssets(shares, totalSupply, totalAssets, market.baseDecimals);
  const redeemBuffer = getRedeemBuffer(baseSupplyIndex);

  return {
    shares,
    shareDecimals: market.shareDecimals,
    grossAssets,
    baseDecimals: market.baseDecimals,
    baseWalletBalance: toBigInt(walletResult, 'baseWalletBalance'),
    wrapperAllowance: toBigInt(allowanceResult, 'wrapperAllowance'),
    redeemBuffer,
    fullExitCash: getFullExitCash(grossAssets, redeemBuffer),
    isWithdrawPaused,
    snapshot: { totalSupply, totalAssets, baseSupplyIndex },
  };
}

export type SupplyIncentives = { earnRewardsAPR: bigint | undefined; isInstitutional: boolean | undefined };

/**
 * The supply incentives the dashboard shows for a route. No COMP, Merkl or institutional boost
 * rate is verified for wrapped positions. On the wrapped route the dashboard's supply figures
 * describe a wrapped supply, so they show the base lending rate only. An account with a direct
 * Comet supply keeps the incentives that supply earns. Borrow-side figures are unchanged.
 */
export function supplyIncentivesForRoute(
  isWrappedRoute: boolean,
  directBaseBalance: bigint,
  incentives: SupplyIncentives
): SupplyIncentives {
  return isWrappedRoute && directBaseBalance <= 0n ? { earnRewardsAPR: 0n, isInstitutional: false } : incentives;
}

export type MarketIdentity = { chainId: number; cometAddress: string };
/** Comet state with the market and account it was read for. */
export type CometStateWithMarket = {
  market: MarketIdentity | undefined;
  account: string | undefined;
  state: CometState;
};
/** The session as it is now: the route, the connected account and the selected market. */
export type LiveSubmissionState = {
  route: LendingRoute;
  account: string | undefined;
  selectedMarket: MarketIdentity | undefined;
  comet: CometStateWithMarket;
};

function isSameMarket(a: MarketIdentity | undefined, b: MarketIdentity): boolean {
  return a !== undefined && a.chainId === b.chainId && a.cometAddress.toLowerCase() === b.cometAddress.toLowerCase();
}

/**
 * Whether to refuse submitting `actions` to `submittedMarket`, judged by the session as it is
 * now. A dialog can keep a submit callback, with its market, actions and balances, from an
 * earlier render. On the wrapped route, the actions must not add to the account's direct
 * Comet supply at the live balances. Without live balances for that market and account, the
 * submission is refused. Once another market is selected, the route of a kept dialog's market is
 * unknown. Such a dialog is refused if its market can route through a wrapper.
 */
export function isSubmissionRefused(
  live: LiveSubmissionState,
  submittedMarket: MarketIdentity,
  actions: Action[],
  registry: WrappedMarketRegistry = WRAPPED_MARKET_REGISTRY
): boolean {
  if (!isSameMarket(live.selectedMarket, submittedMarket)) {
    return registry.lookup(submittedMarket.chainId, submittedMarket.cometAddress).status !== 'unconfigured';
  }
  if (live.route.kind !== 'wrapped') return false;

  const [stateType, cometState] = live.comet.state;
  const isLiveAccount = live.account !== undefined && live.comet.account?.toLowerCase() === live.account.toLowerCase();
  if (stateType !== StateType.Hydrated || !isSameMarket(live.comet.market, submittedMarket) || !isLiveAccount) {
    return true;
  }
  return addsDirectBaseSupply(cometState.baseAsset, cometState.collateralAssets, actions);
}

export type WithdrawableCash = { amount: bigint; limit: 'none' | 'paused' | 'liquidity' };

/**
 * The cash a full exit can pay now. The wrapper pays through Comet's `withdrawTo`, so the exit
 * pays nothing while Comet withdrawals are paused and no more than the base token Comet holds.
 */
export function getWithdrawableCash(
  fullExitCash: bigint,
  isWithdrawPaused: boolean,
  marketLiquidity: bigint
): WithdrawableCash {
  if (isWithdrawPaused) return { amount: 0n, limit: 'paused' };
  if (fullExitCash > marketLiquidity) return { amount: marketLiquidity, limit: 'liquidity' };
  return { amount: fullExitCash, limit: 'none' };
}
