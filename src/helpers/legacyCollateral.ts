/**
 * Legacy collateral assets to hide per Comet, keyed by `${chainId}:${baseAssetSymbol}`.
 * Matching is case-insensitive on both the base-asset symbol and the collateral symbol.
 * Source: Linear COM-18.
 */
const LEGACY_COLLATERAL_BY_COMET: Record<string, string[]> = {
  '1:USDT': ['mETH', 'weETH', 'sdeUSD', 'wUSDM', 'deUSD', 'USDe'],
  '1:USDC': ['rsETH', 'USDe', 'deUSD', 'sdeUSD'],
  '1:wstETH': ['rsETH', 'ezETH', 'weETH'],
  '1:WBTC': ['LBTC', 'pumpBTC'],
  '1:USDS': ['USDe', 'sdeUSD', 'tBTC', 'weETH', 'deUSD'],
};

const NORMALIZED: Record<string, Set<string>> = Object.entries(LEGACY_COLLATERAL_BY_COMET).reduce(
  (acc, [key, symbols]) => {
    acc[key.toLowerCase()] = new Set(symbols.map((s) => s.toLowerCase()));
    return acc;
  },
  {} as Record<string, Set<string>>
);

const cometKey = (chainId: number, baseAssetSymbol: string): string =>
  `${chainId}:${baseAssetSymbol}`.toLowerCase();

/**
 * True if `collateralSymbol` is a removed legacy collateral for the given Comet.
 */
export function isLegacyCollateral(chainId: number, baseAssetSymbol: string, collateralSymbol: string): boolean {
  const removed = NORMALIZED[cometKey(chainId, baseAssetSymbol)];
  return removed !== undefined && removed.has(collateralSymbol.toLowerCase());
}

/**
 * Drop legacy collateral symbols for the given Comet, preserving the order of the rest.
 */
export function filterLegacyCollateralSymbols(
  chainId: number,
  baseAssetSymbol: string,
  symbols: string[]
): string[] {
  return symbols.filter((symbol) => !isLegacyCollateral(chainId, baseAssetSymbol, symbol));
}

/**
 * Whether a collateral asset should remain visible on a market detail page.
 * Non-legacy assets are always kept; a legacy asset is kept only when the user
 * still holds a positive collateral balance of it (so it can be withdrawn).
 */
export function shouldKeepCollateralAsset(
  chainId: number,
  baseAssetSymbol: string,
  collateralSymbol: string,
  balance: bigint
): boolean {
  if (!isLegacyCollateral(chainId, baseAssetSymbol, collateralSymbol)) {
    return true;
  }
  return balance > 0n;
}
