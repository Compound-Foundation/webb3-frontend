# Hide Legacy Markets in app.compound.xyz (COM-19)

## Summary

On the Markets overview page, group the legacy/inactive market chains (Scroll, Linea,
Ronin) into a collapsible "Inactive Markets" section rendered below the core market
panels. The section is collapsed by default and revealed via a minimal text toggle.

This is a presentation-only change — no data, API, or market-definition changes.

## Linear

- Issue: COM-19 — "Hide Legacy Markets in app.compound.xyz"
- https://linear.app/compoundfoundation/issue/COM-19/hide-legacy-markets-in-appcompoundxyz

## Context

The Markets page (`src/pages/markets/index.tsx`) renders
`MarketOverviewPanels` (`src/pages/markets/components/MarketOverviewPanels.tsx`).
That component:

1. Groups `latestMarketSummaries` by `chainId` into `marketSummariesByChain`.
2. Sorts markets within each chain by the user-selected sort criteria.
3. Maps `Object.keys(marketSummariesByChain)` to one `Panel` per chain.
4. Renders a trailing "Looking for V2?" panel.

There is currently no concept of "core" vs "inactive" markets — all chains render
equally in sequence.

## Design

### 1. Configurable inactive-chain list

Add a constant to `src/constants/chains.ts` (co-located with `CHAINS`):

```ts
// Chains whose markets are considered inactive/legacy and hidden behind the
// "Inactive Markets" toggle on the Markets overview page.
export const INACTIVE_CHAIN_IDS: ReadonlySet<number> = new Set([
  534352, // Scroll
  59144,  // Linea
  2020,   // Ronin
]);
```

Adding/removing an inactive chain later is a one-line edit. A `Set` gives O(1)
membership checks and avoids accidental duplicates.

### 2. Partition chains in `MarketOverviewPanels`

Where the component currently does:

```tsx
{Object.keys(marketSummariesByChain).map((chainId) => (
  <Panel key={chainId} chainId={Number(chainId)} marketSummaries={...} />
))}
```

Partition the chain IDs into two groups by membership in `INACTIVE_CHAIN_IDS`:

- `coreChainIds` — everything not in the set.
- `inactiveChainIds` — everything in the set (that actually has summaries).

The existing grouping and in-place sorting logic is untouched; we only split the
list of chain IDs we iterate over when rendering.

### 3. Render

- Render `coreChainIds` panels first, exactly as today.
- If `inactiveChainIds.length > 0`, render a minimal text toggle below the core
  panels:
  - Backed by `const [showInactive, setShowInactive] = useState(false)` — collapsed
    by default.
  - Label: "Show inactive markets" when collapsed, "Hide inactive markets" when
    expanded.
  - Styled with existing label/button classes (e.g. `label L2 text-color--2`) to
    match the page; minimal-to-no new CSS.
- When `showInactive` is true, render the `inactiveChainIds` panels (normal `Panel`
  components) below the toggle.
- The existing "Looking for V2?" panel remains at the very bottom.

### 4. Styling

Reuse existing classes from the page. Add new CSS only if needed to position the
toggle button (e.g. spacing above/below). Keep additions minimal and consistent
with the existing `market-overview-panels__*` naming convention if any new class
is required.

## Edge cases

- If none of the inactive chains have markets in the API response, the toggle does
  not render at all (guarded by `inactiveChainIds.length > 0`).
- If an inactive chain has no summaries, its panel simply does not appear — same
  behavior as today.
- Sorting controls continue to apply to both core and inactive panels.
- The loading skeleton (`MarketOverviewPanelsLoading`) is unchanged.

## Out of scope

- The `MarketSelector` dropdown and any other place markets are listed.
- Any change to market definitions (`src/helpers/markets.ts`) or API behavior.
- Removing or deprecating the legacy markets themselves.

## Testing

- Verify core chains render above the toggle and the three inactive chains render
  only when expanded.
- Verify the toggle is collapsed on initial load.
- Verify the toggle is absent when no inactive-chain markets are present.
- Verify sorting still applies within inactive panels once expanded.
