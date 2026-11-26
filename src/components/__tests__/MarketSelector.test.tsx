import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

import '@testing-library/jest-dom';
import { getSelectedMarketContext, initializeContext } from '@contexts/SelectedMarketContext';
import { LATEST_MARKET_SUMMARY_QUERY_KEY } from '@hooks/useMarkets';
import { Theme } from '@hooks/useThemeManager';
import { LatestMarketSummaryResponse, MarketData, MarketStatus, SelectedMarketData, StateType } from '@types';

import {
  MOCK_DEFAULT_MARKET,
  MOCK_MARKET_LIST,
  MOCK_MARKETS,
  MockMarketsProvider,
} from '../../../__tests__/mocks/mockMarkets';
import MarketSelector from '../MarketSelector';

// Mainnet WETH comet; its base asset is displayed as ETH, so look it up by address
const weth = MOCK_MARKETS.find(
  (market) => market.marketAddress.toLowerCase() === '0xa17581a9e3356d9a858b789d68b4d866e593ae94'
) as MarketData;

const summaryWithStatus = (market: MarketData, status: MarketStatus) =>
  ({ chainId: market.chainInformation.chainId, comet: { address: market.marketAddress }, status }) as LatestMarketSummaryResponse;

const renderSelector = (wethStatus: MarketStatus, isWethInactive = false) => {
  const selected: SelectedMarketData = {
    selectedMarket: [StateType.Hydrated, MOCK_DEFAULT_MARKET],
    selectMarket: jest.fn(),
    selectMarketByAddress: jest.fn(),
  };
  initializeContext(selected);
  const SelectedMarketContext = getSelectedMarketContext();

  render(
    <MemoryRouter>
      <MockMarketsProvider marketSummaries={[{ ...summaryWithStatus(weth, wethStatus), isInactive: isWethInactive }]}>
        <SelectedMarketContext.Provider value={selected}>
          <MarketSelector theme={Theme.Dark} />
        </SelectedMarketContext.Provider>
      </MockMarketsProvider>
    </MemoryRouter>
  );
  return selected;
};

const openAndClickWeth = async () => {
  await userEvent.click(screen.getByText(MOCK_DEFAULT_MARKET.baseAsset.symbol));
  const option = screen
    .getAllByText(weth.baseAsset.symbol)
    .map((node) => node.closest('.market-selector__option'))
    .find((node): node is HTMLElement => node !== null);
  if (option === undefined) throw new Error('WETH option not rendered');
  await userEvent.click(option);
  return option;
};

describe('MarketSelector — market statuses', () => {
  test('an error market is marked and cannot be selected', async () => {
    const { selectMarket } = renderSelector('error');
    const option = await openAndClickWeth();

    expect(option).toHaveAttribute('aria-disabled', 'true');
    expect(selectMarket).not.toHaveBeenCalled();
  });

  test('a partially market can be selected', async () => {
    const { selectMarket } = renderSelector('partially');
    await openAndClickWeth();
    expect(selectMarket).toHaveBeenCalledWith({ ...weth, status: 'partially' });
  });
});

describe('MarketSelector — market list refresh', () => {
  test('keeps working when the hovered network leaves the market list', async () => {
    const BASE_CHAIN_ID = 8453;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryDefaults(LATEST_MARKET_SUMMARY_QUERY_KEY, { enabled: false });
    queryClient.setQueryData(LATEST_MARKET_SUMMARY_QUERY_KEY, MOCK_MARKET_LIST);
    const selected: SelectedMarketData = {
      selectedMarket: [StateType.Hydrated, MOCK_DEFAULT_MARKET],
      selectMarket: jest.fn(),
      selectMarketByAddress: jest.fn(),
    };
    initializeContext(selected);
    const SelectedMarketContext = getSelectedMarketContext();
    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <SelectedMarketContext.Provider value={selected}>
            <MarketSelector theme={Theme.Dark} />
          </SelectedMarketContext.Provider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByText(MOCK_DEFAULT_MARKET.baseAsset.symbol));
    await userEvent.hover(screen.getByText('Base'));
    act(() => {
      queryClient.setQueryData(
        LATEST_MARKET_SUMMARY_QUERY_KEY,
        MOCK_MARKET_LIST.filter((entry) => entry.chainId !== BASE_CHAIN_ID),
      );
    });

    await waitFor(() => expect(screen.queryByText('Base')).not.toBeInTheDocument());
    expect(screen.getAllByText(weth.baseAsset.symbol).length).toBeGreaterThan(0);
  });
});

describe('MarketSelector — inactive markets', () => {
  test('lists a network again under the inactive section, showing only its inactive markets there', async () => {
    renderSelector('success', true);
    await userEvent.click(screen.getByText(MOCK_DEFAULT_MARKET.baseAsset.symbol));

    expect(screen.getByText('Inactive Markets')).toBeInTheDocument();
    const ethereumOptions = screen
      .getAllByText('Ethereum')
      .map((node) => node.closest('.market-selector__option'))
      .filter((node): node is HTMLElement => node !== null);
    expect(ethereumOptions).toHaveLength(2);
    expect(screen.queryByText(weth.baseAsset.symbol)).not.toBeInTheDocument();

    await userEvent.hover(ethereumOptions[1]);

    expect(screen.getByText(weth.baseAsset.symbol)).toBeInTheDocument();
  });
});
