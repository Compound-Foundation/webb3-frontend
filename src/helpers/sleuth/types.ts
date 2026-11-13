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

export type OperatorAllowancesQuery = [
  string, // comet address
  string, // account address
  string[] // operator addresses
];

// One allowance per operator, in the order of the query
export type OperatorAllowancesResponse = BigNumber[];

export type CometWithAccountStateQuery = [
  string, // comet address
  string, // nativeTokenToUsd (extra price feed)
  string, // account address
  string, // bulker address
  string, // wrapped native token symbol
  boolean // checkDeprecatedwUSDM
];

export type CometWithAccountAndStEthQuery = [
  ...CometWithAccountStateQuery,
  string, // stETH address, or the zero address
  string // wstETH address, or the zero address
];

export type StEthStateResponse = {
  bulkerAllowance: BigNumber;
  walletBalance: BigNumber;
  wstETHPerStETH: BigNumber;
};

export type CometWithAccountAndStEthResponse = {
  state: CometWithAccountStateResponse;
  stETHState: StEthStateResponse;
};

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

export type CometWithReservesQuery = [
  string, // comet address
  string, // nativeTokenToUsd (extra price feed)
  boolean, // checkDeprecatedwUSDM
  string[] // collateral assets to read reserves for
];

export type CometWithReservesResponse = {
  state: CometStateResponse;
  reserves: BigNumber;
  targetReserves: BigNumber;
  // Same order as the query's collateral assets
  collateralReserves: BigNumber[];
};

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
