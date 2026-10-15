import type { Query } from '@tanstack/react-query';
import { getAddress } from 'ethers/lib/utils';

import { CHAINS } from '@constants/chains';
import { iconNameForChainId } from '@helpers/assets';
import { V2_MARKET } from '@helpers/markets';
import { LatestMarketSummaryResponse, MarketData } from '@types';

export type MarketListEntry = Pick<
  LatestMarketSummaryResponse,
  'chainId' | 'comet' | 'deploymentKey' | 'displayName' | 'baseAssetName' | 'slug' | 'isDefault' | 'isInstitutional'
>;

export type MarketList = {
  markets: MarketData[];
  defaultMarket: MarketData;
};

export const MARKET_LIST_QUERY_KEY = ['marketList'] as const;
// The list holds only names and addresses, which rarely change
export const MARKET_LIST_REFRESH_INTERVAL = 1000 * 60 * 10; // 10 minutes
export const MARKET_LIST_CACHE_MAX_AGE = 1000 * 60 * 60 * 24; // 24 hours
// Bump when the persisted market list shape changes so stale caches are dropped
export const MARKET_LIST_CACHE_BUSTER = 'market-list-v1';

// Only the market list is persisted to localStorage
export function shouldPersistQuery(query: Query): boolean {
  return query.queryKey[0] === MARKET_LIST_QUERY_KEY[0] && query.state.status === 'success';
}

export const MARKET_PRIORITY = [
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

export const MARKET_OVERRIDES: Record<string, Pick<MarketData, 'isNew' | 'rewardsOverwrite'>> = {
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

function toMarketData(entry: MarketListEntry): MarketData {
  const { chainId, comet, deploymentKey, displayName, baseAssetName, slug, isInstitutional } = entry;
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
    bulkerAddress: comet.bulker ? getAddress(comet.bulker) : undefined,
    rewardsAddress: comet.rewards ? getAddress(comet.rewards) : undefined,
    slug: slug ?? undefined,
    institutional: isInstitutional || undefined,
    ...MARKET_OVERRIDES[`${chainId}:${deploymentKey}`],
    type: 'MarketData',
  };
}

const MARKET_PRIORITY_INDEX = new Map(MARKET_PRIORITY.map((id, index) => [id, index]));

// Markets missing from the priority list go after the listed ones, in summary order (sort is stable)
const priorityOf = ({ chainId, deploymentKey }: MarketListEntry) => {
  return MARKET_PRIORITY_INDEX.get(`${chainId}:${deploymentKey}`) ?? MARKET_PRIORITY.length;
}

export function summaryToMarkets(entries: MarketListEntry[]): MarketList {
  const listed = [...entries]
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

  return { markets: [...listed.map(({ market }) => market), V2_MARKET], defaultMarket };
}
