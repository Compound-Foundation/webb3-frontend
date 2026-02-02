import { BaseAssetWithAccountState } from '@types';

export const mockBaseAsset = (overrides?: Partial<BaseAssetWithAccountState>): BaseAssetWithAccountState => ({
  address: '0x07865c6E87B9F70255377e024ace6630C1Eaa37F',
  allowance: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
  balance: 0n,
  balanceOfComet: 111797201714593570n,
  baseAssetPriceInDollars: 99973018n,
  borrowCapacity: 15691847494n,
  bulkerAllowance: 0n,
  decimals: 6,
  minBorrow: 1000000000n,
  name: 'USD Coin',
  price: 99973018n,
  priceFeed: '0xAb5c49580294Aff77670F839ea425f5b78ab3Ae7',
  symbol: 'USDC',
  walletBalance: 60258205070718n,
  ...overrides,
});
