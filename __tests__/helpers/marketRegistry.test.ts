import { CHAINS } from '@constants/chains';
import { MarketRegistryResponse, registryToMarkets, validateMarketRegistry } from '@helpers/marketRegistry';
import { isV2Market, marketKey, V2_MARKET } from '@helpers/markets';
import { shortMarketKey } from '@hooks/useSelectedMarket';
import { extensions } from '@pages/extensions/helpers/core';
import { getOperator } from '@pages/extensions/helpers/list';
import { MarketData } from '@types';

import { LEGACY_ADDRESSES } from '../mocks/legacyMarketAddresses';
import mockMarketRegistryResponse from '../mocks/mockMarketRegistryResponse.json';

const registry = mockMarketRegistryResponse as MarketRegistryResponse;
const { markets, defaultMarket } = registryToMarkets(registry);

// The market list as it was defined before the migration to the market registry, in the same order.
const LEGACY_MARKETS: [number, string, string, { comet: string; bulker: string; rewards: string }][] = [
  [1, 'USDC', 'USD Coin', LEGACY_ADDRESSES.mainnetUSDC],
  [1, 'ETH', 'Ether', LEGACY_ADDRESSES.mainnetWETH],
  [1, 'USDT', 'Tether', LEGACY_ADDRESSES.mainnetUSDT],
  [1, 'wstETH', 'Lido Wrapped Staked ETH', LEGACY_ADDRESSES.mainnetWSTETH],
  [1, 'USDS', 'USDS', LEGACY_ADDRESSES.mainnetUSDS],
  [1, 'WBTC', 'Wrapped BTC', LEGACY_ADDRESSES.mainnetWBTC],
  [1, 'USDC', 'USDC Institutional', LEGACY_ADDRESSES.mainnetInstitutionalUSDC],
  [137, 'USDC.e', 'USD Coin (Bridged)', LEGACY_ADDRESSES.polygonUSDC],
  [137, 'USDT0', 'Tether', LEGACY_ADDRESSES.polygonUSDT],
  [42161, 'USDC', 'USD Coin', LEGACY_ADDRESSES.arbitrumNativeUSDC],
  [42161, 'USDC.e', 'USD Coin (Bridged)', LEGACY_ADDRESSES.arbitrumBridgedUSDC],
  [42161, 'ETH', 'Ether', LEGACY_ADDRESSES.arbitrumWETH],
  [42161, 'USD₮0', 'Tether', LEGACY_ADDRESSES.arbitrumUSDT],
  [10, 'USDC', 'USD Coin', LEGACY_ADDRESSES.optimismUSDC],
  [10, 'USDT', 'Tether', LEGACY_ADDRESSES.optimismUSDT],
  [10, 'ETH', 'Ether', LEGACY_ADDRESSES.optimismWETH],
  [8453, 'USDC', 'USD Coin', LEGACY_ADDRESSES.baseMainnetUSDC],
  [8453, 'USDbC', 'USD Coin (Bridged)', LEGACY_ADDRESSES.baseMainnetUSDbC],
  [8453, 'USDS', 'USDS', LEGACY_ADDRESSES.baseMainnetUSDS],
  [8453, 'ETH', 'Ether', LEGACY_ADDRESSES.baseMainnetWETH],
  [8453, 'AERO', 'Aero', LEGACY_ADDRESSES.baseMainnetAERO],
  [534352, 'USDC', 'USD Coin', LEGACY_ADDRESSES.scrollUSDC],
  [5000, 'USDe', 'Ethena USDe', LEGACY_ADDRESSES.mantleUSDE],
  [59144, 'USDC', 'USD Coin', LEGACY_ADDRESSES.lineaMainnetUSDC],
  [130, 'USDC', 'USD Coin', LEGACY_ADDRESSES.unichainUSDC],
  [130, 'ETH', 'Ether', LEGACY_ADDRESSES.unichainWETH],
  [2020, 'WETH', 'Wrapped Ether', LEGACY_ADDRESSES.roninWETH],
  [2020, 'RON', 'Ronin', LEGACY_ADDRESSES.roninWRON],
  [59144, 'ETH', 'Ether', LEGACY_ADDRESSES.lineaWETH],
];

const LEGACY_SHORT_KEYS = [
  'usdc-mainnet', 'weth-mainnet', 'usdt-mainnet', 'wsteth-mainnet', 'usds-mainnet', 'wbtc-mainnet',
  'usdc-institutional-mainnet', 'usdc.e-polygon', 'usdt0-polygon', 'usdc-arb', 'usdc.e-arb', 'weth-arb',
  'usd₮0-arb', 'usdc-op', 'usdt-op', 'weth-op', 'usdc-basemainnet', 'usdbc-basemainnet', 'usds-basemainnet',
  'weth-basemainnet', 'aero-basemainnet', 'usdc-scroll', 'usde-mantle', 'usdc-linea', 'usdc-unichain',
  'weth-unichain', 'weth-ronin', 'ron-ronin', 'weth-linea',
];

const withoutV2 = markets.filter((market) => !isV2Market(market));

describe('registryToMarkets', () => {
  test('maps every legacy market in the legacy order, with V2 last', () => {
    expect(withoutV2.length).toEqual(LEGACY_MARKETS.length);
    expect(markets[markets.length - 1]).toBe(V2_MARKET);
    withoutV2.forEach((market, index) => {
      const [chainId, symbol, name, addresses] = LEGACY_MARKETS[index];
      expect([market.chainInformation.chainId, market.baseAsset.symbol, market.baseAsset.name]).toEqual([
        chainId,
        symbol,
        name,
      ]);
      expect(market.marketAddress).toEqual(addresses.comet);
      expect(market.bulkerAddress).toEqual(addresses.bulker);
      expect(market.rewardsAddress).toEqual(addresses.rewards);
    });
  });

  test('keeps legacy URL keys', () => {
    expect(withoutV2.map(shortMarketKey)).toEqual(LEGACY_SHORT_KEYS);
  });

  test('marks only ETH markets as wrapped', () => {
    expect(withoutV2.filter((market) => market.baseAsset.isWrapped).map(marketKey)).toEqual(
      withoutV2.filter((market) => market.baseAsset.symbol === 'ETH').map(marketKey),
    );
    expect(withoutV2.find((market) => market.baseAsset.symbol === 'RON')?.baseAsset.isWrapped).toBe(false);
  });

  test('maps the institutional market with its slug, icon and New badge', () => {
    const institutional = withoutV2.filter((market) => market.institutional);
    expect(institutional.length).toEqual(1);
    expect(institutional[0]).toMatchObject({
      slug: 'usdc-institutional',
      institutional: true,
      isNew: true,
      iconPair: ['INSTITUTIONAL', 'USDC'],
    });
    const standard = withoutV2.filter((market) => !market.institutional);
    standard.forEach((market) => {
      expect(market.slug).toBeUndefined();
      expect(market.institutional).toBeUndefined();
      expect(market.isNew).toBeUndefined();
    });
  });

  test('applies rewards overrides to mainnet USDC, WETH and USDT only', () => {
    const withRewards = withoutV2.filter((market) => market.rewardsOverwrite !== undefined);
    expect(withRewards.map((market) => market.marketAddress)).toEqual([
      LEGACY_ADDRESSES.mainnetUSDC.comet,
      LEGACY_ADDRESSES.mainnetWETH.comet,
      LEGACY_ADDRESSES.mainnetUSDT.comet,
    ]);
    expect(withRewards[1].rewardsOverwrite).toEqual({
      rewardsAssetSymbol: 'COMP',
      supplyCompPerDay: 10n * 10n ** 18n,
      borrowCompPerDay: 20n * 10n ** 18n,
    });
  });

  test('takes chain information from the local CHAINS config', () => {
    withoutV2.forEach((market) => expect(market.chainInformation).toBe(CHAINS[market.chainInformation.chainId]));
  });

  test('omits the fauceteer when the registry has none', () => {
    withoutV2.forEach((market) => expect(market.fauceteerAddress).toBeUndefined());
  });

  test('keeps a market the registry has no bulker for, without a bulker address', () => {
    const [mainnet, ...restNetworks] = registry.networks;
    const [noBulkerMarket, ...restMarkets] = mainnet.markets;
    const withoutBulker: MarketRegistryResponse = {
      ...registry,
      networks: [
        {
          ...mainnet,
          markets: [
            { ...noBulkerMarket, contracts: { ...noBulkerMarket.contracts, bulker: null } },
            ...restMarkets,
          ],
        },
        ...restNetworks,
      ],
    };
    const mapped = registryToMarkets(withoutBulker).markets.find(
      (market) => market.marketAddress.toLowerCase() === noBulkerMarket.contracts.comet
    );
    expect(mapped).toBeDefined();
    expect(mapped?.bulkerAddress).toBeUndefined();
  });

  test('returns the registry default market', () => {
    expect(defaultMarket?.marketAddress).toEqual(LEGACY_ADDRESSES.mainnetUSDC.comet);
  });

  test('falls back to the first market in selector order when the registry has no default', () => {
    const noDefault: MarketRegistryResponse = {
      ...registry,
      networks: [...registry.networks].reverse().map((network) => ({
        ...network,
        markets: network.markets.map((market) => ({ ...market, isDefault: false })),
      })),
    };
    expect(registryToMarkets(noDefault).defaultMarket.marketAddress).toEqual(LEGACY_ADDRESSES.mainnetUSDC.comet);
  });

  test('returns the registry version id', () => {
    expect(registryToMarkets(registry).registryVersionId).toEqual(registry.registryVersion.id);
  });

  test('puts markets missing from the priority list after the listed ones, in registry order', () => {
    const [mainnet] = registry.networks;
    const [usdc] = mainnet.markets;
    const withNewMarkets: MarketRegistryResponse = {
      ...registry,
      networks: [
        {
          ...mainnet,
          markets: [
            { ...usdc, deploymentKey: 'new_b', displayName: 'NEWB', isDefault: false },
            ...mainnet.markets,
            { ...usdc, deploymentKey: 'new_a', displayName: 'NEWA', isDefault: false },
          ],
        },
      ],
    };
    const symbols = registryToMarkets(withNewMarkets).markets.map((market) => market.baseAsset.symbol);
    expect(symbols).toEqual(['USDC', 'ETH', 'USDT', 'wstETH', 'USDS', 'WBTC', 'USDC', 'NEWB', 'NEWA', 'Compound V2']);
  });

  test('skips networks that are not configured in CHAINS', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const withUnknownChain: MarketRegistryResponse = {
      ...registry,
      networks: [{ ...registry.networks[0], chainId: 999999 }, ...registry.networks.slice(1)],
    };
    const mapped = registryToMarkets(withUnknownChain).markets;
    expect(mapped.some((market) => market.chainInformation?.chainId === 999999)).toBe(false);
    expect(mapped.filter((market: MarketData) => !isV2Market(market)).length).toEqual(LEGACY_MARKETS.length - 7);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('skips a market with a malformed address and keeps the rest', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const [mainnet, ...restNetworks] = registry.networks;
    const [badMarket, ...restMarkets] = mainnet.markets;
    const withBadMarket: MarketRegistryResponse = {
      ...registry,
      networks: [
        {
          ...mainnet,
          markets: [
            { ...badMarket, contracts: { ...badMarket.contracts, comet: 'not-an-address' } },
            ...restMarkets,
          ],
        },
        ...restNetworks,
      ],
    };
    const mapped = registryToMarkets(withBadMarket).markets.filter((market) => !isV2Market(market));
    expect(mapped.length).toEqual(LEGACY_MARKETS.length - 1);
    expect(mapped.some((market) => market.marketAddress === badMarket.contracts.comet)).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('validateMarketRegistry', () => {
  test('accepts a valid response', () => {
    expect(validateMarketRegistry(registry)).toBe(registry);
  });

  test('rejects an unsupported schema version', () => {
    expect(() => validateMarketRegistry({ ...registry, schemaVersion: 2 })).toThrow();
  });

  test('rejects a response without networks', () => {
    expect(() => validateMarketRegistry({ schemaVersion: 1 })).toThrow();
    expect(() => validateMarketRegistry(null)).toThrow();
    expect(() => validateMarketRegistry('<html></html>')).toThrow();
  });

  test('rejects a response without supported markets', () => {
    expect(() => validateMarketRegistry({ ...registry, networks: [] })).toThrow();
  });

  test('rejects a response where every market is malformed', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const allMarketsInvalid: MarketRegistryResponse = {
      ...registry,
      networks: registry.networks.map((network) => ({
        ...network,
        markets: network.markets.map((market) => ({
          ...market,
          contracts: { ...market.contracts, comet: 'not-an-address' },
        })),
      })),
    };
    expect(() => validateMarketRegistry(allMarketsInvalid)).toThrow();
    warn.mockRestore();
  });
});

describe('extension operators for registry markets', () => {
  const { mainnetUSDC, mainnetWETH } = LEGACY_ADDRESSES;

  const extensionById = (id: string) => {
    const extension = extensions.find((ext) => ext.id === id);
    if (extension === undefined) throw new Error(`No extension ${id}`);
    return extension;
  };

  const marketByAddress = (address: string): MarketData => {
    const market = markets.find((m) => m.marketAddress === address);
    if (market === undefined) throw new Error(`No market ${address}`);
    return market;
  };

  test('uses the market bulker for the bulker extension', () => {
    const bulker = extensionById('bulker');
    expect(getOperator(bulker, marketByAddress(mainnetUSDC.comet))).toEqual(mainnetUSDC.bulker);
    expect(getOperator(bulker, marketByAddress(mainnetWETH.comet))).toEqual(mainnetWETH.bulker);
  });

  test('keeps the bulker extension limited to its configured markets', () => {
    const bulker = extensionById('bulker');
    const usdt = markets.find((m) => marketKey(m).startsWith('1_USDT_')) as MarketData;
    expect(getOperator(bulker, usdt)).toBeNull();
  });

  test('has no operator for extensions without operator contracts', () => {
    expect(getOperator(extensionById('defisaver'), marketByAddress(mainnetUSDC.comet))).toBeNull();
    expect(getOperator(extensionById('comp_vote'), marketByAddress(mainnetUSDC.comet))).toBeNull();
  });
});
