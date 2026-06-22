# Hide Legacy Markets Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group the Scroll, Linea, and Ronin market chains into a collapsible "Inactive Markets" section (collapsed by default) below the core market panels on the Markets overview page.

**Architecture:** Presentation-only change in `MarketOverviewPanels`. A configurable `INACTIVE_CHAIN_IDS` set in `src/constants/chains.ts` drives a partition of the per-chain panels into core vs. inactive. Inactive panels render only when a `useState`-backed text toggle is expanded.

**Tech Stack:** React, TypeScript, Vite, Jest + React Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-06-22-hide-legacy-markets-design.md`

---

### Task 1: Add configurable inactive-chain constant

**Files:**
- Modify: `src/constants/chains.ts` (append after the `CHAINS` export)

- [ ] **Step 1: Add the constant**

Add to the bottom of `src/constants/chains.ts`:

```ts
/**
 * Chains whose markets are considered inactive/legacy. Their market panels are
 * hidden behind the "Inactive Markets" toggle on the Markets overview page.
 * Edit this set to add/remove inactive chains.
 */
export const INACTIVE_CHAIN_IDS: ReadonlySet<number> = new Set([
  534352, // Scroll
  59144, // Linea
  2020, // Ronin
]);
```

- [ ] **Step 2: Verify it typechecks**

Run: `yarn lint` (or `npx tsc --noEmit`)
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/constants/chains.ts
git commit -m "feat: add INACTIVE_CHAIN_IDS constant (COM-19)"
```

---

### Task 2: Split core/inactive panels with a collapsible toggle (TDD)

**Files:**
- Create: `src/pages/markets/components/__tests__/MarketOverviewPanels.test.tsx`
- Modify: `src/pages/markets/components/MarketOverviewPanels.tsx`

**Notes for the implementer:**
- `getMarketDescriptors(address, chainId)` returns `['UNKNOWN', 'Unknown', 'Unknown']` for
  unknown comet addresses (it does not throw), so fixtures can use arbitrary addresses.
- `Panel` renders its header from `CHAINS[chainId].name` — so chain names ("Ethereum",
  "Scroll", etc.) are reliable text to assert on.
- `PanelRow` calls `useNavigate`, so the component must be rendered inside a router
  (`MemoryRouter`).

- [ ] **Step 1: Write the failing test**

Create `src/pages/markets/components/__tests__/MarketOverviewPanels.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import '@testing-library/jest-dom';
import { LatestMarketSummaries, MarketSummary } from '@types';

import MarketOverviewPanels from '../MarketOverviewPanels';

const makeSummary = (chainId: number, address: string): MarketSummary => ({
  chainId,
  comet: { address },
  borrowAPR: 0n,
  supplyAPR: 0n,
  totalBorrowValue: 0n,
  totalSupplyValue: 0n,
  totalCollateralValue: 0n,
  utilization: 0n,
  timestamp: 0,
  collateralAssetSymbols: [],
  date: '2026-06-22',
});

const renderPanels = (summaries: LatestMarketSummaries) =>
  render(
    <MemoryRouter>
      <MarketOverviewPanels latestMarketSummaries={summaries} />
    </MemoryRouter>
  );

describe('MarketOverviewPanels — inactive markets', () => {
  const coreSummary = makeSummary(1, '0xcore'); // Ethereum (core)
  const scrollSummary = makeSummary(534352, '0xscroll'); // Scroll (inactive)

  test('hides inactive chain panels behind a collapsed toggle by default', () => {
    renderPanels([coreSummary, scrollSummary]);

    // Core chain panel is visible
    expect(screen.getByText('Ethereum')).toBeInTheDocument();
    // Inactive chain panel is hidden initially
    expect(screen.queryByText('Scroll')).not.toBeInTheDocument();
    // Collapsed toggle is shown
    expect(screen.getByText('Show inactive markets')).toBeInTheDocument();
  });

  test('reveals inactive chain panels when the toggle is clicked', async () => {
    renderPanels([coreSummary, scrollSummary]);

    await userEvent.click(screen.getByText('Show inactive markets'));

    expect(screen.getByText('Scroll')).toBeInTheDocument();
    expect(screen.getByText('Hide inactive markets')).toBeInTheDocument();
  });

  test('does not render the toggle when there are no inactive markets', () => {
    renderPanels([coreSummary]);

    expect(screen.queryByText('Show inactive markets')).not.toBeInTheDocument();
    expect(screen.getByText('Ethereum')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/pages/markets/components/__tests__/MarketOverviewPanels.test.tsx`
Expected: FAIL — "Scroll" still rendered / no "Show inactive markets" toggle exists yet.

- [ ] **Step 3: Implement the partition + toggle**

In `src/pages/markets/components/MarketOverviewPanels.tsx`:

1. Add imports:

```tsx
import { CHAINS, INACTIVE_CHAIN_IDS } from '@constants/chains';
```

(Replace the existing `import { CHAINS } from '@constants/chains';` line.)

2. Add toggle state alongside the existing `useState` hooks in `MarketOverviewPanels`:

```tsx
const [showInactive, setShowInactive] = useState<boolean>(false);
```

3. Replace the panels-mapping block (currently):

```tsx
{Object.keys(marketSummariesByChain).map((chainId) => {
  return <Panel key={chainId} chainId={Number(chainId)} marketSummaries={marketSummariesByChain[chainId]} />;
})}
```

with:

```tsx
{(() => {
  const chainIds = Object.keys(marketSummariesByChain).map(Number);
  const coreChainIds = chainIds.filter((id) => !INACTIVE_CHAIN_IDS.has(id));
  const inactiveChainIds = chainIds.filter((id) => INACTIVE_CHAIN_IDS.has(id));

  return (
    <>
      {coreChainIds.map((chainId) => (
        <Panel key={chainId} chainId={chainId} marketSummaries={marketSummariesByChain[chainId]} />
      ))}

      {inactiveChainIds.length > 0 && (
        <div className="market-overview-panels__tables-container">
          <button
            className="button market-overview-panels__inactive-toggle L2 text-color--2"
            onClick={() => setShowInactive((prev) => !prev)}
          >
            <label className="label L2 text-color--2">
              {showInactive ? 'Hide inactive markets' : 'Show inactive markets'}
            </label>
          </button>
        </div>
      )}

      {showInactive &&
        inactiveChainIds.map((chainId) => (
          <Panel key={chainId} chainId={chainId} marketSummaries={marketSummariesByChain[chainId]} />
        ))}
    </>
  );
})()}
```

Note: keep the trailing "Looking for V2?" panel exactly where it is, after this block.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/pages/markets/components/__tests__/MarketOverviewPanels.test.tsx`
Expected: PASS (all three tests).

- [ ] **Step 5: Run lint/typecheck**

Run: `yarn lint`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/pages/markets/components/MarketOverviewPanels.tsx src/pages/markets/components/__tests__/MarketOverviewPanels.test.tsx
git commit -m "feat: hide legacy markets behind Inactive Markets toggle (COM-19)"
```

---

### Task 3: (Optional) Style the toggle button

**Files:**
- Modify: `styles/components/_market-overview-panels.scss`

- [ ] **Step 1: Open** `styles/components/_market-overview-panels.scss` (defines `market-overview-panels__*` styles).

- [ ] **Step 2: Add minimal styling** for `market-overview-panels__inactive-toggle` (e.g. left-align, cursor pointer, vertical spacing) consistent with neighboring controls. Only add what's needed for it to look intentional.

- [ ] **Step 3: Verify visually**

Run: `yarn dev`, open the Markets page, confirm the toggle sits below the core panels, is collapsed by default, and reveals Scroll/Linea/Ronin when clicked.

- [ ] **Step 4: Commit**

```bash
git add <scss-file>
git commit -m "style: Inactive Markets toggle button (COM-19)"
```

---

## Manual verification checklist

- [ ] Markets page loads with the "Inactive Markets" toggle collapsed.
- [ ] Scroll, Linea, Ronin panels are hidden until the toggle is expanded.
- [ ] All other chains remain visible above the toggle.
- [ ] Sorting controls still apply to inactive panels once expanded.
- [ ] Toggle is absent if no inactive-chain markets are returned by the API.
