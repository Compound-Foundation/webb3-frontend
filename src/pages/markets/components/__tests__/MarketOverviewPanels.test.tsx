import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

import '@testing-library/jest-dom';
import { WRAPPED_MARKET_REGISTRY } from '@constants/wrappedMarkets';
import { WrappedLendingContext } from '@contexts/WrappedLendingContext';
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
  borrowRewardsAPR: 0n,
  supplyRewardsAPR: 0n
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

describe('MarketOverviewPanels — wrapped positions', () => {
  const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';

  test('shows the market totals as reported, without adding a wrapped position', () => {
    const lookup = WRAPPED_MARKET_REGISTRY.lookup(1, USDC_COMET);
    if (lookup.status !== 'valid') throw new Error('the mapping must be valid');
    const summary: MarketSummary = {
      ...makeSummary(1, USDC_COMET),
      totalSupplyValue: 100_000_000_000_000n, // $1,000,000 at 8 decimals
    };

    render(
      <WrappedLendingContext.Provider
        value={{
          route: {
            kind: 'wrapped',
            chainId: 1,
            cometAddress: USDC_COMET,
            lookup,
            market: lookup.market,
            validationKey: 'key',
            reads: { isEligible: true },
            deposit: { isEligible: false, reason: 'deposits-disabled' },
            exit: { isEligible: false, reason: 'exits-disabled' },
          },
          position: {
            status: 'loaded',
            position: {
              shares: 500_000n * 10n ** 18n,
              shareDecimals: 18,
              grossAssets: 500_000_000_000n,
              baseDecimals: 6,
              baseWalletBalance: 0n,
              wrapperAllowance: 0n,
              redeemBuffer: 3n,
              fullExitCash: 499_999_999_997n,
              snapshot: { totalSupply: 0n, totalAssets: 0n, baseSupplyIndex: 0n },
            },
          },
          retry: () => undefined,
        }}
      >
        <MemoryRouter>
          <MarketOverviewPanels latestMarketSummaries={[summary]} />
        </MemoryRouter>
      </WrappedLendingContext.Provider>
    );

    expect(screen.getAllByText('$1.00M').length).toBeGreaterThan(0);
    expect(screen.queryByText('$1.50M')).not.toBeInTheDocument();
  });
});
