import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ReactElement } from 'react';

import { CurrencyManagerContext } from '@contexts/CurrencyContext';
import { formatValueInDollars, getValueInDollars, PRICE_PRECISION, PRICE_SCALE } from '@helpers/numbers';
import { getWrappedPositionValueInDollars, WrappedPosition } from '@helpers/wrappedPositions';
import { Theme } from '@hooks/useThemeManager';
import { WrappedPositionState } from '@hooks/useWrappedPosition';
import { Action, ActionType, BaseAssetWithAccountState, Currency, StateType } from '@types';

import { MockBaseAssetWithAccountState } from '../../../../../__tests__/mocks/mockTokens';
import Masthead, { MastheadState } from '../../components/Masthead';

type RenderOptions = {
  baseAssetPost?: BaseAssetWithAccountState;
  collateralValue?: bigint;
  compare?: boolean;
  currency?: Currency;
  liquidationCapacity?: bigint;
  wrappedPosition?: WrappedPositionState;
};

const mastheadState = (
  baseAsset: BaseAssetWithAccountState,
  isDirectBaseSupplyBlocked: boolean,
  actions: Action[],
  { baseAssetPost, collateralValue = 0n, compare = false, liquidationCapacity = 0n, wrappedPosition }: RenderOptions
): MastheadState => [
  StateType.Hydrated,
  {
    actions,
    baseAsset,
    baseAssetPost: baseAssetPost ?? baseAsset,
    borrowAPR: 0n,
    borrowRewardsAPR: 0n,
    collateralAssets: [],
    collateralValue,
    collateralValuePost: collateralValue,
    compare,
    earnAPR: 0n,
    earnRewardsAPR: 0n,
    liquidationCapacity,
    liquidationCapacityPost: liquidationCapacity,
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
// The smaller figure beneath the headline, in the other currency.
const counterLine = () => document.querySelector('.masthead__balance-value + .meta');
const meter = (container: HTMLElement) => container.querySelector('.masthead')?.lastElementChild?.outerHTML;

// A USDT market at a feed price of $0.9995, where the masthead's direct conversion and the
// panel's conversion give different dollar values.
const usdtAccount: BaseAssetWithAccountState = {
  ...MockBaseAssetWithAccountState,
  symbol: 'USDT',
  name: 'Tether USD',
  price: 99_950_000n,
  baseAssetPriceInDollars: 99_950_000n,
};

// The dollar value the wrapped position panel shows for the position.
const panelDollars = (baseAsset: BaseAssetWithAccountState) =>
  formatValueInDollars(
    baseAsset.decimals,
    getWrappedPositionValueInDollars(POSITION.grossAssets, baseAsset.baseAssetPriceInDollars, baseAsset.symbol)
  );

// The headline in dollars: the direct balance converted as without a position, plus the panel's
// dollar value of the wrapped position.
const usdHeadline = (baseAsset: BaseAssetWithAccountState) =>
  formatValueInDollars(
    baseAsset.decimals + PRICE_PRECISION,
    getValueInDollars(baseAsset.price * baseAsset.balance, baseAsset) +
      getWrappedPositionValueInDollars(POSITION.grossAssets, baseAsset.baseAssetPriceInDollars, baseAsset.symbol) *
        PRICE_SCALE
  );

// $5,000 of collateral and 4,000 USDC of liquidation capacity, so a 1,000 USDC borrow fills 25% of
// the utilization meter.
const COLLATERAL = { collateralValue: 500_000_000_000n, liquidationCapacity: 4_000_000_000n };

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
      // The dollar figure beneath it is the same sum as the dollar headline.
      expect(counterLine()).toHaveTextContent(usdHeadline(MockBaseAssetWithAccountState).replace('$', ''));
      expect(counterLine()).toHaveTextContent('5,253.57');
    });

    it('adds the wrapped dollar value to the direct dollar value in dollars', () => {
      renderMasthead(MockBaseAssetWithAccountState, true, [], {
        currency: Currency.USD,
        wrappedPosition: loaded(),
      });

      // 5,004.447061 USDC at $0.9998 is $5,003.4462, and the panel values the 250.125 wrapped USDC
      // at $250.125. Together they are $5,253.5712.
      expect(headline()).toHaveTextContent(usdHeadline(MockBaseAssetWithAccountState));
      expect(headline()).toHaveTextContent('$5,253.57');
      expect(counterLine()).toHaveTextContent('5,254.5721');
    });

    it('adds a USDT wrapped value at the panel dollar value, before and after a direct supply', () => {
      const options = { currency: Currency.USD, wrappedPosition: loaded() };
      const { rerender } = renderMasthead(usdtAccount, true, [], options);

      // The direct 5,004.447061 USDT is converted at $0.9995 twice, as without a position:
      // $4,999.4439. The panel values the 250.125 wrapped USDT at $0.9995 once: $249.9999.
      // Together they are $5,249.4438.
      expect(headline()).toHaveTextContent('$5,249.44');
      expect(screen.getByText('Includes $250.00 wrapped')).toBeInTheDocument();

      // After a direct supply of 1,000 USDT, the direct 6,004.447061 USDT is $5,998.4441, and the
      // headline is $6,248.4441.
      const supply: Action = [ActionType.Supply, usdtAccount, 1_000_000_000n];
      const after = { ...usdtAccount, balance: 6_004_447_061n };
      rerender(mastheadElement(usdtAccount, false, [supply], { ...options, baseAssetPost: after }));
      expect(headline()).toHaveTextContent('$6,248.44');
      expect(screen.getByText('Includes $250.00 wrapped')).toBeInTheDocument();
    });

    it('names the wrapped part of the headline in the base token', () => {
      renderMasthead(MockBaseAssetWithAccountState, true, [], {
        currency: Currency.USDC,
        wrappedPosition: loaded(),
      });

      expect(screen.getByText('Includes 250.1250 USDC wrapped')).toBeInTheDocument();
    });

    it.each<[string, BaseAssetWithAccountState, string]>([
      ['USDC', MockBaseAssetWithAccountState, '$250.13'],
      ['USDT', usdtAccount, '$250.00'],
    ])('names the wrapped part of a %s headline in dollars as the panel values it', (_, baseAsset, dollars) => {
      renderMasthead(baseAsset, true, [], { currency: Currency.USD, wrappedPosition: loaded() });

      expect(panelDollars(baseAsset)).toBe(dollars);
      expect(screen.getByText(`Includes ${dollars} wrapped`)).toBeInTheDocument();
    });

    it('shows a wrapped-only supplier as supplying, with the Net APR', () => {
      renderMasthead(emptyAccount, true, [], { currency: Currency.USDC, wrappedPosition: loaded() });

      expect(headline()).toHaveTextContent('250.1250');
      expect(screen.getByText('Supplying')).toBeInTheDocument();
      expect(screen.getByText(/Net APR/)).toBeInTheDocument();
      expect(screen.queryByText(/Direct supply/)).toBeNull();
      expect(screen.getByText('Includes 250.1250 USDC wrapped')).toBeInTheDocument();
      // The buttons still follow the direct balance: there is no direct supply to withdraw.
      expect(screen.queryByRole('button', { name: 'Withdraw USDC' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Borrow USDC' })).toBeEnabled();
    });

    it('names the Net APR of a direct and wrapped supplier for the direct supply alone', () => {
      renderMasthead(MockBaseAssetWithAccountState, true, [], { currency: Currency.USDC, wrappedPosition: loaded() });

      // The rate includes the supply rewards, which the wrapped supply does not earn.
      expect(screen.getByText(/Direct supply Net APR/)).toBeInTheDocument();
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

    it('adds the wrapped dollar value on both sides of a direct action', () => {
      const supply: Action = [ActionType.Supply, MockBaseAssetWithAccountState, 1_000_000_000n];
      const after = { ...MockBaseAssetWithAccountState, balance: 6_004_447_061n };
      const options = { baseAssetPost: after, currency: Currency.USD, wrappedPosition: loaded() };

      const { unmount } = renderMasthead(MockBaseAssetWithAccountState, false, [supply], options);
      expect(headline()).toHaveTextContent(usdHeadline(after));
      expect(screen.getByText(`Includes ${panelDollars(after)} wrapped`)).toBeInTheDocument();
      unmount();

      renderMasthead(MockBaseAssetWithAccountState, false, [supply], { ...options, compare: true });
      expect(headline()).toHaveTextContent(usdHeadline(MockBaseAssetWithAccountState));
      expect(screen.getByText(`Includes ${panelDollars(MockBaseAssetWithAccountState)} wrapped`)).toBeInTheDocument();
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
      const { container } = renderMasthead(emptyAccount, true, [], {
        currency: Currency.USDC,
        wrappedPosition: { status: 'loading' },
      });

      expect(screen.getByText('Balance')).toBeInTheDocument();
      expect(headline()).toHaveTextContent('0.0000');
      expect(container).not.toHaveTextContent('250');
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

    it.each<[string, BaseAssetWithAccountState, string, string]>([
      ['USDC', MockBaseAssetWithAccountState, '$999.80', '$250.13'],
      ['USDT', usdtAccount, '$999.00', '$250.00'],
    ])('shows the wrapped supply beneath a %s borrow in dollars', (_, baseAsset, borrowDollars, wrappedDollars) => {
      const borrowing = { ...baseAsset, balance: -1_000_000_000n };
      renderMasthead(borrowing, true, [], { currency: Currency.USD, wrappedPosition: loaded() });

      // The headline is the borrow converted as without a position. The wrapped value does not
      // net against it.
      expect(headline()).toHaveTextContent(
        formatValueInDollars(
          baseAsset.decimals + PRICE_PRECISION,
          getValueInDollars(baseAsset.price * 1_000_000_000n, baseAsset)
        )
      );
      expect(headline()).toHaveTextContent(borrowDollars);
      expect(panelDollars(baseAsset)).toBe(wrappedDollars);
      expect(screen.getByText(`Plus ${wrappedDollars} supplied through the wrapper`)).toBeInTheDocument();
    });

    it('keeps the borrow buttons and the utilization meter as they are without the position', () => {
      const options = { ...COLLATERAL, currency: Currency.USDC };
      const withoutPosition = renderMasthead(borrower, true, [], options);
      const buttonsWithout = screen.getAllByRole('button').map((button) => button.textContent);
      const meterWithout = meter(withoutPosition.container);
      withoutPosition.unmount();

      const withPosition = renderMasthead(borrower, true, [], { ...options, wrappedPosition: loaded() });
      expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(buttonsWithout);
      expect(withPosition.container.querySelector('.utilization-meter__percent')).toHaveTextContent('25%');
      expect(meter(withPosition.container)).toEqual(meterWithout);
    });

    it('shows no wrapped line while the position is loading', () => {
      renderMasthead(borrower, true, [], { currency: Currency.USDC, wrappedPosition: { status: 'loading' } });

      expect(headline()).toHaveTextContent('1,000.0000');
      expect(screen.queryByText(/wrapper/)).toBeNull();
    });
  });

  describe('changes to a mounted masthead', () => {
    const options = { currency: Currency.USDC, wrappedPosition: loaded() };

    it('moves from the supply headline to the borrow headline when a direct borrow makes the balance negative', () => {
      const { rerender } = renderMasthead(MockBaseAssetWithAccountState, true, [], options);
      expect(headline()).toHaveTextContent('5,254.5721');
      expect(screen.getByText('Includes 250.1250 USDC wrapped')).toBeInTheDocument();

      // A borrow of 6,004.447061 USDC leaves a direct borrow of 1,000 USDC.
      const borrow: Action = [ActionType.Borrow, MockBaseAssetWithAccountState, 6_004_447_061n];
      const after = { ...MockBaseAssetWithAccountState, balance: -1_000_000_000n };
      rerender(mastheadElement(MockBaseAssetWithAccountState, true, [borrow], { ...options, baseAssetPost: after }));

      expect(screen.getByText('Borrowing')).toBeInTheDocument();
      expect(headline()).toHaveTextContent('1,000.0000');
      expect(screen.getByText('Plus 250.1250 USDC supplied through the wrapper')).toBeInTheDocument();
      expect(screen.queryByText(/Includes/)).toBeNull();
    });

    it('moves from the borrow headline to the wrapped value alone when a repay clears the borrow', () => {
      const { rerender } = renderMasthead(borrower, true, [], options);
      expect(screen.getByText('Plus 250.1250 USDC supplied through the wrapper')).toBeInTheDocument();

      const repay: Action = [ActionType.Repay, borrower, 1_000_000_000n];
      const after = { ...borrower, balance: 0n };
      rerender(mastheadElement(borrower, true, [repay], { ...options, baseAssetPost: after }));

      expect(screen.getByText('Supplying')).toBeInTheDocument();
      expect(headline()).toHaveTextContent('250.1250');
      expect(screen.getByText('Includes 250.1250 USDC wrapped')).toBeInTheDocument();
      expect(screen.queryByText(/Plus/)).toBeNull();
    });

    it('shows the wrapped value alone when a withdrawal empties the direct supply', () => {
      const { rerender } = renderMasthead(MockBaseAssetWithAccountState, true, [], options);

      const withdraw: Action = [ActionType.Withdraw, MockBaseAssetWithAccountState, 5_004_447_061n];
      const after = { ...MockBaseAssetWithAccountState, balance: 0n };
      rerender(mastheadElement(MockBaseAssetWithAccountState, true, [withdraw], { ...options, baseAssetPost: after }));

      expect(screen.getByText('Supplying')).toBeInTheDocument();
      expect(headline()).toHaveTextContent('250.1250');
      expect(screen.getByText('Includes 250.1250 USDC wrapped')).toBeInTheDocument();
    });

    it('keeps the headline and the wrapped line in step when the currency changes', () => {
      const { rerender } = renderMasthead(MockBaseAssetWithAccountState, true, [], options);
      expect(headline()).toHaveTextContent('5,254.5721');
      expect(screen.getByText('Includes 250.1250 USDC wrapped')).toBeInTheDocument();

      rerender(mastheadElement(MockBaseAssetWithAccountState, true, [], { ...options, currency: Currency.USD }));
      expect(headline()).toHaveTextContent('$5,253.57');
      expect(counterLine()).toHaveTextContent('5,254.5721');
      expect(screen.getByText('Includes $250.13 wrapped')).toBeInTheDocument();

      rerender(mastheadElement(MockBaseAssetWithAccountState, true, [], options));
      expect(headline()).toHaveTextContent('5,254.5721');
      expect(counterLine()).toHaveTextContent('5,253.57');
      expect(screen.getByText('Includes 250.1250 USDC wrapped')).toBeInTheDocument();
    });

    it('returns to the direct balance alone when a refresh of the position fails', () => {
      const { rerender } = renderMasthead(MockBaseAssetWithAccountState, true, [], options);
      expect(headline()).toHaveTextContent('5,254.5721');

      const failed: WrappedPositionState = { status: 'error', message: 'The read failed.' };
      rerender(mastheadElement(MockBaseAssetWithAccountState, true, [], { ...options, wrappedPosition: failed }));

      expect(headline()).toHaveTextContent('5,004.4471');
      expect(screen.queryByText(/wrapped|wrapper/)).toBeNull();
    });
  });

  describe('figures other than the headline', () => {
    // A supplier's meter shows no borrow with or without the wrapped value, so a borrower with a
    // direct action shows whether the meter reads the wrapped value before or after the action.
    it.each<[string, boolean, string]>([
      ['after', false, '38%'],
      ['before', true, '25%'],
    ])('leaves the utilization meter to the direct position %s a direct action', (_, compare, percent) => {
      const borrowMore: Action = [ActionType.Borrow, borrower, 500_000_000n];
      const after = { ...borrower, balance: -1_500_000_000n };
      const options = { ...COLLATERAL, baseAssetPost: after, compare, currency: Currency.USDC };
      const withoutPosition = renderMasthead(borrower, true, [borrowMore], options);
      const meterWithout = meter(withoutPosition.container);
      withoutPosition.unmount();

      const withPosition = renderMasthead(borrower, true, [borrowMore], { ...options, wrappedPosition: loaded() });
      expect(withPosition.container.querySelector('.utilization-meter__percent')).toHaveTextContent(percent);
      expect(meter(withPosition.container)).toEqual(meterWithout);
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
