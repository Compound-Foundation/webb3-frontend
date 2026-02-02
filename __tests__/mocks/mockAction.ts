import {
  Action,
  ActionType,
  BaseAssetAction,
  BaseAssetWithAccountState,
  CollateralAction,
  PendingAction,
  TokenWithAccountState,
} from '@types';

import { mockBaseAsset } from './mockBaseAsset';

type BaseActionOverrides = Partial<{
  actionType: BaseAssetAction;
  baseAssetWithAccountState: Partial<BaseAssetWithAccountState>;
  amount: bigint;
}>;
export const mockBaseAction = (overrides?: BaseActionOverrides): Action => [
  overrides?.actionType || ActionType.Borrow,
  {
    address: '0x07865c6E87B9F70255377e024ace6630C1Eaa37F',
    allowance: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
    balance: 0n,
    balanceOfComet: 111797201714593570n,
    baseAssetPriceInDollars: 99973018n,
    borrowCapacity: 15691847494n,
    bulkerAllowance: 60248205070716n,
    decimals: 6,
    minBorrow: 1000000000n,
    name: 'USD Coin',
    price: 99973018n,
    priceFeed: '0xAb5c49580294Aff77670F839ea425f5b78ab3Ae7',
    symbol: 'USDC',
    walletBalance: 60258205070718n,
    ...overrides?.baseAssetWithAccountState,
  },
  overrides?.amount || 10000000000n,
];

export const mockPendingBaseAction = (overrides?: BaseActionOverrides): PendingAction => [
  overrides?.actionType || ActionType.Borrow,
  {
    address: '0x07865c6E87B9F70255377e024ace6630C1Eaa37F',
    allowance: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
    balance: 0n,
    balanceOfComet: 111797201714593570n,
    baseAssetPriceInDollars: 99973018n,
    borrowCapacity: 15691847494n,
    bulkerAllowance: 60248205070716n,
    decimals: 6,
    minBorrow: 1000000000n,
    name: 'USD Coin',
    price: 99973018n,
    priceFeed: '0xAb5c49580294Aff77670F839ea425f5b78ab3Ae7',
    symbol: 'USDC',
    walletBalance: 60258205070718n,
    ...overrides?.baseAssetWithAccountState,
  },
  overrides?.amount,
];

type CollateralActionOverrides = Partial<{
  actionType: CollateralAction;
  tokenWithAccountState: Partial<TokenWithAccountState>;
  amount: bigint;
}>;
export const mockCollateralAction = (overrides?: CollateralActionOverrides): Action => [
  overrides?.actionType || ActionType.SupplyCollateral,
  {
    address: '0x42a71137C09AE83D8d05974960fd607d40033499',
    allowance: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
    balance: 10000000000000000000n,
    bulkerAllowance: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
    collateralFactor: 820000000000000000n,
    decimals: 18,
    liquidateCollateralFactor: 850000000000000000n,
    liquidationFactor: 930000000000000000n,
    name: 'Ether',
    price: 191312360000n,
    priceFeed: '0xD4a33860578De61DBAbDc8BFdb98FD742fA7028e',
    supplyCap: 999999000000000000000000n,
    symbol: 'ETH',
    totalSupply: 133145918599526636569n,
    walletBalance: 64331553326910480601n,
    ...overrides?.tokenWithAccountState,
  },
  overrides?.amount || 1000000000000000000n,
];

export const mockPendingSupplyCollateralAction = (overrides?: CollateralActionOverrides): PendingAction => [
  ActionType.SupplyCollateral,
  {
    address: '0x42a71137C09AE83D8d05974960fd607d40033499',
    allowance: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
    balance: 10000000000000000000n,
    bulkerAllowance: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
    collateralFactor: 820000000000000000n,
    decimals: 18,
    liquidateCollateralFactor: 850000000000000000n,
    liquidationFactor: 930000000000000000n,
    name: 'Ether',
    price: 191312360000n,
    priceFeed: '0xD4a33860578De61DBAbDc8BFdb98FD742fA7028e',
    supplyCap: 999999000000000000000000n,
    symbol: 'ETH',
    totalSupply: 133145918599526636569n,
    walletBalance: 64331553326910480601n,
    ...overrides?.tokenWithAccountState,
  },
  overrides?.amount || 1000000000000000000n,
];

export const mockPendingWithdrawCollateralAction = (overrides?: CollateralActionOverrides): PendingAction => [
  ActionType.WithdrawCollateral,
  {
    address: '0x42a71137C09AE83D8d05974960fd607d40033499',
    allowance: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
    balance: 10000000000000000000n,
    bulkerAllowance: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
    collateralFactor: 820000000000000000n,
    decimals: 18,
    liquidateCollateralFactor: 850000000000000000n,
    liquidationFactor: 930000000000000000n,
    name: 'Ether',
    price: 191312360000n,
    priceFeed: '0xD4a33860578De61DBAbDc8BFdb98FD742fA7028e',
    supplyCap: 999999000000000000000000n,
    symbol: 'ETH',
    totalSupply: 133145918599526636569n,
    walletBalance: 64331553326910480601n,
    ...overrides?.tokenWithAccountState,
  },
  mockBaseAsset(),
  overrides?.amount || 0n,
];
