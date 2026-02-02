import arbitrumNativeUSDCRoots from 'comet/deployments/arbitrum/usdc/roots.json';
import arbitrumBridgedUSDCRoots from 'comet/deployments/arbitrum/usdc.e/roots.json';
import arbitrumUSDTRoots from 'comet/deployments/arbitrum/usdt/roots.json';
import arbitrumWETHRoots from 'comet/deployments/arbitrum/weth/roots.json';
import baseMainnetAERORoots from 'comet/deployments/base/aero/roots.json';
import baseMainnetUSDbCRoots from 'comet/deployments/base/usdbc/roots.json';
import baseMainnetUSDCRoots from 'comet/deployments/base/usdc/roots.json';
import baseMainnetUSDSRoots from 'comet/deployments/base/usds/roots.json';
import baseMainnetWETHRoots from 'comet/deployments/base/weth/roots.json';
import lineaMainnetUSDCRoots from 'comet/deployments/linea/usdc/roots.json';
import lineaWETHRoots from 'comet/deployments/linea/weth/roots.json';
import mainnetUSDCRoots from 'comet/deployments/mainnet/usdc/roots.json';
import mainnetUSDSRoots from 'comet/deployments/mainnet/usds/roots.json';
import mainnetUSDTRoots from 'comet/deployments/mainnet/usdt/roots.json';
import mainnetWBTCRoots from 'comet/deployments/mainnet/wbtc/roots.json';
import mainnetWETHRoots from 'comet/deployments/mainnet/weth/roots.json';
import mainnetWSTETHRoots from 'comet/deployments/mainnet/wsteth/roots.json';
import mantleUSDERoots from 'comet/deployments/mantle/usde/roots.json';
import optimismUSDCRoots from 'comet/deployments/optimism/usdc/roots.json';
import optimismUSDTRoots from 'comet/deployments/optimism/usdt/roots.json';
import optimismWETHRoots from 'comet/deployments/optimism/weth/roots.json';
import polygonUSDCRoots from 'comet/deployments/polygon/usdc/roots.json';
import polygonUSDTRoots from 'comet/deployments/polygon/usdt/roots.json';
import roninWETHRoots from 'comet/deployments/ronin/weth/roots.json';
import roninWRONRoots from 'comet/deployments/ronin/wron/roots.json';
import scrollUSDCRoots from 'comet/deployments/scroll/usdc/roots.json';
import sepoliaUSDCRoots from 'comet/deployments/sepolia/usdc/roots.json';
import sepoliaWETHRoots from 'comet/deployments/sepolia/weth/roots.json';
import unichainUSDCRoots from 'comet/deployments/unichain/usdc/roots.json';
import unichainWETHRoots from 'comet/deployments/unichain/weth/roots.json';

import { iconNameForChainId } from '@helpers/assets';
import { MARKET_KEY_DELIMITER } from '@helpers/constants';
import { ChainInformation, MarketData, MarketDataLoaded, MarketsByNetwork } from '@types';

import { CHAINS } from '../constants/chains';

// The base assets of our markets are all ERC-20 tokens, and for some markets, we handle & abstract away
// the conversion so that users don't need to concern themselves with wrapping their native tokens.
// One example is how we show ETH as the base asset to supply in the UI, but we refer to it as the WETH market (since WETH is the actual base token).
const WRAPPED_BASE_ASSETS = ['ETH'];

export const DEFAULT_MARKET: MarketData = {
  baseAsset: {
    symbol: 'USDC',
    name: 'USD Coin',
    isWrapped: false,
  },
  chainInformation: CHAINS[1],
  iconPair: [iconNameForChainId(1), 'USDC'],
  marketAddress: mainnetUSDCRoots['comet'],
  bulkerAddress: mainnetUSDCRoots['bulker'],
  rewardsAddress: mainnetUSDCRoots['rewards'],
  type: 'MarketData',
};

export const V2_MARKET_KEY = 'Compound V2';

export const V2_MARKET: MarketData = {
  baseAsset: {
    symbol: V2_MARKET_KEY,
    name: V2_MARKET_KEY,
  },
  chainInformation: CHAINS[1],
  iconPair: [iconNameForChainId(1), 'V2'],
  bulkerAddress: '0xFA4E',
  marketAddress: '0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B', // V2 Comptroller address
  type: 'MarketData',
};

// NOTE: Currently, the order we list markets will dictate the order they show up in the market selector
export const MARKETS: MarketData[] = [
  ...(
    [
      [1, 'USDC', 'USD Coin', mainnetUSDCRoots],
      [1, 'ETH', 'Ether', mainnetWETHRoots],
      [1, 'USDT', 'Tether', mainnetUSDTRoots],
      [1, 'wstETH', 'Lido Wrapped Staked ETH', mainnetWSTETHRoots],
      [1, 'USDS', 'USDS', mainnetUSDSRoots],
      [1, 'WBTC', 'Wrapped BTC', mainnetWBTCRoots],
      [137, 'USDC.e', 'USD Coin (Bridged)', polygonUSDCRoots],
      [137, 'USDT', 'Tether', polygonUSDTRoots],
      [42161, 'USDC', 'USD Coin', arbitrumNativeUSDCRoots],
      [42161, 'USDC.e', 'USD Coin (Bridged)', arbitrumBridgedUSDCRoots],
      [42161, 'ETH', 'Ether', arbitrumWETHRoots],
      [42161, 'USDT', 'Tether', arbitrumUSDTRoots],
      [11155111, 'USDC', 'USD Coin', sepoliaUSDCRoots],
      [11155111, 'ETH', 'Ether', sepoliaWETHRoots],
      [10, 'USDC', 'USD Coin', optimismUSDCRoots],
      [10, 'USDT', 'Tether', optimismUSDTRoots],
      [10, 'ETH', 'Ether', optimismWETHRoots],
      [8453, 'USDC', 'USD Coin', baseMainnetUSDCRoots],
      [8453, 'USDbC', 'USD Coin (Bridged)', baseMainnetUSDbCRoots],
      [8453, 'USDS', 'USDS', baseMainnetUSDSRoots],
      [8453, 'ETH', 'Ether', baseMainnetWETHRoots],
      [8453, 'AERO', 'Aero', baseMainnetAERORoots],
      [534352, 'USDC', 'USD Coin', scrollUSDCRoots],
      [5000, 'USDe', 'Ethena USDe', mantleUSDERoots],
      [59144, 'USDC', 'USD Coin', lineaMainnetUSDCRoots],
      [130, 'USDC', 'USD Coin', unichainUSDCRoots],
      [130, 'ETH', 'Ether', unichainWETHRoots],
      [2020, 'WETH', 'Wrapped Ether', roninWETHRoots],
      [2020, 'RON', 'Ronin', roninWRONRoots],
      [59144, 'ETH', 'Ether', lineaWETHRoots],
    ] as [number, string, string, { [x: string]: string }][]
  ).map(([chainId, baseAsset, baseAssetName, root]) => {
    const chain: ChainInformation = CHAINS[chainId];

    return {
      baseAsset: {
        symbol: baseAsset,
        name: baseAssetName,
        isWrapped: WRAPPED_BASE_ASSETS.includes(baseAsset),
      },
      chainInformation: chain,
      iconPair: [iconNameForChainId(chainId), baseAsset],
      marketAddress: root['comet'],
      bulkerAddress: root['bulker'],
      fauceteerAddress: root['fauceteer'],
      rewardsAddress: root['rewards'],
      type: 'MarketData',
    } as MarketData;
  }),
  // This is a faux supported market for Compound V2 and points to comptroller address
  V2_MARKET,
];

export const getMarketDescriptors = (cometAddress: string, chainId: number) => {
  const marketData = getMarket(chainId, cometAddress);

  if (marketData === undefined) {
    return ['UNKNOWN', 'Unknown', 'Unknown'];
  }

  return [marketData.baseAsset.symbol, marketData.chainInformation.name, marketData.baseAsset.name];
};

/**
 * Calculate a unique key for the market in the form of `chainId_baseAssetSymbol_marketAddress`
 * @param market
 * @returns
 */
export function marketKey(market: MarketData | MarketDataLoaded): string {
  return [market.chainInformation.chainId, market.baseAsset.symbol, market.marketAddress].join(MARKET_KEY_DELIMITER);
}

export function areSameMarket(market1: MarketData | MarketDataLoaded, market2: MarketData | MarketDataLoaded): boolean {
  return marketKey(market1) === marketKey(market2);
}

export function isV2Market(market: MarketData | MarketDataLoaded) {
  return areSameMarket(market, V2_MARKET);
}

export function getMarkets(showTestnet: boolean): MarketData[] {
  return MARKETS.filter((market) => (showTestnet ? true : !market.chainInformation.testnet));
}

export function getMarketsByNetwork(showTestnet: boolean): MarketsByNetwork {
  return getMarkets(showTestnet).reduce<MarketsByNetwork>((acc, market: MarketData) => {
    const { chainInformation } = market;
    const networkInfo = acc[chainInformation.chainId] ?? { chainInformation, markets: [] };
    return {
      ...acc,
      [chainInformation.chainId]: {
        ...networkInfo,
        markets: [...networkInfo.markets, market],
      },
    };
  }, {});
}

export function getMarket(chainId: number, marketAddress: string): MarketData | undefined {
  const market = MARKETS.find(
    (market) =>
      market.chainInformation.chainId === chainId && market.marketAddress.toLowerCase() === marketAddress.toLowerCase()
  );

  return market;
}
