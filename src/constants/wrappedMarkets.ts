import { getAddress, isAddress, zeroAddress } from 'viem';

import { getMarket, isV2Market } from '@helpers/markets';

/**
 * The EIP-6963 RDNS the Anchorage Digital extension announces, and so the id of its wagmi
 * connector. Any extension can announce it, so it selects a user experience only. It is not
 * authorization and does not identify an Anchorage customer.
 */
export const ANCHORAGE_CONNECTOR_ID = 'com.anchorage.connect';

/** A market identity: the chain and the Comet proxy address. Never a token symbol. */
export type WrappedMarketIdentity = { chainId: number; cometAddress: string };

/** One wrapper mapping as a configuration source states it, before validation. */
export type WrappedMarketSource = {
  chainId: number;
  cometAddress: string;
  wrapperAddress: string;
  baseTokenAddress: string;
  baseDecimals: number;
  /** Always 18: the wrapper offsets its decimals by `18 - asset decimals`. */
  shareDecimals: number;
  /** Release control for new wrapped deposits. */
  depositsEnabled: boolean;
  /** Release control for wrapped exits, set independently of deposits. */
  exitsEnabled: boolean;
};

/**
 * Everything a configuration source supplies. `routedMarkets` lists the markets the Anchorage
 * connector must reach through a wrapper, and `markets` the wrapper for each. A market in
 * either list routes through a wrapper, so losing the other half of its configuration
 * disables it rather than sending deposits straight to Comet.
 */
export type WrappedLendingSource = {
  routedMarkets: readonly WrappedMarketIdentity[];
  markets: readonly WrappedMarketSource[];
};

/** A validated mapping, with addresses in checksum form. */
export type WrappedMarket = Readonly<WrappedMarketSource>;

export type WrappedMarketProblem = 'missing' | 'zero-address' | 'malformed-address' | 'duplicate' | 'inconsistent';

export type WrappedMarketLookup =
  | { status: 'unconfigured' }
  | { status: 'valid'; market: WrappedMarket }
  | { status: 'invalid'; problem: WrappedMarketProblem; detail: string };

export type WrappedMarketRegistry = {
  lookup: (chainId: number, cometAddress: string) => WrappedMarketLookup;
  /** Source entries that could not be tied to a market at all. */
  problems: readonly string[];
};

const ETHEREUM = 1;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const SHARE_DECIMALS = 18;

/**
 * The three Ethereum wrappers, resolved from the factory's `getWrapper(comet)`. The evidence
 * and the release checks that keep both controls off are in docs/anchorage-wrapper-registry.md.
 */
const HARDCODED_MARKETS: readonly WrappedMarketSource[] = [
  {
    chainId: ETHEREUM,
    cometAddress: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
    wrapperAddress: '0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73',
    baseTokenAddress: USDC,
    baseDecimals: 6,
    shareDecimals: SHARE_DECIMALS,
    depositsEnabled: false,
    exitsEnabled: false,
  },
  {
    chainId: ETHEREUM,
    cometAddress: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840',
    wrapperAddress: '0xD7c9F42a35C8d13b71D4c0B024AE9eb0e77b9cFf',
    baseTokenAddress: USDT,
    baseDecimals: 6,
    shareDecimals: SHARE_DECIMALS,
    depositsEnabled: false,
    exitsEnabled: false,
  },
  {
    // Institutional USDC: a separate Comet from the one above, with the same base token.
    chainId: ETHEREUM,
    cometAddress: '0x207158a267CBD2598BB3d611D8CBdEE2709F2F8C',
    wrapperAddress: '0xc7Eb9aA5B9ae154C1bAb08872E90fC44e522E463',
    baseTokenAddress: USDC,
    baseDecimals: 6,
    shareDecimals: SHARE_DECIMALS,
    depositsEnabled: false,
    exitsEnabled: false,
  },
];

export const HARDCODED_WRAPPED_LENDING_SOURCE: WrappedLendingSource = Object.freeze({
  routedMarkets: Object.freeze(
    HARDCODED_MARKETS.map(({ chainId, cometAddress }) => Object.freeze({ chainId, cometAddress })),
  ),
  markets: Object.freeze(HARDCODED_MARKETS.map((market) => Object.freeze({ ...market }))),
});

type ParsedAddress = { ok: true; address: string } | { ok: false; problem: 'zero-address' | 'malformed-address' };

function parseAddress(value: unknown): ParsedAddress {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    return { ok: false, problem: 'malformed-address' };
  }
  const address = getAddress(value);
  return address === zeroAddress ? { ok: false, problem: 'zero-address' } : { ok: true, address };
}

function isChainId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function marketKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

type Invalid = { problem: WrappedMarketProblem; detail: string };

/** Validate one entry on its own; duplicates across entries are found afterwards. */
function validateEntry(source: WrappedMarketSource, cometAddress: string): WrappedMarket | Invalid {
  const addresses = {
    wrapperAddress: parseAddress(source.wrapperAddress),
    baseTokenAddress: parseAddress(source.baseTokenAddress),
  };
  for (const [field, parsed] of Object.entries(addresses)) {
    if (!parsed.ok) return { problem: parsed.problem, detail: `${field} is ${parsed.problem}` };
  }
  const wrapperAddress = (addresses.wrapperAddress as { address: string }).address;
  const baseTokenAddress = (addresses.baseTokenAddress as { address: string }).address;
  const inconsistent = (detail: string): Invalid => ({ problem: 'inconsistent', detail });

  const market = getMarket(source.chainId, cometAddress);
  if (market === undefined || isV2Market(market)) {
    return inconsistent('the Comet is not a market the frontend lists on that chain');
  }
  if (new Set([cometAddress, wrapperAddress, baseTokenAddress]).size !== 3) {
    return inconsistent('the Comet, wrapper and base token must be three different contracts');
  }
  if (!Number.isInteger(source.baseDecimals) || source.baseDecimals < 0 || source.baseDecimals > SHARE_DECIMALS) {
    return inconsistent(`baseDecimals must be an integer from 0 to ${SHARE_DECIMALS}`);
  }
  if (source.shareDecimals !== SHARE_DECIMALS) {
    return inconsistent(`shareDecimals must be ${SHARE_DECIMALS}`);
  }
  if (typeof source.depositsEnabled !== 'boolean' || typeof source.exitsEnabled !== 'boolean') {
    return inconsistent('depositsEnabled and exitsEnabled must be booleans');
  }
  return Object.freeze({
    chainId: source.chainId,
    cometAddress,
    wrapperAddress,
    baseTokenAddress,
    baseDecimals: source.baseDecimals,
    shareDecimals: source.shareDecimals,
    depositsEnabled: source.depositsEnabled,
    exitsEnabled: source.exitsEnabled,
  });
}

function isInvalid(result: WrappedMarket | Invalid): result is Invalid {
  return 'problem' in result;
}

/**
 * Validate a configuration source into the one lookup the app reads wrapper mappings through.
 * A problem with an entry makes that market's lookup `invalid`, which the route resolver turns
 * into a disabled wrapped route.
 */
export function buildWrappedMarketRegistry(source: WrappedLendingSource): WrappedMarketRegistry {
  const problems: string[] = [];
  const results = new Map<string, WrappedMarket | Invalid>();
  const counts = new Map<string, number>();

  source.markets.forEach((entry, index) => {
    const comet = parseAddress(entry.cometAddress);
    if (!isChainId(entry.chainId) || !comet.ok) {
      problems.push(`markets[${index}] has no valid chain ID and Comet address, so it maps no market`);
      return;
    }
    const key = marketKey(entry.chainId, comet.address);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    results.set(key, validateEntry(entry, comet.address));
  });

  for (const [key, count] of counts) {
    if (count > 1) results.set(key, { problem: 'duplicate', detail: 'the Comet is mapped more than once' });
  }

  // One wrapper holds one Comet, so a wrapper mapped to two markets is wrong for at least one.
  const keysByWrapper = new Map<string, string[]>();
  for (const [key, result] of results) {
    if (isInvalid(result)) continue;
    const wrapper = marketKey(result.chainId, result.wrapperAddress);
    keysByWrapper.set(wrapper, [...(keysByWrapper.get(wrapper) ?? []), key]);
  }
  for (const keys of keysByWrapper.values()) {
    if (keys.length < 2) continue;
    for (const key of keys)
      results.set(key, { problem: 'duplicate', detail: 'the wrapper is mapped to more than one Comet' });
  }

  const routed = new Set<string>();
  source.routedMarkets.forEach((identity, index) => {
    const comet = parseAddress(identity.cometAddress);
    if (!isChainId(identity.chainId) || !comet.ok) {
      problems.push(`routedMarkets[${index}] has no valid chain ID and Comet address, so it routes no market`);
      return;
    }
    routed.add(marketKey(identity.chainId, comet.address));
  });

  const lookups = new Map<string, WrappedMarketLookup>();
  for (const [key, result] of results) {
    lookups.set(key, isInvalid(result) ? { status: 'invalid', ...result } : { status: 'valid', market: result });
  }
  for (const key of routed) {
    if (!lookups.has(key)) {
      lookups.set(key, { status: 'invalid', problem: 'missing', detail: 'the market is routed but has no wrapper' });
    }
  }

  return Object.freeze({
    lookup: (chainId: number, cometAddress: string): WrappedMarketLookup => {
      const comet = parseAddress(cometAddress);
      if (!comet.ok) return { status: 'unconfigured' };
      return lookups.get(marketKey(chainId, comet.address)) ?? { status: 'unconfigured' };
    },
    problems: Object.freeze(problems),
  });
}

/** The registry built from the hardcoded source. A later configuration source replaces the source only. */
export const WRAPPED_MARKET_REGISTRY: WrappedMarketRegistry = buildWrappedMarketRegistry(
  HARDCODED_WRAPPED_LENDING_SOURCE,
);
