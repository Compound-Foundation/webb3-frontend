import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ReactElement } from 'react';

import { CurrencyManagerContext } from '@contexts/CurrencyContext';
import { WrappedPosition } from '@helpers/wrappedPositions';
import { Theme } from '@hooks/useThemeManager';
import { WrappedPositionState } from '@hooks/useWrappedPosition';
import { Action, ActionType, BaseAssetWithAccountState, Currency, StateType } from '@types';

import { MockBaseAssetWithAccountState } from '../../../../../__tests__/mocks/mockTokens';
import Masthead, { MastheadState } from '../../components/Masthead';

type RenderOptions = {
  baseAssetPost?: BaseAssetWithAccountState;
  compare?: boolean;
  currency?: Currency;
  wrappedPosition?: WrappedPositionState;
};

const mastheadState = (
  baseAsset: BaseAssetWithAccountState,
  isDirectBaseSupplyBlocked: boolean,
  actions: Action[],
  { baseAssetPost, compare = false, wrappedPosition }: RenderOptions
): MastheadState => [
  StateType.Hydrated,
  {
    actions,
    baseAsset,
    baseAssetPost: baseAssetPost ?? baseAsset,
    borrowAPR: 0n,
    borrowRewardsAPR: 0n,
    collateralAssets: [],
    collateralValue: 0n,
    collateralValuePost: 0n,
    compare,
    earnAPR: 0n,
    earnRewardsAPR: 0n,
    liquidationCapacity: 0n,
    liquidationCapacityPost: 0n,
    onSupplyAction: () => undefined,
    onWithdrawAction: () => undefined,
    setCompare: () => undefined,
    theme: Theme.Dark,
    isInstitutional: false,
    isDirectBaseSupplyBlocked,
    wrappedPosition,
  },
];

// Without a provider the masthead reads the default context, which shows dollars first.
const withCurrency = (currency: Currency | undefined, element: ReactElement) =>
  currency === undefined ? (
    element
  ) : (
    <CurrencyManagerContext.Provider
      value={{
        currency,
        counterCurrency: currency === Currency.USD ? Currency.USDC : Currency.USD,
        pressDownAnimate: false,
        setPressDownAnimate: () => undefined,
        pressUpAnimate: false,
        setPressUpAnimate: () => undefined,
        toggleCurrency: () => undefined,
        updateShowCurrencyToggle: () => undefined,
        showCurrencyToggle: false,
        baseAssetSymbol: 'USDC',
      }}
    >
      {element}
    </CurrencyManagerContext.Provider>
  );

const mastheadElement = (
  baseAsset: BaseAssetWithAccountState,
  isDirectBaseSupplyBlocked: boolean,
  actions: Action[],
  options: RenderOptions
) =>
  withCurrency(
    options.currency,
    <div>
      <div id="overlay"></div>
      <Masthead state={mastheadState(baseAsset, isDirectBaseSupplyBlocked, actions, options)} />
    </div>
  );

const renderMasthead = (
  baseAsset: BaseAssetWithAccountState,
  isDirectBaseSupplyBlocked: boolean,
  actions: Action[] = [],
  options: RenderOptions = {}
) => render(mastheadElement(baseAsset, isDirectBaseSupplyBlocked, actions, options));

// 250.125 USDC of wrapped supply. The mock base asset holds 5,004.447061 USDC directly, at a
// price of $0.9998.
const POSITION: WrappedPosition = {
  shares: 250n * 10n ** 18n,
  shareDecimals: 18,
  grossAssets: 250_125_000n,
  baseDecimals: 6,
  baseWalletBalance: 42_500_000n,
  wrapperAllowance: 0n,
  redeemBuffer: 3n,
  fullExitCash: 250_124_997n,
  isWithdrawPaused: false,
  snapshot: { totalSupply: 0n, totalAssets: 0n, baseSupplyIndex: 0n },
};
const loaded = (position: WrappedPosition = POSITION): WrappedPositionState => ({ status: 'loaded', position });

const headline = () => screen.getByRole('heading', { level: 1 });

describe('Masthead on the wrapped route', () => {
  const emptyAccount = { ...MockBaseAssetWithAccountState, balance: 0n };
  const borrower = { ...MockBaseAssetWithAccountState, balance: -1_000_000_000n };

  it('does not offer a direct base supply to an empty account', () => {
    renderMasthead(emptyAccount, true);

    expect(screen.queryByRole('button', { name: 'Supply USDC' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Borrow USDC' })).toBeEnabled();
  });

  it('leaves borrowing exactly as on the standard route', () => {
    const noCapacity = { ...emptyAccount, borrowCapacity: 0n };

    renderMasthead(noCapacity, true);
    expect(screen.getByRole('button', { name: 'Borrow USDC' })).toBeDisabled();
  });

  it('still offers repaying a direct borrow', () => {
    renderMasthead(borrower, true);

    expect(screen.getByRole('button', { name: 'Repay USDC' })).toBeInTheDocument();
  });

  it('offers the direct base supply on the standard route', () => {
    renderMasthead(emptyAccount, false);

    expect(screen.getByRole('button', { name: 'Supply USDC' })).toBeEnabled();
  });

  describe('headline balance with a wrapped position', () => {
    it('adds the wrapped value to the direct balance in the base token', () => {
      renderMasthead(MockBaseAssetWithAccountState, true, [], {
        currency: Currency.USDC,
        wrappedPosition: loaded(),
      });

      // 5,004.447061 + 250.125 = 5,254.572061 USDC, shown to four places.
      expect(headline()).toHaveTextContent('5,254.5721');
      expect(screen.getByText('Supplying')).toBeInTheDocument();
    });

    it('adds the wrapped value to the direct balance in dollars', () => {
      renderMasthead(MockBaseAssetWithAccountState, true, [], {
        currency: Currency.USD,
        wrappedPosition: loaded(),
      });

      // 5,254.572061 USDC at $0.9998 is $5,253.5211.
      expect(headline()).toHaveTextContent('$5,253.52');
    });

    it('names the wrapped part of the headline in the base token', () => {
      renderMasthead(MockBaseAssetWithAccountState, true, [], {
        currency: Currency.USDC,
        wrappedPosition: loaded(),
      });

      expect(screen.getByText('Includes 250.1250 USDC wrapped')).toBeInTheDocument();
    });

    it('names the wrapped part of the headline in dollars', () => {
      renderMasthead(MockBaseAssetWithAccountState, true, [], {
        currency: Currency.USD,
        wrappedPosition: loaded(),
      });

      // 250.125 USDC at $0.9998 is $250.074975.
      expect(screen.getByText('Includes $250.07 wrapped')).toBeInTheDocument();
    });

    it('shows a wrapped-only supplier as supplying, with the Net APR', () => {
      renderMasthead(emptyAccount, true, [], { currency: Currency.USDC, wrappedPosition: loaded() });

      expect(headline()).toHaveTextContent('250.1250');
      expect(screen.getByText('Supplying')).toBeInTheDocument();
      expect(screen.getByText(/Net APR/)).toBeInTheDocument();
      expect(screen.getByText('Includes 250.1250 USDC wrapped')).toBeInTheDocument();
      // The buttons still follow the direct balance: there is no direct supply to withdraw.
      expect(screen.queryByRole('button', { name: 'Withdraw USDC' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Borrow USDC' })).toBeEnabled();
    });

    it('adds nothing for a wrapped position worth zero', () => {
      renderMasthead(emptyAccount, true, [], {
        currency: Currency.USDC,
        wrappedPosition: loaded({ ...POSITION, shares: 0n, grossAssets: 0n, fullExitCash: 0n }),
      });

      expect(headline()).toHaveTextContent('0.0000');
      expect(screen.getByText('Balance')).toBeInTheDocument();
      expect(screen.queryByText(/wrapped/)).toBeNull();
    });

    it('adds the wrapped value on both sides of a direct action', () => {
      const supply: Action = [ActionType.Supply, MockBaseAssetWithAccountState, 1_000_000_000n];
      const after = { ...MockBaseAssetWithAccountState, balance: 6_004_447_061n };
      const options = { baseAssetPost: after, currency: Currency.USDC, wrappedPosition: loaded() };

      const { unmount } = renderMasthead(MockBaseAssetWithAccountState, false, [supply], options);
      expect(screen.getByText('After Transaction')).toBeInTheDocument();
      expect(headline()).toHaveTextContent('6,254.5721');
      unmount();

      renderMasthead(MockBaseAssetWithAccountState, false, [supply], { ...options, compare: true });
      expect(screen.getByText('Before Transaction')).toBeInTheDocument();
      expect(headline()).toHaveTextContent('5,254.5721');
    });

    it('updates the headline when the panel position refreshes', () => {
      const options = { currency: Currency.USDC, wrappedPosition: loaded() };
      const { rerender } = renderMasthead(MockBaseAssetWithAccountState, true, [], options);
      expect(headline()).toHaveTextContent('5,254.5721');

      // A wrapped supply of 100 USDC settled, and the panel read the larger position.
      const larger = { ...POSITION, grossAssets: 350_125_000n, fullExitCash: 350_124_997n };
      rerender(
        mastheadElement(MockBaseAssetWithAccountState, true, [], { ...options, wrappedPosition: loaded(larger) })
      );

      expect(headline()).toHaveTextContent('5,354.5721');
      expect(screen.getByText('Includes 350.1250 USDC wrapped')).toBeInTheDocument();
    });

    it.each<[string, WrappedPositionState]>([
      ['loading', { status: 'loading' }],
      ['unavailable', { status: 'unavailable', reason: 'wrong-chain' }],
      ['failed to read', { status: 'error', message: 'The read failed.' }],
    ])('shows the direct balance alone while the position is %s', (_, wrappedPosition) => {
      renderMasthead(MockBaseAssetWithAccountState, true, [], { currency: Currency.USDC, wrappedPosition });

      expect(headline()).toHaveTextContent('5,004.4471');
      expect(screen.queryByText(/wrapped|wrapper/)).toBeNull();
    });

    it('shows a wrapped-only supplier a zero balance, not a stand-in, while the position loads', () => {
      renderMasthead(emptyAccount, true, [], { currency: Currency.USDC, wrappedPosition: { status: 'loading' } });

      expect(screen.getByText('Balance')).toBeInTheDocument();
      expect(screen.queryByText(/wrapped|wrapper/)).toBeNull();
    });
  });

  describe('a direct borrow alongside a wrapped supply', () => {
    it('keeps the borrow headline and shows the wrapped supply beneath it', () => {
      renderMasthead(borrower, true, [], { currency: Currency.USDC, wrappedPosition: loaded() });

      expect(screen.getByText('Borrowing')).toBeInTheDocument();
      expect(headline()).toHaveTextContent('1,000.0000');
      expect(screen.getByText('Plus 250.1250 USDC supplied through the wrapper')).toBeInTheDocument();
      expect(screen.queryByText(/Includes/)).toBeNull();
    });

    it('shows the wrapped supply beneath the borrow in dollars', () => {
      renderMasthead(borrower, true, [], { currency: Currency.USD, wrappedPosition: loaded() });

      // 1,000 USDC at $0.9998 is $999.80. The wrapped value does not net against it.
      expect(headline()).toHaveTextContent('$999.80');
      expect(screen.getByText('Plus $250.07 supplied through the wrapper')).toBeInTheDocument();
    });

    it('keeps the borrow buttons and the utilization meter as they are without the position', () => {
      const withoutPosition = renderMasthead(borrower, true, [], { currency: Currency.USDC });
      const buttonsWithout = screen.getAllByRole('button').map((button) => button.textContent);
      const meterWithout = withoutPosition.container.querySelector('.masthead')?.lastElementChild?.outerHTML;
      withoutPosition.unmount();

      const withPosition = renderMasthead(borrower, true, [], { currency: Currency.USDC, wrappedPosition: loaded() });
      expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(buttonsWithout);
      expect(withPosition.container.querySelector('.masthead')?.lastElementChild?.outerHTML).toEqual(meterWithout);
    });

    it('shows no wrapped line while the position is loading', () => {
      renderMasthead(borrower, true, [], { currency: Currency.USDC, wrappedPosition: { status: 'loading' } });

      expect(headline()).toHaveTextContent('1,000.0000');
      expect(screen.queryByText(/wrapper/)).toBeNull();
    });
  });

  describe('figures other than the headline', () => {
    it('leaves the utilization meter to the direct position', () => {
      const withoutPosition = renderMasthead(MockBaseAssetWithAccountState, true, [], { currency: Currency.USDC });
      const meterWithout = withoutPosition.container.querySelector('.masthead')?.lastElementChild?.outerHTML;
      withoutPosition.unmount();

      const withPosition = renderMasthead(MockBaseAssetWithAccountState, true, [], {
        currency: Currency.USDC,
        wrappedPosition: loaded(),
      });
      expect(withPosition.container.querySelector('.masthead')?.lastElementChild?.outerHTML).toEqual(meterWithout);
    });
  });

  describe('without a wrapped position', () => {
    it.each<[string, BaseAssetWithAccountState]>([
      ['supply', MockBaseAssetWithAccountState],
      ['empty', { ...MockBaseAssetWithAccountState, balance: 0n }],
      ['borrow', { ...MockBaseAssetWithAccountState, balance: -1_000_000_000n }],
    ])('renders a %s position exactly as when no position is passed', (_, baseAsset) => {
      const standard = renderMasthead(baseAsset, false, [], { currency: Currency.USDC });
      const standardHtml = standard.container.innerHTML;
      standard.unmount();

      const notApplicable = renderMasthead(baseAsset, false, [], {
        currency: Currency.USDC,
        wrappedPosition: { status: 'not-applicable' },
      });
      expect(notApplicable.container.innerHTML).toEqual(standardHtml);
      expect(screen.queryByText(/wrapped|wrapper/)).toBeNull();
    });
  });
});
