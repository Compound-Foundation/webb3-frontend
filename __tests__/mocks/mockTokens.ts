import { BaseAsset, BaseAssetConfig, BaseAssetWithAccountState, BaseAssetWithState, Token } from '@types';

export const MockUSDCToken: Token = {
  address: '0x07865c6E87B9F70255377e024ace6630C1Eaa37F',
  decimals: 6,
  name: 'USD Coin',
  symbol: 'USDC',
};

export const MockBaseAssetConfig: BaseAssetConfig = {
  symbol: 'USDC',
  name: 'USD Coin',
};

export const MockBaseAsset: BaseAsset = {
  ...MockBaseAssetConfig,
  ...MockUSDCToken,
  minBorrow: 1000000n,
  priceFeed: '0xAb5c49580294Aff77670F839ea425f5b78ab3Ae7',
};

export const MockBaseAssetWithState: BaseAssetWithState = {
  ...MockBaseAsset,
  balanceOfComet: 8402209360n,
  price: 99980000n,
  baseAssetPriceInDollars: 99980000n,
};

export const MockBaseAssetWithAccountState: BaseAssetWithAccountState = {
  ...MockBaseAssetWithState,
  allowance: 115792089237316195423570985008687907853269984665640564039457584007913124639935n,
  balance: 5004447061n,
  borrowCapacity: 3494435137n,
  bulkerAllowance: 0n,
  walletBalance: 5069028428530n,
};
