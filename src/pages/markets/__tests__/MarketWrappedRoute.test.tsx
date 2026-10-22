import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router';

import { WRAPPED_MARKET_REGISTRY } from '@constants/wrappedMarkets';
import * as SelectedMarketContextHelpers from '@contexts/SelectedMarketContext';
import { STANDARD_LENDING, WrappedLending, WrappedLendingContext } from '@contexts/WrappedLendingContext';
import { getMarket } from '@helpers/markets';
import { MarketData, StateType } from '@types';

import { mockWeb3 } from '../../../../__tests__/mocks/mockWeb3';
import Market from '../Market';

// Panels that need chart or market data are replaced with markers; the test is about which
// account-specific notices the page shows.
function mockMarker(testId: string) {
  return { __esModule: true, default: () => <div data-testid={testId} /> };
}
jest.mock('../components/WhitelistStatusBanner', () => mockMarker('whitelist-status-banner'));
jest.mock('../components/MarketStatsPanel', () => mockMarker('market-stats'));
jest.mock('../components/MarketRatesPanel', () => mockMarker('market-rates'));
jest.mock('../components/RateModelPanel', () => mockMarker('rate-model'));
jest.mock('../components/AdditionalMarketDataPanel', () => mockMarker('additional-data'));
jest.mock('../components/MarketHistoryPanel', () => mockMarker('market-history'));
jest.mock('../components/CollateralAssetsPanel', () => mockMarker('collateral-assets'));
jest.mock('@components/IconPair', () => mockMarker('icon-pair'));

const INSTITUTIONAL_COMET = '0x207158a267CBD2598BB3d611D8CBdEE2709F2F8C';
const INSTITUTIONAL_MARKET = getMarket(1, INSTITUTIONAL_COMET) as MarketData;

jest.mock('../hooks/useMarketsState', () => ({
  useMarketsState: () => [
    'hydrated',
    {
      type: 'ProtocolAndMarketState',
      borrowAPR: 0n,
      borrowRewardsAPR: 0n,
      borrowRates: [],
      earnAPR: 40_000_000_000_000_000n,
      baseAsset: { symbol: 'USDC', decimals: 6, price: 100_000_000n, baseAssetPriceInDollars: 100_000_000n },
      collateralAssets: [],
      reserves: 0n,
      supplyRates: [],
      totalBorrow: 0n,
      totalSupply: 0n,
      utilization: 0n,
      isInstitutional: true,
      supplyRewardsAPR: 30_000_000_000_000_000n,
      rewardsAssetSymbol: 'USDC',
      isRewardsLoading: false,
      marketHistory: [],
    },
  ],
}));

SelectedMarketContextHelpers.initializeContext({
  selectedMarket: [StateType.Hydrated, INSTITUTIONAL_MARKET],
  selectMarket: jest.fn(),
  selectMarketByAddress: jest.fn(),
});

function wrappedLending(): WrappedLending {
  const lookup = WRAPPED_MARKET_REGISTRY.lookup(1, INSTITUTIONAL_COMET);
  if (lookup.status !== 'valid') throw new Error('the mapping must be valid');
  return {
    route: {
      kind: 'wrapped',
      chainId: 1,
      cometAddress: INSTITUTIONAL_COMET,
      lookup,
      market: lookup.market,
      validationKey: 'key',
      reads: { isEligible: true },
      deposit: { isEligible: false, reason: 'deposits-disabled' },
      exit: { isEligible: false, reason: 'exits-disabled' },
    },
    position: { status: 'loading' },
    retry: jest.fn(),
    action: STANDARD_LENDING.action,
    write: STANDARD_LENDING.write,
  };
}

function renderMarket(lending: WrappedLending) {
  const SelectedMarketContext = SelectedMarketContextHelpers.getSelectedMarketContext();
  render(
    <MemoryRouter>
      <WrappedLendingContext.Provider value={lending}>
        <SelectedMarketContext.Provider
          value={{
            selectedMarket: [StateType.Hydrated, INSTITUTIONAL_MARKET],
            selectMarket: jest.fn(),
            selectMarketByAddress: jest.fn(),
          }}
        >
          <Market web3={mockWeb3} />
        </SelectedMarketContext.Provider>
      </WrappedLendingContext.Provider>
    </MemoryRouter>
  );
}

describe('Market page and the wrapped route', () => {
  it('explains the wrapped route and hides the account boost banner', () => {
    renderMarket(wrappedLending());

    expect(screen.getByText(/you supply to this market goes through its wrapper/)).toBeInTheDocument();
    expect(screen.queryByTestId('whitelist-status-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('market-rates')).toBeInTheDocument();
  });

  it('keeps the account boost banner and shows no notice on the standard route', () => {
    renderMarket(STANDARD_LENDING);

    expect(screen.queryByText(/goes through its wrapper/)).not.toBeInTheDocument();
    expect(screen.getByTestId('whitelist-status-banner')).toBeInTheDocument();
  });
});
