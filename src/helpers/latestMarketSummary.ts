import { queryOptions } from '@tanstack/react-query';

import { convertApiResponse } from '@helpers/functions';
import { getLatestMarketSummaryEndpoint } from '@helpers/urls';
import { LatestMarketSummaryResponse } from '@types';

export const LATEST_MARKET_SUMMARY_REFRESH_INTERVAL = 1000 * 60 * 10; // 10 minutes

async function fetchLatestMarketSummaries(): Promise<LatestMarketSummaryResponse[]> {
  const response = await fetch(getLatestMarketSummaryEndpoint());
  if (!response.ok) {
    throw new Error(`Latest market summary request failed with status ${response.status}`);
  }
  const summaries = await response.json();
  return summaries.map(convertApiResponse) as LatestMarketSummaryResponse[];
}

// One cache entry for every consumer of the latest summaries, so the app makes a single request.
export const latestMarketSummaryQueryOptions = queryOptions({
  queryKey: ['latestMarketSummary'],
  queryFn: fetchLatestMarketSummaries,
  refetchInterval: LATEST_MARKET_SUMMARY_REFRESH_INTERVAL,
});
