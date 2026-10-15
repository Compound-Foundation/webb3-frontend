import { useQuery } from '@tanstack/react-query';
import { createContext, ReactNode, useContext, useMemo } from 'react';

import { latestMarketSummaryQueryOptions } from '@helpers/latestMarketSummary';
import { MarketList } from '@helpers/marketList';
import { getMarket, getMarketDescriptors, getMarkets, getMarketsByNetwork } from '@helpers/markets';
import { buildMarketStatusIndex, getCollateralStatus, getMarketStatus } from '@helpers/marketStatus';
import { useMarketList } from '@hooks/useMarketList';
import { CollateralStatus, MarketData, MarketsByNetwork, MarketStatus } from '@types';

type MarketsProviderProps = {
  children: ReactNode;
};

type MarketsHelpers = {
  getMarket: (chainId: number, marketAddress: string) => MarketData | undefined;
  getMarkets: (showTestnet: boolean) => MarketData[];
  getMarketsByNetwork: (showTestnet: boolean) => MarketsByNetwork;
  getMarketDescriptors: (cometAddress: string, chainId: number) => string[];
  // Statuses come from the latest market summary; undefined until it loads or when it fails
  getMarketStatus: (chainId: number, cometAddress: string) => MarketStatus | undefined;
  getCollateralStatus: (chainId: number, cometAddress: string, collateralAddress: string) => CollateralStatus | undefined;
};

type MarketsLoading = Omit<MarketList, 'defaultMarket'> & {
  isLoading: true;
  defaultMarket: undefined;
};

type MarketsLoaded = MarketList & {
  isLoading: false;
};

type MarketsState = MarketsLoading | MarketsLoaded;

export type MarketsContextValue = MarketsState & MarketsHelpers & { loadFailed: boolean };

export const MarketsContext = createContext<MarketsContextValue | undefined>(undefined);

export const MarketsProvider = (props: MarketsProviderProps) => {
  const { children } = props;

  const { marketList: data, loadFailed } = useMarketList();

  const { data: statusIndex } = useQuery({ ...latestMarketSummaryQueryOptions, select: buildMarketStatusIndex });

  const value = useMemo((): MarketsContextValue => {
    const markets = data?.markets ?? [];

    const helpers: MarketsHelpers & { loadFailed: boolean } = {
      loadFailed,
      getMarket: (chainId, marketAddress) => getMarket(markets, chainId, marketAddress),
      getMarkets: (showTestnet) => getMarkets(markets, showTestnet),
      getMarketsByNetwork: (showTestnet) => getMarketsByNetwork(markets, showTestnet),
      getMarketDescriptors: (cometAddress, chainId) => getMarketDescriptors(markets, cometAddress, chainId),
      getMarketStatus: (chainId, cometAddress) =>
        statusIndex && getMarketStatus(statusIndex, chainId, cometAddress),
      getCollateralStatus: (chainId, cometAddress, collateralAddress) =>
        statusIndex && getCollateralStatus(statusIndex, chainId, cometAddress, collateralAddress),
    };

    return data === undefined
      ? { ...helpers, isLoading: true, markets, defaultMarket: undefined }
      : { ...helpers, isLoading: false, ...data };
  }, [data, loadFailed, statusIndex]);

  return (
    <MarketsContext.Provider value={value}>
      {children}
    </MarketsContext.Provider>
  )
};

export function useMarketsContext() {
  const context = useContext(MarketsContext);
  if (!context) throw new Error('MarketsContext not found');
  return context;
}
