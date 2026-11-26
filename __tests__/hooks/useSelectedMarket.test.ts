import { marketKey } from '@helpers/markets';
import { parseMarketKeyOrDefault, shortMarketKey } from '@hooks/useSelectedMarket';

import { LEGACY_ADDRESSES } from '../mocks/legacyMarketAddresses';
import { MOCK_DEFAULT_MARKET, MOCK_MARKETS } from '../mocks/mockMarkets';

const MARKETS = MOCK_MARKETS;
const MAINNET_USDC_COMET = LEGACY_ADDRESSES.mainnetUSDC.comet;
const MAINNET_WETH_COMET = LEGACY_ADDRESSES.mainnetWETH.comet;
const MAINNET_INSTITUTIONAL_USDC_COMET = LEGACY_ADDRESSES.mainnetInstitutionalUSDC.comet;

const marketByAddress = (address: string) => {
  const market = MARKETS.find((market) => market.marketAddress.toLowerCase() === address.toLowerCase());
  if (market === undefined) {
    throw new Error(`No market found for address ${address}`);
  }
  return market;
};

describe('shortMarketKey', () => {
  test('uses the base asset symbol by default', () => {
    expect(shortMarketKey(marketByAddress(MAINNET_USDC_COMET))).toEqual('usdc-mainnet');
  });

  test('uses the wrapped asset symbol for wrapped base assets', () => {
    expect(shortMarketKey(marketByAddress(MAINNET_WETH_COMET))).toEqual('weth-mainnet');
  });

  test('uses the slug override when present', () => {
    expect(shortMarketKey(marketByAddress(MAINNET_INSTITUTIONAL_USDC_COMET))).toEqual('usdc-institutional-mainnet');
  });
});

describe('parseMarketKeyOrDefault', () => {
  test('parses a plain shorthand key', () => {
    expect(parseMarketKeyOrDefault(MARKETS, MOCK_DEFAULT_MARKET, 'usdc-mainnet').marketAddress).toEqual(
      MAINNET_USDC_COMET,
    );
  });

  test('parses a slug shorthand key', () => {
    expect(parseMarketKeyOrDefault(MARKETS, MOCK_DEFAULT_MARKET, 'usdc-institutional-mainnet').marketAddress).toEqual(
      MAINNET_INSTITUTIONAL_USDC_COMET,
    );
  });

  test('does not resolve a slugged market from the plain shorthand key', () => {
    expect(parseMarketKeyOrDefault(MARKETS, MOCK_DEFAULT_MARKET, 'usdc-mainnet').marketAddress).not.toEqual(
      MAINNET_INSTITUTIONAL_USDC_COMET,
    );
  });

  test('round-trips every market through its shorthand key', () => {
    for (const market of MARKETS) {
      expect(marketKey(parseMarketKeyOrDefault(MARKETS, MOCK_DEFAULT_MARKET, shortMarketKey(market)))).toEqual(
        marketKey(market),
      );
    }
  });

  test('parses a full market key', () => {
    const fullKey = `1_USDC_${MAINNET_INSTITUTIONAL_USDC_COMET}`;
    expect(parseMarketKeyOrDefault(MARKETS, MOCK_DEFAULT_MARKET, fullKey).marketAddress).toEqual(
      MAINNET_INSTITUTIONAL_USDC_COMET,
    );
  });

  test('falls back to the default market for unknown keys', () => {
    expect(parseMarketKeyOrDefault(MARKETS, MOCK_DEFAULT_MARKET, 'not-a-market')).toEqual(MOCK_DEFAULT_MARKET);
  });

  test('resolves every market from a full key saved before the migration', () => {
    for (const market of MARKETS) {
      const savedKey = `${market.chainInformation.chainId}_${market.baseAsset.symbol}_${market.marketAddress}`;
      expect(parseMarketKeyOrDefault(MARKETS, MOCK_DEFAULT_MARKET, savedKey)).toBe(market);
    }
    expect(
      parseMarketKeyOrDefault(MARKETS, MOCK_DEFAULT_MARKET, `1_USDC_${MAINNET_USDC_COMET}`).marketAddress,
    ).toEqual(MAINNET_USDC_COMET);
  });

  test('falls back to the default market for a market missing from the market list', () => {
    expect(parseMarketKeyOrDefault(MARKETS, MOCK_DEFAULT_MARKET, 'usdc-avax')).toBe(MOCK_DEFAULT_MARKET);
  });
});
