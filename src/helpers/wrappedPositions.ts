import { BigNumber } from 'ethers';
import { Contract, ContractCall } from 'ethers-multicall';

import { WrappedMarket } from '@constants/wrappedMarkets';
import CometAbi from '@helpers/abis/Comet';
import ERC20Abi from '@helpers/abis/ERC20';
import WrappedCometAbi from '@helpers/abis/WrappedCometERC4626';

/** The wrapper's divisor for Comet's supply index in its redeem buffer. */
const BASE_INDEX_SCALE = 10n ** 15n;
/** The wrapper's allowance for what one Comet transfer can lose to rounding, in base units. */
const COMET_TRANSFER_LOSS = 2n;
const PRICE_DECIMALS = 8n;

/** A read that could not produce a trustworthy position. The UI shows it; it never means zero. */
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
 * One account's position in one wrapper. Shares use `shareDecimals` (18); every other amount
 * is in base-token units (`baseDecimals`, 6 for the three Ethereum wrappers).
 */
export type WrappedPosition = {
  shares: bigint;
  shareDecimals: number;
  /** What the shares are worth, as the wrapper's `convertToAssets` rounds it: down. */
  grossAssets: bigint;
  baseDecimals: number;
  /** The base token the account holds in its wallet and could supply. */
  baseWalletBalance: bigint;
  /** The base-token allowance the account has given the wrapper. */
  wrapperAllowance: bigint;
  /** The base units the wrapper holds back from every exit. */
  redeemBuffer: bigint;
  /** The cash a full exit pays at this snapshot: the gross value less the buffer, or zero. */
  fullExitCash: bigint;
  snapshot: WrappedPositionSnapshot;
};

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
 * The dollar value of a base-unit amount, priced with the market's existing 8-decimal base
 * price. The result keeps the base token's decimals.
 */
export function getWrappedPositionValueInDollars(grossAssets: bigint, baseAssetPriceInDollars: bigint) {
  return (grossAssets * baseAssetPriceInDollars) / 10n ** PRICE_DECIMALS;
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
      baseToken.balanceOf(account),
      baseToken.allowance(account, market.wrapperAddress),
    ]);
  } catch (error) {
    throw new WrappedPositionReadError('The wrapper position could not be read.', { cause: error });
  }

  const [sharesResult, totalSupplyResult, asset, totalAssetsResult, totalsBasic, walletResult, allowanceResult] =
    results;
  if (typeof asset !== 'string' || asset.toLowerCase() !== market.cometAddress.toLowerCase()) {
    throw new WrappedPositionReadError('The wrapper does not hold the configured market.');
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
    snapshot: { totalSupply, totalAssets, baseSupplyIndex },
  };
}

export type SupplyIncentives = { earnRewardsAPR: bigint | undefined; isInstitutional: boolean | undefined };

/**
 * The supply incentives the dashboard shows for a route. No COMP, Merkl or institutional boost
 * rate is verified for wrapped positions, so the wrapped route shows none and keeps only the
 * market's base lending rate. Borrow-side figures are not affected.
 */
export function supplyIncentivesForRoute(isWrappedRoute: boolean, incentives: SupplyIncentives): SupplyIncentives {
  return isWrappedRoute ? { earnRewardsAPR: 0n, isInstitutional: false } : incentives;
}
