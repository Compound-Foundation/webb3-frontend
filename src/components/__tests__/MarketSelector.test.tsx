import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

import '@testing-library/jest-dom';
import { getSelectedMarketContext, initializeContext } from '@contexts/SelectedMarketContext';
import { LatestMarketSummaryResponse, MarketData, MarketStatus, SelectedMarketData, StateType } from '@types';

import { MOCK_DEFAULT_MARKET, MOCK_MARKETS, MockMarketsProvider } from '../../../__tests__/mocks/mockMarkets';
import MarketSelector from '../MarketSelector';

// Mainnet WETH comet; its base asset is displayed as ETH, so look it up by address
const weth = MOCK_MARKETS.find(
  (market) => market.marketAddress.toLowerCase() === '0xa17581a9e3356d9a858b789d68b4d866e593ae94'
) as MarketData;

const summaryWithStatus = (market: MarketData, status: MarketStatus) =>
  ({ chainId: market.chainInformation.chainId, comet: { address: market.marketAddress }, status }) as LatestMarketSummaryResponse;

const renderSelector = (wethStatus: MarketStatus) => {
  const selected: SelectedMarketData = {
    selectedMarket: [StateType.Hydrated, MOCK_DEFAULT_MARKET],
    selectMarket: jest.fn(),
    selectMarketByAddress: jest.fn(),
  };
  initializeContext(selected);
  const SelectedMarketContext = getSelectedMarketContext();

  render(
    <MemoryRouter>
      <MockMarketsProvider marketSummaries={[summaryWithStatus(weth, wethStatus)]}>
        <SelectedMarketContext.Provider value={selected}>
          <MarketSelector />
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
