import { keepPreviousData, QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { getAddress } from 'ethers/lib/utils';
import { useContext } from 'react';

import { useMarketsContext } from '@contexts/MarketsContext';
import RewardsStateContext from '@contexts/RewardsStateContext';
import { isNonStablecoinMarket } from '@helpers/baseAssetPrice';
import { convertApiResponse } from '@helpers/functions';
import { latestMarketSummaryQueryOptions, LATEST_MARKET_SUMMARY_REFRESH_INTERVAL } from '@helpers/latestMarketSummary';
import { filterLegacyCollateralSymbols } from '@helpers/legacyCollateral';
import { getMarket, getMarketDescriptors } from '@helpers/markets';
import { BASE_FACTOR, FACTOR_PRECISION, PRICE_PRECISION } from '@helpers/numbers';
import { getMarketRewardsAPRs } from '@helpers/rewards';
import { getHistoricalMarketSummaryEndpoint } from '@helpers/urls';
import {
  AggregatedHistoricalSummary,
  LatestMarketSummaryResponse,
  MarketData,
  MarketOverviewState,
  MarketSummary,
  RewardsState,
  StateType,
} from '@types';

export function useMarketsOverviewState(): MarketOverviewState {
  const { isLoading: marketsLoading, markets, registryVersionId } = useMarketsContext();
  const rewardsState = useContext(RewardsStateContext);
  const queryClient = useQueryClient();

  const query = useQuery({
    // A new registry version re-derives the summaries from the new market list
    queryKey: ['marketOverviewState', registryVersionId, rewardsState[0]],
    queryFn: () => getState(queryClient, markets, rewardsState),
    // Keep showing the summaries fetched before rewards loaded while the query refetches with them
    placeholderData: keepPreviousData,
    refetchInterval: LATEST_MARKET_SUMMARY_REFRESH_INTERVAL,
    enabled: !marketsLoading,
  });

  return query.data ?? [StateType.Loading];
}

const getState = async (
  queryClient: QueryClient,
  markets: MarketData[],
  rewardsState: RewardsState,
  includeTestnets = false
): Promise<MarketOverviewState> => {
  // Same cache entry as MarketsContext's statuses, so the page makes one request for the latest summaries
  const latestMarketSummaries = await queryClient.fetchQuery(latestMarketSummaryQueryOptions);

  const sanitizedLatestMarketSummaries: MarketSummary[] = latestMarketSummaries.map((marketSummary) =>
    sanitizeMarketSummary(markets, marketSummary, rewardsState)
  );

  const historicalMarketSummariesResponse = await fetch(getHistoricalMarketSummaryEndpoint(includeTestnets));
  const historicalMarketSummaries = await historicalMarketSummariesResponse.json();
  const sanitizedHistoricalMarketSummaries: MarketSummary[] = historicalMarketSummaries
    .map(convertApiResponse)
    .map((marketSummary: LatestMarketSummaryResponse) => sanitizeMarketSummary(markets, marketSummary));

  // Aggregate historical summaries by date
  const aggregatedHistoricalSummaries = sanitizedHistoricalMarketSummaries.reduce<AggregatedHistoricalSummary[]>(
    (acc, marketSummary) => {
      const existingSummary = acc.find((summary) => summary.date === marketSummary.date);

      if (existingSummary) {
        existingSummary.totalBorrowValue += marketSummary.totalBorrowValue;
        existingSummary.totalSupplyValue += marketSummary.totalSupplyValue;
        existingSummary.totalCollateralValue += marketSummary.totalCollateralValue;
      } else {
        acc.push({
          date: marketSummary.date,
          totalBorrowValue: marketSummary.totalBorrowValue,
          totalSupplyValue: marketSummary.totalSupplyValue,
          totalCollateralValue: marketSummary.totalCollateralValue,
        });
      }

      return acc;
    },
    []
  );

  return [
    StateType.Hydrated,
    { latestMarketSummaries: sanitizedLatestMarketSummaries, historicalMarketSummaries: aggregatedHistoricalSummaries },
  ];
};

/**
 * Sanitize the values we get back from the API to a form that is more consistent
 * with the rest of the app.
 * 1. Convert all numbers to BigInts (except timestamp)
 * 2. Use USD values of each asset amount field with a base of PRICE_SCALE
 *
 * @param markets
 * @param marketSummary
 * @param marketRewards
 * @returns
 */
export const sanitizeMarketSummary = (
  markets: MarketData[],
  marketSummary: LatestMarketSummaryResponse,
  marketRewards?: RewardsState
): MarketSummary => {
  const baseUsdPrice = BigInt(Math.floor(Number(marketSummary.baseUsdPrice ?? 0) * 10 ** PRICE_PRECISION));
  const borrowAPR = BigInt(Math.floor(Number(marketSummary.borrowApr ?? 0) * 10 ** FACTOR_PRECISION));
  const supplyAPR = BigInt(Math.floor(Number(marketSummary.supplyApr ?? 0) * 10 ** FACTOR_PRECISION));

  // Comet prices non-native markets in USD terms already. Thus, the API returns
  // USD values already for non-native markets. For the native token markets,
  // we need to convert the values to USD.
  const [baseAsset] = getMarketDescriptors(markets, marketSummary.comet.address, marketSummary.chainId);
  const isNativeAssetMarket = isNonStablecoinMarket(baseAsset);
  const usdPrice = isNativeAssetMarket ? baseUsdPrice : BigInt(10 ** PRICE_PRECISION);

  const totalBorrowValue = BigInt(Math.floor(Number(marketSummary.totalBorrowValue ?? 0) * 10 ** FACTOR_PRECISION));
  const totalBorrowValueInDollars = (totalBorrowValue * usdPrice) / BASE_FACTOR;

  const totalSupplyValue = BigInt(Math.floor(Number(marketSummary.totalSupplyValue ?? 0) * 10 ** FACTOR_PRECISION));
  const totalSupplyValueInDollars = (totalSupplyValue * usdPrice) / BASE_FACTOR;

  const totalCollateralValue = BigInt(Math.floor(Number(marketSummary.totalCollateralValue ?? 0) * 10 ** FACTOR_PRECISION));
  const totalCollateralValueInDollars = (totalCollateralValue * usdPrice) / BASE_FACTOR;

  const utilization = BigInt(marketSummary.utilization ?? 0);

  const market = getMarket(markets, marketSummary.chainId, marketSummary.comet.address);

  return {
    chainId: marketSummary.chainId,
    comet: {
      address: getAddress(marketSummary.comet.address),
    },
    totalBorrowValue: totalBorrowValueInDollars,
    totalSupplyValue: totalSupplyValueInDollars,
    totalCollateralValue: totalCollateralValueInDollars,
    utilization: utilization,
    timestamp: marketSummary.timestamp,
    date: marketSummary.date,
    collateralAssetSymbols: filterLegacyCollateralSymbols(
      marketSummary.chainId,
      baseAsset,
      marketSummary.collateralAssetSymbols ?? []
    ),
    borrowAPR: borrowAPR,
    supplyAPR: supplyAPR,
    status: marketSummary.status,
    errorCollateralSymbols: (marketSummary.collaterals ?? [])
      .filter((collateral) => collateral.status === 'error')
      .map((collateral) => collateral.symbol),
    ...((() => {
      if (!market || !marketRewards) {
        return {
          borrowRewardsAPR: 0n,
          supplyRewardsAPR: 0n,
        };
      }

      return getMarketRewardsAPRs(
        market,
        marketRewards,
        totalSupplyValueInDollars,
        totalBorrowValueInDollars
      );
    })()),
    isRewardsLoading: !!market?.rewardsOverwrite && marketRewards?.[0] === StateType.Loading,
  };
};
