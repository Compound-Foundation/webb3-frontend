import { JsonRpcProvider, StaticJsonRpcProvider } from '@ethersproject/providers';
import { parseUnits } from '@ethersproject/units';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';

import RewardsStateContext from '@contexts/RewardsStateContext';
import type { Web3 } from '@contexts/Web3Context';
import { adjustCollateralPrice, getBaseAssetPriceFeed } from '@helpers/baseAssetPrice';
import { getIsDeprecatedwUSDMMarket } from '@helpers/deprecatedMarkets';
import { aprAt, toRateModel } from '@helpers/interestRates';
import { isV2Market } from '@helpers/markets';
import { getMockMarketState } from '@helpers/mocks';
import { FACTOR_PRECISION } from '@helpers/numbers';
import { getMarketRewardsAPRs } from '@helpers/rewards';
import CometQuery from '@helpers/sleuth/out/CometQuery.sol/CometQuery.json';
import { Sleuth } from '@helpers/sleuth/sleuth';
import { CometWithReservesQuery, CometWithReservesResponse } from '@helpers/sleuth/types';
import { getMarketDataUrlForMarket } from '@helpers/urls';
import { getSleuthOptions } from '@hooks/useSelectedMarket';
import { getV2State } from '@hooks/useV2MarketState';
import {
  MarketData,
  MarketDataLoaded,
  MarketDataState,
  MarketHistoricalBucket,
  MarketState,
  ProtocolAndMarketsState,
  RewardsState,
  StateType,
  TokenWithMarketState,
  V3MarketApiBucket
} from '@types';


const MARKETS_REFRESH_INTERVAL = 300_000; // 5 mins

const QUERY_WITH_RESERVES = Sleuth.querySol(CometQuery, { queryFunctionName: 'queryWithReserves' });

export function useMarketsState(web3: Web3, marketState: MarketDataState): MarketState {
  const location = useLocation();
  const [state, setState] = useState<MarketState>([StateType.Loading]);
  const marketRef = useRef(marketState);
  const rewardsState = useContext(RewardsStateContext);

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
        state = await getState(web3.read.provider, marketState[1], rewardsState);
      }

      // Only update state if chainId has not changed since the start of this callback
      // We compare to a ref because the `web3.read.chainId` in the callback can be stale
      if (marketState === marketRef.current) {
        setState(state);
      }
    }
  }, [marketState, rewardsState]);

  useEffect(() => {
    const intervalId = setInterval(refreshData, MARKETS_REFRESH_INTERVAL);
    // refresh data immediately
    refreshData();

    return () => clearInterval(intervalId);
  }, [refreshData]);

  return state;
}

const getState = async (rawProvider: JsonRpcProvider, market: MarketData | MarketDataLoaded, rewardsState: RewardsState): Promise<MarketState> => {
  if (isV2Market(market)) {
    return getV2State();
  }

  if (market.type === 'MarketData') return [StateType.Loading];

  const sleuth = new Sleuth(
    new StaticJsonRpcProvider(rawProvider.connection),
    getSleuthOptions(market.chainInformation.chainId)
  );
  const {
    state: cometResponse,
    reserves,
    targetReserves,
    collateralReserves,
  } = await sleuth.fetch<CometWithReservesResponse, CometWithReservesQuery>(QUERY_WITH_RESERVES, [
    market.marketAddress,
    getBaseAssetPriceFeed(market),
    getIsDeprecatedwUSDMMarket(market.baseAsset, market.chainInformation),
    market.collateralAssets.map((asset) => asset.address),
  ]);

  const factorScale = Number(cometResponse.factorScale);
  const utilizationDescale = factorScale / 1e2;

  const utilizationIntervals = [...Array(101).keys()].map((n) => BigInt(n * utilizationDescale));

  const rateFactorScale = cometResponse.factorScale.toBigInt();
  const borrowRateModel = toRateModel(cometResponse.borrowRateModel);
  const supplyRateModel = toRateModel(cometResponse.supplyRateModel);

  const borrowRates: [bigint, bigint][] = utilizationIntervals.map((interval) => [
    interval,
    aprAt(interval, borrowRateModel, rateFactorScale),
  ]);
  const supplyRates: [bigint, bigint][] = utilizationIntervals.map((interval) => [
    interval,
    aprAt(interval, supplyRateModel, rateFactorScale),
  ]);

  const baseAssetPrice = cometResponse.baseAsset.price.toBigInt();
  const utilization = cometResponse.utilization.toBigInt();

  const borrowAPR = aprAt(utilization, borrowRateModel, rateFactorScale);
  const earnAPR = aprAt(utilization, supplyRateModel, rateFactorScale);

  const totalSupply = cometResponse.totalSupply.toBigInt();
  const totalBorrow = cometResponse.totalBorrow.toBigInt();

  const collateralAssets: TokenWithMarketState[] = market.collateralAssets.flatMap((asset, index) => {
    const assetInfo = cometResponse.collateralAssets.find((info) => info.collateralAsset === asset.address);
    if (!assetInfo) return [];

    return [
      {
        ...asset,
        liquidationPenalty: BigInt(1e18) - asset.liquidationFactor,
        price: adjustCollateralPrice(market.baseAsset.symbol, baseAssetPrice, assetInfo.price.toBigInt()),
        reserves: collateralReserves[index].toBigInt(),
        totalSupply: assetInfo.totalSupply.toBigInt(),
      },
    ];
  });

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
          supplyRate: parseUnits(v3HistoryBucket.supply_apr, FACTOR_PRECISION).toBigInt(),
          borrowRate: parseUnits(v3HistoryBucket.borrow_apr, FACTOR_PRECISION).toBigInt(),
        };
      })
      .sort((a, b) => (a.blockTimestamp > b.blockTimestamp ? 1 : -1));
  } catch (e) {
    console.error('Error fetching historical market data: ', e);
  }

  const baseAssetWithState: ProtocolAndMarketsState['baseAsset'] = {
    ...market.baseAsset,
    balanceOfComet: cometResponse.baseAsset.balanceOfComet.toBigInt(),
    price: baseAssetPrice,
    baseAssetPriceInDollars: cometResponse.nativeAssetInDollars.toBigInt(),
  };

  const totalSupplyValueInDollars = (totalSupply * baseAssetWithState.baseAssetPriceInDollars) / 10n ** BigInt(baseAssetWithState.decimals);

  const totalBorrowValueInDollars = (totalBorrow * baseAssetWithState.baseAssetPriceInDollars) / 10n ** BigInt(baseAssetWithState.decimals);

  const state: ProtocolAndMarketsState = {
    baseAsset: baseAssetWithState,
    borrowRates,
    collateralAssets,
    cometAddress: market.marketAddress,
    totalBaseSupplyUsd: totalSupplyValueInDollars,
    factorScale,
    marketHistory: marketHistoryAsBuckets,
    reserves: reserves.toBigInt(),
    supplyRates,
    targetReserves: targetReserves.toBigInt(),
    totalBorrow,
    totalSupply,
    utilization,
    type: 'ProtocolAndMarketState',
    borrowAPR: borrowAPR,
    earnAPR: earnAPR,
    ...getMarketRewardsAPRs(market, rewardsState, totalSupplyValueInDollars, totalBorrowValueInDollars),
    isRewardsLoading: rewardsState[0] === StateType.Loading,
  };
  return [StateType.Hydrated, state];
};
