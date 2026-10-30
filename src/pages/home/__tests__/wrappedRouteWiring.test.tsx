import { act, render } from '@testing-library/react';

import { WRAPPED_MARKET_REGISTRY } from '@constants/wrappedMarkets';
import * as ActionQueueContextHelpers from '@contexts/ActionQueueContext';
import * as SelectedMarketContextHelpers from '@contexts/SelectedMarketContext';
import type { Web3 } from '@contexts/Web3Context';
import { STANDARD_LENDING, WrappedLending } from '@contexts/WrappedLendingContext';
import { recordCometStateSource } from '@helpers/cometStateSource';
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
import { mockCompCollateralAsset } from '../../../../__tests__/mocks/mockCollateralAssets';
import { MOCK_MARKETS } from '../../../../__tests__/mocks/mockMarkets';
import { mockWeb3 } from '../../../../__tests__/mocks/mockWeb3';
import { TestLendingProvider } from '../../../../__tests__/mocks/wrappedLending';
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
  allowOperator: jest.fn(),
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
const USDC_MARKET = getMarket(MOCK_MARKETS, 1, USDC_COMET) as MarketData;
const USDT_MARKET = getMarket(MOCK_MARKETS, 1, USDT_COMET) as MarketData;

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
    submission: STANDARD_LENDING.submission,
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
  submission: STANDARD_LENDING.submission,
};

type CometRead = { market?: MarketData; account?: string; isBulkerAllowed?: boolean };

// A Comet state as useCometState makes it: recorded with the market and account it was read for.
function cometState(baseAsset: BaseAssetWithAccountState, read: CometRead = {}): CometState {
  const { market = USDC_MARKET, account = mockWeb3.read.account, isBulkerAllowed = true } = read;
  const state = [
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
      isBulkerAllowed,
      totalBaseSupplyUsd: 0n,
    },
  ] as unknown as CometState;
  recordCometStateSource(
    state,
    { chainId: market.chainInformation.chainId, cometAddress: market.marketAddress },
    account
  );
  return state;
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

type Setup = { lending: WrappedLending; market?: MarketData; state: CometState; queue: ActionQueue; web3?: Web3 };

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
    <TestLendingProvider value={lending} web3={web3} market={market}>
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
    </TestLendingProvider>
  );
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

  it('submits a full repay of a direct borrow as a repay of the whole debt at execution', () => {
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
    // Comet repays the borrow balance at execution for MAX_UINT256, so the repay leaves no excess.
    expect(mockWriteState.supply).toHaveBeenCalledTimes(1);
    expect(mockWriteState.supply).toHaveBeenCalledWith(
      USDC_MARKET,
      borrower.address,
      MAX_UINT256,
      `Repay ${borrower.name}`,
      0,
      expect.any(Function)
    );
    expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
  });

  // Accepted risk: a fixed amount stays fixed, so a debt that falls before execution leaves the
  // excess as direct Comet supply.
  it.each([
    ['equal to', 5_000_000n],
    ['below', 2_000_000n],
  ])('submits a typed repay %s the debt as that fixed amount', (_, amount) => {
    const borrower = { ...EMPTY_ACCOUNT, balance: -5_000_000n };
    render(
      homeElement({
        lending: wrappedLending(),
        state: cometState(borrower),
        queue: actionQueue([[ActionType.Repay, borrower, amount]]),
      })
    );

    mockLastProps.PositionCard.state[1].onSubmitClicked();
    expect(mockWriteState.supply).toHaveBeenCalledTimes(1);
    expect(mockWriteState.supply).toHaveBeenCalledWith(
      USDC_MARKET,
      borrower.address,
      amount,
      `Repay ${borrower.name}`,
      0,
      expect.any(Function)
    );
    expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
  });

  it('passes a full repay queued before a collateral withdrawal to the Bulker as a repay of the whole debt', () => {
    const borrower = { ...EMPTY_ACCOUNT, balance: -5_000_000n };
    const actions: Action[] = [
      [ActionType.Repay, borrower, MAX_UINT256],
      [ActionType.WithdrawCollateral, mockCompCollateralAsset(), 10n ** 18n],
    ];
    render(homeElement({ lending: wrappedLending(), state: cometState(borrower), queue: actionQueue(actions) }));

    act(() => mockLastProps.PositionCard.state[1].onSubmitClicked());
    expect(mockWriteState.invokeBulker).toHaveBeenCalledTimes(1);
    const [market, submitted] = mockWriteState.invokeBulker.mock.calls[0];
    expect(market).toBe(USDC_MARKET);
    expect(submitted).toEqual(actions);
    // An in-place rewrite also changes `actions`, so the comparison above still passes. Check the
    // amount independently.
    expect(submitted[0][2]).toBe(MAX_UINT256);
    expect(mockWriteState.supply).not.toHaveBeenCalled();
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
    const usdc = { ...wrappedLending(), write: { approve: jest.fn(), supply, withdraw } };
    const { rerender } = render(homeElement({ lending: usdc, state, queue: actionQueue([action]) }));
    const keptSubmit = mockLastProps.PositionCard.state[1].onSubmitClicked;

    // The user switches to the USDT market: the submit callback from before belongs to USDC.
    const usdt = { ...wrappedLending(USDT_COMET), write: { approve: jest.fn(), supply, withdraw } };
    const usdtAction = [action[0], { ...EMPTY_ACCOUNT, address: USDT }, action[2]] as Action;
    rerender(homeElement({ lending: usdt, market: USDT_MARKET, state, queue: actionQueue([usdtAction]) }));

    keptSubmit();
    expect(supply).not.toHaveBeenCalled();
    expect(withdraw).not.toHaveBeenCalled();
    mockLastProps.PositionCard.state[1].onSubmitClicked();
    expect(supply.mock.calls.length + withdraw.mock.calls.length).toBe(1);
  });

  it('leaves the wrapped value out while the Comet state still belongs to the previous market', () => {
    const state = cometState(EMPTY_ACCOUNT, { market: USDT_MARKET });
    const loaded: WrappedLending = { ...wrappedLending(), position: LOADED };
    const { rerender } = render(
      homeElement({ lending: wrappedLending(USDT_COMET), market: USDT_MARKET, state, queue: actionQueue([]) })
    );

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
    render(homeElement({ lending, state: cometState(EMPTY_ACCOUNT), queue: actionQueue([]) }));

    expect(mockLastProps.Masthead.state[1].baseAsset.balance).toBe(0n);
  });

  it('shows a failed read of the position in the masthead, with Retry', () => {
    const failed: WrappedLending = { ...wrappedLending(), position: { status: 'error', message: 'Read failed.' } };
    render(homeElement({ lending: failed, state: cometState(EMPTY_ACCOUNT), queue: actionQueue([]) }));

    const { notice } = mockLastProps.Masthead.state[1];
    expect(notice.actionLabel).toBe('Retry');
    expect(notice.onAction).toBe(failed.retry);
  });

  it('says why the position is unavailable when the wrapper check could not run', () => {
    const unavailable: WrappedLending = {
      ...wrappedLending(),
      position: { status: 'unavailable', reason: 'validation-failed' },
    };
    render(homeElement({ lending: unavailable, state: cometState(EMPTY_ACCOUNT), queue: actionQueue([]) }));

    expect(mockLastProps.Masthead.state[1].notice).toMatchObject({
      message: expect.stringMatching(/could not be checked/),
      actionLabel: 'Reload',
    });
  });

  it('adds no wrapped value to Comet state read for another account', () => {
    const loaded: WrappedLending = { ...wrappedLending(), position: LOADED };
    const state = cometState(EMPTY_ACCOUNT);
    const { rerender } = render(homeElement({ lending: loaded, state, queue: actionQueue([]) }));
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

  it('adds the wrapped value to Comet state read for the connected account before the dashboard mounted', () => {
    const borrower = { ...EMPTY_ACCOUNT, balance: -5_000_000n };
    render(
      homeElement({
        lending: { ...wrappedLending(), position: LOADED },
        state: cometState(borrower),
        queue: actionQueue([[ActionType.Repay, borrower, MAX_UINT256]]),
      })
    );

    // useCometState recorded the account it read the state for, so a remounted dashboard knows it.
    expect(mockLastProps.Masthead.state[1].wrappedSupplyApart).toBe(7_000_000n);
    mockLastProps.PositionCard.state[1].onSubmitClicked();
    expect(mockWriteState.supply).toHaveBeenCalledTimes(1);
  });

  it('adds no wrapped value to Comet state with no record of the account it was read for', () => {
    // A copy is a state useCometState never recorded.
    const unrecorded = [...cometState(EMPTY_ACCOUNT)] as unknown as CometState;
    render(
      homeElement({ lending: { ...wrappedLending(), position: LOADED }, state: unrecorded, queue: actionQueue([]) })
    );

    expect(mockLastProps.Masthead.state[1].baseAsset.balance).toBe(0n);
  });
});

describe('Home on the wrapped route across a wallet change', () => {
  const ACCOUNT_A = '0x0000000000000000000000000000000000000aa1';
  const ACCOUNT_B = '0x0000000000000000000000000000000000000bb2';
  const walletSession = (account: string, connector: string): Web3 => ({
    ...mockWeb3,
    read: { ...mockWeb3.read, account },
    write: { ...mockWeb3.write, account, connector: { uid: connector } as Web3['write']['connector'] },
  });
  const WALLET_A = walletSession(ACCOUNT_A, 'connector-a');
  const WALLET_B = walletSession(ACCOUNT_B, 'connector-b');
  const borrower = { ...EMPTY_ACCOUNT, balance: -100_000_000n };
  // Two actions go through the Bulker, which these accounts have not yet allowed.
  const repays = actionQueue([
    [ActionType.Repay, borrower, 50_000_000n],
    [ActionType.Repay, borrower, 50_000_000n],
  ]);

  beforeEach(() => {
    Object.values(mockWriteState).forEach((fn) => fn.mockReset());
  });

  function openBulkerApproval() {
    const state = cometState(borrower, { account: ACCOUNT_A, isBulkerAllowed: false });
    const view = render(homeElement({ lending: wrappedLending(), state, queue: repays, web3: WALLET_A }));
    act(() => mockLastProps.PositionCard.state[1].onSubmitClicked());
    const [, dialog] = mockLastProps.ActionModal.state;
    return {
      ...view,
      approveBulker: dialog.onActionClicked as () => void,
      completeTransaction: dialog.onCompleteClicked as () => void,
    };
  }

  it('completes a kept Bulker approval dialog in the session that opened it', () => {
    const { rerender, completeTransaction } = openBulkerApproval();

    // The approval settles and the account's balances load again.
    const approved = cometState(borrower, { account: ACCOUNT_A });
    rerender(homeElement({ lending: wrappedLending(), state: approved, queue: repays, web3: WALLET_A }));
    act(() => completeTransaction());

    expect(mockWriteState.invokeBulker).toHaveBeenCalledTimes(1);
  });

  it('refuses a kept Bulker approval dialog once another wallet is connected', () => {
    const { rerender, completeTransaction } = openBulkerApproval();

    // Wallet B connects, its balances load and allow the same repayments, and it allows the Bulker.
    const walletB = cometState(borrower, { account: ACCOUNT_B });
    rerender(homeElement({ lending: wrappedLending(), state: walletB, queue: repays, web3: WALLET_B }));
    act(() => completeTransaction());

    // The dialog's callback would sign with wallet A's session, so nothing is submitted.
    expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
  });

  it('asks for the Bulker approval from a kept dialog in the session that opened it', () => {
    const { rerender, approveBulker } = openBulkerApproval();

    const unchanged = cometState(borrower, { account: ACCOUNT_A, isBulkerAllowed: false });
    rerender(homeElement({ lending: wrappedLending(), state: unchanged, queue: repays, web3: WALLET_A }));
    act(() => approveBulker());

    expect(mockWriteState.allowOperator).toHaveBeenCalledTimes(1);
  });

  it("refuses a kept dialog's Bulker approval once another wallet is connected", () => {
    const { rerender, approveBulker } = openBulkerApproval();

    // Wallet B connects, and it has not allowed the Bulker either.
    const walletB = cometState(borrower, { account: ACCOUNT_B, isBulkerAllowed: false });
    rerender(homeElement({ lending: wrappedLending(), state: walletB, queue: repays, web3: WALLET_B }));
    act(() => approveBulker());

    // The dialog's approval would ask wallet A's session to sign, so nothing is requested.
    expect(mockWriteState.allowOperator).not.toHaveBeenCalled();
  });

  it('refuses a kept dialog once the same account connects through another connector', () => {
    const { rerender, completeTransaction } = openBulkerApproval();

    const sameAccount = walletSession(ACCOUNT_A, 'connector-b');
    const approved = cometState(borrower, { account: ACCOUNT_A });
    rerender(homeElement({ lending: wrappedLending(), state: approved, queue: repays, web3: sameAccount }));
    act(() => completeTransaction());

    expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
  });

  it('refuses balances read for the previous account on a return to the dashboard', () => {
    // Account A owes 100 USDC and account B owes nothing. Account B connected while another page
    // was shown, and the app still holds account A's Comet state while B's read is pending.
    const accountA = cometState(borrower, { account: ACCOUNT_A });
    const repay = actionQueue([[ActionType.Repay, borrower, 100_000_000n]]);
    render(homeElement({ lending: wrappedLending(), state: accountA, queue: repay, web3: WALLET_B }));

    act(() => mockLastProps.PositionCard.state[1].onSubmitClicked());

    expect(mockWriteState.supply).not.toHaveBeenCalled();
    expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
  });

  it('submits from balances read for the connected account on a return to the dashboard', () => {
    const accountB = cometState(borrower, { account: ACCOUNT_B });
    const repay = actionQueue([[ActionType.Repay, borrower, 100_000_000n]]);
    render(homeElement({ lending: wrappedLending(), state: accountB, queue: repay, web3: WALLET_B }));

    act(() => mockLastProps.PositionCard.state[1].onSubmitClicked());

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
