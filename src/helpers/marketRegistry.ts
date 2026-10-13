import type { Query } from '@tanstack/react-query';
import { getAddress, isAddress } from 'ethers/lib/utils';

import { CHAINS } from '@constants/chains';
import { iconNameForChainId } from '@helpers/assets';
import { V2_MARKET } from '@helpers/markets';
import { getMarketRegistryEndpoint } from '@helpers/urls';
import { ChainInformation, MarketData } from '@types';

export type RegistryMarket = {
  deploymentKey: string;
  displayName: string;
  slug: string | null;
  isDefault: boolean;
  isInstitutional: boolean;
  contracts: {
    comet: string;
    bulker: string | null;
    rewards: string | null;
    fauceteer: string | null;
  };
  baseAsset: {
    displayName: string;
  };
};

export type RegistryNetwork = {
  chainId: number;
  markets: RegistryMarket[];
};

export type MarketRegistryResponse = {
  schemaVersion: number;
  registryVersion: { id: string };
  networks: RegistryNetwork[];
};

export const MARKET_REGISTRY_SCHEMA_VERSION = 1;

export const MARKET_REGISTRY_QUERY_KEY = ['marketRegistry'] as const;
export const MARKET_REGISTRY_REFRESH_INTERVAL = 1000 * 60 * 10; // 10 minutes
export const MARKET_REGISTRY_CACHE_MAX_AGE = 1000 * 60 * 60 * 24 * 7; // 7 days
// Bump when the persisted response shape changes so stale caches are dropped
export const MARKET_REGISTRY_CACHE_BUSTER = 'market-registry-v1';

// Only the market registry is persisted to localStorage
export function shouldPersistQuery(query: Query): boolean {
  return query.queryKey[0] === MARKET_REGISTRY_QUERY_KEY[0] && query.state.status === 'success';
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

function toMarketData(chainId: number, chainInformation: ChainInformation, market: RegistryMarket): MarketData {
  const { contracts } = market;
  return {
    baseAsset: {
      symbol: market.displayName,
      name: market.baseAsset.displayName,
      // The ETH market's base asset is WETH, shown unwrapped; its URL key uses the wrapped symbol ('weth-mainnet')
      isWrapped: market.displayName === 'ETH',
    },
    chainInformation,
    iconPair: [market.isInstitutional ? 'INSTITUTIONAL' : iconNameForChainId(chainId), market.displayName],
    marketAddress: getAddress(contracts.comet),
    bulkerAddress: contracts.bulker ? getAddress(contracts.bulker) : undefined,
    rewardsAddress: contracts.rewards ? getAddress(contracts.rewards) : undefined,
    fauceteerAddress: contracts.fauceteer ? getAddress(contracts.fauceteer) : undefined,
    slug: market.slug ?? undefined,
    institutional: market.isInstitutional || undefined,
    ...MARKET_OVERRIDES[`${chainId}:${market.deploymentKey}`],
    type: 'MarketData',
  };
}

export type RegistryMarkets = {
  markets: MarketData[];
  defaultMarket: MarketData;
  registryVersionId: string;
};

const MARKET_PRIORITY_INDEX = new Map(MARKET_PRIORITY.map((id, index) => [id, index]));

type CollectedMarkets = {
  entries: { priority: number; market: MarketData }[];
  registryDefaultMarket?: MarketData;
};

function collectRegistryMarkets(response: MarketRegistryResponse): CollectedMarkets {
  const collected: CollectedMarkets = { entries: [] };

  for (const network of response.networks) {
    const chainInformation = CHAINS[network.chainId];

    if (chainInformation === undefined) {
      console.warn(`Market registry: skipping markets on unsupported chain ${network.chainId}`);
      continue;
    }

    for (const market of network.markets) {
      const id = `${network.chainId}:${market.deploymentKey}`;

      const { comet, bulker, rewards, fauceteer } = market.contracts;

      if (![comet, bulker, rewards, fauceteer].every((address) => address === null || isAddress(address))) {
        console.warn(`Market registry: skipping market ${id} (invalid address)`);
        continue;
      }

      const marketData = toMarketData(network.chainId, chainInformation, market);

      // Markets missing from the priority list go after the listed ones, in registry order
      collected.entries.push({ priority: MARKET_PRIORITY_INDEX.get(id) ?? MARKET_PRIORITY.length, market: marketData });

      if (market.isDefault) collected.registryDefaultMarket ??= marketData;
    }
  }

  return collected;
}

export function registryToMarkets(response: MarketRegistryResponse): RegistryMarkets {
  const { entries, registryDefaultMarket } = collectRegistryMarkets(response);

  entries.sort((a, b) => a.priority - b.priority);

  // Without a registry default the first market in selector order is used
  const defaultMarket = registryDefaultMarket ?? entries[0]?.market;

  if (defaultMarket === undefined) {
    throw new Error('Market registry response has no supported markets');
  }

  return {
    // This is a faux supported market for Compound V2 and points to comptroller address
    markets: [...entries.map((entry) => entry.market), V2_MARKET],
    defaultMarket,
    registryVersionId: response.registryVersion.id,
  };
}

export function validateMarketRegistry(json: unknown): MarketRegistryResponse {
  const response = json as Partial<MarketRegistryResponse> | null;
  if (response?.schemaVersion !== MARKET_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`Unsupported market registry schema version: ${response?.schemaVersion}`);
  }
  if (!Array.isArray(response.networks)) {
    throw new Error('Market registry response has no networks');
  }

  const registry = response as MarketRegistryResponse;
  // Throws when the response has no supported markets
  registryToMarkets(registry);
  return registry;
}

export async function fetchMarketRegistry(): Promise<MarketRegistryResponse> {
  const response = await fetch(getMarketRegistryEndpoint());
  if (!response.ok) {
    throw new Error(`Market registry request failed with status ${response.status}`);
  }
  return validateMarketRegistry(await response.json());
}
