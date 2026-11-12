import { getAddress, isAddress, zeroAddress } from 'viem';

import { getMarket, isV2Market } from '@helpers/markets';

/**
 * The EIP-6963 RDNS the Anchorage Digital extension announces, and so the id of its wagmi
 * connector. Any extension can announce it. It selects a user experience only. It is not
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
  isDepositEnabled: boolean;
  /** Release control for wrapped exits, set independently of deposits. */
  isExitEnabled: boolean;
};

/** What a configuration source supplies: wrapper metadata and release controls. */
export type WrappedLendingSource = { markets: readonly WrappedMarketSource[] };

/** A validated mapping, with addresses in checksum form. */
export type WrappedMarket = Readonly<WrappedMarketSource>;

export type WrappedMarketProblem =
  'missing' | 'zero-address' | 'malformed-address' | 'duplicate' | 'inconsistent' | 'unreadable-source';

export type WrappedMarketLookup =
  | { status: 'unconfigured' }
  | { status: 'valid'; market: WrappedMarket }
  | { status: 'invalid'; problem: WrappedMarketProblem; detail: string };

export type WrappedMarketRegistry = {
  lookup: (chainId: number, cometAddress: string) => WrappedMarketLookup;
  /** Source entries that name no chain and Comet the registry can parse. */
  problems: readonly string[];
};

const ETHEREUM_CHAIN_ID = 1;
const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const SHARE_DECIMALS = 18;

/**
 * Markets the Anchorage connector reaches only through a wrapper. The list is kept in code,
 * apart from the replaceable source, so a source that omits or garbles one of these markets
 * disables it instead of sending deposits straight to Comet.
 */
export const WRAPPED_ROUTED_MARKETS: readonly WrappedMarketIdentity[] = Object.freeze([
  Object.freeze({ chainId: ETHEREUM_CHAIN_ID, cometAddress: '0xc3d688B66703497DAA19211EEdff47f25384cdc3' }),
  Object.freeze({ chainId: ETHEREUM_CHAIN_ID, cometAddress: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840' }),
  Object.freeze({ chainId: ETHEREUM_CHAIN_ID, cometAddress: '0x207158a267CBD2598BB3d611D8CBdEE2709F2F8C' }),
]);

/**
 * The factory whose `getWrapper(comet)` names each market's canonical wrapper, by chain.
 * Kept in code, apart from the replaceable source, so a source cannot supply both a wrapper
 * and the authority that vouches for it.
 */
export const WRAPPER_FACTORY_BY_CHAIN_ID: Readonly<Record<number, string>> = Object.freeze({
  [ETHEREUM_CHAIN_ID]: '0xf77f675a383eB43fa032ea3c6d1dd4dC56B69BF6',
});

/**
 * The three Ethereum wrappers, as the factory's `getWrapper(comet)` returns them, with
 * wrapped deposits and exits open. The evidence and the release checks are in
 * docs/anchorage-wrapper-registry.md, and the rollback in docs/anchorage-release-runbook.md.
 */
export const HARDCODED_WRAPPED_LENDING_SOURCE: WrappedLendingSource = Object.freeze({
  markets: Object.freeze([
    Object.freeze({
      chainId: ETHEREUM_CHAIN_ID,
      cometAddress: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
      wrapperAddress: '0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73',
      baseTokenAddress: USDC_ADDRESS,
      baseDecimals: 6,
      shareDecimals: SHARE_DECIMALS,
      isDepositEnabled: true,
      isExitEnabled: true,
    }),
    Object.freeze({
      chainId: ETHEREUM_CHAIN_ID,
      cometAddress: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840',
      wrapperAddress: '0xD7c9F42a35C8d13b71D4c0B024AE9eb0e77b9cFf',
      baseTokenAddress: USDT_ADDRESS,
      baseDecimals: 6,
      shareDecimals: SHARE_DECIMALS,
      isDepositEnabled: true,
      isExitEnabled: true,
    }),
    // Institutional USDC: a separate Comet from the USDC market, with the same base token.
    Object.freeze({
      chainId: ETHEREUM_CHAIN_ID,
      cometAddress: '0x207158a267CBD2598BB3d611D8CBdEE2709F2F8C',
      wrapperAddress: '0xc7Eb9aA5B9ae154C1bAb08872E90fC44e522E463',
      baseTokenAddress: USDC_ADDRESS,
      baseDecimals: 6,
      shareDecimals: SHARE_DECIMALS,
      isDepositEnabled: true,
      isExitEnabled: true,
    }),
  ]),
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

function addressKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

type Invalid = { problem: WrappedMarketProblem; detail: string };

/** Validates one entry on its own. Duplicates across entries are found afterwards. */
function validateEntry(source: WrappedMarketSource, cometAddress: string): WrappedMarket | Invalid {
  const wrapper = parseAddress(source.wrapperAddress);
  if (!wrapper.ok) return { problem: wrapper.problem, detail: `wrapperAddress is ${wrapper.problem}` };
  const baseToken = parseAddress(source.baseTokenAddress);
  if (!baseToken.ok) return { problem: baseToken.problem, detail: `baseTokenAddress is ${baseToken.problem}` };
  const inconsistent = (detail: string): Invalid => ({ problem: 'inconsistent', detail });

  const market = getMarket(source.chainId, cometAddress);
  if (market === undefined || isV2Market(market)) {
    return inconsistent('the Comet is not a market the frontend lists on that chain');
  }
  if (new Set([cometAddress, wrapper.address, baseToken.address]).size !== 3) {
    return inconsistent('the Comet, wrapper and base token must be three different contracts');
  }
  if (!Number.isInteger(source.baseDecimals) || source.baseDecimals < 0 || source.baseDecimals > SHARE_DECIMALS) {
    return inconsistent(`baseDecimals must be an integer from 0 to ${SHARE_DECIMALS}`);
  }
  if (source.shareDecimals !== SHARE_DECIMALS) {
    return inconsistent(`shareDecimals must be ${SHARE_DECIMALS}`);
  }
  if (typeof source.isDepositEnabled !== 'boolean' || typeof source.isExitEnabled !== 'boolean') {
    return inconsistent('isDepositEnabled and isExitEnabled must be booleans');
  }
  return Object.freeze({
    chainId: source.chainId,
    cometAddress,
    wrapperAddress: wrapper.address,
    baseTokenAddress: baseToken.address,
    baseDecimals: source.baseDecimals,
    shareDecimals: source.shareDecimals,
    isDepositEnabled: source.isDepositEnabled,
    isExitEnabled: source.isExitEnabled,
  });
}

function isInvalid(result: WrappedMarket | Invalid): result is Invalid {
  return 'problem' in result;
}

/**
 * Validates a configuration source into the one lookup the app reads wrapper mappings
 * through. A problem with an entry makes its market's lookup `invalid`, and the route
 * resolver turns that into a disabled wrapped route. A market in `routedMarkets` with no
 * entry is `invalid` too. A source with any entry the registry cannot tie to a market is not
 * trusted at all: every market it or `routedMarkets` names is `invalid`.
 */
export function buildWrappedMarketRegistry(
  source: WrappedLendingSource,
  routedMarkets: readonly WrappedMarketIdentity[] = WRAPPED_ROUTED_MARKETS,
): WrappedMarketRegistry {
  const problems: string[] = [];
  const results = new Map<string, WrappedMarket | Invalid>();
  const entryCounts = new Map<string, number>();
  // Every Comet each parseable wrapper address is mapped to, whatever else is wrong with the entry.
  const cometsByWrapper = new Map<string, Set<string>>();

  source.markets.forEach((entry, index) => {
    const comet = parseAddress(entry.cometAddress);
    if (!isChainId(entry.chainId) || !comet.ok) {
      problems.push(`markets[${index}] has no valid chain ID and Comet address, so it maps no market`);
      return;
    }
    const key = addressKey(entry.chainId, comet.address);
    entryCounts.set(key, (entryCounts.get(key) ?? 0) + 1);
    results.set(key, validateEntry(entry, comet.address));

    const wrapper = parseAddress(entry.wrapperAddress);
    if (wrapper.ok) {
      const wrapperKey = addressKey(entry.chainId, wrapper.address);
      cometsByWrapper.set(wrapperKey, (cometsByWrapper.get(wrapperKey) ?? new Set()).add(key));
    }
  });

  for (const [key, count] of entryCounts) {
    if (count > 1) results.set(key, { problem: 'duplicate', detail: 'the Comet is mapped more than once' });
  }
  // One wrapper holds one Comet, so a wrapper mapped to two Comets is wrong for at least one of them.
  for (const comets of cometsByWrapper.values()) {
    if (comets.size < 2) continue;
    for (const key of comets) {
      results.set(key, { problem: 'duplicate', detail: 'the wrapper is mapped to more than one Comet' });
    }
  }

  const routedKeys = new Set<string>();
  routedMarkets.forEach((identity, index) => {
    const comet = parseAddress(identity.cometAddress);
    if (!isChainId(identity.chainId) || !comet.ok) {
      problems.push(`routedMarkets[${index}] has no valid chain ID and Comet address, so it routes no market`);
      return;
    }
    routedKeys.add(addressKey(identity.chainId, comet.address));
  });

  const lookups = new Map<string, WrappedMarketLookup>();
  if (problems.length > 0) {
    const unreadable: WrappedMarketLookup = {
      status: 'invalid',
      problem: 'unreadable-source',
      detail: 'the configuration has entries that name no market, so none of it is used',
    };
    for (const key of [...results.keys(), ...routedKeys]) lookups.set(key, unreadable);
  } else {
    for (const [key, result] of results) {
      lookups.set(key, isInvalid(result) ? { status: 'invalid', ...result } : { status: 'valid', market: result });
    }
    for (const key of routedKeys) {
      if (!lookups.has(key)) {
        lookups.set(key, { status: 'invalid', problem: 'missing', detail: 'the market is routed but has no wrapper' });
      }
    }
  }

  return Object.freeze({
    lookup: (chainId: number, cometAddress: string): WrappedMarketLookup => {
      const comet = parseAddress(cometAddress);
      if (!comet.ok) return { status: 'unconfigured' };
      return lookups.get(addressKey(chainId, comet.address)) ?? { status: 'unconfigured' };
    },
    problems: Object.freeze(problems),
  });
}

/** The registry built from the hardcoded source. A later configuration source replaces only the source. */
export const WRAPPED_MARKET_REGISTRY: WrappedMarketRegistry = buildWrappedMarketRegistry(
  HARDCODED_WRAPPED_LENDING_SOURCE,
);
