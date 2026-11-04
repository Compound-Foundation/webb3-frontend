import { Token, TokenWithAccountState } from '@types';

import { StEthStateResponse } from './sleuth/types';

export const STETH_SYMBOL = 'stETH';
export const WRAPPED_STETH_SYMBOL = 'wstETH';

export function isStETH(symbol: string): boolean {
  return symbol === STETH_SYMBOL;
}

export function isWrappedStETH(symbol: string): boolean {
  return symbol === WRAPPED_STETH_SYMBOL;
}

export function getStETHAccountState(
  wstETHAccountState: TokenWithAccountState,
  stETH: Omit<Token, 'decimals'>,
  { bulkerAllowance, walletBalance, wstETHPerStETH }: StEthStateResponse
): TokenWithAccountState {
  const stETHAccountState = { ...wstETHAccountState };
  if (isStETH(stETH.symbol)) {
    stETHAccountState.balance = 0n;
    stETHAccountState.bulkerAllowance = bulkerAllowance.toBigInt();

    stETHAccountState.price =
      (wstETHAccountState.price * wstETHPerStETH.toBigInt()) / BigInt(10 ** wstETHAccountState.decimals);
    stETHAccountState.walletBalance = walletBalance.toBigInt();

    stETHAccountState.address = stETH.address;
    stETHAccountState.symbol = stETH.symbol;
    stETHAccountState.name = stETH.name;
  }
  return stETHAccountState;
}
