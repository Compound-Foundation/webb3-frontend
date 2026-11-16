import { JsonRpcProvider } from '@ethersproject/providers';
import { parseUnits } from '@ethersproject/units';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import type { Address } from 'viem';

import RewardsStateContext from '@contexts/RewardsStateContext';
import type { Web3 } from '@contexts/Web3Context';
import Comet from '@helpers/abis/Comet';
import ERC20 from '@helpers/abis/ERC20';
import { adjustCollateralPrice, getBaseAssetPriceFeed } from '@helpers/baseAssetPrice';
import { getHardcodedFeedPrice, getRemappedPriceFeed } from '@helpers/deprecatedMarkets';
import { aprAt, RateModel } from '@helpers/interestRates';
import { isV2Market } from '@helpers/markets';
import { getMockMarketState } from '@helpers/mocks';
import { readClient } from '@helpers/multicall';
import { FACTOR_PRECISION } from '@helpers/numbers';
import { getMarketRewardsAPRs } from '@helpers/rewards';
import { getMarketDataUrlForMarket } from '@helpers/urls';
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

  const client = readClient(rawProvider, market.chainInformation);
  const comet = { address: market.marketAddress as Address, abi: Comet } as const;

  // A deprecated feed's reads revert, so its hardcoded price is used instead of reading it
  const collateralPrice = (priceFeed: string) =>
    getRemappedPriceFeed(priceFeed) === ''
      ? client.readContract({ ...comet, functionName: 'getPrice', args: [priceFeed as Address] })
      : getHardcodedFeedPrice(priceFeed);

  const [
    utilization,
    rateFactorScale,
    reserves,
    totalSupply,
    totalBorrow,
    targetReserves,
    baseTokenPriceInDollars,
    baseAssetPrice,
    baseAssetBalanceOfComet,
    borrowKink,
    borrowBase,
    borrowSlopeLow,
    borrowSlopeHigh,
    supplyKink,
    supplyBase,
    supplySlopeLow,
    supplySlopeHigh,
    ...collaterals
  ] = await Promise.all([
    client.readContract({ ...comet, functionName: 'getUtilization' }),
    client.readContract({ ...comet, functionName: 'factorScale' }),
    client.readContract({ ...comet, functionName: 'getReserves' }),
    client.readContract({ ...comet, functionName: 'totalSupply' }),
    client.readContract({ ...comet, functionName: 'totalBorrow' }),
    client.readContract({ ...comet, functionName: 'targetReserves' }),
    client.readContract({ ...comet, functionName: 'getPrice', args: [getBaseAssetPriceFeed(market) as Address] }),
    client.readContract({ ...comet, functionName: 'getPrice', args: [market.baseAsset.priceFeed as Address] }),
    client.readContract({
      address: market.baseAsset.address as Address,
      abi: ERC20,
      functionName: 'balanceOf',
      args: [market.marketAddress as Address],
    }),
    client.readContract({ ...comet, functionName: 'borrowKink' }),
    client.readContract({ ...comet, functionName: 'borrowPerSecondInterestRateBase' }),
    client.readContract({ ...comet, functionName: 'borrowPerSecondInterestRateSlopeLow' }),
    client.readContract({ ...comet, functionName: 'borrowPerSecondInterestRateSlopeHigh' }),
    client.readContract({ ...comet, functionName: 'supplyKink' }),
    client.readContract({ ...comet, functionName: 'supplyPerSecondInterestRateBase' }),
    client.readContract({ ...comet, functionName: 'supplyPerSecondInterestRateSlopeLow' }),
    client.readContract({ ...comet, functionName: 'supplyPerSecondInterestRateSlopeHigh' }),
    ...market.collateralAssets.map((asset) =>
      Promise.all([
        collateralPrice(asset.priceFeed),
        client.readContract({ ...comet, functionName: 'totalsCollateral', args: [asset.address as Address] }),
        // getCollateralReserves reverts when the asset's balanceOf reverts or Comet's balance drops
        // below its recorded supply. Such a collateral shows 0 reserves instead of breaking the page.
        client
          .readContract({ ...comet, functionName: 'getCollateralReserves', args: [asset.address as Address] })
          .catch(() => 0n),
      ])
    ),
  ]);

  const factorScale = Number(rateFactorScale);
  const utilizationDescale = factorScale / 1e2;

  const utilizationIntervals = [...Array(101).keys()].map((n) => BigInt(n * utilizationDescale));

  const borrowRateModel: RateModel = {
    kink: borrowKink,
    base: borrowBase,
    slopeLow: borrowSlopeLow,
    slopeHigh: borrowSlopeHigh,
  };
  const supplyRateModel: RateModel = {
    kink: supplyKink,
    base: supplyBase,
    slopeLow: supplySlopeLow,
    slopeHigh: supplySlopeHigh,
  };

  const borrowRates: [bigint, bigint][] = utilizationIntervals.map((interval) => [
    interval,
    aprAt(interval, borrowRateModel, rateFactorScale),
  ]);
  const supplyRates: [bigint, bigint][] = utilizationIntervals.map((interval) => [
    interval,
    aprAt(interval, supplyRateModel, rateFactorScale),
  ]);

  const borrowAPR = aprAt(utilization, borrowRateModel, rateFactorScale);
  const earnAPR = aprAt(utilization, supplyRateModel, rateFactorScale);

  const collateralAssets: TokenWithMarketState[] = market.collateralAssets.map((asset, index) => {
    const [price, [totalSupplyAsset], collateralReserves] = collaterals[index];
    return {
      ...asset,
      liquidationPenalty: BigInt(1e18) - asset.liquidationFactor,
      price: adjustCollateralPrice(market.baseAsset.symbol, baseAssetPrice, price),
      reserves: collateralReserves,
      totalSupply: totalSupplyAsset,
    };
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
    balanceOfComet: baseAssetBalanceOfComet,
    price: baseAssetPrice,
    baseAssetPriceInDollars: baseTokenPriceInDollars,
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
    reserves,
    supplyRates,
    targetReserves,
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
