import { Interface } from '@ethersproject/abi';
import { TransactionReceipt } from '@ethersproject/providers';
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  ANCHORAGE_CONNECTOR_ID,
  buildWrappedMarketRegistry,
  HARDCODED_WRAPPED_LENDING_SOURCE,
  WrappedMarketRegistry,
} from '@constants/wrappedMarkets';
import * as ActionQueueContextHelpers from '@contexts/ActionQueueContext';
import * as SelectedMarketContextHelpers from '@contexts/SelectedMarketContext';
import { Web3 } from '@contexts/Web3Context';
import { STANDARD_LENDING, WrappedLending } from '@contexts/WrappedLendingContext';
import { calculateUpdatedBalances, validateAddingAction, validateAllowanceForAction } from '@helpers/actions';
import { LendingRoute, LendingSession, resolveLendingRoute, wrappedRouteKey } from '@helpers/lendingRoute';
import { getMarket } from '@helpers/markets';
import { MAX_UINT256 } from '@helpers/numbers';
import {
  WRAPPED_ACTION,
  WrappedActionDraft,
  WrappedActionType,
  WrappedBlockReason,
  WrappedStep,
  wrappedActionIdentity,
} from '@helpers/wrappedActions';
import { WrappedPosition } from '@helpers/wrappedPositions';
import { Theme } from '@hooks/useThemeManager';
import { WrappedActionController, WrappedActionState, WrappedStepState } from '@hooks/useWrappedAction';
import {
  Action,
  ActionQueue,
  ActionType,
  BaseAssetWithAccountState,
  CometState,
  MarketData,
  PendingAction,
  StateType,
  TokenWithAccountState,
  Transaction,
  TransactionState,
} from '@types';

import { mockBaseAsset } from '../../../../__tests__/mocks/mockBaseAsset';
import { mockCompCollateralAsset, mockEthCollateralAsset } from '../../../../__tests__/mocks/mockCollateralAssets';
import { mockWeb3 } from '../../../../__tests__/mocks/mockWeb3';
import { TestLendingProvider } from '../../../../__tests__/mocks/wrappedLending';
import Home from '../index';

// Home's children record their props.
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
// Each collateral row's props, by its asset's symbol.
const mockAssetRows: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
jest.mock('../components/AssetRow', () => ({
  __esModule: true,
  default: (props: { state: [unknown, { asset?: { symbol: string } }?] }) => {
    mockAssetRows[props.state[1]?.asset?.symbol ?? ''] = props;
    return null;
  },
}));
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

const ACCOUNT = '0x0000000000000000000000000000000000000aa1';
const OTHER_ACCOUNT = '0x0000000000000000000000000000000000000bb2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const USDC_WRAPPER = '0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73';
const USDT_COMET = '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840';
const WETH_COMET = '0xA17581A9E3356d9A858b789D68B4d866e593aE94';
const USDC_MARKET = getMarket(1, USDC_COMET) as MarketData;
const USDT_MARKET = getMarket(1, USDT_COMET) as MarketData;
const WETH_MARKET = getMarket(1, WETH_COMET) as MarketData;
const WALLET = { name: 'wallet provider' };
const AMOUNT = 1_000_000_000n;
const HASH = `0x${'7'.repeat(64)}`;

const CALLS = new Interface([
  'function approve(address spender, uint256 amount)',
  'function supplyAndWrap(uint256 amount)',
  'function unwrapAndWithdraw(uint256 shares)',
]);

function registryWith(isOpen: boolean): WrappedMarketRegistry {
  return buildWrappedMarketRegistry({
    markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({
      ...market,
      isDepositEnabled: isOpen,
      isExitEnabled: isOpen,
    })),
  });
}
/** Deposits and exits open, as a release would set them. The committed registry keeps both closed. */
const OPEN = registryWith(true);
const CLOSED = registryWith(false);

const SESSION: LendingSession = {
  connector: { id: ANCHORAGE_CONNECTOR_ID, uid: 'uid-1' },
  status: 'connected',
  account: ACCOUNT,
  chainId: 1,
  isWatchOnly: false,
  isSignerReady: true,
  screeningStatus: 'allowed',
};

function routeFor(registry: WrappedMarketRegistry = OPEN, cometAddress = USDC_COMET): LendingRoute {
  const lookup = registry.lookup(1, cometAddress);
  return resolveLendingRoute({
    market: { chainId: 1, cometAddress },
    session: SESSION,
    conflictedRdns: new Set(),
    validation:
      lookup.status === 'valid' ? { key: wrappedRouteKey(lookup.market, SESSION), status: 'matched' } : undefined,
    registry,
  });
}

function draftFor(type: WrappedActionType, steps: WrappedStep[], amount = AMOUNT): WrappedActionDraft {
  const identity = wrappedActionIdentity(type, {
    route: routeFor(),
    account: ACCOUNT,
    chainId: 1,
    screeningStatus: 'allowed',
    provider: WALLET,
  });
  if (identity === undefined) throw new Error('the session must have an identity');
  return { kind: WRAPPED_ACTION, id: `draft-${type}`, identity, amount, steps };
}

const APPROVE_STEP: WrappedStep = {
  id: 'approve',
  kind: 'approve',
  description: 'Enable USDC',
  request: { to: USDC, data: CALLS.encodeFunctionData('approve', [USDC_WRAPPER, AMOUNT]) },
};
const SUPPLY_STEP: WrappedStep = {
  id: 'supply',
  kind: 'supply-and-wrap',
  description: 'Supply USDC',
  request: { to: USDC_WRAPPER, data: CALLS.encodeFunctionData('supplyAndWrap', [AMOUNT]) },
};

const SHARES = 400n * 10n ** 18n;
const WITHDRAW_STEP: WrappedStep = {
  id: 'withdraw',
  kind: 'unwrap-and-withdraw',
  description: 'Withdraw USDC',
  request: { to: USDC_WRAPPER, data: CALLS.encodeFunctionData('unwrapAndWithdraw', [SHARES]) },
  check: async () => ({ ok: false, message: 'not used' }),
};

function supplyState(
  phase: 'review' | 'signing' | 'complete' | 'stopped',
  steps: WrappedStep[],
  statuses: WrappedStepState[],
  stepIndex = 0,
  draft = draftFor('supply', steps)
): WrappedActionState {
  return { phase, draft, steps: statuses, stepIndex };
}

const confirmed = (hash = HASH): WrappedStepState => ({
  status: 'confirmed',
  hash,
  receipt: { transactionHash: hash, status: 1 } as TransactionReceipt,
});

type Controller = WrappedActionController & { confirm: jest.Mock; discard: jest.Mock };

function controller(state: WrappedActionState = { phase: 'idle' }, overrides: Partial<Controller> = {}): Controller {
  return {
    state,
    session: { status: 'usable' },
    recovered: { pending: [], settled: [] },
    blockedReason: () => undefined,
    start: jest.fn(),
    confirm: jest.fn(),
    discard: jest.fn(),
    ...overrides,
  };
}

// 2,500.125 USDC of wrapped supply, of which a full exit pays 2,500.124997 USDC.
const POSITION: WrappedPosition = {
  shares: 2_500n * 10n ** 18n,
  shareDecimals: 18,
  grossAssets: 2_500_125_000n,
  baseDecimals: 6,
  baseWalletBalance: 5_000_000_000n,
  wrapperAllowance: 0n,
  redeemBuffer: 3n,
  fullExitCash: 2_500_124_997n,
  isWithdrawPaused: false,
  snapshot: {
    totalSupply: 2_500n * 10n ** 18n,
    totalAssets: 2_500_125_000n,
    baseSupplyIndex: 1_000_000_000_000_000n,
  },
};

type Lending = WrappedLending & { write: { approve: jest.Mock; supply: jest.Mock; withdraw: jest.Mock } };

/** The position with an allowance to the wrapper that covers a supply of `AMOUNT`. */
const APPROVED: WrappedPosition = { ...POSITION, wrapperAllowance: AMOUNT };

function lendingWith(
  action: Controller = controller(),
  {
    route = routeFor(),
    position = APPROVED,
    supplyRefusal,
  }: { route?: LendingRoute; position?: WrappedPosition | undefined; supplyRefusal?: WrappedBlockReason } = {}
): Lending {
  return {
    route,
    position: position === undefined ? { status: 'loading' } : { status: 'loaded', position },
    retry: jest.fn(),
    action,
    write: {
      approve: jest.fn(() => undefined),
      supply: jest.fn(() => supplyRefusal),
      withdraw: jest.fn(() => undefined),
    },
    submission: STANDARD_LENDING.submission,
  };
}

// The account holds nothing in Comet: the empty-account path.
const BASE_ASSET = mockBaseAsset({
  address: USDC,
  symbol: 'USDC',
  decimals: 6,
  balance: 0n,
  allowance: 0n,
  walletBalance: 5_000_000_000n,
  balanceOfComet: 10n ** 15n,
});
const COLLATERAL: TokenWithAccountState = mockEthCollateralAsset({ walletBalance: 10n ** 18n });

function cometState(baseAsset: BaseAssetWithAccountState = BASE_ASSET, isBulkerAllowed = true): CometState {
  return [
    StateType.Hydrated,
    {
      baseAsset,
      borrowAPR: 0n,
      collateralAssets: [COLLATERAL],
      collateralValue: 123n,
      earnAPR: 0n,
      liquidationCapacity: 456n,
      borrowRewardsAPR: 0n,
      supplyRewardsAPR: 0n,
      isInstitutional: false,
      rewardsAssetSymbol: 'COMP',
      isRewardsLoading: false,
      isBulkerAllowed,
      totalBaseSupplyUsd: 0n,
    },
  ] as unknown as CometState;
}

type Queue = ActionQueue & {
  addOrUpdateAction: jest.Mock;
  clearActions: jest.Mock;
  removeAction: jest.Mock;
  setPendingAction: jest.Mock;
};

function actionQueue(actions: Action[] = [], pendingAction?: PendingAction): Queue {
  return {
    addOrUpdateAction: jest.fn(),
    clearActions: jest.fn(),
    queueActions: jest.fn(),
    // The queue hands back its actions with the base asset Home passes, as `useActionQueue` does.
    getActions: (baseAsset: BaseAssetWithAccountState) =>
      actions.map((action) =>
        action[0] === ActionType.Supply || action[0] === ActionType.Withdraw
          ? ([action[0], baseAsset, action[2]] as Action)
          : action
      ),
    getPendingAction: (baseAsset: BaseAssetWithAccountState) =>
      pendingAction === undefined ? undefined : ([pendingAction[0], baseAsset, pendingAction[2]] as PendingAction),
    removeAction: jest.fn(),
    setPendingAction: jest.fn(),
  } as Queue;
}

const WEB3: Web3 = {
  ...mockWeb3,
  read: { ...mockWeb3.read, account: ACCOUNT, chainId: 1 },
  write: {
    ...mockWeb3.write,
    account: ACCOUNT,
    chainId: 1,
    connector: { id: ANCHORAGE_CONNECTOR_ID, uid: 'uid-1' } as Web3['write']['connector'],
  },
};

SelectedMarketContextHelpers.initializeContext({
  selectedMarket: [StateType.Hydrated, USDC_MARKET],
  selectMarket: jest.fn(),
  selectMarketByAddress: jest.fn(),
});
ActionQueueContextHelpers.initializeContext(actionQueue());

const switchWriteNetwork = jest.fn(async () => true);

type HomeOptions = {
  queue?: ActionQueue;
  /** The transaction manager's list. */
  transactions?: Transaction[];
  market?: MarketData;
  web3?: Web3;
  state?: CometState;
  /** Whether the dashboard is shown. App and its providers stay mounted when another page is shown. */
  isDashboard?: boolean;
};

function homeElement(
  lending: WrappedLending,
  {
    queue = actionQueue(),
    transactions = [],
    market = USDC_MARKET,
    web3 = WEB3,
    state,
    isDashboard = true,
  }: HomeOptions = {}
) {
  const SelectedMarketContext = SelectedMarketContextHelpers.getSelectedMarketContext();
  const ActionQueueContext = ActionQueueContextHelpers.getActionQueueContext();
  const selectedMarketData = {
    selectedMarket: [StateType.Hydrated, market] as const,
    selectMarket: jest.fn(),
    selectMarketByAddress: jest.fn(),
  };
  return (
    <TestLendingProvider value={lending} web3={web3} market={market}>
      <SelectedMarketContext.Provider value={selectedMarketData as never}>
        <ActionQueueContext.Provider value={queue}>
          {isDashboard && (
            <Home
              transactions={transactions}
              web3={web3}
              selectedMarketData={selectedMarketData as never}
              cometState={state ?? cometState()}
              addTransaction={jest.fn()}
              switchWriteNetwork={switchWriteNetwork}
              estimatedGasMap={new Map()}
              theme={Theme.Dark}
            />
          )}
        </ActionQueueContext.Provider>
      </SelectedMarketContext.Provider>
    </TestLendingProvider>
  );
}

// Home trusts a Comet state for the account only once it arrives while the dashboard is mounted,
// as the app delivers it.
function renderHome(lending: WrappedLending, options: HomeOptions = {}) {
  const view = render(homeElement(lending, { ...options, state: [StateType.Loading, undefined] }));
  view.rerender(homeElement(lending, options));
  return {
    ...view,
    rerenderHome: (nextLending: WrappedLending, nextOptions: HomeOptions = options) =>
      view.rerender(homeElement(nextLending, nextOptions)),
  };
}

const masthead = () => mockLastProps.Masthead.state[1];
const positionCard = () => mockLastProps.PositionCard.state[1];

/**
 * Whether any dialog is shown. App keeps its modal nodes mounted and marks the shown one active, so
 * both are checked, as is the dashboard's own modal, which is recorded here.
 */
function expectNoDialog() {
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.querySelector('.modal--active')).toBeNull();
  expect(mockLastProps.ActionModal.state).toBeUndefined();
}

/** A wrapper transaction in the manager's list, as the lifecycle sends one. */
function wrapperTransaction(step: string, state: TransactionState): Transaction {
  const base = {
    id: `transaction-${step}`,
    key: USDC_WRAPPER,
    networkId: 1,
    networkName: 'homestead',
    description: step === 'supply' ? 'Supply USDC' : step === 'withdraw' ? 'Withdraw USDC' : 'Enable USDC',
    nonce: 5,
    account: ACCOUNT.toLowerCase(),
    step,
  };
  return state === TransactionState.Pending
    ? { ...base, state, hash: HASH }
    : { ...base, state: TransactionState.AwaitingConfirmation };
}

describe('Home on the wrapped route', () => {
  beforeEach(() => {
    Object.values(mockWriteState).forEach((fn) => fn.mockReset());
    switchWriteNetwork.mockClear();
  });

  describe('uses the normal dashboard', () => {
    it('renders no separate wrapped panel and offers the normal Supply entry', () => {
      const queue = actionQueue();
      const { container } = renderHome(lendingWith(), { queue });

      expect(container.querySelector('.wrapped-position-panel')).toBeNull();
      expect(screen.queryByRole('button', { name: /through the wrapper/i })).toBeNull();
      expect(masthead().isDirectBaseSupplyBlocked).toBeFalsy();

      const supply = [ActionType.Supply, masthead().baseAsset, undefined] as PendingAction;
      act(() => masthead().onSupplyAction(supply));
      expect(queue.setPendingAction).toHaveBeenCalledWith(supply);
    });

    it("gives the amount form and queue the allowance to the wrapper, not Comet's", () => {
      renderHome(lendingWith(controller(), { position: { ...POSITION, wrapperAllowance: AMOUNT - 1n } }));
      const { actionRules, baseAsset, collateralAssets } = positionCard();
      const supply: Action = [ActionType.Supply, baseAsset, AMOUNT];

      expect(actionRules.wrappedBase.supplyAllowance).toBe(AMOUNT - 1n);
      // The Comet snapshot keeps its own allowance.
      expect(baseAsset.allowance).toBe(BASE_ASSET.allowance);
      expect(validateAddingAction(baseAsset, collateralAssets, [], supply, actionRules)).toBe('ok');
      expect(validateAllowanceForAction(baseAsset, collateralAssets, [], supply, actionRules)).toEqual([
        false,
        'Approval Failed',
      ]);
    });

    it('shows the wrapped value as the base balance, and queued actions in the after values', () => {
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      renderHome(lendingWith(), { queue });

      expect(masthead().baseAsset.balance).toBe(POSITION.grossAssets);
      expect(masthead().baseAssetPost.balance).toBe(POSITION.grossAssets + AMOUNT);
      expect(masthead().baseAssetPost.walletBalance).toBe(BASE_ASSET.walletBalance - AMOUNT);
      expect(positionCard().baseAsset.balance).toBe(POSITION.grossAssets);
      expect(positionCard().baseAssetPost.balance).toBe(POSITION.grossAssets + AMOUNT);
    });

    it('keeps wrapper shares out of collateral, borrow capacity and liquidation figures', () => {
      renderHome(lendingWith());

      const withoutWrapper = calculateUpdatedBalances(BASE_ASSET, [COLLATERAL], []);

      expect(positionCard().collateralValue).toBe(123n);
      expect(positionCard().liquidationCapacity).toBe(456n);
      expect(positionCard().baseAsset.borrowCapacity).toBe(BASE_ASSET.borrowCapacity);
      expect(positionCard().baseAssetPost.borrowCapacity).toBe(withoutWrapper.baseAsset.borrowCapacity);
      expect(positionCard().collateralValuePost).toBe(withoutWrapper.collateralValue);
      expect(positionCard().liquidationCapacityPost).toBe(withoutWrapper.liquidationCapacity);
    });

    it('never nets the wrapped value against a direct borrow', () => {
      const borrower = { ...BASE_ASSET, balance: -1_000_000_000n };
      renderHome(lendingWith(), { state: cometState(borrower) });

      expect(masthead().baseAsset.balance).toBe(-1_000_000_000n);
      expect(masthead().wrappedSupplyApart).toBe(POSITION.grossAssets);
    });

    it("shows the route's blocked reason instead of queueing while the release controls are closed", () => {
      const queue = actionQueue([], [ActionType.Supply, BASE_ASSET, undefined]);
      const lending = lendingWith(controller(), { route: routeFor(CLOSED), position: POSITION });
      renderHome(lending, { queue });
      const { actionRules, baseAsset, collateralAssets } = positionCard();

      expect(
        validateAddingAction(baseAsset, collateralAssets, [], [ActionType.Supply, baseAsset, 1n], actionRules)
      ).toEqual([false, 'Supply Not Open Yet']);
      expect(
        validateAddingAction(baseAsset, collateralAssets, [], [ActionType.Withdraw, baseAsset, 1n], actionRules)
      ).toEqual([false, 'Withdrawals Not Open Yet']);

      // A form callback kept from before the controls closed queues nothing and asks for nothing.
      act(() => positionCard().onPendingActionConfirm(AMOUNT));
      expect(queue.addOrUpdateAction).not.toHaveBeenCalled();
      expect(lending.write.approve).not.toHaveBeenCalled();
    });
  });

  describe('adds a base supply as production does: Approve & Add requests the approval', () => {
    it('requests the exact approval to the wrapper and queues the supply, with no dialog', () => {
      const lending = lendingWith(controller(), { position: POSITION });
      const queue = actionQueue([], [ActionType.Supply, BASE_ASSET, undefined]);
      renderHome(lending, { queue });

      act(() => positionCard().onPendingActionConfirm(AMOUNT));

      expect(lending.write.approve).toHaveBeenCalledWith(AMOUNT);
      expect(queue.addOrUpdateAction).toHaveBeenCalledTimes(1);
      const [queued] = queue.addOrUpdateAction.mock.calls[0];
      expect([queued[0], queued[2]]).toEqual([ActionType.Supply, AMOUNT]);
      // Never an approval of Comet, and nothing is supplied yet.
      expect(mockWriteState.approve).not.toHaveBeenCalled();
      expect(lending.write.supply).not.toHaveBeenCalled();
      expectNoDialog();
    });

    it('approves the wallet balance for a Max supply', () => {
      const lending = lendingWith(controller(), { position: POSITION });
      renderHome(lending, { queue: actionQueue([], [ActionType.Supply, BASE_ASSET, undefined]) });

      act(() => positionCard().onPendingActionConfirm(MAX_UINT256));

      expect(lending.write.approve).toHaveBeenCalledWith(BASE_ASSET.walletBalance);
    });

    it('queues with no request when the allowance to the wrapper covers the amount, as Add Action does', () => {
      const lending = lendingWith();
      const queue = actionQueue([], [ActionType.Supply, BASE_ASSET, undefined]);
      renderHome(lending, { queue });

      act(() => positionCard().onPendingActionConfirm(AMOUNT));

      expect(queue.addOrUpdateAction).toHaveBeenCalledTimes(1);
      expect(lending.write.approve).not.toHaveBeenCalled();
    });

    it('asks for an approval again when the amount is raised above the allowance', () => {
      const lending = lendingWith();
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]], [ActionType.Supply, BASE_ASSET, AMOUNT]);
      renderHome(lending, { queue });

      act(() => positionCard().onPendingActionConfirm(AMOUNT + 1n));

      expect(lending.write.approve).toHaveBeenCalledWith(AMOUNT + 1n);
    });

    it('queues nothing and leaves the form open when the approval cannot start, as while an earlier one is pending', () => {
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const lending = lendingWith(controller(), { position: POSITION });
      lending.write.approve.mockReturnValue('action-in-progress');
      const queue = actionQueue([], [ActionType.Supply, BASE_ASSET, undefined]);
      renderHome(lending, { queue });

      act(() => positionCard().onPendingActionConfirm(AMOUNT));

      expect(lending.write.approve).toHaveBeenCalledWith(AMOUNT);
      expect(queue.addOrUpdateAction).not.toHaveBeenCalled();
      expect(queue.setPendingAction).not.toHaveBeenCalled();
    });

    it('asks the wallet to switch network first, as production does, and queues nothing', () => {
      const lending = lendingWith(controller(), { position: POSITION });
      const queue = actionQueue([], [ActionType.Supply, BASE_ASSET, undefined]);
      renderHome(lending, { queue, web3: { ...WEB3, write: { ...WEB3.write, chainId: 8453 } } });

      act(() => positionCard().onPendingActionConfirm(AMOUNT));

      expect(switchWriteNetwork).toHaveBeenCalledWith(1);
      expect(lending.write.approve).not.toHaveBeenCalled();
      expect(queue.addOrUpdateAction).not.toHaveBeenCalled();
    });

    it('queues a withdrawal with no approval', () => {
      const lending = lendingWith(controller(), { position: POSITION });
      const queue = actionQueue([], [ActionType.Withdraw, BASE_ASSET, undefined]);
      renderHome(lending, { queue });

      act(() => positionCard().onPendingActionConfirm(400_000_000n));

      expect(queue.addOrUpdateAction).toHaveBeenCalledTimes(1);
      expect(lending.write.approve).not.toHaveBeenCalled();
    });

    it("shows the supply's row as Approval Pending from the press until the receipt, without holding the dashboard", () => {
      const supply: Action = [ActionType.Supply, BASE_ASSET, AMOUNT];
      const queue = actionQueue([], [ActionType.Supply, BASE_ASSET, undefined]);
      const { rerenderHome } = renderHome(lendingWith(controller(), { position: POSITION }), { queue });
      act(() => positionCard().onPendingActionConfirm(AMOUNT));
      const queued = actionQueue([supply]);
      const approvalRow = () =>
        positionCard().approvalTransactions.find((transaction: Transaction) => transaction.key === BASE_ASSET.address);

      // The approval's checks run before the wallet is asked.
      const identity = draftFor('supply', [APPROVE_STEP]).identity;
      rerenderHome(lendingWith(controller({ phase: 'reading', identity }), { position: POSITION }), {
        queue: queued,
      });
      expect(approvalRow()).toBeDefined();
      expect(positionCard().transaction).toBeUndefined();

      // The wallet has the request, then its hash.
      const approving = { ...draftFor('supply', [APPROVE_STEP]), isApprovalOnly: true };
      for (const state of [TransactionState.AwaitingConfirmation, TransactionState.Pending]) {
        const step: WrappedStepState =
          state === TransactionState.Pending ? { status: 'submitted', hash: HASH } : { status: 'awaiting-signature' };
        rerenderHome(
          lendingWith(controller(supplyState('signing', [APPROVE_STEP], [step], 0, approving)), { position: POSITION }),
          {
            queue: queued,
            transactions: [wrapperTransaction('approve', state)],
          }
        );
        expect(approvalRow()).toMatchObject({ state });
        // An approval does not hold the dashboard.
        expect(positionCard().transaction).toBeUndefined();
        expect(masthead().transaction).toBeUndefined();
        expect(mockAssetRows[COLLATERAL.symbol].state[1].transaction).toBeUndefined();
      }

      rerenderHome(lendingWith(controller(supplyState('complete', [APPROVE_STEP], [confirmed()], 0, approving))), {
        queue: queued,
      });
      expect(approvalRow()).toBeUndefined();
      expect(queue.removeAction).not.toHaveBeenCalled();
      expectNoDialog();
    });
  });

  describe('submits a queued base supply through the wrapper, with the position card states', () => {
    it('starts the wrapped supply of the queued amount, never a Comet supply, an approval or the Bulker', () => {
      const lending = lendingWith();
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      renderHome(lending, { queue });

      act(() => positionCard().onSubmitClicked());

      expect(lending.write.supply).toHaveBeenCalledWith(AMOUNT);
      expect(lending.write.approve).not.toHaveBeenCalled();
      expect(mockWriteState.supply).not.toHaveBeenCalled();
      expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
      expect(mockWriteState.approve).not.toHaveBeenCalled();
      expectNoDialog();
    });

    it('supplies the wallet balance for a maximum supply', () => {
      const lending = lendingWith(controller(), { position: { ...POSITION, wrapperAllowance: MAX_UINT256 } });
      renderHome(lending, { queue: actionQueue([[ActionType.Supply, BASE_ASSET, MAX_UINT256]]) });

      act(() => positionCard().onSubmitClicked());

      expect(lending.write.supply).toHaveBeenCalledWith(BASE_ASSET.walletBalance);
    });

    it('shows Confirm Transaction from the press, Transaction Pending... after the hash, and clears the supply on its receipt', () => {
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lendingWith(), { queue });
      act(() => positionCard().onSubmitClicked());
      const card = () => positionCard().transaction?.state;

      // The checks before the wallet is asked.
      const identity = draftFor('supply', [SUPPLY_STEP]).identity;
      rerenderHome(lendingWith(controller({ phase: 'reading', identity })), { queue });
      expect(card()).toBe(TransactionState.AwaitingConfirmation);
      rerenderHome(lendingWith(controller(supplyState('signing', [SUPPLY_STEP], [{ status: 'checking' }]))), { queue });
      expect(card()).toBe(TransactionState.AwaitingConfirmation);
      // The wallet has the request.
      const draft = draftFor('supply', [SUPPLY_STEP]);
      rerenderHome(
        lendingWith(controller(supplyState('signing', [SUPPLY_STEP], [{ status: 'awaiting-signature' }], 0, draft))),
        { queue, transactions: [wrapperTransaction('supply', TransactionState.AwaitingConfirmation)] }
      );
      expect(card()).toBe(TransactionState.AwaitingConfirmation);
      expect(masthead().transaction).toBeDefined();
      expect(mockAssetRows[COLLATERAL.symbol].state[1].transaction).toBeDefined();
      // The hash.
      rerenderHome(
        lendingWith(controller(supplyState('signing', [SUPPLY_STEP], [{ status: 'submitted', hash: HASH }], 0, draft))),
        { queue, transactions: [wrapperTransaction('supply', TransactionState.Pending)] }
      );
      expect(card()).toBe(TransactionState.Pending);
      expect(queue.removeAction).not.toHaveBeenCalled();
      expectNoDialog();

      // The receipt.
      rerenderHome(lendingWith(controller(supplyState('complete', [SUPPLY_STEP], [confirmed()], 0, draft))), { queue });
      expect(queue.removeAction).toHaveBeenCalledTimes(1);
      expect(queue.removeAction.mock.calls[0][0][0]).toBe(ActionType.Supply);
      expect(queue.clearActions).not.toHaveBeenCalled();
      expect(card()).toBeUndefined();
      expectNoDialog();
    });

    it('returns the queue to Submit after a rejection, with nothing said, as production does', () => {
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const first = lendingWith();
      const { rerenderHome } = renderHome(first, { queue });
      act(() => positionCard().onSubmitClicked());
      const rejected = lendingWith(controller(supplyState('stopped', [SUPPLY_STEP], [{ status: 'rejected' }])));
      rerenderHome(rejected, { queue });

      expect(positionCard().transaction).toBeUndefined();
      expect(positionCard().actionRules.wrappedBase.stopped).toBeUndefined();
      expect(queue.removeAction).not.toHaveBeenCalled();
      expectNoDialog();

      act(() => positionCard().onSubmitClicked());
      expect(rejected.write.supply).toHaveBeenCalledWith(AMOUNT);
    });

    it.each<[string, WrappedActionState, string]>([
      [
        'a check before the signature',
        supplyState('stopped', [SUPPLY_STEP], [{ status: 'blocked', reason: 'step-check-failed', message: 'x' }]),
        'Not Sent, Try Again',
      ],
      [
        'the reads before the checks',
        { phase: 'read-failed', identity: draftFor('supply', [SUPPLY_STEP]).identity, message: 'rate limited' },
        'Not Sent, Try Again',
      ],
      [
        "the wallet's refusal before it handled the request",
        supplyState('stopped', [SUPPLY_STEP], [{ status: 'refused', message: 'Unauthorized (4100)' }]),
        'Reconnect Your Wallet',
      ],
    ])(
      'labels the row in its error position when %s stops the supply, and Submit sends it again',
      (_name, state, label) => {
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const supply: Action = [ActionType.Supply, BASE_ASSET, AMOUNT];
        const queue = actionQueue([supply]);
        const { rerenderHome } = renderHome(lendingWith(), { queue });
        act(() => positionCard().onSubmitClicked());
        const stopped = lendingWith(controller(state));
        rerenderHome(stopped, { queue });

        expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
          action: expect.arrayContaining([ActionType.Supply]),
          label,
        });
        expect(positionCard().transaction).toBeUndefined();
        expect(queue.removeAction).not.toHaveBeenCalled();
        expectNoDialog();

        act(() => positionCard().onSubmitClicked());
        expect(stopped.write.supply).toHaveBeenCalledTimes(1);
      }
    );

    it.each<[WrappedBlockReason, string]>([
      // An earlier request can still go through, so the row does not ask for another try.
      ['transaction-pending', 'Earlier Request Still Pending'],
      ['action-in-progress', 'Earlier Request Still Pending'],
      ['session-unusable', 'Not Sent, Try Again'],
    ])('labels the row when the start is refused with %s, and opens no dialog', (refusal, label) => {
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      renderHome(lendingWith(controller(), { supplyRefusal: refusal }), { queue });

      act(() => positionCard().onSubmitClicked());

      expect(positionCard().actionRules.wrappedBase.stopped?.label).toBe(label);
      expect(positionCard().transaction).toBeUndefined();
      expectNoDialog();
    });

    it('does not take a supply out of the queue for a draft that completed before this submission', () => {
      const earlier = supplyState('complete', [SUPPLY_STEP], [confirmed()]);
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      // The start is accepted, but the lifecycle still shows the earlier draft, as it does until the
      // new draft's first render.
      const lending = lendingWith(controller(earlier));
      const { rerenderHome } = renderHome(lending, { queue });

      act(() => positionCard().onSubmitClicked());
      rerenderHome(lending, { queue });

      expect(lending.write.supply).toHaveBeenCalledTimes(1);
      expect(queue.removeAction).not.toHaveBeenCalled();
    });

    it('starts one wrapped supply however often Submit is pressed while it is in progress', () => {
      const lending = lendingWith();
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lending, { queue });
      const submit = positionCard().onSubmitClicked;

      act(() => submit());
      const reading = lendingWith(
        controller({ phase: 'reading', identity: draftFor('supply', [SUPPLY_STEP]).identity })
      );
      rerenderHome(reading, { queue });
      act(() => submit());
      act(() => positionCard().onSubmitClicked());

      expect(lending.write.supply).toHaveBeenCalledTimes(1);
      expect(reading.write.supply).not.toHaveBeenCalled();
    });
  });

  describe('keeps a run across a visit to another page', () => {
    it('takes the supply out of the queue once it confirmed while another page was shown', () => {
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lendingWith(controller()), { queue });
      act(() => positionCard().onSubmitClicked());
      const draft = draftFor('supply', [SUPPLY_STEP]);
      const signing = supplyState('signing', [SUPPLY_STEP], [{ status: 'submitted', hash: HASH }], 0, draft);
      rerenderHome(lendingWith(controller(signing)), { queue });

      // The user opens another page while the supply is pending, and it confirms there.
      const complete = supplyState('complete', [SUPPLY_STEP], [confirmed()], 0, draft);
      rerenderHome(lendingWith(controller(signing)), { queue, isDashboard: false });
      rerenderHome(lendingWith(controller(complete)), { queue, isDashboard: false });
      expect(queue.removeAction).not.toHaveBeenCalled();

      rerenderHome(lendingWith(controller(complete)), { queue });
      expect(queue.removeAction).toHaveBeenCalledTimes(1);
      expectNoDialog();
    });
  });

  describe('holds the queue still while a supply runs', () => {
    it('ignores edits, removals, clears and new amounts kept from earlier renders while its checks run', () => {
      const supply: Action = [ActionType.Supply, BASE_ASSET, AMOUNT];
      const queue = actionQueue([supply], [ActionType.Supply, BASE_ASSET, undefined]);
      const { rerenderHome } = renderHome(lendingWith(controller()), { queue });
      act(() => positionCard().onSubmitClicked());
      rerenderHome(lendingWith(controller(supplyState('signing', [SUPPLY_STEP], [{ status: 'checking' }]))), {
        queue,
      });
      queue.setPendingAction.mockClear();

      act(() => positionCard().onPendingActionConfirm(5n * AMOUNT));
      act(() => positionCard().onDeleteAction(supply));
      act(() => positionCard().onClearClicked());
      act(() => positionCard().onSelectAction(supply));
      act(() => masthead().onSupplyAction([ActionType.Supply, BASE_ASSET, undefined]));

      expect(queue.addOrUpdateAction).not.toHaveBeenCalled();
      expect(queue.removeAction).not.toHaveBeenCalled();
      expect(queue.clearActions).not.toHaveBeenCalled();
      expect(queue.setPendingAction).not.toHaveBeenCalled();
    });

    it('disables both collateral row families as a pending transaction to Comet does', () => {
      // stETH is listed apart from the market's collateral, as "Other Assets".
      const stETH = mockEthCollateralAsset({
        address: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84',
        symbol: 'stETH',
        name: 'Lido Staked ETH',
      });
      const state = cometState();
      const withStETH = [state[0], { ...state[1], collateralAssets: [COLLATERAL, stETH] }] as unknown as CometState;
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const options = { queue, state: withStETH };
      const { rerenderHome } = renderHome(lendingWith(controller()), options);
      act(() => positionCard().onSubmitClicked());
      // The check before the signature is held open: the wallet has not been asked, so the
      // transaction manager tracks nothing yet.
      rerenderHome(lendingWith(controller(supplyState('signing', [SUPPLY_STEP], [{ status: 'checking' }]))), options);

      for (const asset of [COLLATERAL, stETH]) {
        expect(mockAssetRows[asset.symbol].state[1].transaction).toMatchObject({
          state: TransactionState.AwaitingConfirmation,
        });
      }
    });
  });

  describe('a supply that stops where it can still go through', () => {
    it('leaves the queue when the wallet may still send it, and shows nothing more', () => {
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lendingWith(controller()), { queue });
      act(() => positionCard().onSubmitClicked());
      const pending: WrappedStepState = {
        status: 'provider-failure',
        message: 'The request can still complete (4900)',
        isPendingInWallet: true,
      };
      rerenderHome(lendingWith(controller(supplyState('stopped', [SUPPLY_STEP], [pending]))), { queue });

      expect(queue.removeAction).toHaveBeenCalledTimes(1);
      expect(positionCard().actionRules.wrappedBase.stopped).toBeUndefined();
      expectNoDialog();
    });

    it('stays queued, labelled, when it reverted', () => {
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lendingWith(controller()), { queue });
      act(() => positionCard().onSubmitClicked());
      const reverted: WrappedStepState = {
        status: 'reverted',
        hash: HASH,
        receipt: { transactionHash: HASH, status: 0 } as TransactionReceipt,
      };
      rerenderHome(lendingWith(controller(supplyState('stopped', [SUPPLY_STEP], [reverted]))), { queue });

      expect(queue.removeAction).not.toHaveBeenCalled();
      expect(positionCard().actionRules.wrappedBase.stopped?.label).toBe('Transaction Failed');
    });

    it('leaves the queue when another transaction took its nonce, as a sped-up copy does', () => {
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lendingWith(controller()), { queue });
      act(() => positionCard().onSubmitClicked());
      const replaced: WrappedStepState = { status: 'replaced', hash: HASH };
      rerenderHome(lendingWith(controller(supplyState('stopped', [SUPPLY_STEP], [replaced]))), { queue });

      expect(queue.removeAction).toHaveBeenCalledTimes(1);
      expectNoDialog();
    });
  });

  describe('submits a queued base withdrawal through the wrapper', () => {
    it('asks the wrapper for the queued cash, with no dialog', () => {
      const lending = lendingWith();
      renderHome(lending, { queue: actionQueue([[ActionType.Withdraw, BASE_ASSET, 400_000_000n]]) });

      act(() => positionCard().onSubmitClicked());

      expect(lending.write.withdraw).toHaveBeenCalledWith({ kind: 'partial', cash: 400_000_000n });
      expect(mockWriteState.withdraw).not.toHaveBeenCalled();
      expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
      expectNoDialog();
    });

    it('asks for a full exit for a maximum withdrawal, and its row shows the cash the exit pays', () => {
      const lending = lendingWith();
      renderHome(lending, { queue: actionQueue([[ActionType.Withdraw, BASE_ASSET, MAX_UINT256]]) });

      expect(positionCard().actionRules.wrappedBase.fullExitCash).toBe(POSITION.fullExitCash);
      act(() => positionCard().onSubmitClicked());

      expect(lending.write.withdraw).toHaveBeenCalledWith({ kind: 'full' });
      expect(mockWriteState.withdraw).not.toHaveBeenCalled();
      expectNoDialog();
    });

    it('shows Confirm Transaction and Transaction Pending... for the withdrawal, and clears it on its receipt', () => {
      const queue = actionQueue([[ActionType.Withdraw, BASE_ASSET, MAX_UINT256]]);
      const { rerenderHome } = renderHome(lendingWith(), { queue });
      act(() => positionCard().onSubmitClicked());
      const draft = draftFor('withdraw', [WITHDRAW_STEP], SHARES);
      const withdrawing = (step: WrappedStepState) =>
        lendingWith(controller({ phase: 'signing', draft, steps: [step], stepIndex: 0 }));

      rerenderHome(withdrawing({ status: 'checking' }), { queue });
      expect(positionCard().transaction?.state).toBe(TransactionState.AwaitingConfirmation);
      rerenderHome(withdrawing({ status: 'submitted', hash: HASH }), {
        queue,
        transactions: [wrapperTransaction('withdraw', TransactionState.Pending)],
      });
      expect(positionCard().transaction?.state).toBe(TransactionState.Pending);

      rerenderHome(lendingWith(controller({ phase: 'complete', draft, steps: [confirmed()], stepIndex: 0 })), {
        queue,
      });
      expect(queue.removeAction).toHaveBeenCalledTimes(1);
      expect(queue.removeAction.mock.calls[0][0][0]).toBe(ActionType.Withdraw);
      expectNoDialog();
    });

    it('limits a partial withdrawal to what the wrapper pays, net of its rounding buffer', () => {
      renderHome(lendingWith());
      const { actionRules } = positionCard();

      expect(actionRules.wrappedBase.maxPartialWithdrawal).toBeGreaterThan(0n);
      expect(actionRules.wrappedBase.maxPartialWithdrawal).toBeLessThan(POSITION.grossAssets);
      expect(actionRules.wrappedBase.canWithdrawAll).toBe(true);
    });
  });

  describe('a mixed queue: the wrapper action first, then the direct actions through the production path', () => {
    const supplyCollateral: Action = [ActionType.SupplyCollateral, COLLATERAL, 10n ** 17n];
    const withdrawCollateral: Action = [ActionType.WithdrawCollateral, COLLATERAL, 10n ** 16n];

    it('starts the wrapper action alone, with no dialog', () => {
      const lending = lendingWith();
      const queue = actionQueue([supplyCollateral, [ActionType.Supply, BASE_ASSET, AMOUNT]]);
      renderHome(lending, { queue });

      act(() => positionCard().onSubmitClicked());

      expect(lending.write.supply).toHaveBeenCalledWith(AMOUNT);
      expect(mockWriteState.supply).not.toHaveBeenCalled();
      expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
      expectNoDialog();
    });

    it('sends the direct actions through the Bulker once the wrapper action confirms, and never the wrapper action', () => {
      const queue = actionQueue([supplyCollateral, withdrawCollateral, [ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lendingWith(), { queue });
      act(() => positionCard().onSubmitClicked());
      rerenderHome(lendingWith(controller(supplyState('signing', [SUPPLY_STEP], [{ status: 'checking' }]))), { queue });
      expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();

      rerenderHome(lendingWith(controller(supplyState('complete', [SUPPLY_STEP], [confirmed()]))), { queue });

      expect(queue.removeAction).toHaveBeenCalledTimes(1);
      expect(mockWriteState.invokeBulker).toHaveBeenCalledTimes(1);
      const bulkerActions: Action[] = mockWriteState.invokeBulker.mock.calls[0][1];
      expect(bulkerActions.map((action) => action[0])).toEqual([
        ActionType.SupplyCollateral,
        ActionType.WithdrawCollateral,
      ]);
      expect(mockWriteState.supply).not.toHaveBeenCalled();
      // The Bulker's own transaction dialog, as for any queue of several direct actions.
      expect(mockLastProps.ActionModal.state[0]).toBe('bulker');
    });

    it("opens the Bulker's own approval first when the Bulker is not yet allowed", () => {
      const queue = actionQueue([supplyCollateral, withdrawCollateral, [ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const options = { queue, state: cometState(BASE_ASSET, false) };
      const { rerenderHome } = renderHome(lendingWith(), options);
      act(() => positionCard().onSubmitClicked());
      rerenderHome(lendingWith(controller(supplyState('signing', [SUPPLY_STEP], [{ status: 'checking' }]))), options);
      rerenderHome(lendingWith(controller(supplyState('complete', [SUPPLY_STEP], [confirmed()]))), options);

      expect(mockLastProps.ActionModal.state[0]).toBe('bulker-approve');
      expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
    });

    it('sends one remaining direct action straight to Comet, as production does for a token that is not wrapped', () => {
      // ETH and stETH go through the Bulker even alone, so the remaining action is a COMP supply.
      const comp = mockCompCollateralAsset({ walletBalance: 10n ** 18n });
      const state = cometState();
      const withComp = [state[0], { ...state[1], collateralAssets: [COLLATERAL, comp] }] as unknown as CometState;
      const queue = actionQueue([
        [ActionType.SupplyCollateral, comp, 10n ** 17n],
        [ActionType.Supply, BASE_ASSET, AMOUNT],
      ]);
      const options = { queue, state: withComp };
      const { rerenderHome } = renderHome(lendingWith(), options);
      act(() => positionCard().onSubmitClicked());
      rerenderHome(lendingWith(controller(supplyState('signing', [SUPPLY_STEP], [{ status: 'checking' }]))), options);
      rerenderHome(lendingWith(controller(supplyState('complete', [SUPPLY_STEP], [confirmed()]))), options);

      expect(mockWriteState.supply).toHaveBeenCalledTimes(1);
      expect(mockWriteState.supply.mock.calls[0][1]).toBe(comp.address);
      expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
      expectNoDialog();
    });

    it('leaves the direct actions queued for the next Submit when the wrapper action confirmed while another page was shown', () => {
      const queue = actionQueue([supplyCollateral, withdrawCollateral, [ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lendingWith(), { queue });
      act(() => positionCard().onSubmitClicked());
      const draft = draftFor('supply', [SUPPLY_STEP]);
      rerenderHome(lendingWith(controller(supplyState('signing', [SUPPLY_STEP], [{ status: 'checking' }], 0, draft))), {
        queue,
      });

      // The user opens another page, and the supply confirms there.
      rerenderHome(lendingWith(controller(supplyState('complete', [SUPPLY_STEP], [confirmed()], 0, draft))), {
        queue,
        isDashboard: false,
      });
      rerenderHome(lendingWith(controller(supplyState('complete', [SUPPLY_STEP], [confirmed()], 0, draft))), { queue });

      expect(queue.removeAction).toHaveBeenCalledTimes(1);
      expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
      expect(mockWriteState.supply).not.toHaveBeenCalled();
      expectNoDialog();
    });

    it('keeps every action queued and sends no direct action when the wrapper action stops', () => {
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const queue = actionQueue([supplyCollateral, [ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lendingWith(), { queue });
      act(() => positionCard().onSubmitClicked());

      rerenderHome(
        lendingWith(
          controller(supplyState('stopped', [SUPPLY_STEP], [{ status: 'blocked', reason: 'supply-paused' }]))
        ),
        { queue }
      );

      expect(queue.removeAction).not.toHaveBeenCalled();
      expect(mockWriteState.supply).not.toHaveBeenCalled();
      expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
      expectNoDialog();
    });
  });

  describe('drops a run when the session or market changes', () => {
    const variants: [string, HomeOptions][] = [
      ['account', { web3: { ...WEB3, write: { ...WEB3.write, account: OTHER_ACCOUNT } } }],
      [
        'connector',
        {
          web3: {
            ...WEB3,
            write: {
              ...WEB3.write,
              connector: { id: ANCHORAGE_CONNECTOR_ID, uid: 'uid-2' } as Web3['write']['connector'],
            },
          },
        },
      ],
      ['chain', { web3: { ...WEB3, write: { ...WEB3.write, chainId: 8453 } } }],
      ['connection', { web3: { ...WEB3, write: { ...WEB3.write, status: 'reconnecting' } } }],
      ['market', { market: USDT_MARKET }],
    ];

    it.each(variants)(
      'shows nothing of the run and ignores its kept callbacks after a change of %s',
      (_name, change) => {
        const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
        const checking = controller(supplyState('signing', [SUPPLY_STEP], [{ status: 'checking' }]));
        const { rerenderHome } = renderHome(lendingWith(), { queue });
        const keptSubmit = positionCard().onSubmitClicked;
        act(() => keptSubmit());
        rerenderHome(lendingWith(checking), { queue });
        expect(positionCard().transaction).toBeDefined();

        const changed = lendingWith(checking, change.market === undefined ? {} : { route: routeFor(OPEN, USDT_COMET) });
        rerenderHome(changed, { queue, ...change });

        expect(positionCard().transaction).toBeUndefined();
        act(() => keptSubmit());
        expect(changed.write.supply).not.toHaveBeenCalled();
        expectNoDialog();
      }
    );
  });
});

describe('Home on the standard route', () => {
  beforeEach(() => {
    Object.values(mockWriteState).forEach((fn) => fn.mockReset());
  });

  it('supplies directly to Comet for another wallet on a wrapped market', () => {
    const metamask: Web3 = {
      ...WEB3,
      write: { ...WEB3.write, connector: { id: 'io.metamask', uid: 'uid-9' } as Web3['write']['connector'] },
    };
    const queue = actionQueue([[ActionType.Supply, { ...BASE_ASSET, allowance: MAX_UINT256 }, AMOUNT]]);
    renderHome(STANDARD_LENDING, { queue, web3: metamask });

    act(() => positionCard().onSubmitClicked());

    expect(mockWriteState.supply).toHaveBeenCalledTimes(1);
    expect(mockWriteState.supply.mock.calls[0][0]).toBe(USDC_MARKET);
    expect(masthead().baseAsset.balance).toBe(0n);
  });

  it('supplies directly to Comet for the Anchorage connector on a market without a wrapper', () => {
    const weth = mockBaseAsset({
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      symbol: 'WETH',
      allowance: MAX_UINT256,
    });
    const queue = actionQueue([[ActionType.Supply, weth, 10n ** 18n]]);
    renderHome(lendingWith(controller(), { route: routeFor(OPEN, WETH_COMET) }), {
      queue,
      market: WETH_MARKET,
      state: cometState(weth),
    });

    act(() => positionCard().onSubmitClicked());

    expect(mockWriteState.supply).toHaveBeenCalledTimes(1);
    expect(mockWriteState.supply.mock.calls[0][0]).toBe(WETH_MARKET);
  });
});
