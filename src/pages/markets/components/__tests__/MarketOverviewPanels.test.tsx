import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

import '@testing-library/jest-dom';
import { MARKETS_TOP_COLLATERAL_KEY } from '@helpers/constants';
import { LatestMarketSummaries, MarketSummary } from '@types';

import { MockMarketsProvider } from '../../../../../__tests__/mocks/mockMarkets';
import MarketOverviewPanels from '../MarketOverviewPanels';

const makeSummary = (chainId: number, address: string, overrides: Partial<MarketSummary> = {}): MarketSummary => ({
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
  topCollateralAssetSymbols: [],
  date: '2026-06-22',
  borrowRewardsAPR: 0n,
  supplyRewardsAPR: 0n,
  ...overrides,
});

const renderPanels = (summaries: LatestMarketSummaries) =>
  render(
    <MemoryRouter initialEntries={['/markets']}>
      <MockMarketsProvider>
        <Routes>
          <Route path="/markets" element={<MarketOverviewPanels latestMarketSummaries={summaries} />} />
          <Route path="/markets/:market" element={<div>Market page</div>} />
        </Routes>
      </MockMarketsProvider>
    </MemoryRouter>
  );

describe('MarketOverviewPanels — inactive markets', () => {
  const coreSummary = makeSummary(1, '0xcore'); // Ethereum (core)
  const scrollSummary = makeSummary(534352, '0xscroll'); // Scroll (inactive)

  test('hides inactive chain panels behind a collapsed toggle by default', () => {
    renderPanels([coreSummary, scrollSummary]);
    expect(screen.getByText('Ethereum')).toBeInTheDocument();
    expect(screen.queryByText('Scroll')).not.toBeInTheDocument();
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

describe('MarketOverviewPanels — market statuses', () => {
  // Ethereum USDC comet from the mock market list
  const USDC_COMET = '0xc3d688b66703497daa19211eedff47f25384cdc3';

  // jsdom doesn't implement scrolling, which a row click does after navigating
  beforeEach(() => jest.spyOn(window, 'scrollTo').mockImplementation(() => undefined));

  const getRow = (assetName: string) => screen.getByText(assetName).closest('tr') as HTMLElement;

  test('shows N/A instead of numbers for a market in the error status', () => {
    renderPanels([
      makeSummary(1, USDC_COMET, { status: 'error', utilization: 5n * 10n ** 17n, totalSupplyValue: 10n ** 12n }),
    ]);

    expect(within(getRow('USD Coin')).getAllByText('N/A')).toHaveLength(7);
  });

  test('does not open the market page for a market in the error status', async () => {
    renderPanels([makeSummary(1, USDC_COMET, { status: 'error' })]);

    await userEvent.click(getRow('USD Coin'));

    expect(screen.queryByText('Market page')).not.toBeInTheDocument();
  });

  test('shows the numbers of a partially working market and still opens its page', async () => {
    renderPanels([makeSummary(1, USDC_COMET, { status: 'partially' })]);

    const row = getRow('USD Coin');
    expect(within(row).queryByText('N/A')).not.toBeInTheDocument();

    await userEvent.click(row);

    expect(screen.getByText('Market page')).toBeInTheDocument();
  });

  test('marks the icons of collaterals in the error status', () => {
    renderPanels([
      makeSummary(1, USDC_COMET, {
        status: 'partially',
        collateralAssetSymbols: ['WBTC', 'LINK'],
        topCollateralAssetSymbols: ['WBTC', 'LINK'],
        errorCollateralSymbols: ['LINK'],
      }),
    ]);

    const icons = getRow('USD Coin').querySelectorAll('.market-overview-panels__collateral-asset-icon');
    expect(icons[0]).not.toHaveClass('market-overview-panels__collateral-asset-icon--error');
    expect(icons[1]).toHaveClass('market-overview-panels__collateral-asset-icon--error');
  });
});

describe('MarketOverviewPanels — top collateral toggle', () => {
  const USDC_COMET = '0xc3d688b66703497daa19211eedff47f25384cdc3';

  beforeEach(() => window.localStorage.clear());

  test('shows only the top collaterals until the toggle is turned off, and remembers it', async () => {
    renderPanels([
      makeSummary(1, USDC_COMET, { collateralAssetSymbols: ['WBTC', 'COMP'], topCollateralAssetSymbols: ['WBTC'] }),
    ]);
    const getIcons = () =>
      (screen.getByText('USD Coin').closest('tr') as HTMLElement).querySelectorAll(
        '.market-overview-panels__collateral-asset-icon'
      );
    expect(getIcons()).toHaveLength(1);

    await userEvent.click(screen.getByRole('checkbox', { name: /Show top collateral only/ }));

    expect(getIcons()).toHaveLength(2);
    expect(window.localStorage.getItem(MARKETS_TOP_COLLATERAL_KEY)).toBe('false');
  });
});
