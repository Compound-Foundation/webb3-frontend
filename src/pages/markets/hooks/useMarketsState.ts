import { BigNumber } from '@ethersproject/bignumber';
import { JsonRpcProvider, StaticJsonRpcProvider } from '@ethersproject/providers';
import { Contract, Provider } from 'ethers-multicall';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import type { Web3 } from '@contexts/Web3Context';
import Comet from '@helpers/abis/Comet';
import ERC20 from '@helpers/abis/ERC20';
import { adjustCollateralPrice, getBaseAssetPriceFeed } from '@helpers/baseAssetPrice';
import { getRemappedPriceFeed } from '@helpers/deprecatedMarkets';
import { isV2Market } from '@helpers/markets';
import { getMockMarketState } from '@helpers/mocks';
import { getMarketDataUrlForMarket } from '@helpers/urls';
import { getV2State } from '@hooks/useV2MarketState';
import {
  MarketDataState,
  MarketData,
  MarketDataLoaded,
  MarketHistoricalBucket,
  MarketState,
  ProtocolAndMarketsState,
  StateType,
  TokenWithMarketState,
  V3MarketApiBucket,
} from '@types';

const MARKETS_REFRESH_INTERVAL = 300_000; // 5 mins

const SECONDS_PER_YEAR = BigInt(60 * 60 * 24 * 365);

export function useMarketsState(web3: Web3, marketState: MarketDataState): MarketState {
  const location = useLocation();
  const [state, setState] = useState<MarketState>([StateType.Loading]);
  const marketRef = useRef(marketState);

  // When network is changed, immediately set state to loading and update the chainIdRef
  useEffect(() => {
    const state: MarketState = [StateType.Loading];
    setState(state);
    marketRef.current = marketState;
  }, [marketState]);

  const refreshData = useCallback(async () => {
    const [marketStateType] = marketState;

    if (web3.read.provider !== undefined && marketStateType !== StateType.Loading) {
      let state: MarketState;
      if (new URLSearchParams(location.search).has('mock')) {
        state = getMockMarketState();
      } else {
        state = await getState(web3.read.provider, marketState[1]);
      }

      // Only update state if chainId has not changed since the start of this callback
      // We compare to a ref because the `web3.read.chainId` in the callback can be stale
      if (marketState === marketRef.current) {
        setState(state);
      }
    }
  }, [marketState]);

  useEffect(() => {
    const intervalId = setInterval(refreshData, MARKETS_REFRESH_INTERVAL);
    // refresh data immediately
    refreshData();

    return () => clearInterval(intervalId);
  }, [refreshData]);

  return state;
}

const getState = async (rawProvider: JsonRpcProvider, market: MarketData | MarketDataLoaded): Promise<MarketState> => {
  if (isV2Market(market)) {
    return getV2State();
  }

  if (market.type === 'MarketData') return [StateType.Loading];

  const provider = new StaticJsonRpcProvider(rawProvider.connection);
  const ethcallProvider = new Provider(provider, market.chainInformation.chainId);

  const cometContract = new Contract(market.marketAddress, Comet);

  const [utilization, factorScaleBN]: [BigNumber, BigNumber] = await ethcallProvider.all([
    cometContract.getUtilization(),
    cometContract.factorScale(),
  ]);

  const factorScale = Number(factorScaleBN);
  const utilizationDescale = factorScale / 1e2;

  const utilizationIntervals = [...Array(101).keys()].map((n) => BigInt(n * utilizationDescale));
  const borrowRateCalls = utilizationIntervals.map((interval) => cometContract.getBorrowRate(interval));
  const supplyRateCalls = utilizationIntervals.map((interval) => cometContract.getSupplyRate(interval));

  const baseAssetDollarPriceFeed = getBaseAssetPriceFeed(market);

  const [
    borrowRatePerSecond,
    supplyRatePerSecond,
    reserves,
    totalSupplyBN,
    totalBorrowBN,
    targetReserves,
    baseTokenPriceInDollars,
    ...borrowAndSupplyRates
  ] = await ethcallProvider.all([
    cometContract.getBorrowRate(utilization),
    cometContract.getSupplyRate(utilization),
    cometContract.getReserves(),
    cometContract.totalSupply(),
    cometContract.totalBorrow(),
    cometContract.targetReserves(),
    cometContract.getPrice(baseAssetDollarPriceFeed),
    ...borrowRateCalls,
    ...supplyRateCalls,
  ]);

  const borrowRates: [bigint, number][] = borrowAndSupplyRates
    .slice(0, utilizationIntervals.length)
    .map((borrowRate, idx) => {
      return [utilizationIntervals[idx], Number(borrowRate.toBigInt() * SECONDS_PER_YEAR) / utilizationDescale];
    });
  const supplyRates: [bigint, number][] = borrowAndSupplyRates
    .slice(utilizationIntervals.length)
    .map((supplyRate, idx) => {
      return [utilizationIntervals[idx], Number(supplyRate.toBigInt() * SECONDS_PER_YEAR) / utilizationDescale];
    });
  const baseTokenContract = new Contract(market.baseAsset.address, ERC20);

  let ignoredCollateralPriceIndex = -1;
  const priceCalls = market.collateralAssets.map((asset, index) => {
    // If the price feed is the now deprecated wUSDM feed then keep track of the
    // index in the asset list and force a dummy getPrice call that we'll ignore
    // down below.
    const remappedDeprecatedPriceFeedAddress = getRemappedPriceFeed(asset.priceFeed);
    if (remappedDeprecatedPriceFeedAddress !== '') {
      ignoredCollateralPriceIndex = index;
      return cometContract.getPrice(remappedDeprecatedPriceFeedAddress);
    }
    return cometContract.getPrice(asset.priceFeed);
  });
  const totalsCollateralCalls = market.collateralAssets.map((asset) => cometContract.totalsCollateral(asset.address));
  const collateralReservesCalls = market.collateralAssets.map((asset) =>
    cometContract.getCollateralReserves(asset.address)
  );

  const [baseTokenPrice, baseAssetBalanceOfComet, ...combinedCalls] = await ethcallProvider.all([
    cometContract.getPrice(market.baseAsset.priceFeed),
    baseTokenContract.balanceOf(market.marketAddress),
    ...priceCalls,
    ...totalsCollateralCalls,
    ...collateralReservesCalls,
  ]);

  const numAssets = market.collateralAssets.length;

  const prices = combinedCalls.slice(0, numAssets).map((price, index) => {
    // If we found the deprecated feed, then let's ignore it.
    if (ignoredCollateralPriceIndex === index) {
      return 0n;
    }
    return price.toBigInt();
  });
  const totalSupplies = combinedCalls.slice(numAssets, numAssets * 2).map((tc) => tc.totalSupplyAsset.toBigInt());
  const collateralReserves = combinedCalls.slice(numAssets * 2, numAssets * 3).map((cr) => cr.toBigInt());

  const baseAssetPrice = baseTokenPrice.toBigInt();
  const borrowAPR = borrowRatePerSecond.toBigInt() * SECONDS_PER_YEAR;
  const earnAPR = supplyRatePerSecond.toBigInt() * SECONDS_PER_YEAR;
  const totalSupply = totalSupplyBN.toBigInt();
  const totalBorrow = totalBorrowBN.toBigInt();

  const collateralAssets: TokenWithMarketState[] = await Promise.all(
    market.collateralAssets.map(async (asset, index) => {
      const liquidationPenalty = BigInt(1e18) - asset.liquidationFactor;
      const tokenWithState: TokenWithMarketState = {
        ...asset,
        liquidationPenalty,
        price: adjustCollateralPrice(market.baseAsset.symbol, baseAssetPrice, prices[index]),
        reserves: collateralReserves[index],
        totalSupply: totalSupplies[index],
      };

      return tokenWithState;
    })
  );

  let marketHistoryAsBuckets: MarketHistoricalBucket[] = [];
  try {
    const response = await fetch(getMarketDataUrlForMarket(market) + '/historical/summary');

    const responsePayload: V3MarketApiBucket[] = await response.json();
    marketHistoryAsBuckets = responsePayload
      .map((v3HistoryBucket) => {
        return {
          blockTimestamp: Number(v3HistoryBucket.timestamp * 1000),
          supplyTotal: Number(v3HistoryBucket.total_collateral_value),
          borrowTotal: Number(v3HistoryBucket.total_borrow_value),
          supplyRate: Number(v3HistoryBucket.supply_apr),
          borrowRate: Number(v3HistoryBucket.borrow_apr),
        };
      })
      .sort((a, b) => (a.blockTimestamp > b.blockTimestamp ? 1 : -1));
  } catch (e) {
    console.error('Error fetching historical market data: ', e);
  }

  const state: ProtocolAndMarketsState = {
    baseAsset: {
      ...market.baseAsset,
      balanceOfComet: baseAssetBalanceOfComet.toBigInt(),
      price: baseAssetPrice,
      baseAssetPriceInDollars: baseTokenPriceInDollars.toBigInt(),
    },
    borrowAPR,
    borrowRates,
    collateralAssets,
    cometAddress: market.marketAddress,
    earnAPR,
    factorScale,
    marketHistory: marketHistoryAsBuckets,
    reserves: reserves.toBigInt(),
    supplyRates,
    targetReserves: targetReserves.toBigInt(),
    totalBorrow,
    totalSupply,
    utilization: utilization.toBigInt(),
    type: 'ProtocolAndMarketState',
  };
  return [StateType.Hydrated, state];
};
