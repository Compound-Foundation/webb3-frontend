import { ReactNode } from 'react';

import { MarketsContext, MarketsContextValue } from '@contexts/MarketsContext';
import { convertApiResponse } from '@helpers/functions';
import { MarketListEntry, summaryToMarkets } from '@helpers/marketList';
import { getMarket, getMarketDescriptors, getMarkets, getMarketsByNetwork } from '@helpers/markets';
import { buildMarketStatusIndex, getCollateralStatus, getMarketStatus } from '@helpers/marketStatus';
import { LatestMarketSummaryResponse, MarketData } from '@types';

import mockMarketListResponse from './mockMarketListResponse.json';

export const MOCK_MARKET_LIST = mockMarketListResponse.map(convertApiResponse) as MarketListEntry[];

const marketList = summaryToMarkets(MOCK_MARKET_LIST);

export const MOCK_MARKETS: MarketData[] = marketList.markets;
export const MOCK_DEFAULT_MARKET: MarketData = marketList.defaultMarket;

export const MockMarketsProvider = ({
  children,
  isLoading = false,
  markets = MOCK_MARKETS,
  marketSummaries = [],
}: {
  children: ReactNode;
  isLoading?: boolean;
  markets?: MarketData[];
  // Latest summaries the market and collateral statuses are read from
  marketSummaries?: LatestMarketSummaryResponse[];
}) => {
  const contextMarkets = isLoading ? [] : markets;
  const statusIndex = buildMarketStatusIndex(marketSummaries);
  const helpers = {
    loadFailed: false,
    getMarket: (chainId: number, marketAddress: string) => getMarket(contextMarkets, chainId, marketAddress),
    getMarkets: (showTestnet: boolean) => getMarkets(contextMarkets, showTestnet),
    getMarketsByNetwork: (showTestnet: boolean) => getMarketsByNetwork(contextMarkets, showTestnet),
    getMarketDescriptors: (cometAddress: string, chainId: number) =>
      getMarketDescriptors(contextMarkets, cometAddress, chainId),
    getMarketStatus: (chainId: number, cometAddress: string) => getMarketStatus(statusIndex, chainId, cometAddress),
    getCollateralStatus: (chainId: number, cometAddress: string, collateralAddress: string) =>
      getCollateralStatus(statusIndex, chainId, cometAddress, collateralAddress),
  };

  const value: MarketsContextValue = isLoading
    ? {
        ...helpers,
        isLoading: true,
        markets: contextMarkets,
        defaultMarket: undefined,
      }
    : { ...helpers, isLoading: false, ...marketList, markets };

  return <MarketsContext.Provider value={value}>{children}</MarketsContext.Provider>;
};
