import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import '@testing-library/jest-dom';
import { getSelectedMarketContext, initializeContext } from '@contexts/SelectedMarketContext';
import { LatestMarketSummaryResponse, MarketStatus, SelectedMarketData, StateType } from '@types';

import { MOCK_DEFAULT_MARKET, MockMarketsProvider } from '../../../__tests__/mocks/mockMarkets';
import { mockWeb3 } from '../../../__tests__/mocks/mockWeb3';
import AlertBanner from '../AlertBanner';

const MARKET_DATA_UNAVAILABLE = 'Market temporarily unavailable. Please check back shortly.';

const renderBanner = (path: string, status: MarketStatus) => {
  const selected: SelectedMarketData = {
    selectedMarket: [StateType.Hydrated, MOCK_DEFAULT_MARKET],
    selectMarket: jest.fn(),
    selectMarketByAddress: jest.fn(),
    isSelectedMarketError: false,
  };
  initializeContext(selected);
  const SelectedMarketContext = getSelectedMarketContext();
  const summary = {
    chainId: MOCK_DEFAULT_MARKET.chainInformation.chainId,
    comet: { address: MOCK_DEFAULT_MARKET.marketAddress },
    status,
  } as LatestMarketSummaryResponse;

  render(
    <MemoryRouter initialEntries={[path]}>
      <MockMarketsProvider marketSummaries={[summary]}>
        <SelectedMarketContext.Provider value={selected}>
          <AlertBanner web3={mockWeb3} isCometStateError={false} isMarketsStateError={false} />
        </SelectedMarketContext.Provider>
      </MockMarketsProvider>
    </MemoryRouter>
  );
};

describe('AlertBanner — selected market status', () => {
  test('shows the market data message on Home when the selected market is in the error status', () => {
    renderBanner('/', 'error');
    expect(screen.getByText(MARKET_DATA_UNAVAILABLE)).toBeInTheDocument();
  });

  test('stays hidden for a partially market', () => {
    renderBanner('/', 'partially');
    expect(screen.queryByText(MARKET_DATA_UNAVAILABLE)).not.toBeInTheDocument();
  });

  test('does not show the message outside Home', () => {
    renderBanner('/extensions', 'error');
    expect(screen.queryByText(MARKET_DATA_UNAVAILABLE)).not.toBeInTheDocument();
  });
});
