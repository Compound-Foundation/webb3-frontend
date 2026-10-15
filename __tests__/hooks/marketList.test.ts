import { convertApiResponse } from '@helpers/functions';
import { isV2Market, marketKey, V2_MARKET } from '@helpers/markets';
import { summaryToMarkets } from '@hooks/useMarkets';
import { shortMarketKey } from '@hooks/useSelectedMarket';
import { extensions } from '@pages/extensions/helpers/core';
import { getOperator } from '@pages/extensions/helpers/list';
import { LatestMarketSummaryResponse, MarketData } from '@types';

import { LEGACY_ADDRESSES } from '../mocks/legacyMarketAddresses';
import mockMarketListResponse from '../mocks/mockMarketListResponse.json';

const entries = mockMarketListResponse.map(convertApiResponse) as LatestMarketSummaryResponse[];
const { markets, defaultMarket } = summaryToMarkets(entries);

// The market list as it was defined before the migration, in the same order.
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
const mainnetEntries = entries.filter((entry) => entry.chainId === 1);

describe('summaryToMarkets', () => {
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
      expect(market.institutional).toBe(false);
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

  test('returns the default market from the summary', () => {
    expect(defaultMarket.marketAddress).toEqual(LEGACY_ADDRESSES.mainnetUSDC.comet);
  });

  test('falls back to the first market in selector order when the summary has no default', () => {
    const noDefault = [...entries].reverse().map((entry) => ({ ...entry, isDefault: false }));
    expect(summaryToMarkets(noDefault).defaultMarket.marketAddress).toEqual(LEGACY_ADDRESSES.mainnetUSDC.comet);
  });

  test('puts markets missing from the priority list after the listed ones, in summary order', () => {
    const [usdc] = mainnetEntries;
    const withNewMarkets = [
      { ...usdc, deploymentKey: 'new_b', displayName: 'NEWB', isDefault: false },
      ...mainnetEntries,
      { ...usdc, deploymentKey: 'new_a', displayName: 'NEWA', isDefault: false },
    ];
    const symbols = summaryToMarkets(withNewMarkets).markets.map((market) => market.baseAsset.symbol);
    expect(symbols).toEqual(['USDC', 'ETH', 'USDT', 'wstETH', 'USDS', 'WBTC', 'USDC', 'NEWB', 'NEWA', 'Compound V2']);
  });

  test('skips markets on chains that are not configured in CHAINS', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const withUnknownChain = entries.map((entry) => (entry.chainId === 1 ? { ...entry, chainId: 999999 } : entry));
    const mapped = summaryToMarkets(withUnknownChain).markets;
    expect(mapped.some((market) => market.chainInformation?.chainId === 999999)).toBe(false);
    expect(mapped.filter((market: MarketData) => !isV2Market(market)).length).toEqual(LEGACY_MARKETS.length - 7);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('treats fields sent as null like missing ones', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const [usdc, weth, ...rest] = entries;
    const withNulls = [
      { ...usdc, slug: null },
      { ...weth, displayName: null },
      ...rest,
    ] as unknown as LatestMarketSummaryResponse[];
    const mapped = summaryToMarkets(withNulls).markets.filter((market) => !isV2Market(market));

    const usdcMarket = mapped.find((market) => market.marketAddress === LEGACY_ADDRESSES.mainnetUSDC.comet);
    expect(usdcMarket?.slug).toBeUndefined();
    expect(usdcMarket && shortMarketKey(usdcMarket)).toEqual('usdc-mainnet');
    expect(mapped.some((market) => market.marketAddress === LEGACY_ADDRESSES.mainnetWETH.comet)).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('throws when no market is supported', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => summaryToMarkets([])).toThrow();
    expect(() =>
      summaryToMarkets(
        entries.map((entry) => ({ ...entry, deploymentKey: undefined, displayName: undefined, baseAssetName: undefined }))
      )
    ).toThrow();
    warn.mockRestore();
  });
});

describe('extension operators for the market list', () => {
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
});
