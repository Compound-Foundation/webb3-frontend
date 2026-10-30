import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ReactElement } from 'react';

import { CurrencyManagerContext } from '@contexts/CurrencyContext';
import { formatValueInDollars, getValueInDollars, PRICE_PRECISION } from '@helpers/numbers';
import { getWrappedPositionValueInDollars, withWrappedSupply } from '@helpers/wrappedPositions';
import { Theme } from '@hooks/useThemeManager';
import { Action, ActionType, BaseAssetWithAccountState, Currency, StateType } from '@types';

import { MockBaseAssetWithAccountState } from '../../../../../__tests__/mocks/mockTokens';
import Masthead, { MastheadNotice, MastheadState } from '../../components/Masthead';

type RenderOptions = {
  baseAssetPost?: BaseAssetWithAccountState;
  collateralValue?: bigint;
  compare?: boolean;
  currency?: Currency;
  liquidationCapacity?: bigint;
  wrappedSupplyApart?: bigint;
  isMixedSupply?: boolean;
  notice?: MastheadNotice;
};

const mastheadState = (
  baseAsset: BaseAssetWithAccountState,
  actions: Action[],
  {
    baseAssetPost,
    collateralValue = 0n,
    compare = false,
    liquidationCapacity = 0n,
    wrappedSupplyApart,
    isMixedSupply,
    notice,
  }: RenderOptions
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
    wrappedSupplyApart,
    isMixedSupply,
    notice,
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

const mastheadElement = (baseAsset: BaseAssetWithAccountState, actions: Action[], options: RenderOptions) =>
  withCurrency(
    options.currency,
    <div>
      <div id="overlay"></div>
      <Masthead state={mastheadState(baseAsset, actions, options)} />
    </div>
  );

const renderMasthead = (baseAsset: BaseAssetWithAccountState, actions: Action[] = [], options: RenderOptions = {}) =>
  render(mastheadElement(baseAsset, actions, options));

// 250.125 USDC of wrapped supply. The mock base asset holds 5,004.447061 USDC directly, at a
// price of $0.9998.
const WRAPPED_VALUE = 250_125_000n;

const headline = () => screen.getByRole('heading', { level: 1 });
const meter = (container: HTMLElement) => container.querySelector('.masthead')?.lastElementChild?.outerHTML;

const usdtAccount: BaseAssetWithAccountState = {
  ...MockBaseAssetWithAccountState,
  symbol: 'USDT',
  name: 'Tether USD',
  price: 99_950_000n,
  baseAssetPriceInDollars: 99_950_000n,
};

// $5,000 of collateral and 4,000 USDC of liquidation capacity, so a 1,000 USDC borrow fills 25% of
// the utilization meter.
const COLLATERAL = { collateralValue: 500_000_000_000n, liquidationCapacity: 4_000_000_000n };

describe('Masthead on the wrapped route', () => {
  const emptyAccount = { ...MockBaseAssetWithAccountState, balance: 0n };
  const borrower = { ...MockBaseAssetWithAccountState, balance: -1_000_000_000n };

  it('offers the normal Supply to an empty account', () => {
    renderMasthead(emptyAccount);

    expect(screen.getByRole('button', { name: 'Supply USDC' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Borrow USDC' })).toBeEnabled();
  });

  it('shows a wrapped position Home adds to the base balance as the normal supply, with Withdraw', () => {
    renderMasthead(withWrappedSupply(emptyAccount, WRAPPED_VALUE), [], { currency: Currency.USDC });

    expect(headline()).toHaveTextContent('250.1250');
    expect(screen.getByText('Supplying')).toBeInTheDocument();
    expect(screen.getByText(/^\s*\S+ Net APR$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw USDC' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Supply USDC' })).toBeEnabled();
    expect(screen.queryByText(/wrapped|wrapper/i)).toBeNull();
  });

  it('shows a queued supply in the after value and the queued balance before it', () => {
    const before = withWrappedSupply(emptyAccount, WRAPPED_VALUE);
    const supply: Action = [ActionType.Supply, before, 1_000_000_000n];
    const after = { ...before, balance: before.balance + 1_000_000_000n };
    const options = { baseAssetPost: after, currency: Currency.USDC };

    const { unmount } = renderMasthead(before, [supply], options);
    expect(screen.getByText('After Transaction')).toBeInTheDocument();
    expect(headline()).toHaveTextContent('1,250.1250');
    unmount();

    renderMasthead(before, [supply], { ...options, compare: true });
    expect(screen.getByText('Before Transaction')).toBeInTheDocument();
    expect(headline()).toHaveTextContent('250.1250');
  });

  it('names the Net APR of a direct and wrapped supplier for the direct supply alone', () => {
    renderMasthead(withWrappedSupply(MockBaseAssetWithAccountState, WRAPPED_VALUE), [], {
      currency: Currency.USDC,
      isMixedSupply: true,
    });

    // The rate includes the supply rewards, which the wrapped supply does not earn.
    expect(headline()).toHaveTextContent('5,254.5721');
    expect(screen.getByText(/Direct supply Net APR/)).toBeInTheDocument();
  });

  it('shows a notice about the wrapped position, with its action', () => {
    const onAction = jest.fn();
    renderMasthead(emptyAccount, [], {
      notice: { message: 'Your supplied balance could not be loaded.', actionLabel: 'Retry', onAction },
    });

    expect(screen.getByText('Your supplied balance could not be loaded.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  describe('a direct borrow alongside a wrapped supply', () => {
    it('keeps the borrow headline and shows the wrapped supply beneath it', () => {
      renderMasthead(borrower, [], { currency: Currency.USDC, wrappedSupplyApart: WRAPPED_VALUE });

      expect(screen.getByText('Borrowing')).toBeInTheDocument();
      expect(headline()).toHaveTextContent('1,000.0000');
      expect(screen.getByText('Plus 250.1250 USDC supplied through the wrapper')).toBeInTheDocument();
    });

    it.each<[string, BaseAssetWithAccountState, string, string]>([
      ['USDC', MockBaseAssetWithAccountState, '$999.80', '$250.13'],
      ['USDT', usdtAccount, '$999.00', '$250.00'],
    ])('shows the wrapped supply beneath a %s borrow in dollars', (_, baseAsset, borrowDollars, wrappedDollars) => {
      const borrowing = { ...baseAsset, balance: -1_000_000_000n };
      renderMasthead(borrowing, [], { currency: Currency.USD, wrappedSupplyApart: WRAPPED_VALUE });

      // The headline is the borrow converted as without a position. The wrapped value does not
      // net against it.
      expect(headline()).toHaveTextContent(
        formatValueInDollars(
          baseAsset.decimals + PRICE_PRECISION,
          getValueInDollars(baseAsset.price * 1_000_000_000n, baseAsset)
        )
      );
      expect(headline()).toHaveTextContent(borrowDollars);
      expect(
        formatValueInDollars(
          baseAsset.decimals,
          getWrappedPositionValueInDollars(WRAPPED_VALUE, baseAsset.baseAssetPriceInDollars, baseAsset.symbol)
        )
      ).toBe(wrappedDollars);
      expect(screen.getByText(`Plus ${wrappedDollars} supplied through the wrapper`)).toBeInTheDocument();
    });

    it('keeps the borrow buttons and the utilization meter as they are without the position', () => {
      const options = { ...COLLATERAL, currency: Currency.USDC };
      const withoutPosition = renderMasthead(borrower, [], options);
      const buttonsWithout = screen.getAllByRole('button').map((button) => button.textContent);
      const meterWithout = meter(withoutPosition.container);
      withoutPosition.unmount();

      const withPosition = renderMasthead(borrower, [], { ...options, wrappedSupplyApart: WRAPPED_VALUE });
      expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(buttonsWithout);
      expect(withPosition.container.querySelector('.utilization-meter__percent')).toHaveTextContent('25%');
      expect(meter(withPosition.container)).toEqual(meterWithout);
    });
  });

  describe('without a wrapped position', () => {
    it.each<[string, BaseAssetWithAccountState]>([
      ['supply', MockBaseAssetWithAccountState],
      ['empty', { ...MockBaseAssetWithAccountState, balance: 0n }],
      ['borrow', { ...MockBaseAssetWithAccountState, balance: -1_000_000_000n }],
    ])('renders a %s position exactly as when no wrapped value is passed', (_, baseAsset) => {
      const standard = renderMasthead(baseAsset, [], { currency: Currency.USDC });
      const standardHtml = standard.container.innerHTML;
      standard.unmount();

      const zero = renderMasthead(baseAsset, [], { currency: Currency.USDC, wrappedSupplyApart: 0n });
      expect(zero.container.innerHTML).toEqual(standardHtml);
      expect(screen.queryByText(/wrapped|wrapper/)).toBeNull();
    });
  });
});
