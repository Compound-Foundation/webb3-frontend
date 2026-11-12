import usdcConfiguration from 'comet/deployments/mainnet/usdc/configuration.json';
import usdtConfiguration from 'comet/deployments/mainnet/usdt/configuration.json';

import {
  buildWrappedMarketRegistry,
  HARDCODED_WRAPPED_LENDING_SOURCE,
  WRAPPED_MARKET_REGISTRY,
  WRAPPED_ROUTED_MARKETS,
  WRAPPER_FACTORY_BY_CHAIN_ID,
  WrappedMarketIdentity,
  WrappedMarketSource,
} from '@constants/wrappedMarkets';
import { getMarket, MARKETS } from '@helpers/markets';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

const EXPECTED = [
  {
    label: 'Ethereum USDC',
    comet: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
    wrapper: '0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73',
    baseToken: USDC,
    symbol: 'USDC',
    institutional: undefined,
  },
  {
    label: 'Ethereum USDT',
    comet: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840',
    wrapper: '0xD7c9F42a35C8d13b71D4c0B024AE9eb0e77b9cFf',
    baseToken: USDT,
    symbol: 'USDT',
    institutional: undefined,
  },
  {
    label: 'Ethereum institutional USDC',
    comet: '0x207158a267CBD2598BB3d611D8CBdEE2709F2F8C',
    wrapper: '0xc7Eb9aA5B9ae154C1bAb08872E90fC44e522E463',
    baseToken: USDC,
    symbol: 'USDC',
    institutional: true,
  },
];

const USDC_COMET = EXPECTED[0].comet;
const USDT_COMET = EXPECTED[1].comet;

function entry(overrides: Partial<WrappedMarketSource> = {}): WrappedMarketSource {
  return {
    chainId: 1,
    cometAddress: USDC_COMET,
    wrapperAddress: EXPECTED[0].wrapper,
    baseTokenAddress: USDC,
    baseDecimals: 6,
    shareDecimals: 18,
    isDepositEnabled: false,
    isExitEnabled: false,
    ...overrides,
  };
}

function usdtEntry(overrides: Partial<WrappedMarketSource> = {}): WrappedMarketSource {
  return entry({ cometAddress: USDT_COMET, wrapperAddress: EXPECTED[1].wrapper, baseTokenAddress: USDT, ...overrides });
}

function registryOf(markets: WrappedMarketSource[], routedMarkets: WrappedMarketIdentity[] = []) {
  return buildWrappedMarketRegistry({ markets }, routedMarkets);
}

describe('wrappedMarkets', () => {
  it('maps the three Ethereum Comet addresses to distinct wrappers and correct units', () => {
    for (const expected of EXPECTED) {
      const lookup = WRAPPED_MARKET_REGISTRY.lookup(1, expected.comet);
      expect(lookup).toEqual({
        status: 'valid',
        market: {
          chainId: 1,
          cometAddress: expected.comet,
          wrapperAddress: expected.wrapper,
          baseTokenAddress: expected.baseToken,
          baseDecimals: 6,
          shareDecimals: 18,
          // New deposits and exits are both open.
          isDepositEnabled: true,
          isExitEnabled: true,
        },
      });

      // The Comet is an existing frontend market with the expected base asset.
      const market = getMarket(1, expected.comet);
      expect(market?.baseAsset.symbol).toBe(expected.symbol);
      expect(market?.institutional).toBe(expected.institutional);

      // Lookup is keyed by address, whatever its case.
      expect(WRAPPED_MARKET_REGISTRY.lookup(1, expected.comet.toLowerCase())).toEqual(lookup);
      expect(WRAPPED_MARKET_REGISTRY.lookup(1, expected.comet.toUpperCase().replace('0X', '0x'))).toEqual(lookup);
      // ...and by chain: the same address on another chain is not configured.
      expect(WRAPPED_MARKET_REGISTRY.lookup(8453, expected.comet)).toEqual({ status: 'unconfigured' });
    }

    // USDC and institutional USDC share a base token but stay distinct markets.
    const wrappers = new Set(EXPECTED.map(({ wrapper }) => wrapper.toLowerCase()));
    const comets = new Set(EXPECTED.map(({ comet }) => comet.toLowerCase()));
    expect(wrappers.size).toBe(3);
    expect(comets.size).toBe(3);

    // Base tokens agree with the Comet deployment configuration the app is built from.
    expect(USDC.toLowerCase()).toBe(usdcConfiguration.baseTokenAddress.toLowerCase());
    expect(USDT.toLowerCase()).toBe(usdtConfiguration.baseTokenAddress.toLowerCase());

    // Only the three are configured; other Ethereum markets are not.
    const configured = MARKETS.filter(
      (market) =>
        WRAPPED_MARKET_REGISTRY.lookup(market.chainInformation.chainId, market.marketAddress).status !== 'unconfigured',
    );
    expect(configured.map((market) => market.marketAddress)).toEqual(EXPECTED.map(({ comet }) => comet));

    expect(WRAPPED_MARKET_REGISTRY.problems).toEqual([]);
    // The routed markets and the factory are kept in code, apart from the replaceable source.
    expect(WRAPPED_ROUTED_MARKETS).toEqual(EXPECTED.map(({ comet }) => ({ chainId: 1, cometAddress: comet })));
    expect(WRAPPER_FACTORY_BY_CHAIN_ID).toEqual({ 1: '0xf77f675a383eB43fa032ea3c6d1dd4dC56B69BF6' });
    expect(HARDCODED_WRAPPED_LENDING_SOURCE.markets).toHaveLength(3);
  });

  it('normalizes addresses and rejects duplicate, zero, malformed and inconsistent entries', () => {
    // Lowercase input is stored in checksum form and found under any case.
    const normalized = registryOf([
      entry({
        cometAddress: USDC_COMET.toLowerCase(),
        wrapperAddress: EXPECTED[0].wrapper.toLowerCase(),
        baseTokenAddress: USDC.toLowerCase(),
      }),
    ]);
    expect(normalized.lookup(1, USDC_COMET)).toEqual({ status: 'valid', market: entry() });
    expect(normalized.problems).toEqual([]);

    const problemOf = (markets: WrappedMarketSource[], cometAddress = USDC_COMET) => {
      const lookup = registryOf(markets).lookup(1, cometAddress);
      return lookup.status === 'invalid' ? lookup.problem : lookup.status;
    };

    // Zero addresses.
    const zero = '0x0000000000000000000000000000000000000000';
    expect(problemOf([entry({ wrapperAddress: zero })])).toBe('zero-address');
    expect(problemOf([entry({ baseTokenAddress: zero })])).toBe('zero-address');

    // Malformed addresses.
    expect(problemOf([entry({ wrapperAddress: '0x89dd54aB898944BB4cb8a2C403B7D511F88f9E7' })])).toBe(
      'malformed-address',
    );
    expect(problemOf([entry({ wrapperAddress: 'wcUSDCv3' })])).toBe('malformed-address');
    expect(problemOf([entry({ baseTokenAddress: '' })])).toBe('malformed-address');
    expect(problemOf([entry({ wrapperAddress: undefined as unknown as string })])).toBe('malformed-address');

    // Duplicates: the same Comet twice, or one wrapper for two Comets, invalidates every entry involved.
    expect(problemOf([entry(), entry()])).toBe('duplicate');
    expect(problemOf([entry(), entry({ cometAddress: USDC_COMET.toLowerCase() })])).toBe('duplicate');
    const sharedWrapper = [entry(), usdtEntry({ wrapperAddress: EXPECTED[0].wrapper })];
    expect(problemOf(sharedWrapper, USDC_COMET)).toBe('duplicate');
    expect(problemOf(sharedWrapper, USDT_COMET)).toBe('duplicate');
    // A wrapper reused by an entry that is invalid for another reason still invalidates both.
    const sharedWithInvalid = [entry(), usdtEntry({ wrapperAddress: EXPECTED[0].wrapper, baseDecimals: 19 })];
    expect(problemOf(sharedWithInvalid, USDC_COMET)).toBe('duplicate');
    expect(problemOf(sharedWithInvalid, USDT_COMET)).toBe('duplicate');
    // ...and so does one reused by a duplicated Comet.
    expect(problemOf([entry(), usdtEntry(), usdtEntry({ wrapperAddress: EXPECTED[0].wrapper })], USDC_COMET)).toBe(
      'duplicate',
    );
    // An unrelated valid entry is unaffected by another entry's problem.
    expect(problemOf([entry({ wrapperAddress: zero }), usdtEntry()], USDT_COMET)).toBe('valid');

    // Inconsistent entries.
    expect(problemOf([entry({ shareDecimals: 6 })])).toBe('inconsistent');
    expect(problemOf([entry({ baseDecimals: 19 })])).toBe('inconsistent');
    expect(problemOf([entry({ baseDecimals: 1.5 })])).toBe('inconsistent');
    expect(problemOf([entry({ baseDecimals: -1 })])).toBe('inconsistent');
    expect(problemOf([entry({ wrapperAddress: USDC_COMET })])).toBe('inconsistent');
    expect(problemOf([entry({ baseTokenAddress: USDC_COMET })])).toBe('inconsistent');
    expect(problemOf([entry({ baseTokenAddress: EXPECTED[0].wrapper })])).toBe('inconsistent');
    expect(problemOf([entry({ isDepositEnabled: 'yes' as unknown as boolean })])).toBe('inconsistent');
    expect(problemOf([entry({ isExitEnabled: undefined as unknown as boolean })])).toBe('inconsistent');
    // A Comet the frontend does not list on that chain.
    const unknownComet = '0x1111111111111111111111111111111111111111';
    expect(problemOf([entry({ cometAddress: unknownComet })], unknownComet)).toBe('inconsistent');
    expect(registryOf([entry({ chainId: 8453 })]).lookup(8453, USDC_COMET)).toMatchObject({
      status: 'invalid',
      problem: 'inconsistent',
    });
    // The V2 pseudo-market is not a Comet.
    const comptroller = '0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B';
    expect(problemOf([entry({ cometAddress: comptroller })], comptroller)).toBe('inconsistent');

    // A routed market with no mapping is reported missing, not unconfigured.
    const routedOnly = registryOf([], [{ chainId: 1, cometAddress: USDT_COMET }]);
    expect(routedOnly.lookup(1, USDT_COMET)).toMatchObject({ status: 'invalid', problem: 'missing' });
    expect(routedOnly.lookup(1, USDC_COMET)).toEqual({ status: 'unconfigured' });

    // The routed markets default to the ones kept in code, so a source that loses them leaves
    // them missing.
    const empty = buildWrappedMarketRegistry({ markets: [] });
    for (const { comet } of EXPECTED) {
      expect(empty.lookup(1, comet)).toMatchObject({ status: 'invalid', problem: 'missing' });
    }

    // A source with an entry that names no market is not used at all: every market it or the
    // routed list names is invalid, including ones whose own entries are valid.
    const stringChainId = buildWrappedMarketRegistry({
      markets: [entry(), usdtEntry({ chainId: '1' as unknown as number })],
    });
    expect(stringChainId.problems).toHaveLength(1);
    for (const { comet } of EXPECTED) {
      expect(stringChainId.lookup(1, comet)).toMatchObject({ status: 'invalid', problem: 'unreadable-source' });
    }
    const unkeyable = registryOf(
      [entry({ cometAddress: '0xnot-a-comet' })],
      [{ chainId: 1, cometAddress: USDC_COMET }],
    );
    expect(unkeyable.lookup(1, USDC_COMET)).toMatchObject({ status: 'invalid', problem: 'unreadable-source' });
    // A malformed routed identity makes the source unreadable too.
    const badRoute = registryOf([entry()], [{ chainId: 1, cometAddress: 'USDC' }]);
    expect(badRoute.problems).toHaveLength(1);
    expect(badRoute.lookup(1, USDC_COMET)).toMatchObject({ status: 'invalid', problem: 'unreadable-source' });

    // Validation does not mutate the source.
    const source = { markets: [entry({ cometAddress: USDC_COMET.toLowerCase() })] };
    const snapshot = JSON.parse(JSON.stringify(source));
    buildWrappedMarketRegistry(source);
    expect(source).toEqual(snapshot);
  });
});
