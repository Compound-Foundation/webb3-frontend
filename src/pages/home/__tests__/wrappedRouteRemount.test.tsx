import { render, screen } from '@testing-library/react';

import { WRAPPED_MARKET_REGISTRY } from '@constants/wrappedMarkets';
import * as ActionQueueContextHelpers from '@contexts/ActionQueueContext';
import * as SelectedMarketContextHelpers from '@contexts/SelectedMarketContext';
import { WrappedLending, WrappedLendingContext } from '@contexts/WrappedLendingContext';
import { LendingRoute } from '@helpers/lendingRoute';
import { getMarket } from '@helpers/markets';
import { Theme } from '@hooks/useThemeManager';
import { IDLE_WRAPPED_ACTION } from '@hooks/useWrappedAction';
import { IDLE_WRITE_WRAPPED_STATE } from '@hooks/useWriteWrappedState';
import { ActionQueue, BaseAssetWithAccountState, CometState, MarketData, SelectedMarketData, StateType } from '@types';

import { mockBaseAsset } from '../../../../__tests__/mocks/mockBaseAsset';
import { mockWeb3 } from '../../../../__tests__/mocks/mockWeb3';
import Home from '../index';

// The masthead renders for real so the headline can be read. It also records the props Home
// passes it. The other child components are replaced with stand-ins.
const mockLastProps: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
jest.mock('../components/Masthead', () => {
  const { default: Masthead, ...rest } = jest.requireActual('../components/Masthead');
  return {
    __esModule: true,
    ...rest,
    default: (props: { [key: string]: unknown }) => {
      mockLastProps.Masthead = props;
      return <Masthead {...props} />;
    },
  };
});
function mockStandIn() {
  return { __esModule: true, default: () => null };
}
jest.mock('../components/PositionCard', () => mockStandIn());
jest.mock('../components/ActionModal', () => mockStandIn());
jest.mock('../components/AssetRow', () => mockStandIn());
jest.mock('../components/InstitutionalBanner', () => mockStandIn());
jest.mock('@hooks/useWriteCometState', () => ({ useWriteCometState: () => ({}) }));

const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const USDC_MARKET = getMarket(1, USDC_COMET) as MarketData;
const ACCOUNT_B = '0x0000000000000000000000000000000000000bb2';

function wrappedLending(): WrappedLending {
  const lookup = WRAPPED_MARKET_REGISTRY.lookup(1, USDC_COMET);
  if (lookup.status !== 'valid') throw new Error('the mapping must be valid');
  const route: LendingRoute = {
    kind: 'wrapped',
    chainId: 1,
    cometAddress: USDC_COMET,
    lookup,
    market: lookup.market,
    validationKey: 'key',
    reads: { isEligible: true },
    deposit: { isEligible: false, reason: 'deposits-disabled' },
    exit: { isEligible: false, reason: 'exits-disabled' },
  };
  return {
    route,
    position: {
      status: 'loaded',
      position: {
        shares: 1n,
        shareDecimals: 18,
        grossAssets: 250_000_000n,
        baseDecimals: 6,
        baseWalletBalance: 0n,
        wrapperAllowance: 0n,
        redeemBuffer: 3n,
        fullExitCash: 0n,
        isWithdrawPaused: false,
        snapshot: { totalSupply: 0n, totalAssets: 0n, baseSupplyIndex: 0n },
      },
    },
    retry: jest.fn(),
    action: IDLE_WRAPPED_ACTION,
    write: IDLE_WRITE_WRAPPED_STATE,
  };
}

// A direct supply of 1,000 USDC at $1.
function cometState(): CometState {
  const baseAsset: BaseAssetWithAccountState = {
    ...mockBaseAsset({ address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' }),
    balance: 1_000_000_000n,
    price: 100_000_000n,
    baseAssetPriceInDollars: 100_000_000n,
  };
  return [
    StateType.Hydrated,
    {
      baseAsset,
      borrowAPR: 0n,
      collateralAssets: [],
      collateralValue: 0n,
      earnAPR: 40_000_000_000_000_000n,
      liquidationCapacity: 0n,
      borrowRewardsAPR: 0n,
      supplyRewardsAPR: 12_000_000_000_000_000n,
      isInstitutional: true,
      rewardsAssetSymbol: 'COMP',
      isRewardsLoading: false,
      isBulkerAllowed: true,
      totalBaseSupplyUsd: 0n,
    },
  ] as unknown as CometState;
}

function actionQueue(): ActionQueue {
  return {
    addOrUpdateAction: jest.fn(),
    clearActions: jest.fn(),
    queueActions: jest.fn(),
    getActions: () => [],
    getPendingAction: () => undefined,
    removeAction: jest.fn(),
    setPendingAction: jest.fn(),
  };
}

function web3For(account: string): typeof mockWeb3 {
  return { ...mockWeb3, read: { ...mockWeb3.read, account }, write: { ...mockWeb3.write, account } };
}

const selectedMarketData: SelectedMarketData = {
  selectedMarket: [StateType.Hydrated, USDC_MARKET],
  selectMarket: jest.fn(),
  selectMarketByAddress: jest.fn(),
};
SelectedMarketContextHelpers.initializeContext(selectedMarketData);
ActionQueueContextHelpers.initializeContext(actionQueue());

// The app as the user moves between pages: the dashboard is mounted only while it is the
// current page, and the Comet state and the wallet belong to the app and outlive it.
function app({ isDashboard, state, web3 }: { isDashboard: boolean; state: CometState; web3: typeof mockWeb3 }) {
  const SelectedMarketContext = SelectedMarketContextHelpers.getSelectedMarketContext();
  const ActionQueueContext = ActionQueueContextHelpers.getActionQueueContext();
  return (
    <WrappedLendingContext.Provider value={wrappedLending()}>
      <SelectedMarketContext.Provider value={selectedMarketData}>
        <ActionQueueContext.Provider value={actionQueue()}>
          <div id="overlay" />
          {isDashboard ? (
            <Home
              transactions={[]}
              web3={web3}
              selectedMarketData={selectedMarketData}
              cometState={state}
              addTransaction={jest.fn()}
              switchWriteNetwork={jest.fn()}
              estimatedGasMap={new Map()}
              theme={Theme.Dark}
            />
          ) : (
            <p>Markets</p>
          )}
        </ActionQueueContext.Provider>
      </SelectedMarketContext.Provider>
    </WrappedLendingContext.Provider>
  );
}

const LOADING: CometState = [StateType.Loading, undefined];
const headline = () => screen.getByRole('heading', { level: 1 }).textContent;

describe('Home on the wrapped route across a return to the dashboard', () => {
  beforeEach(() => {
    delete mockLastProps.Masthead;
  });

  it('adds no wrapped value to the previous account’s Comet state after an account switch', () => {
    const accountA = web3For(mockWeb3.read.account as string);
    const stateForA = cometState();
    const { rerender } = render(app({ isDashboard: true, state: LOADING, web3: accountA }));
    rerender(app({ isDashboard: true, state: stateForA, web3: accountA }));
    expect(headline()).toBe('$1,250.00');

    // The user leaves the dashboard and switches to account B. The app keeps A's Comet state
    // until B's read arrives, and the user returns to the dashboard before it does.
    rerender(app({ isDashboard: false, state: stateForA, web3: accountA }));
    rerender(app({ isDashboard: false, state: stateForA, web3: web3For(ACCOUNT_B) }));
    rerender(app({ isDashboard: true, state: stateForA, web3: web3For(ACCOUNT_B) }));
    expect(headline()).toBe('$1,000.00');

    // B's Comet state arrives while the dashboard is mounted.
    rerender(app({ isDashboard: true, state: cometState(), web3: web3For(ACCOUNT_B) }));
    expect(headline()).toBe('$1,250.00');
  });

  it('keeps the wrapped value on a return with the same account and Comet state', () => {
    const state = cometState();
    const { rerender } = render(app({ isDashboard: true, state: LOADING, web3: mockWeb3 }));
    rerender(app({ isDashboard: true, state, web3: mockWeb3 }));
    expect(headline()).toBe('$1,250.00');

    rerender(app({ isDashboard: false, state, web3: mockWeb3 }));
    rerender(app({ isDashboard: true, state, web3: mockWeb3 }));
    expect(headline()).toBe('$1,250.00');
  });

  it('adds no wrapped value to Comet state read before the dashboard first mounted', () => {
    const { rerender } = render(app({ isDashboard: true, state: cometState(), web3: mockWeb3 }));
    expect(headline()).toBe('$1,000.00');

    rerender(app({ isDashboard: true, state: cometState(), web3: mockWeb3 }));
    expect(headline()).toBe('$1,250.00');
  });
});
