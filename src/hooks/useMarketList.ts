import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { latestMarketSummaryQueryOptions } from '@helpers/latestMarketSummary';
import {
  MARKET_LIST_CACHE_MAX_AGE,
  MARKET_LIST_QUERY_KEY,
  MARKET_LIST_REFRESH_INTERVAL,
  MarketList,
  MarketListEntry,
  summaryToMarkets,
} from '@helpers/marketList';
import { LatestMarketSummaryResponse } from '@types';

const toMarketListEntry = ({
  chainId,
  comet,
  deploymentKey,
  displayName,
  baseAssetName,
  slug,
  isDefault,
  isInstitutional,
}: LatestMarketSummaryResponse): MarketListEntry => ({
  chainId,
  comet,
  deploymentKey,
  displayName,
  baseAssetName,
  slug,
  isDefault,
  isInstitutional,
});

// The list comes from the latest summaries the rest of the app reads: once they are loaded it makes no request of
// its own. It keeps only plain fields: the list is persisted as JSON, and MarketData holds bigints
export async function fetchMarketList(queryClient: QueryClient): Promise<MarketListEntry[]> {
  const summaries = await queryClient.ensureQueryData(latestMarketSummaryQueryOptions);
  const entries = summaries.map(toMarketListEntry);
  // Throws when no market is supported, so an unusable list is fetched again instead of cached
  summaryToMarkets(entries);
  return entries;
}

function selectMarketList(entries: MarketListEntry[]): MarketList {
  try {
    return summaryToMarkets(entries);
  } catch (error) {
    console.warn('Market list: failed to map the list, treating as loading', error);
    throw error;
  }
}

export function useMarketList(): { marketList: MarketList | undefined; loadFailed: boolean } {
  const queryClient = useQueryClient();

  const { data, failureCount, isError } = useQuery({
    queryKey: MARKET_LIST_QUERY_KEY,
    queryFn: () => fetchMarketList(queryClient),
    select: selectMarketList,
    staleTime: MARKET_LIST_REFRESH_INTERVAL,
    refetchInterval: MARKET_LIST_REFRESH_INTERVAL,
    // Must outlive the persisted cache, otherwise the restored list is garbage collected
    gcTime: MARKET_LIST_CACHE_MAX_AGE,
    // Keep retrying in the background; the UI shows skeletons (no data yet) or the cached list
    retry: true,
  });

  return { marketList: data, loadFailed: data === undefined && (isError || failureCount >= 3) };
}
