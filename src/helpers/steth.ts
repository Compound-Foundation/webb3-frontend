import { parseAbi, type Address } from 'viem';

import { readClient } from '@helpers/multicall';
import { Token, TokenWithAccountState } from '@types';

import ERC20 from './abis/ERC20';

const WSTETH_ABI = parseAbi(['function tokensPerStEth() view returns (uint256)']);

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
  client: Pick<ReturnType<typeof readClient>, 'readContract'>
): Promise<TokenWithAccountState> {
  const stETHAccountState = { ...wstETHAccountState };
  if (isStETH(stETH.symbol)) {
    const stETHToken = { address: stETH.address as Address, abi: ERC20 } as const;
    const [stETHBulkerAllowance, wstETHPerStETH, walletBalance] = await Promise.all([
      client.readContract({
        ...stETHToken,
        functionName: 'allowance',
        args: [account as Address, bulkerAddress as Address],
      }),
      client.readContract({
        address: wstETHAccountState.address as Address,
        abi: WSTETH_ABI,
        functionName: 'tokensPerStEth',
      }),
      client.readContract({ ...stETHToken, functionName: 'balanceOf', args: [account as Address] }),
    ]);
    stETHAccountState.balance = 0n;
    stETHAccountState.bulkerAllowance = stETHBulkerAllowance;

    stETHAccountState.price = (wstETHAccountState.price * wstETHPerStETH) / BigInt(10 ** wstETHAccountState.decimals);
    stETHAccountState.walletBalance = walletBalance;

    stETHAccountState.address = stETH.address;
    stETHAccountState.symbol = stETH.symbol;
    stETHAccountState.name = stETH.name;
  }
  return stETHAccountState;
}
