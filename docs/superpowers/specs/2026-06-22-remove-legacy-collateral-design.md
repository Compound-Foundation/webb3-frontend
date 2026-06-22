# Remove Legacy Collateral Assets in ETH Mainnet Comets (COM-18)

## Summary

Hide a fixed set of legacy collateral assets from specific Ethereum Mainnet
(chainId 1) Comets in the app.compound.xyz webapp. The removal applies to both the
individual market detail page and the Markets overview "Collateral Assets" icon
column. On the detail page, a removed collateral is still shown when the connected
user holds a positive collateral balance of it, so existing positions remain
visible and withdrawable.

## Linear

- Issue: COM-18 — "Remove legacy collateral assets in ETH Mainnet Comets for new
  app.compound.xyz webapp"
- https://linear.app/compoundfoundation/issue/COM-18/remove-legacy-collateral-assets-in-eth-mainnet-comets-for-new

## Collateral assets to remove (Ethereum Mainnet, chainId 1)

| Comet (base asset) | Collateral symbols to remove |
| --- | --- |
| USDT | mETH, weETH, sdeUSD, wUSDM, deUSD, USDe |
| USDC | rsETH, USDe, deUSD, sdeUSD |
| wstETH | rsETH, ezETH, weETH |
| WBTC | LBTC, pumpBTC |
| USDS | USDe, sdeUSD, tBTC, weETH, deUSD |

(The ticket writes "wUSDm" / "pumpBTC"; matching is case-insensitive.)

## Context / current behavior

- **Detail page** collateral comes from on-chain reads:
  `CometQuery.sol` → `queryCometData(WithAccount)` → `formatCometStateHydrated`
  (`src/hooks/useCometState.ts`). Each collateral asset is a `TokenWithAccountState`
  with a display `symbol` (already resolved via `getAssetDisplaySymbol`) and, when an
  account is connected, a `balance` (collateral supplied in the Comet).
- There is an existing precedent: `useCometState.ts` (~lines 115-132) filters out
  **wUSDM** by token address with a "temporary fix … TODO: remove" comment. wUSDM is
  in this ticket's USDT list, so this block is superseded and folded into the new
  config.
- **Overview** collateral comes from a different source: the v3-api
  `collateralAssetSymbols: string[]` per market summary
  (`src/pages/markets/hooks/useMarketsOverviewState.ts`). It has no per-user balance.
- Markets are identified by `chainId` + base-asset symbol; collateral assets carry
  both an address and a display symbol.

## Design

### 1. New module: `src/helpers/legacyCollateral.ts`

Single source of truth, keyed per Comet by `${chainId}:${baseAssetSymbol}`
(case-insensitive), listing collateral **display symbols** to hide:

```ts
const LEGACY_COLLATERAL_BY_COMET: Record<string, string[]> = {
  '1:USDT': ['mETH', 'weETH', 'sdeUSD', 'wUSDM', 'deUSD', 'USDe'],
  '1:USDC': ['rsETH', 'USDe', 'deUSD', 'sdeUSD'],
  '1:wstETH': ['rsETH', 'ezETH', 'weETH'],
  '1:WBTC': ['LBTC', 'pumpBTC'],
  '1:USDS': ['USDe', 'sdeUSD', 'tBTC', 'weETH', 'deUSD'],
};
```

Exports:

```ts
// True if `collateralSymbol` is a removed legacy collateral for the given Comet.
// Case-insensitive on both the base-asset symbol (key) and the collateral symbol.
export function isLegacyCollateral(
  chainId: number,
  baseAssetSymbol: string,
  collateralSymbol: string,
): boolean;

// Overview helper: drop legacy symbols, preserving the order of the rest.
export function filterLegacyCollateralSymbols(
  chainId: number,
  baseAssetSymbol: string,
  symbols: string[],
): string[];
```

Implementation notes:
- Internally build a normalized lookup (lowercased base key → Set of lowercased
  collateral symbols) so checks are O(1) and case-insensitive.
- Unconfigured chains/comets return `false` / the unchanged list.

### 2. Detail page — `src/hooks/useCometState.ts`

Replace the wUSDM block (~lines 115-132) with a generic filter over
`collateralAssets`, using the in-scope market (`marketState[1]`) for
`chainId` and `baseAsset.symbol`. Keep an asset when:

> it is **not** legacy for this Comet, **OR** the user holds a positive collateral
> `balance` of it.

Sketch:

```ts
const market = marketState[1];
const [, marketStateWithCollaterals] = state;
if (market && marketStateWithCollaterals) {
  const { chainId } = market.chainInformation;
  const baseSymbol = market.baseAsset.symbol;
  marketStateWithCollaterals.collateralAssets = marketStateWithCollaterals.collateralAssets.filter(
    (asset) => {
      if (!isLegacyCollateral(chainId, baseSymbol, asset.symbol)) return true;
      const balance = 'balance' in asset ? (asset as TokenWithAccountState).balance : 0n;
      return balance > 0n; // keep legacy asset only if the user still holds it
    },
  );
}
```

In the NoWallet (not-logged-in) state there is no balance, so legacy assets are
hidden. The on-chain `checkDeprecatedwUSDM` price-feed logic is unrelated and left
unchanged.

### 3. Overview icons — `src/pages/markets/hooks/useMarketsOverviewState.ts`

The overview has no per-user balance, so legacy symbols are removed
**unconditionally**. For each market summary, resolve the base-asset symbol from its
comet address via `getMarketDescriptors(comet.address, chainId)`, then apply
`filterLegacyCollateralSymbols(chainId, baseSymbol, collateralAssetSymbols)`. Do this
in the existing sanitize/map step so rendering stays unchanged. The displayed icon
count drops accordingly.

## Behavioral note

A user holding a removed collateral (e.g. weETH in USDT) still sees it on the
**detail** page (so they can withdraw), but the **overview** icon count will not
include it. This is intentional: the overview is global market info, not
user-specific.

## Edge cases

- Symbols are matched case-insensitively (`wUSDm` vs `wUSDM`, `pumpBTC` vs `pumpbtc`).
- Only chainId 1 comets are configured; all other chains/markets are unaffected.
- A Comet not present in the config is unaffected.
- Removing wUSDM's bespoke address filter changes wUSDM behavior from
  "always hidden" to "hidden unless held" — consistent with the chosen approach and
  more correct for users with existing positions.

## Out of scope

- Changing the v3-api response itself (overview filter is client-side).
- Blocking on-chain interactions beyond hiding from the UI list.
- Any non-mainnet markets, or markets other than USDT/USDC/wstETH/WBTC/USDS.

## Testing

- Unit tests for `legacyCollateral.ts`:
  - `isLegacyCollateral` returns true for each configured (comet, symbol) pair.
  - Case-insensitive matches (`wusdm`, `pumpbtc`).
  - Returns false for unconfigured comets, other chains, and non-legacy symbols.
  - `filterLegacyCollateralSymbols` drops exactly the legacy symbols and preserves
    the order of remaining symbols.
- A focused test that the overview sanitize step strips legacy symbols for a mainnet
  summary and leaves non-mainnet summaries untouched.
- Detail-page keep-if-held behavior is a one-line use of `isLegacyCollateral` in
  `useCometState`, covered by the helper's unit tests and the design reasoning.
