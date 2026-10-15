import { iconNameForChainId } from '@helpers/assets';
import { MARKET_KEY_DELIMITER } from '@helpers/constants';
import { MarketData, MarketDataLoaded, MarketsByNetwork } from '@types';

import { CHAINS } from '../constants/chains';

export const V2_MARKET_KEY = 'Compound V2';

export const V2_MARKET: MarketData = {
  baseAsset: {
    symbol: V2_MARKET_KEY,
    name: V2_MARKET_KEY,
  },
  chainInformation: CHAINS[1],
  iconPair: [iconNameForChainId(1), 'V2'],
  bulkerAddress: '0xFA4E',
  marketAddress: '0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B', // V2 Comptroller address
  type: 'MarketData',
};

export const getMarketDescriptors = (markets: MarketData[], cometAddress: string, chainId: number) => {
  const marketData = getMarket(markets, chainId, cometAddress);

  if (marketData === undefined) {
    return ['UNKNOWN', 'Unknown', 'Unknown'];
  }

  return [marketData.baseAsset.symbol, marketData.chainInformation.name, marketData.baseAsset.name];
};

/**
 * Calculate a unique key for the market in the form of `chainId_baseAssetSymbol_marketAddress`
 * @param market
 * @returns
 */
export function marketKey(market: MarketData | MarketDataLoaded): string {
  return [market.chainInformation.chainId, market.baseAsset.symbol, market.marketAddress].join(MARKET_KEY_DELIMITER);
}

// A market is identified by its chain and comet address. The base asset symbol isn't part of it:
// a loaded market carries the on-chain symbol, which can differ from the market list one (e.g. USDC-cr)
export function areSameMarket(market1: MarketData | MarketDataLoaded, market2: MarketData | MarketDataLoaded): boolean {
  return (
    market1.chainInformation.chainId === market2.chainInformation.chainId &&
    market1.marketAddress.toLowerCase() === market2.marketAddress.toLowerCase()
  );
}

export function isV2Market(market: MarketData | MarketDataLoaded) {
  return areSameMarket(market, V2_MARKET);
}

export function getMarketsByNetwork(markets: MarketData[]): MarketsByNetwork {
  return markets.reduce<MarketsByNetwork>((acc, market: MarketData) => {
    const { chainInformation } = market;
    const networkInfo = acc[chainInformation.chainId] ?? { chainInformation, markets: [] };
    return {
      ...acc,
      [chainInformation.chainId]: {
        ...networkInfo,
        markets: [...networkInfo.markets, market],
      },
    };
  }, {});
}

export function getMarket(markets: MarketData[], chainId: number, marketAddress: string): MarketData | undefined {
  return markets.find(
    (market) =>
      market.chainInformation.chainId === chainId && market.marketAddress.toLowerCase() === marketAddress.toLowerCase()
  );
}
