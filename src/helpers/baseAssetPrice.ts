import { BigNumber } from 'ethers';

import { MarketData, MarketDataLoaded } from '@types';

import { PRICE_PRECISION } from './numbers';
import { CometStateResponse, CometWithAccountStateResponse } from './sleuth/types';

export const getBaseAssetPriceFeed = (market: MarketData | MarketDataLoaded): string => {
  const baseAssetSymbol = market.baseAsset.symbol;
  let baseAssetPriceFeed;
  if (market.type === 'MarketData') {
    baseAssetPriceFeed = market.chainInformation.extraPriceFeeds.nativeTokenToUsd;
  } else {
    baseAssetPriceFeed = market.baseAsset.priceFeed;
  }

  if (market.chainInformation.nativeToken.symbol === baseAssetSymbol) {
    baseAssetPriceFeed = market.chainInformation.extraPriceFeeds?.nativeTokenToUsd;
  } else if (market.chainInformation.extraPriceFeeds.otherBaseTokensToUsd) {
    if (market.chainInformation.extraPriceFeeds.otherBaseTokensToUsd[baseAssetSymbol]) {
      baseAssetPriceFeed = market.chainInformation.extraPriceFeeds.otherBaseTokensToUsd[baseAssetSymbol];
    }
  }

  return baseAssetPriceFeed;
};

//TODO: This is not entirely correct because some base assets are in the Native Token (ie: ETH)
//      while others are in USD...
export const getBaseAssetDollarPrice = (
  cometResponse: CometStateResponse | CometWithAccountStateResponse,
  market: MarketData | MarketDataLoaded
): BigNumber => {
  return cometResponse.baseAsset.symbol === `W${market.chainInformation.nativeToken.symbol}` ||
    cometResponse.baseAsset.symbol === `wstETH` ||
    cometResponse.baseAsset.symbol === `WBTC` ||
    (market.chainInformation.chainId === 2020 && cometResponse.baseAsset.symbol === 'WETH')
    ? cometResponse.nativeAssetInDollars
    : cometResponse.baseAsset.price;
};

export const isNonStablecoinMarket = (baseAssetSymbol: string): boolean => {
  return (
    baseAssetSymbol === 'ETH' ||
    baseAssetSymbol === 'wstETH' ||
    baseAssetSymbol === 'WBTC' ||
    baseAssetSymbol === 'WETH' ||
    baseAssetSymbol === 'RON'
  );
};

export const adjustCollateralPrice = (
  baseAssetSymbol: string,
  baseAssetPrice: bigint,
  collateralPrice: bigint
): bigint => {
  if (baseAssetSymbol === 'AERO') {
    return BigInt(Math.floor(Number(collateralPrice) * 10 ** PRICE_PRECISION)) / baseAssetPrice;
  } else {
    return collateralPrice;
  }
};

// Adjust value based on AERO's unique calc requirements -- if asset is 'AERO' we use a fixed factor of 10^8, otherwise we use provided asset price
export const adjustValueForAeroAsset = (value: bigint, baseAssetSymbol: string, baseAssetPrice: bigint): bigint => {
  return baseAssetSymbol === 'AERO' ? value * BigInt(10 ** 8) : value * baseAssetPrice;
};
