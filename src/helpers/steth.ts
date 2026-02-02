import { Contract, Provider } from 'ethers-multicall';

import { Token, TokenWithAccountState } from '@types';

import ERC20 from './abis/ERC20';
import WstETH from './abis/WstETH';

export const STETH_SYMBOL = 'stETH';
export const WRAPPED_STETH_SYMBOL = 'wstETH';

export function isStETH(symbol: string): boolean {
  return symbol === STETH_SYMBOL;
}

export function isWrappedStETH(symbol: string): boolean {
  return symbol === WRAPPED_STETH_SYMBOL;
}

export async function getStETHAccountState(
  account: string,
  wstETHAccountState: TokenWithAccountState,
  stETH: Omit<Token, 'decimals'>,
  bulkerAddress: string,
  provider: Provider
): Promise<TokenWithAccountState> {
  const stETHAccountState = { ...wstETHAccountState };
  if (isStETH(stETH.symbol)) {
    const [stETHBulkerAllowance, wstETHPerStETH, walletBalance] = await provider.all([
      new Contract(stETH.address, ERC20).allowance(account, bulkerAddress),
      new Contract(wstETHAccountState.address, WstETH).tokensPerStEth(),
      new Contract(stETH.address, ERC20).balanceOf(account),
    ]);
    stETHAccountState.balance = 0n;
    stETHAccountState.bulkerAllowance = stETHBulkerAllowance.toBigInt();

    stETHAccountState.price =
      (wstETHAccountState.price * wstETHPerStETH.toBigInt()) / BigInt(10 ** wstETHAccountState.decimals);
    stETHAccountState.walletBalance = walletBalance.toBigInt();

    stETHAccountState.address = stETH.address;
    stETHAccountState.symbol = stETH.symbol;
    stETHAccountState.name = stETH.name;
  }
  return stETHAccountState;
}
