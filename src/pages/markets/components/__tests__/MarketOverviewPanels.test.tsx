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
