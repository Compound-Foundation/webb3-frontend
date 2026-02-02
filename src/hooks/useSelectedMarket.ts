import { StaticJsonRpcProvider } from '@ethersproject/providers';
import { ConnectionInfo } from 'ethers/lib/utils';
import { setMulticallAddress } from 'ethers-multicall';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import type { Web3 } from '@contexts/Web3Context';
import { getAssetDisplayName, getAssetDisplaySymbol } from '@helpers/assets';
import { MARKET_KEY_DELIMITER, MARKET_LOCAL_STORAGE_KEY } from '@helpers/constants';
import { getIsDeprecatedwUSDMMarket } from '@helpers/deprecatedMarkets';
import {
  DEFAULT_MARKET,
  V2_MARKET,
  areSameMarket,
  getMarket,
  getMarkets,
  isV2Market,
  marketKey,
} from '@helpers/markets';
import CometQuery from '@helpers/sleuth/out/CometQuery.sol/CometQuery.json';
import { Sleuth } from '@helpers/sleuth/sleuth';
import { CometStateQuery, CometStateResponse } from '@helpers/sleuth/types';
import {
  MarketData,
  MarketDataLoaded,
  MarketDataState,
  StateType,
  SelectedMarketData,
  MarketDataHydrated,
} from '@types';

// Ethers-multicall doesn't directly support certain chains,
// so you'll have to tell it the address of a multicall contract
// it can use for those chains
// EX: https://goerli.basescan.org/address/0xcA11bde05977b3631167028862bE2a173976CA11#code
setMulticallAddress(43113, '0x3D015943d2780fE97FE3f69C97edA2CCC094f78c');
setMulticallAddress(420, '0xcA11bde05977b3631167028862bE2a173976CA11');
setMulticallAddress(421613, '0xcA11bde05977b3631167028862bE2a173976CA11');
setMulticallAddress(42161, '0xcA11bde05977b3631167028862bE2a173976CA11');
setMulticallAddress(8453, '0xcA11bde05977b3631167028862bE2a173976CA11');
setMulticallAddress(84531, '0xcA11bde05977b3631167028862bE2a173976CA11');
setMulticallAddress(59140, '0xcA11bde05977b3631167028862bE2a173976CA11');
setMulticallAddress(534352, '0xcA11bde05977b3631167028862bE2a173976CA11');
setMulticallAddress(10, '0xcA11bde05977b3631167028862bE2a173976CA11');
setMulticallAddress(11155111, '0xcA11bde05977b3631167028862bE2a173976CA11');
setMulticallAddress(5000, '0xcA11bde05977b3631167028862bE2a173976CA11');
setMulticallAddress(59144, '0xcA11bde05977b3631167028862bE2a173976CA11');
setMulticallAddress(130, '0xcA11bde05977b3631167028862bE2a173976CA11');
setMulticallAddress(2020, '0xcA11bde05977b3631167028862bE2a173976CA11');

/**
 * Gets the selected market from the query params or local storage and
 * fetches the market data from the Comet contract.
 * @param web3
 * @returns
 */
export function useSelectedMarketState(web3: Web3): SelectedMarketData {
  const location = useLocation();

  // Most routes use <route>/?market=<marketId> to select a market
  const [searchParams, setSearchParams] = useSearchParams();

  // The markets/:marketId route has a react router param for the marketId
  const { marketId } = useParams();
  const navigate = useNavigate();

  const [state, setState] = useState<MarketDataState>([StateType.Loading, undefined]);
  const marketRef = useRef('');

  const selectMarket = useCallback(
    async (desiredMarket: MarketData) => {
      const isMarketsPage = location.pathname.startsWith('/markets');
      const hasMarketQueryParam = searchParams.has('market');

      // On the /markets page, don't set the market query param
      if (!isMarketsPage) {
        // Force update the market query parameter
        const newSearchParams = new URLSearchParams(searchParams);
        newSearchParams.set('market', shortMarketKey(desiredMarket));

        setSearchParams(newSearchParams, { replace: true });
      } else if (hasMarketQueryParam) {
        // Instead of updating query param, navigate to /markets/:marketId.
        const existingSearchParams = new URLSearchParams(searchParams);
        existingSearchParams.delete('market');

        navigate(`/markets/${shortMarketKey(desiredMarket)}?${existingSearchParams.toString()}`, { replace: true });
      }

      const [, currentMarket] = state;
      // if we've already selected the desired market, return
      if (currentMarket !== undefined && areSameMarket(currentMarket, desiredMarket)) return;
      const switched = await web3.switchReadNetwork(desiredMarket.chainInformation.chainId);

      if (switched) {
        setState([StateType.Loading, desiredMarket]);
        const key = marketKey(desiredMarket);
        window.localStorage.setItem(MARKET_LOCAL_STORAGE_KEY, key);

        marketRef.current = marketKey(desiredMarket);
      }
    },
    [location.pathname, state[1], web3.switchReadNetwork]
  );

  const selectMarketByAddress = useCallback(
    async (chainId: number, comet: string) => {
      const market = getMarket(chainId, comet);
      if (market !== undefined) {
        selectMarket(market);
      }
    },
    [selectMarket]
  );

  useEffect(() => {
    // When choosing a market based on the query params, filter from all the set of available markets.
    const markets = getMarkets(true);

    const maybePreferredMarket =
      marketId ?? searchParams.get('market') ?? window.localStorage.getItem(MARKET_LOCAL_STORAGE_KEY) ?? undefined;
    const market = parseMarketKeyOrDefault(markets, DEFAULT_MARKET, maybePreferredMarket);

    selectMarket(market);
  }, [location.pathname]);

  const getData = useCallback(async () => {
    const [stateType, market] = state;
    if (
      market !== undefined &&
      web3.read.chainId === market.chainInformation.chainId &&
      web3.read.provider !== undefined &&
      stateType === StateType.Loading
    ) {
      const state = await getState(web3.read.provider.connection, market);
      // Only update state if market key has not changed since the start of this callback
      // We compare to a ref because the `market` in the callback can be stale
      if (marketKey(market) === marketRef.current) {
        setState(state);
      }
    }
  }, [web3.read.chainId, web3.read.provider, state[1]?.marketAddress, state[1]?.chainInformation.chainId]);

  useEffect(() => {
    getData();
  }, [web3.read.chainId, getData]);

  return {
    selectMarket,
    selectMarketByAddress,
    selectedMarket: state,
  };
}

const QUERY = Sleuth.querySol(CometQuery, { queryFunctionName: 'query' });

export function getSleuthOptions(chainId: number): { contractAddress: string } {
  //TODO: This should be moved into the Sleuth code...
  const SLEUTH_CONTRACT_ADDRESS = '0xc6a613fdac3465d250df7ff3cc21bec86eb8a372';
  const MANTLE_CHAIN_ID = 5000;
  const MANTLE_SLEUTH_CONTRACT_ADDRESS = '0x1C31c10691Ba7728A04C2bAa2ac02E663a87466F'; // https://mantlescan.xyz/address/0x1C31c10691Ba7728A04C2bAa2ac02E663a87466F

  // for Mantle our Sleuth contract is deployed on a different address than usual
  return chainId === MANTLE_CHAIN_ID
    ? { contractAddress: MANTLE_SLEUTH_CONTRACT_ADDRESS }
    : { contractAddress: SLEUTH_CONTRACT_ADDRESS };
}

export const queryCometData = async (
  providerConnection: string | ConnectionInfo,
  market: MarketData | MarketDataLoaded
): Promise<CometStateResponse> => {
  const provider = new StaticJsonRpcProvider(providerConnection);
  const sleuth = new Sleuth(provider, getSleuthOptions(market.chainInformation.chainId));

  let nativeTokenToUsdPriceFeed = market.chainInformation.extraPriceFeeds.nativeTokenToUsd;
  const baseAssetSymbol = market.baseAsset.symbol;
  if (
    market.chainInformation.extraPriceFeeds.otherBaseTokensToUsd &&
    market.chainInformation.extraPriceFeeds.otherBaseTokensToUsd[baseAssetSymbol]
  ) {
    nativeTokenToUsdPriceFeed = market.chainInformation.extraPriceFeeds.otherBaseTokensToUsd[baseAssetSymbol];
  }
  const checkDeprecatedwUSDM = getIsDeprecatedwUSDMMarket(market.baseAsset, market.chainInformation);
  return sleuth.fetch<CometStateResponse, CometStateQuery>(QUERY, [
    market.marketAddress,
    nativeTokenToUsdPriceFeed,
    checkDeprecatedwUSDM,
  ]);
};

const getState = async (
  providerConnection: string | ConnectionInfo,
  market: MarketData | MarketDataLoaded
): Promise<MarketDataHydrated> => {
  if (isV2Market(market)) {
    return [StateType.Hydrated, market];
  }

  const cometResponse = await queryCometData(providerConnection, market);
  const marketDataLoaded: MarketDataLoaded = {
    ...market,
    baseAsset: {
      address: cometResponse.baseAsset.baseAsset,
      symbol: getAssetDisplaySymbol(
        cometResponse.baseAsset.baseAsset,
        cometResponse.baseAsset.symbol,
        market.chainInformation
      ),
      decimals: cometResponse.baseAsset.decimals.toNumber(),
      minBorrow: cometResponse.baseAsset.minBorrow.toBigInt(),
      name: getAssetDisplayName(
        cometResponse.baseAsset.baseAsset,
        cometResponse.baseAsset.name,
        market.chainInformation
      ),
      priceFeed: cometResponse.baseAsset.priceFeed,
    },
    baseMinForRewards: cometResponse.baseMinForRewards.toBigInt(),
    baseTrackingBorrowSpeed: cometResponse.baseTrackingBorrowSpeed.toBigInt(),
    baseTrackingSupplySpeed: cometResponse.baseTrackingSupplySpeed.toBigInt(),
    collateralAssets: cometResponse.collateralAssets.map((assetInfo) => ({
      address: assetInfo.collateralAsset,
      priceFeed: assetInfo.priceFeed,
      symbol: getAssetDisplaySymbol(assetInfo.collateralAsset, assetInfo.symbol, market.chainInformation),
      decimals: assetInfo.decimals.toNumber(),
      name: getAssetDisplayName(
        assetInfo.collateralAsset,
        sanitizeCollateralAssetName(assetInfo.name),
        market.chainInformation
      ),
      collateralFactor: assetInfo.collateralFactor.toBigInt(),
      liquidateCollateralFactor: assetInfo.liquidateCollateralFactor.toBigInt(),
      liquidationFactor: assetInfo.liquidationFactor.toBigInt(),
      supplyCap: assetInfo.supplyCap.toBigInt(),
    })),
    trackingIndexScale: cometResponse.trackingIndexScale.toBigInt(),
    type: 'MarketDataLoaded',
  };

  return [StateType.Hydrated, marketDataLoaded];
};

export function sanitizeCollateralAssetName(name: string) {
  if (name === 'ChainLink Token') {
    return 'Chainlink';
  } else if (name === 'Wrapped BTC') {
    return 'Wrapped Bitcoin';
  }
  return name;
}

export function shortMarketKey(market: MarketData | MarketDataLoaded): string {
  if (market.baseAsset.symbol === V2_MARKET.baseAsset.symbol) {
    return 'v2';
  }
  // Markets with a wrapped base asset are referred to in terms of the wrapped asset (e.g. 'WETH' or 'WMATIC').
  const marketName = market.baseAsset.isWrapped
    ? `w${market.baseAsset.symbol.toLowerCase()}`
    : market.baseAsset.symbol.toLowerCase();
  return [marketName, market.chainInformation.key.toLowerCase()].join('-');
}

export function parseMarketKeyOrDefault(
  markets: MarketData[],
  defaultData: MarketData,
  marketKey?: string | null
): MarketData {
  if (marketKey === undefined || marketKey === null) {
    // No market key was found, e.g. if the user visits app.compound.finance for the first time.
    return defaultData;
  }

  const maybeShorthandMatch = marketKey.match(new RegExp('^([a-zA-Z.]+)-([a-zA-Z]+)$'));
  if (maybeShorthandMatch !== null) {
    // Matches a market key like 'usdc-mainnet'
    const [, baseAssetSymbol, networkName] = maybeShorthandMatch;
    const maybeMarketFromShorthand = markets.find(
      (market: MarketData) =>
        market.chainInformation.key.toLowerCase() === networkName.toLowerCase() &&
        ((!market.baseAsset.isWrapped && market.baseAsset.symbol.toLowerCase() === baseAssetSymbol.toLowerCase()) ||
          (market.baseAsset.isWrapped && `w${market.baseAsset.symbol}`.toLowerCase() === baseAssetSymbol.toLowerCase()))
    );

    if (maybeMarketFromShorthand) {
      return maybeMarketFromShorthand;
    }
  } else if (marketKey === 'v2') {
    return V2_MARKET;
  } else {
    // Matches a market key like '1_USDC_0xc3d688B66703497DAA19211EEdff47f25384cdc3';
    const [chainId, baseAssetSymbol, marketAddress] = marketKey.split(MARKET_KEY_DELIMITER);

    const maybeMarket = markets.find(
      (market: MarketData) =>
        market.chainInformation.chainId === Number(chainId) &&
        market.baseAsset.symbol === baseAssetSymbol &&
        market.marketAddress === marketAddress
    );

    if (maybeMarket) {
      return maybeMarket;
    }
  }

  console.warn(`Unknown market from query param: ${marketKey} -- Returning default market data`);
  return defaultData;
}

export function parseMarketKey(markets: MarketData[], marketKey: string): MarketData | undefined {
  const [chainId, baseAssetSymbol, marketAddress] = marketKey.split(MARKET_KEY_DELIMITER);

  const supportedMarket = markets.find(
    (market: MarketData) =>
      market.chainInformation.chainId === Number(chainId) &&
      market.baseAsset.symbol === baseAssetSymbol &&
      market.marketAddress === marketAddress
  );

  return supportedMarket;
}
