# Remove Legacy Collateral Assets Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide a fixed per-Comet set of legacy collateral assets from the Ethereum Mainnet USDT/USDC/wstETH/WBTC/USDS markets, on both the market detail page (unless the user holds a balance) and the Markets overview icon column.

**Architecture:** A new `src/helpers/legacyCollateral.ts` module holds the per-Comet deny-list (keyed by `chainId:baseAssetSymbol`, case-insensitive) and two pure helpers. The detail page (`useCometState.ts`) filters on-chain collateral, keeping a legacy asset only when the user's collateral balance is positive. The overview hook (`useMarketsOverviewState.ts`) filters the API's `collateralAssetSymbols` unconditionally.

**Tech Stack:** React, TypeScript, Vite, Jest + ts-jest (jsdom).

**Spec:** `docs/superpowers/specs/2026-06-22-remove-legacy-collateral-design.md`

---

### Task 1: Legacy-collateral config + helpers (TDD)

**Files:**
- Create: `src/helpers/legacyCollateral.ts`
- Create: `src/helpers/__tests__/legacyCollateral.test.ts`

**Notes:** Existing helper unit tests live under `src/helpers/__tests__/` or `__tests__/`. Use ts-jest; these are pure functions (no React, no DOM). The path alias `@helpers` maps to `src/helpers`.

- [ ] **Step 1: Write the failing test**

Create `src/helpers/__tests__/legacyCollateral.test.ts`:

```ts
import { isLegacyCollateral, filterLegacyCollateralSymbols } from '@helpers/legacyCollateral';

describe('isLegacyCollateral', () => {
  test('returns true for configured (comet, symbol) pairs', () => {
    expect(isLegacyCollateral(1, 'USDT', 'mETH')).toBe(true);
    expect(isLegacyCollateral(1, 'USDT', 'USDe')).toBe(true);
    expect(isLegacyCollateral(1, 'USDC', 'rsETH')).toBe(true);
    expect(isLegacyCollateral(1, 'wstETH', 'ezETH')).toBe(true);
    expect(isLegacyCollateral(1, 'WBTC', 'LBTC')).toBe(true);
    expect(isLegacyCollateral(1, 'WBTC', 'pumpBTC')).toBe(true);
    expect(isLegacyCollateral(1, 'USDS', 'tBTC')).toBe(true);
  });

  test('is case-insensitive on both base and collateral symbol', () => {
    expect(isLegacyCollateral(1, 'usdt', 'wusdm')).toBe(true);
    expect(isLegacyCollateral(1, 'WBTC', 'pumpbtc')).toBe(true);
    expect(isLegacyCollateral(1, 'WstEth', 'WEETH')).toBe(true);
  });

  test('returns false for non-legacy symbols, other comets, and other chains', () => {
    expect(isLegacyCollateral(1, 'USDT', 'WBTC')).toBe(false); // not in USDT list
    expect(isLegacyCollateral(1, 'WBTC', 'weETH')).toBe(false); // weETH not removed from WBTC
    expect(isLegacyCollateral(1, 'ETH', 'USDe')).toBe(false); // ETH comet not configured
    expect(isLegacyCollateral(10, 'USDT', 'mETH')).toBe(false); // wrong chain
  });
});

describe('filterLegacyCollateralSymbols', () => {
  test('drops legacy symbols and preserves order of the rest', () => {
    const input = ['WBTC', 'mETH', 'COMP', 'USDe', 'LINK'];
    expect(filterLegacyCollateralSymbols(1, 'USDT', input)).toEqual(['WBTC', 'COMP', 'LINK']);
  });

  test('returns the list unchanged for unconfigured comets', () => {
    const input = ['WBTC', 'COMP'];
    expect(filterLegacyCollateralSymbols(1, 'ETH', input)).toEqual(['WBTC', 'COMP']);
    expect(filterLegacyCollateralSymbols(8453, 'USDC', input)).toEqual(['WBTC', 'COMP']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/helpers/__tests__/legacyCollateral.test.ts`
Expected: FAIL — module `@helpers/legacyCollateral` does not exist.

- [ ] **Step 3: Implement the module**

Create `src/helpers/legacyCollateral.ts`:

```ts
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

// Normalized lookup: lowercased `${chainId}:${baseSymbol}` -> Set of lowercased collateral symbols.
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/helpers/__tests__/legacyCollateral.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/helpers/legacyCollateral.ts src/helpers/__tests__/legacyCollateral.test.ts
git commit -m "feat: add legacy-collateral config and helpers (COM-18)"
```

---

### Task 2: Filter legacy collateral on the market detail page

**Files:**
- Modify: `src/hooks/useCometState.ts` (the wUSDM block, ~lines 115-132)

**Notes:** The hook has `marketState` in scope (`marketState[1]` is the `MarketData`, or undefined). `marketState[1].baseAsset.symbol` and `marketState[1].chainInformation.chainId` identify the Comet. Collateral assets carry a display `symbol`; in the logged-in (Hydrated) state they also carry `balance: bigint` (collateral supplied). In the not-logged-in state there is no balance. This task replaces the existing hardcoded wUSDM address filter (wUSDM is already in the USDT list), changing wUSDM from "always hidden" to "hidden unless held" — this is the intended new behavior.

- [ ] **Step 1: Add the import**

Add to the imports in `src/hooks/useCometState.ts`:

```ts
import { isLegacyCollateral } from '@helpers/legacyCollateral';
```

- [ ] **Step 2: Replace the wUSDM block**

Replace this existing block (~lines 115-132):

```ts
  /**
   * This is a temporary fix for the USDT market.
   *
   * The code block below avoids the usage of the wUSDM collateral on the UI.
   *
   * TODO: Remove this once the collateral is fixed.
   */
  {
    const [, marketStateWithCollaterals] = state;

    if (marketStateWithCollaterals) {
      marketStateWithCollaterals.collateralAssets = marketStateWithCollaterals.collateralAssets.filter(
        ({ address }) => {
          return address.toLowerCase() !== '0x57f5e098cad7a3d1eed53991d4d66c45c9af7812';
        }
      );
    }
  }
```

with:

```ts
  /**
   * Hide legacy collateral assets per Comet (Linear COM-18). A removed asset is
   * still shown when the connected user holds a positive collateral balance of it,
   * so existing positions remain visible and withdrawable.
   */
  {
    const market = marketState[1];
    const [, marketStateWithCollaterals] = state;

    if (market && marketStateWithCollaterals) {
      const { chainId } = market.chainInformation;
      const baseSymbol = market.baseAsset.symbol;
      marketStateWithCollaterals.collateralAssets = marketStateWithCollaterals.collateralAssets.filter((asset) => {
        if (!isLegacyCollateral(chainId, baseSymbol, asset.symbol)) {
          return true;
        }
        const balance = 'balance' in asset ? (asset.balance as bigint) : 0n;
        return balance > 0n;
      });
    }
  }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no NEW errors referencing `useCometState.ts` (pre-existing unrelated errors elsewhere are acceptable). If `'balance' in asset` does not narrow cleanly, keep the `(asset.balance as bigint)` cast as written.

- [ ] **Step 4: Run the existing suite to confirm nothing broke**

Run: `yarn test`
Expected: all suites pass (no test currently asserts wUSDM-specific behavior).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useCometState.ts
git commit -m "feat: hide legacy collateral on market detail page, keep if held (COM-18)"
```

---

### Task 3: Filter legacy collateral icons on the Markets overview

**Files:**
- Modify: `src/pages/markets/hooks/useMarketsOverviewState.ts` (`sanitizeMarketSummary`, ~lines 132 and 160)

**Notes:** `sanitizeMarketSummary` already resolves `const [baseAsset] = getMarketDescriptors(marketSummary.comet.address, marketSummary.chainId)` (line ~132) and has `marketSummary.chainId`. The overview has no per-user balance, so legacy symbols are removed unconditionally. The existing test mock contains no legacy symbols, so existing overview tests are unaffected.

- [ ] **Step 1: Add the import**

Add to the imports in `src/pages/markets/hooks/useMarketsOverviewState.ts`:

```ts
import { filterLegacyCollateralSymbols } from '@helpers/legacyCollateral';
```

- [ ] **Step 2: Apply the filter in the returned object**

In `sanitizeMarketSummary`, change the returned `collateralAssetSymbols` (currently `collateralAssetSymbols: marketSummary.collateralAssetSymbols,`) to:

```ts
    collateralAssetSymbols: filterLegacyCollateralSymbols(
      marketSummary.chainId,
      baseAsset,
      marketSummary.collateralAssetSymbols
    ),
```

(`baseAsset` is the destructured value already computed at ~line 132.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors referencing `useMarketsOverviewState.ts`.

- [ ] **Step 4: Run the overview test + full suite**

Run: `yarn test`
Expected: all suites pass, including `__tests__/pages/markets/hooks/useMarketsOverviewState.test.tsx` (its mock has no legacy symbols, so expectations are unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/pages/markets/hooks/useMarketsOverviewState.ts
git commit -m "feat: hide legacy collateral icons on markets overview (COM-18)"
```

---

## Manual verification checklist

(Dev server: `.env.local` is already configured with public prod hosts; `yarn dev` → http://localhost:5173)

- [ ] On http://localhost:5173/markets, the mainnet USDT/USDC/wstETH/WBTC/USDS rows show a reduced "Collateral Assets" icon count (legacy assets gone).
- [ ] Open each of those markets (e.g. `/markets/usdt-mainnet`): the removed collaterals no longer appear in the collateral table when not held.
- [ ] (If feasible) With a wallet holding a removed collateral as supplied collateral, that asset still appears on the detail page so it can be withdrawn.
- [ ] Non-mainnet markets and non-listed mainnet collaterals are unchanged.
