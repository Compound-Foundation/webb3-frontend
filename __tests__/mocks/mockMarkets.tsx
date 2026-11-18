import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode, useState } from 'react';

import { convertApiResponse } from '@helpers/functions';
import { LATEST_MARKET_SUMMARY_QUERY_KEY, summaryToMarkets } from '@hooks/useMarkets';
import { LatestMarketSummaryResponse, MarketData } from '@types';

import mockMarketListResponse from './mockMarketListResponse.json';

export const MOCK_MARKET_LIST = mockMarketListResponse.map(convertApiResponse) as LatestMarketSummaryResponse[];

const marketList = summaryToMarkets(MOCK_MARKET_LIST);

export const MOCK_MARKETS: MarketData[] = marketList.markets;
export const MOCK_DEFAULT_MARKET: MarketData = marketList.defaultMarket;

const isSameSummary = (a: LatestMarketSummaryResponse, b: LatestMarketSummaryResponse) =>
  a.chainId === b.chainId && a.comet.address.toLowerCase() === b.comet.address.toLowerCase();

// Serves the mock market list as the latest summaries useMarkets reads, without requesting them
export const MockMarketsProvider = ({
  children,
  isLoading = false,
  marketSummaries = [],
}: {
  children: ReactNode;
  isLoading?: boolean;
  // Latest summaries the market and collateral statuses are read from
  marketSummaries?: LatestMarketSummaryResponse[];
}) => {
  const [queryClient] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Without cached summaries the market list stays loading
    client.setQueryDefaults(LATEST_MARKET_SUMMARY_QUERY_KEY, { enabled: false });
    if (!isLoading) {
      client.setQueryData(
        LATEST_MARKET_SUMMARY_QUERY_KEY,
        MOCK_MARKET_LIST.map((entry) => {
          const summary = marketSummaries.find((summary) => isSameSummary(summary, entry));
          return summary ? { ...entry, status: summary.status, collaterals: summary.collaterals } : entry;
        })
      );
    }
    return client;
  });

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
};
