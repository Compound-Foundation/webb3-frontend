import { render } from '@testing-library/react';

import { WRAPPED_MARKET_REGISTRY } from '@constants/wrappedMarkets';
import * as ActionQueueContextHelpers from '@contexts/ActionQueueContext';
import * as SelectedMarketContextHelpers from '@contexts/SelectedMarketContext';
import { WrappedLending, WrappedLendingContext } from '@contexts/WrappedLendingContext';
import { LendingRoute } from '@helpers/lendingRoute';
import { getMarket } from '@helpers/markets';
import { MAX_UINT256 } from '@helpers/numbers';
import { Theme } from '@hooks/useThemeManager';
import { IDLE_WRAPPED_ACTION } from '@hooks/useWrappedAction';
import { IDLE_WRITE_WRAPPED_STATE } from '@hooks/useWriteWrappedState';
import {
  Action,
  ActionQueue,
  ActionType,
  BaseAssetWithAccountState,
  CometState,
  MarketData,
  PendingAction,
  StateType,
} from '@types';

import { mockBaseAsset } from '../../../../__tests__/mocks/mockBaseAsset';
import { mockWeb3 } from '../../../../__tests__/mocks/mockWeb3';
import Home from '../index';

// Child components are replaced with stand-ins that record the props Home passes them.
const mockLastProps: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
function mockRecordProps(name: string) {
  return {
    __esModule: true,
    default: (props: unknown) => {
      mockLastProps[name] = props;
      return null;
    },
  };
}
jest.mock('../components/Masthead', () => mockRecordProps('Masthead'));
jest.mock('../components/PositionCard', () => mockRecordProps('PositionCard'));
jest.mock('../components/ActionModal', () => mockRecordProps('ActionModal'));
jest.mock('../components/AssetRow', () => mockRecordProps('AssetRow'));
jest.mock('../components/InstitutionalBanner', () => mockRecordProps('InstitutionalBanner'));

const mockWriteState = {
  approve: jest.fn(),
  supply: jest.fn(),
  withdraw: jest.fn(),
  invokeBulker: jest.fn(),
  claimReward: jest.fn(),
  drip: jest.fn(),
};
jest.mock('@hooks/useWriteCometState', () => ({ useWriteCometState: () => mockWriteState }));

const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const USDT_COMET = '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDC_MARKET = getMarket(1, USDC_COMET) as MarketData;
const USDT_MARKET = getMarket(1, USDT_COMET) as MarketData;

function wrappedLending(cometAddress = USDC_COMET): WrappedLending {
  const lookup = WRAPPED_MARKET_REGISTRY.lookup(1, cometAddress);
  if (lookup.status !== 'valid') throw new Error('the mapping must be valid');
  const route: LendingRoute = {
    kind: 'wrapped',
    chainId: 1,
    cometAddress,
    lookup,
    market: lookup.market,
    validationKey: 'key',
    reads: { isEligible: true },
    deposit: { isEligible: false, reason: 'deposits-disabled' },
    exit: { isEligible: false, reason: 'exits-disabled' },
  };
  return {
    route,
    position: { status: 'loading' },
    retry: jest.fn(),
    action: IDLE_WRAPPED_ACTION,
    write: IDLE_WRITE_WRAPPED_STATE,
  };
}

const LOADED: WrappedLending['position'] = {
  status: 'loaded',
  position: {
    shares: 7n * 10n ** 18n,
    shareDecimals: 18,
    grossAssets: 7_000_000n,
    baseDecimals: 6,
    baseWalletBalance: 0n,
    wrapperAllowance: 0n,
    redeemBuffer: 3n,
    fullExitCash: 6_999_997n,
    isWithdrawPaused: false,
    snapshot: { totalSupply: 0n, totalAssets: 0n, baseSupplyIndex: 0n },
  },
};

const STANDARD: WrappedLending = {
  route: { kind: 'standard', writes: { isEligible: true } },
  position: { status: 'not-applicable' },
  retry: jest.fn(),
  action: IDLE_WRAPPED_ACTION,
  write: IDLE_WRITE_WRAPPED_STATE,
};

function cometState(baseAsset: BaseAssetWithAccountState): CometState {
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

function actionQueue(actions: Action[]): ActionQueue & { setPendingAction: jest.Mock } {
  return {
    addOrUpdateAction: jest.fn(),
    clearActions: jest.fn(),
    queueActions: jest.fn(),
    getActions: () => actions,
    getPendingAction: () => undefined,
    removeAction: jest.fn(),
    setPendingAction: jest.fn(),
  };
}

type Setup = {
  lending: WrappedLending;
  market?: MarketData;
  state: CometState;
  queue: ActionQueue;
  web3?: typeof mockWeb3;
};

SelectedMarketContextHelpers.initializeContext({
  selectedMarket: [StateType.Hydrated, USDC_MARKET],
  selectMarket: jest.fn(),
  selectMarketByAddress: jest.fn(),
});
ActionQueueContextHelpers.initializeContext(actionQueue([]));

function homeElement({ lending, market = USDC_MARKET, state, queue, web3 = mockWeb3 }: Setup) {
  const SelectedMarketContext = SelectedMarketContextHelpers.getSelectedMarketContext();
  const ActionQueueContext = ActionQueueContextHelpers.getActionQueueContext();
  return (
    <WrappedLendingContext.Provider value={lending}>
      <SelectedMarketContext.Provider
        value={{
          selectedMarket: [StateType.Hydrated, market],
          selectMarket: jest.fn(),
          selectMarketByAddress: jest.fn(),
        }}
      >
        <ActionQueueContext.Provider value={queue}>
          <Home
            transactions={[]}
            web3={web3}
            selectedMarketData={{
              selectedMarket: [StateType.Hydrated, market],
              selectMarket: jest.fn(),
              selectMarketByAddress: jest.fn(),
            }}
            cometState={state}
            addTransaction={jest.fn()}
            switchWriteNetwork={jest.fn()}
            estimatedGasMap={new Map()}
            theme={Theme.Dark}
          />
        </ActionQueueContext.Provider>
      </SelectedMarketContext.Provider>
    </WrappedLendingContext.Provider>
  );
}

// On the wrapped route, the masthead gets the loaded wrapped position only once Home knows the account
// a hydrated Comet state was read for: one that arrived while the dashboard was mounted. These
// renders deliver the state after the dashboard mounts, as the app does.
function renderWithCometRead(setup: Setup) {
  const view = render(homeElement({ ...setup, state: [StateType.Loading, undefined] }));
  view.rerender(homeElement(setup));
  return view;
}

const EMPTY_ACCOUNT = mockBaseAsset({ address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' });
const supplyAction = (asset: BaseAssetWithAccountState): Action => [ActionType.Supply, asset, 1_000_000n];

describe('Home on the wrapped route', () => {
  beforeEach(() => {
    Object.values(mockWriteState).forEach((fn) => fn.mockReset());
  });

  it("shows no supply incentives, and gives the form the route's rules", () => {
    render(homeElement({ lending: wrappedLending(), state: cometState(EMPTY_ACCOUNT), queue: actionQueue([]) }));

    const [, masthead] = mockLastProps.Masthead.state;
    expect(masthead.earnRewardsAPR).toBe(0n);
    expect(masthead.isInstitutional).toBe(false);

    const [, positionCard] = mockLastProps.PositionCard.state;
    // The committed release controls are closed, so the form shows why instead of queueing.
    expect(positionCard.actionRules).toEqual({
      wrappedBase: {
        supplyBlockedReason: 'Supply Not Open Yet',
        withdrawBlockedReason: 'Withdrawals Not Open Yet',
        maxPartialWithdrawal: undefined,
        canWithdrawAll: false,
      },
    });
    expect(positionCard.earnRewardsAPR).toBe(0n);
    expect(positionCard.isInstitutional).toBe(false);
  });

  it('keeps the incentives a direct supply earns', () => {
    const directSupplier = { ...EMPTY_ACCOUNT, balance: 5_000_000n };
    render(homeElement({ lending: wrappedLending(), state: cometState(directSupplier), queue: actionQueue([]) }));

    const [, positionCard] = mockLastProps.PositionCard.state;
    expect(positionCard.earnRewardsAPR).toBe(12_000_000_000_000_000n);
  });

  it('opens the normal amount form for a base supply', () => {
    const queue = actionQueue([]);
    render(homeElement({ lending: wrappedLending(), state: cometState(EMPTY_ACCOUNT), queue }));

    const [, masthead] = mockLastProps.Masthead.state;
    masthead.onSupplyAction([ActionType.Supply, EMPTY_ACCOUNT, undefined] as PendingAction);
    expect(queue.setPendingAction).toHaveBeenCalledWith([ActionType.Supply, EMPTY_ACCOUNT, undefined]);
  });

  it('never sends a queued base supply to Comet or the Bulker, even when the wrapper cannot take it', () => {
    render(
      homeElement({
        lending: wrappedLending(),
        state: cometState(EMPTY_ACCOUNT),
        queue: actionQueue([supplyAction(EMPTY_ACCOUNT)]),
      })
    );

    const [, positionCard] = mockLastProps.PositionCard.state;
    positionCard.onSubmitClicked();
    expect(mockWriteState.supply).not.toHaveBeenCalled();
    expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
  });

  it('submits a full repay of a direct borrow', () => {
    const borrower = { ...EMPTY_ACCOUNT, balance: -5_000_000n };
    render(
      homeElement({
        lending: wrappedLending(),
        state: cometState(borrower),
        queue: actionQueue([[ActionType.Repay, borrower, MAX_UINT256]]),
      })
    );

    const [, positionCard] = mockLastProps.PositionCard.state;
    positionCard.onSubmitClicked();
    expect(mockWriteState.supply).toHaveBeenCalledTimes(1);
  });

  it('sends no base supply to Comet from a submit callback kept from before the route became wrapped', () => {
    const queue = actionQueue([supplyAction(EMPTY_ACCOUNT)]);
    const state = cometState(EMPTY_ACCOUNT);
    const { rerender } = render(homeElement({ lending: STANDARD, state, queue }));
    const keptSubmit = mockLastProps.PositionCard.state[1].onSubmitClicked;

    rerender(homeElement({ lending: wrappedLending(), state, queue }));
    keptSubmit();

    expect(mockWriteState.supply).not.toHaveBeenCalled();
    expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
  });

  it.each<[string, Action]>([
    ['supply', [ActionType.Supply, EMPTY_ACCOUNT, 1_000_000n]],
    ['withdrawal', [ActionType.Withdraw, EMPTY_ACCOUNT, 1_000_000n]],
  ])('starts no wrapped %s from a submit callback kept from an earlier visit', (_, action) => {
    const supply = jest.fn(() => undefined);
    const withdraw = jest.fn(() => undefined);
    const state = cometState(EMPTY_ACCOUNT);
    const usdc = { ...wrappedLending(), write: { supply, withdraw } };
    const { rerender } = render(homeElement({ lending: usdc, state, queue: actionQueue([action]) }));
    const keptSubmit = mockLastProps.PositionCard.state[1].onSubmitClicked;

    // The user switches to the USDT market: the submit callback from before belongs to USDC.
    const usdt = { ...wrappedLending(USDT_COMET), write: { supply, withdraw } };
    const usdtAction = [action[0], { ...EMPTY_ACCOUNT, address: USDT }, action[2]] as Action;
    rerender(homeElement({ lending: usdt, market: USDT_MARKET, state, queue: actionQueue([usdtAction]) }));

    keptSubmit();
    expect(supply).not.toHaveBeenCalled();
    expect(withdraw).not.toHaveBeenCalled();
    mockLastProps.PositionCard.state[1].onSubmitClicked();
    expect(supply.mock.calls.length + withdraw.mock.calls.length).toBe(1);
  });

  it('leaves the wrapped value out while the Comet state still belongs to the previous market', () => {
    const state = cometState(EMPTY_ACCOUNT);
    const loaded: WrappedLending = { ...wrappedLending(), position: LOADED };
    const { rerender } = renderWithCometRead({
      lending: wrappedLending(USDT_COMET),
      market: USDT_MARKET,
      state,
      queue: actionQueue([]),
    });

    rerender(homeElement({ lending: loaded, market: USDC_MARKET, state, queue: actionQueue([]) }));
    expect(mockLastProps.Masthead.state[1].baseAsset.balance).toBe(0n);
    expect(mockLastProps.PositionCard.state[1].actionRules.wrappedBase.maxPartialWithdrawal).toBeUndefined();

    rerender(
      homeElement({ lending: loaded, market: USDC_MARKET, state: cometState(EMPTY_ACCOUNT), queue: actionQueue([]) })
    );
    expect(mockLastProps.Masthead.state[1].baseAsset.balance).toBe(7_000_000n);
    expect(mockLastProps.PositionCard.state[1].baseAsset.balance).toBe(7_000_000n);
  });

  it.each<[string, WrappedLending['position']]>([
    ['loading', { status: 'loading' }],
    ['failed to read', { status: 'error', message: 'Read failed.' }],
  ])('shows the direct balance alone while the position is %s', (_, position) => {
    const lending = { ...wrappedLending(), position };
    renderWithCometRead({ lending, state: cometState(EMPTY_ACCOUNT), queue: actionQueue([]) });

    expect(mockLastProps.Masthead.state[1].baseAsset.balance).toBe(0n);
  });

  it('shows a failed read of the position in the masthead, with Retry', () => {
    const failed: WrappedLending = { ...wrappedLending(), position: { status: 'error', message: 'Read failed.' } };
    renderWithCometRead({ lending: failed, state: cometState(EMPTY_ACCOUNT), queue: actionQueue([]) });

    const { notice } = mockLastProps.Masthead.state[1];
    expect(notice.actionLabel).toBe('Retry');
    expect(notice.onAction).toBe(failed.retry);
  });

  it('says why the position is unavailable when the wrapper check could not run', () => {
    const unavailable: WrappedLending = {
      ...wrappedLending(),
      position: { status: 'unavailable', reason: 'validation-failed' },
    };
    renderWithCometRead({ lending: unavailable, state: cometState(EMPTY_ACCOUNT), queue: actionQueue([]) });

    expect(mockLastProps.Masthead.state[1].notice).toMatchObject({
      message: expect.stringMatching(/could not be checked/),
      actionLabel: 'Reload',
    });
  });

  it('adds no wrapped value to Comet state read for another account', () => {
    const loaded: WrappedLending = { ...wrappedLending(), position: LOADED };
    const state = cometState(EMPTY_ACCOUNT);
    const { rerender } = renderWithCometRead({ lending: loaded, state, queue: actionQueue([]) });
    expect(mockLastProps.Masthead.state[1].baseAsset.balance).toBe(7_000_000n);

    // The wallet switched accounts, and the Comet state is still the previous account's.
    const otherAccount = '0x0000000000000000000000000000000000000bb2';
    const switched = {
      ...mockWeb3,
      read: { ...mockWeb3.read, account: otherAccount },
      write: { ...mockWeb3.write, account: otherAccount },
    };
    rerender(homeElement({ lending: loaded, state, queue: actionQueue([]), web3: switched }));

    expect(mockLastProps.Masthead.state[1].baseAsset.balance).toBe(0n);
  });

  it('adds no wrapped value to Comet state read before the dashboard mounted, but still submits from it', () => {
    const borrower = { ...EMPTY_ACCOUNT, balance: -5_000_000n };
    render(
      homeElement({
        lending: { ...wrappedLending(), position: LOADED },
        state: cometState(borrower),
        queue: actionQueue([[ActionType.Repay, borrower, MAX_UINT256]]),
      })
    );

    // The account this state was read for is unknown, so the masthead leaves out the wrapped value.
    expect(mockLastProps.Masthead.state[1].wrappedSupplyApart).toBeUndefined();
    // A direct submission is judged as on any other visit.
    mockLastProps.PositionCard.state[1].onSubmitClicked();
    expect(mockWriteState.supply).toHaveBeenCalledTimes(1);
  });
});

describe('Home on the standard route', () => {
  it('keeps the direct supply and the market incentives', () => {
    render(homeElement({ lending: STANDARD, state: cometState(EMPTY_ACCOUNT), queue: actionQueue([]) }));

    const [, masthead] = mockLastProps.Masthead.state;
    expect(masthead.earnRewardsAPR).toBe(12_000_000_000_000_000n);
    expect(mockLastProps.PositionCard.state[1].actionRules).toEqual({});
  });

  it('adds no wrapped value and shows no wrapped notice', () => {
    render(homeElement({ lending: STANDARD, state: cometState(EMPTY_ACCOUNT), queue: actionQueue([]) }));

    const [, masthead] = mockLastProps.Masthead.state;
    expect(masthead.baseAsset).toBe(EMPTY_ACCOUNT);
    expect(masthead.wrappedSupplyApart).toBeUndefined();
    expect(masthead.notice).toBeUndefined();
  });
});
