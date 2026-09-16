import { useQuery } from '@tanstack/react-query';
import { getAddress } from 'ethers/lib/utils';
import { useContext } from 'react';

import RewardsStateContext from '@contexts/RewardsStateContext';
import { isNonStablecoinMarket } from '@helpers/baseAssetPrice';
import { convertApiResponse } from '@helpers/functions';
import { institutionalSupplyRewardRate } from '@helpers/institutionalRates';
import { filterLegacyCollateralSymbols } from '@helpers/legacyCollateral';
import { getMarket, getMarketDescriptors } from '@helpers/markets';
import { BASE_FACTOR, FACTOR_PRECISION, getRewardsAPR, PRICE_PRECISION } from '@helpers/numbers';
import { getHistoricalMarketSummaryEndpoint, getLatestMarketSummaryEndpoint } from '@helpers/urls';
import {
  AggregatedHistoricalSummary,
  MarketOverviewState,
  MarketSummary,
  RewardsState,
  RewardsTokenState,
  StateType
} from '@types';


const LATEST_SUMMARY_REFRESH_INTERVAL = 1000 * 60 * 10; // 10 minutes

export function useMarketsOverviewState(): MarketOverviewState {
  const rewardsState = useContext(RewardsStateContext);

  const query = useQuery({
    queryKey: ['marketOverviewState', rewardsState[0]],
    queryFn: () => getState(rewardsState),
    initialData: [StateType.Loading],
    refetchInterval: LATEST_SUMMARY_REFRESH_INTERVAL,
  });

  return query.data;
}

type MarketSummaryResponse = {
  chainId: number;
  comet: {
    address: string;
  };
  borrowApr: string;
  supplyApr: string;
  totalBorrowValue: string;
  totalSupplyValue: string;
  totalCollateralValue: string;
  utilization: string;
  timestamp: number;
  date: string;
  baseUsdPrice: string;
  collateralAssetSymbols: string[];
};

const getState = async (rewardsState: RewardsState, includeTestnets = false,): Promise<MarketOverviewState> => {
  const [rewardsStateType, rewards] = rewardsState;

  if (rewardsStateType === StateType.Loading) {
    return [StateType.Loading];
  }
  
  const latestMarketSummariesResponse = await fetch(getLatestMarketSummaryEndpoint(includeTestnets));
  const latestMarketSummaries = await latestMarketSummariesResponse.json();

  const sanitizedLatestMarketSummaries: MarketSummary[] = latestMarketSummaries
    .map(convertApiResponse)
    .map((marketSummary: MarketSummaryResponse) => {
      const marketRewards = rewards
        ?.find(([chainId]) => +chainId === +marketSummary.chainId)?.[1]
        ?.rewardsStates.find((state) =>
            state.comet.toLowerCase() === marketSummary.comet.address.toLowerCase()
        );

      return { marketSummary, marketRewards };
    })
    .map(({ marketSummary, marketRewards }: {marketSummary: MarketSummaryResponse, marketRewards: RewardsTokenState}) => {
      return sanitizeMarketSummary(marketSummary, marketRewards);
    });

  const historicalMarketSummariesResponse = await fetch(getHistoricalMarketSummaryEndpoint(includeTestnets));
  const historicalMarketSummaries = await historicalMarketSummariesResponse.json();
  const sanitizedHistoricalMarketSummaries: MarketSummary[] = historicalMarketSummaries
    .map(convertApiResponse)
    .map(sanitizeMarketSummary);

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
 * @param marketSummary
 * @returns
 */
export const sanitizeMarketSummary = (marketSummary: MarketSummaryResponse, marketRewards?: RewardsTokenState): MarketSummary => {
  const baseUsdPrice = BigInt(Math.floor(Number(marketSummary.baseUsdPrice) * 10 ** PRICE_PRECISION));
  const borrowAPR = BigInt(Math.floor(Number(marketSummary.borrowApr) * 10 ** FACTOR_PRECISION));
  const supplyAPR = BigInt(Math.floor(Number(marketSummary.supplyApr) * 10 ** FACTOR_PRECISION));

  // Comet prices non-native markets in USD terms already. Thus, the API returns
  // USD values already for non-native markets. For the native token markets,
  // we need to convert the values to USD.
  const [baseAsset] = getMarketDescriptors(marketSummary.comet.address, marketSummary.chainId);
  const isNativeAssetMarket = isNonStablecoinMarket(baseAsset);
  const usdPrice = isNativeAssetMarket ? baseUsdPrice : BigInt(10 ** PRICE_PRECISION);

  const totalBorrowValue = BigInt(Math.floor(Number(marketSummary.totalBorrowValue) * 10 ** FACTOR_PRECISION));
  const totalBorrowValueInDollars = (totalBorrowValue * usdPrice) / BASE_FACTOR;

  const totalSupplyValue = BigInt(Math.floor(Number(marketSummary.totalSupplyValue) * 10 ** FACTOR_PRECISION));
  const totalSupplyValueInDollars = (totalSupplyValue * usdPrice) / BASE_FACTOR;

  const totalCollateralValue = BigInt(Math.floor(Number(marketSummary.totalCollateralValue) * 10 ** FACTOR_PRECISION));
  const totalCollateralValueInDollars = (totalCollateralValue * usdPrice) / BASE_FACTOR;

  const utilization = BigInt(marketSummary.utilization);

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
    ...((() => {
      const market = getMarket(marketSummary.chainId, marketSummary.comet.address);

      if (market?.rewardsOverwrite) {
        const rewardsAssetPrice = marketRewards?.rewardAsset?.price ?? 0n;

        return {
          borrowRewardsAPR:
            market.rewardsOverwrite.borrowRewardsAPR ??
            (() =>
              getRewardsAPR(
                market.rewardsOverwrite.borrowCompPerDay,
                rewardsAssetPrice,
                totalBorrowValueInDollars,
              ))(),
          supplyRewardsAPR:
            market.rewardsOverwrite.supplyRewardsAPR ??
            (() =>
              getRewardsAPR(
                market.rewardsOverwrite.supplyCompPerDay,
                rewardsAssetPrice,
                totalSupplyValueInDollars
              ))(),
          rewardsAssetSymbol: market.rewardsOverwrite.rewardsAssetSymbol
        };
      }

      if (market?.institutional) {
        return {
          borrowRewardsAPR: 0n,
          supplyRewardsAPR: institutionalSupplyRewardRate(totalSupplyValueInDollars),
          isInstitutional: true
        };
      }

      return {
        borrowRewardsAPR: 0n,
        supplyRewardsAPR: 0n,
      };
    })())
  };
};
