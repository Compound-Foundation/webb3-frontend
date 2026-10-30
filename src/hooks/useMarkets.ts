import { useQuery } from '@tanstack/react-query';
import { getAddress } from 'ethers/lib/utils';

import { CHAINS } from '@constants/chains';
import { iconNameForChainId } from '@helpers/assets';
import { convertApiResponse } from '@helpers/functions';
import { V2_MARKET } from '@helpers/markets';
import { getLatestMarketSummaryEndpoint } from '@helpers/urls';
import { LatestMarketSummaryResponse, MarketData, StateType } from '@types';

type Markets = { markets: MarketData[]; defaultMarket: MarketData; summaries: LatestMarketSummaryResponse[] };

export type MarketsStateLoading = [StateType.Loading, { loadFailed: boolean }];
export type MarketsStateHydrated = [StateType.Hydrated, Markets];
export type MarketsState = MarketsStateLoading | MarketsStateHydrated;

export const LATEST_MARKET_SUMMARY_QUERY_KEY = ['latestMarketSummary'];
const LATEST_MARKET_SUMMARY_REFRESH_INTERVAL = 1000 * 60 * 10; // 10 minutes

// Markets are listed in this order; markets missing from it go last, in summary order
const MARKET_PRIORITY = [
  '1:usdc',
  '1:weth',
  '1:usdt',
  '1:wsteth',
  '1:usds',
  '1:wbtc',
  '1:institutional_usdc',
  '137:usdc',
  '137:usdt',
  '42161:usdc',
  '42161:usdc.e',
  '42161:weth',
  '42161:usdt',
  '10:usdc',
  '10:usdt',
  '10:weth',
  '8453:usdc',
  '8453:usdbc',
  '8453:usds',
  '8453:weth',
  '8453:aero',
  '534352:usdc',
  '5000:usde',
  '59144:usdc',
  '130:usdc',
  '130:weth',
  '2020:weth',
  '2020:wron',
  '59144:weth',
];

const MARKET_OVERRIDES: Record<string, Pick<MarketData, 'isNew' | 'rewardsOverwrite'>> = {
  '1:usdc': {
    rewardsOverwrite: {
      rewardsAssetSymbol: 'COMP',
      supplyCompPerDay: 55n * 10n ** 18n,
      borrowCompPerDay: 55n * 10n ** 18n,
    },
  },
  '1:weth': {
    rewardsOverwrite: {
      rewardsAssetSymbol: 'COMP',
      supplyCompPerDay: 10n * 10n ** 18n,
      borrowCompPerDay: 20n * 10n ** 18n,
    },
  },
  '1:usdt': {
    rewardsOverwrite: {
      rewardsAssetSymbol: 'COMP',
      supplyCompPerDay: 30n * 10n ** 18n,
      borrowCompPerDay: 30n * 10n ** 18n,
    },
  },
  '1:institutional_usdc': { isNew: true },
};

function toMarketData(entry: LatestMarketSummaryResponse): MarketData {
  const { chainId, comet, deploymentKey, displayName, baseAssetName, slug, isInstitutional, status, collaterals } =
    entry;

  const chainInformation = CHAINS[chainId];

  if (chainInformation === undefined) {
    throw new Error(`Unsupported chain ${chainId}`);
  }
  // A field sent as null counts as missing
  if (deploymentKey == null || displayName == null || baseAssetName == null) {
    throw new Error('Market summary has no market list fields');
  }

  return {
    baseAsset: {
      symbol: displayName,
      name: baseAssetName,
      // The ETH market's base asset is WETH, shown unwrapped; its URL key uses the wrapped symbol ('weth-mainnet')
      isWrapped: displayName === 'ETH',
    },
    chainInformation,
    iconPair: [isInstitutional ? 'INSTITUTIONAL' : iconNameForChainId(chainId), displayName],
    marketAddress: getAddress(comet.address),
    bulkerAddress: getAddress(comet.bulker),
    rewardsAddress: getAddress(comet.rewards),
    slug: slug ?? undefined,
    institutional: isInstitutional || false,
    status,
    collaterals,
    ...MARKET_OVERRIDES[`${chainId}:${deploymentKey}`],
    type: 'MarketData',
  };
}

const priorityOf = ({ chainId, deploymentKey }: LatestMarketSummaryResponse) => {
  const index = MARKET_PRIORITY.indexOf(`${chainId}:${deploymentKey}`);

  return index === -1 ? MARKET_PRIORITY.length : index;
};

// Throws when no market is supported, so the query reports an error instead of an empty list
export function summaryToMarkets(summaries: LatestMarketSummaryResponse[]): Markets {
  const listed = [...summaries]
    .sort((a, b) => priorityOf(a) - priorityOf(b))
    .flatMap((entry) => {
      try {
        return [{ entry, market: toMarketData(entry) }];
      } catch (error) {
        console.warn(`Market list: skipping market ${entry.chainId}:${entry.deploymentKey}`, error);
        return [];
      }
    });

  const defaultMarket = (listed.find(({ entry }) => entry.isDefault) ?? listed[0])?.market;

  if (defaultMarket === undefined) {
    throw new Error('Latest market summary has no supported markets');
  }

  return { markets: [...listed.map(({ market }) => market), V2_MARKET], defaultMarket, summaries };
}

async function fetchLatestMarketSummaries(): Promise<LatestMarketSummaryResponse[]> {
  const response = await fetch(getLatestMarketSummaryEndpoint());

  if (!response.ok) {
    throw new Error(`Latest market summary request failed with status ${response.status}`);
  }

  const summaries = await response.json();

  return summaries.map(convertApiResponse) as LatestMarketSummaryResponse[];
}

// The market list and statuses come from the latest summaries, one cache entry for every consumer
export function useMarkets(): MarketsState {
  const { data, isError } = useQuery({
    queryKey: LATEST_MARKET_SUMMARY_QUERY_KEY,
    queryFn: fetchLatestMarketSummaries,
    refetchInterval: LATEST_MARKET_SUMMARY_REFRESH_INTERVAL,
    select: summaryToMarkets,
  });

  if (data === undefined) {
    return [StateType.Loading, { loadFailed: isError }];
  }

  return [StateType.Hydrated, data];
}
