import mainnetInstitutionalUSDCRoots from 'comet/deployments/mainnet/institutional_usdc/roots.json';
import mainnetUSDCRoots from 'comet/deployments/mainnet/usdc/roots.json';
import mainnetWETHRoots from 'comet/deployments/mainnet/weth/roots.json';

import { DEFAULT_MARKET, getMarkets, marketKey } from '@helpers/markets';
import { parseMarketKeyOrDefault, shortMarketKey } from '@hooks/useSelectedMarket';

const MARKETS = getMarkets(true);

const marketByAddress = (address: string) => {
  const market = MARKETS.find((market) => market.marketAddress.toLowerCase() === address.toLowerCase());
  if (market === undefined) {
    throw new Error(`No market found for address ${address}`);
  }
  return market;
};

describe('shortMarketKey', () => {
  test('uses the base asset symbol by default', () => {
    expect(shortMarketKey(marketByAddress(mainnetUSDCRoots['comet']))).toEqual('usdc-mainnet');
  });

  test('uses the wrapped asset symbol for wrapped base assets', () => {
    expect(shortMarketKey(marketByAddress(mainnetWETHRoots['comet']))).toEqual('weth-mainnet');
  });

  test('uses the slug override when present', () => {
    expect(shortMarketKey(marketByAddress(mainnetInstitutionalUSDCRoots['comet']))).toEqual(
      'usdc-institutional-mainnet',
    );
  });
});

describe('parseMarketKeyOrDefault', () => {
  test('parses a plain shorthand key', () => {
    expect(parseMarketKeyOrDefault(MARKETS, DEFAULT_MARKET, 'usdc-mainnet').marketAddress).toEqual(
      mainnetUSDCRoots['comet'],
    );
  });

  test('parses a slug shorthand key', () => {
    expect(parseMarketKeyOrDefault(MARKETS, DEFAULT_MARKET, 'usdc-institutional-mainnet').marketAddress).toEqual(
      mainnetInstitutionalUSDCRoots['comet'],
    );
  });

  test('does not resolve a slugged market from the plain shorthand key', () => {
    expect(parseMarketKeyOrDefault(MARKETS, DEFAULT_MARKET, 'usdc-mainnet').marketAddress).not.toEqual(
      mainnetInstitutionalUSDCRoots['comet'],
    );
  });

  test('round-trips every market through its shorthand key', () => {
    for (const market of MARKETS) {
      expect(marketKey(parseMarketKeyOrDefault(MARKETS, DEFAULT_MARKET, shortMarketKey(market)))).toEqual(
        marketKey(market),
      );
    }
  });

  test('parses a full market key', () => {
    const fullKey = `1_USDC_${mainnetInstitutionalUSDCRoots['comet']}`;
    expect(parseMarketKeyOrDefault(MARKETS, DEFAULT_MARKET, fullKey).marketAddress).toEqual(
      mainnetInstitutionalUSDCRoots['comet'],
    );
  });

  test('falls back to the default market for unknown keys', () => {
    expect(parseMarketKeyOrDefault(MARKETS, DEFAULT_MARKET, 'not-a-market')).toEqual(DEFAULT_MARKET);
  });
});
