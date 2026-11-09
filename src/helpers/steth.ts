export const STETH_SYMBOL = 'stETH';
export const WRAPPED_STETH_SYMBOL = 'wstETH';

export function isStETH(symbol: string): boolean {
  return symbol === STETH_SYMBOL;
}

export function isWrappedStETH(symbol: string): boolean {
  return symbol === WRAPPED_STETH_SYMBOL;
}
