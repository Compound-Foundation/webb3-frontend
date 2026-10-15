import { useQuery } from '@tanstack/react-query';

import { convertApiResponse } from '@helpers/functions';
import { MarketList, summaryToMarkets } from '@helpers/marketList';
import { getLatestMarketSummaryEndpoint } from '@helpers/urls';
import { LatestMarketSummaryResponse, StateType } from '@types';

export type MarketsStateLoading = [StateType.Loading, { loadFailed: boolean }];
export type MarketsStateHydrated = [StateType.Hydrated, MarketList & { summaries: LatestMarketSummaryResponse[] }];
export type MarketsState = MarketsStateLoading | MarketsStateHydrated;

export const LATEST_MARKET_SUMMARY_QUERY_KEY = ['latestMarketSummary'];
const LATEST_MARKET_SUMMARY_REFRESH_INTERVAL = 1000 * 60 * 10; // 10 minutes

async function fetchLatestMarketSummaries(): Promise<LatestMarketSummaryResponse[]> {
  const response = await fetch(getLatestMarketSummaryEndpoint());
  if (!response.ok) {
    throw new Error(`Latest market summary request failed with status ${response.status}`);
  }
  const summaries = await response.json();
  return summaries.map(convertApiResponse) as LatestMarketSummaryResponse[];
}

// Throws when no market is supported, so the query reports an error instead of an empty list
function selectMarkets(summaries: LatestMarketSummaryResponse[]): MarketsStateHydrated[1] {
  return { ...summaryToMarkets(summaries), summaries };
}

// The market list and statuses come from the latest summaries, one cache entry for every consumer
export function useMarkets(): MarketsState {
  const { data, isError } = useQuery({
    queryKey: LATEST_MARKET_SUMMARY_QUERY_KEY,
    queryFn: fetchLatestMarketSummaries,
    refetchInterval: LATEST_MARKET_SUMMARY_REFRESH_INTERVAL,
    select: selectMarkets,
  });

  if (data === undefined) {
    return [StateType.Loading, { loadFailed: isError }];
  }

  return [StateType.Hydrated, data];
}
