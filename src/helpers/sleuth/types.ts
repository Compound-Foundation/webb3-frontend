import { BigNumber } from 'ethers';

// Ideally these query & response types could be auto-generated with a script
// that parses the structs in the sleuth solidity files in the future.

// Interest rate model parameters, per second at factorScale precision
export type RateModelResponse = {
  kink: BigNumber;
  perSecondInterestRateBase: BigNumber;
  perSecondInterestRateSlopeLow: BigNumber;
  perSecondInterestRateSlopeHigh: BigNumber;
};

export type CometWithAccountStateQuery = [
  string, // comet address
  string, // nativeTokenToUsd (extra price feed)
  string, // account address
  string, // bulker address
  string, // wrapped native token symbol
  boolean // checkDeprecatedwUSDM
];

export type CometWithAccountStateResponse = {
  baseAsset: {
    baseAsset: string;
    bulkerAllowance: BigNumber;
    allowance: BigNumber;
    balance: BigNumber;
    balanceOfComet: BigNumber;
    decimals: BigNumber;
    minBorrow: BigNumber;
    name: string;
    priceFeed: string;
    price: BigNumber;
    symbol: string;
    walletBalance: BigNumber;
  };
  baseMinForRewards: BigNumber;
  baseTrackingBorrowSpeed: BigNumber;
  baseTrackingSupplySpeed: BigNumber;
  borrowRateModel: RateModelResponse;
  bulkerAllowance: BigNumber;
  collateralAssets: {
    collateralAsset: string;
    bulkerAllowance: BigNumber;
    allowance: BigNumber;
    balance: BigNumber;
    collateralFactor: BigNumber;
    decimals: BigNumber;
    name: string;
    liquidateCollateralFactor: BigNumber;
    liquidationFactor: BigNumber;
    price: BigNumber;
    priceFeed: string;
    supplyCap: BigNumber;
    symbol: string;
    totalSupply: BigNumber;
    walletBalance: BigNumber;
  }[];
  factorScale: BigNumber;
  nativeAssetInDollars: BigNumber;
  nativeAssetWalletBalance: BigNumber;
  supplyRateModel: RateModelResponse;
  totalBorrow: BigNumber;
  totalBorrowPrincipal: BigNumber;
  totalSupply: BigNumber;
  totalSupplyPrincipal: BigNumber;
  trackingIndexScale: BigNumber;
  utilization: BigNumber;
};

export type CometStateQuery = [
  string, // comet address
  string, // nativeTokenToUsd (extra price feed)
  boolean // checkDeprecatedwUSDM
];

export type CometStateResponse = {
  baseAsset: {
    baseAsset: string;
    balanceOfComet: BigNumber;
    decimals: BigNumber;
    minBorrow: BigNumber;
    name: string;
    priceFeed: string;
    price: BigNumber;
    symbol: string;
  };
  baseMinForRewards: BigNumber;
  baseTrackingBorrowSpeed: BigNumber;
  baseTrackingSupplySpeed: BigNumber;
  borrowRateModel: RateModelResponse;
  collateralAssets: {
    collateralAsset: string;
    collateralFactor: BigNumber;
    decimals: BigNumber;
    name: string;
    liquidateCollateralFactor: BigNumber;
    liquidationFactor: BigNumber;
    price: BigNumber;
    priceFeed: string;
    supplyCap: BigNumber;
    symbol: string;
    totalSupply: BigNumber;
  }[];
  factorScale: BigNumber;
  nativeAssetInDollars: BigNumber;
  supplyRateModel: RateModelResponse;
  totalBorrow: BigNumber;
  totalBorrowPrincipal: BigNumber;
  totalSupply: BigNumber;
  totalSupplyPrincipal: BigNumber;
  trackingIndexScale: BigNumber;
  utilization: BigNumber;
};
