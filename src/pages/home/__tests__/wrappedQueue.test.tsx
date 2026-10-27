import { Interface } from '@ethersproject/abi';
import { TransactionReceipt } from '@ethersproject/providers';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
} from '@types';

import { mockBaseAsset } from '../../../../__tests__/mocks/mockBaseAsset';
import { mockEthCollateralAsset } from '../../../../__tests__/mocks/mockCollateralAssets';
import { mockWeb3 } from '../../../../__tests__/mocks/mockWeb3';
import { TestLendingProvider } from '../../../../__tests__/mocks/wrappedLending';
import Home from '../index';

// Home's children record their props. The submission dialog is real.
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

const RESET_STEP: WrappedStep = {
  id: 'reset-allowance',
  kind: 'approve',
  description: 'Reset the USDC allowance for the wrapper to 0',
  request: { to: USDC, data: CALLS.encodeFunctionData('approve', [USDC_WRAPPER, 0n]) },
};
const APPROVE_STEP: WrappedStep = {
  id: 'approve',
  kind: 'approve',
  description: 'Approve 1,000.000000 USDC for the wrapper',
  request: { to: USDC, data: CALLS.encodeFunctionData('approve', [USDC_WRAPPER, AMOUNT]) },
};
const SUPPLY_STEP: WrappedStep = {
  id: 'supply',
  kind: 'supply-and-wrap',
  description: 'Supply 1,000.000000 USDC through the wrapper',
  request: { to: USDC_WRAPPER, data: CALLS.encodeFunctionData('supplyAndWrap', [AMOUNT]) },
};

const SHARES = 400n * 10n ** 18n;
const WITHDRAW_STEP: WrappedStep = {
  id: 'withdraw',
  kind: 'unwrap-and-withdraw',
  description: 'Withdraw about 400.000000 USDC from the wrapper',
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

type Controller = WrappedActionController & { confirm: jest.Mock; discard: jest.Mock; dismissRecovered: jest.Mock };

function controller(state: WrappedActionState = { phase: 'idle' }, overrides: Partial<Controller> = {}): Controller {
  return {
    state,
    session: { status: 'usable' },
    recovered: { pending: [], settled: [] },
    isRecoveredRequestPendingInWallet: false,
    canDismissRecovered: false,
    hasUnansweredWalletRequest: false,
    walletRefusalMessage: undefined,
    blockedReason: () => undefined,
    start: jest.fn(),
    confirm: jest.fn(),
    discard: jest.fn(),
    dismissRecovered: jest.fn(),
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

type Lending = WrappedLending & { write: { supply: jest.Mock; withdraw: jest.Mock } };

function lendingWith(
  action: Controller = controller(),
  {
    route = routeFor(),
    position = POSITION,
    supplyRefusal,
  }: { route?: LendingRoute; position?: WrappedPosition | undefined; supplyRefusal?: WrappedBlockReason } = {}
): Lending {
  return {
    route,
    position: position === undefined ? { status: 'loading' } : { status: 'loaded', position },
    retry: jest.fn(),
    action,
    write: { supply: jest.fn(() => supplyRefusal), withdraw: jest.fn(() => undefined) },
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

type HomeOptions = {
  queue?: ActionQueue;
  market?: MarketData;
  web3?: Web3;
  state?: CometState;
  /** Whether the dashboard is shown. App and its providers stay mounted when another page is shown. */
  isDashboard?: boolean;
};

function homeElement(
  lending: WrappedLending,
  { queue = actionQueue(), market = USDC_MARKET, web3 = WEB3, state, isDashboard = true }: HomeOptions = {}
) {
  const SelectedMarketContext = SelectedMarketContextHelpers.getSelectedMarketContext();
  const ActionQueueContext = ActionQueueContextHelpers.getActionQueueContext();
  const selectedMarketData = {
    selectedMarket: [StateType.Hydrated, market] as const,
    selectMarket: jest.fn(),
    selectMarketByAddress: jest.fn(),
  };
  return (
    <TestLendingProvider value={lending}>
      <SelectedMarketContext.Provider value={selectedMarketData as never}>
        <ActionQueueContext.Provider value={queue}>
          {isDashboard && (
            <Home
              transactions={[]}
              web3={web3}
              selectedMarketData={selectedMarketData as never}
              cometState={state ?? cometState()}
              addTransaction={jest.fn()}
              switchWriteNetwork={jest.fn()}
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
const dialog = () => screen.getByRole('dialog');

describe('Home on the wrapped route', () => {
  beforeEach(() => {
    Object.values(mockWriteState).forEach((fn) => fn.mockReset());
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

    it('queues a confirmed base supply without asking for an approval to Comet', () => {
      const queue = actionQueue([], [ActionType.Supply, BASE_ASSET, undefined]);
      renderHome(lendingWith(), { queue });

      act(() => positionCard().onPendingActionConfirm(AMOUNT));

      expect(queue.addOrUpdateAction).toHaveBeenCalledTimes(1);
      const [queued] = queue.addOrUpdateAction.mock.calls[0];
      expect(queued[0]).toBe(ActionType.Supply);
      expect(queued[2]).toBe(AMOUNT);
      expect(mockWriteState.approve).not.toHaveBeenCalled();
    });

    it('gives the amount form and queue rules that accept a supply without an allowance to Comet', () => {
      renderHome(lendingWith());
      const { actionRules, baseAsset, collateralAssets } = positionCard();
      const supply: Action = [ActionType.Supply, baseAsset, AMOUNT];

      expect(validateAddingAction(baseAsset, collateralAssets, [], supply, actionRules)).toBe('ok');
      expect(validateAllowanceForAction(baseAsset, collateralAssets, [], supply, actionRules)).toBe('ok');
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
      renderHome(lendingWith(controller(), { route: routeFor(CLOSED) }), { queue });
      const { actionRules, baseAsset, collateralAssets } = positionCard();

      expect(
        validateAddingAction(baseAsset, collateralAssets, [], [ActionType.Supply, baseAsset, 1n], actionRules)
      ).toEqual([false, 'Supply Not Open Yet']);
      expect(
        validateAddingAction(baseAsset, collateralAssets, [], [ActionType.Withdraw, baseAsset, 1n], actionRules)
      ).toEqual([false, 'Withdrawals Not Open Yet']);

      // A form callback kept from before the controls closed queues nothing either.
      act(() => positionCard().onPendingActionConfirm(AMOUNT));
      expect(queue.addOrUpdateAction).not.toHaveBeenCalled();
    });
  });

  describe('submits a queued base supply through the wrapper', () => {
    it('starts the wrapped supply of the queued amount, never a Comet supply or the Bulker', () => {
      const lending = lendingWith();
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      renderHome(lending, { queue });

      act(() => positionCard().onSubmitClicked());

      expect(lending.write.supply).toHaveBeenCalledWith(AMOUNT);
      expect(mockWriteState.supply).not.toHaveBeenCalled();
      expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
      expect(mockWriteState.approve).not.toHaveBeenCalled();
    });

    it('supplies the wallet balance for a maximum supply', () => {
      const lending = lendingWith();
      renderHome(lending, { queue: actionQueue([[ActionType.Supply, BASE_ASSET, MAX_UINT256]]) });

      act(() => positionCard().onSubmitClicked());

      expect(lending.write.supply).toHaveBeenCalledWith(BASE_ASSET.walletBalance);
    });

    it('shows the exact approval, the USDT reset first, then the supply, in order, each waiting for a confirmation', () => {
      const steps = [RESET_STEP, APPROVE_STEP, SUPPLY_STEP];
      const action = controller(
        supplyState(
          'review',
          steps,
          steps.map(() => ({ status: 'waiting' }))
        )
      );
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lendingWith(controller()), { queue });
      act(() => positionCard().onSubmitClicked());
      rerenderHome(lendingWith(action), { queue });

      const items = within(dialog()).getAllByRole('listitem');
      expect(items.map((item) => item.querySelector('.body--emphasized')?.textContent)).toEqual([
        RESET_STEP.description,
        APPROVE_STEP.description,
        SUPPLY_STEP.description,
      ]);
      expect(items[0]).toHaveTextContent('Ready for you to confirm.');
      expect(items[1]).toHaveTextContent('Waits for the step before it.');

      fireEvent.click(within(dialog()).getByRole('button', { name: 'Reset Allowance' }));
      expect(action.confirm).toHaveBeenCalledTimes(1);
    });

    it('takes the supplied action out of the queue once the supply confirms', () => {
      const steps = [APPROVE_STEP, SUPPLY_STEP];
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lendingWith(controller()), { queue });
      act(() => positionCard().onSubmitClicked());

      rerenderHome(
        lendingWith(controller(supplyState('signing', steps, [confirmed(), { status: 'submitted', hash: HASH }], 1))),
        {
          queue,
        }
      );
      expect(queue.removeAction).not.toHaveBeenCalled();

      rerenderHome(lendingWith(controller(supplyState('complete', steps, [confirmed(), confirmed()], 1))), { queue });
      expect(queue.removeAction).toHaveBeenCalledTimes(1);
      expect(queue.removeAction.mock.calls[0][0][0]).toBe(ActionType.Supply);
      expect(queue.clearActions).not.toHaveBeenCalled();
    });

    it('keeps the queued supply when a step is rejected, and closing sends nothing more', () => {
      const steps = [APPROVE_STEP, SUPPLY_STEP];
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lendingWith(controller()), { queue });
      act(() => positionCard().onSubmitClicked());
      const stopped = controller(supplyState('stopped', steps, [confirmed(), { status: 'rejected' }], 1));
      rerenderHome(lendingWith(stopped), { queue });

      expect(dialog()).toHaveTextContent('You rejected the request in your wallet. Nothing was sent.');
      expect(dialog()).toHaveTextContent(/stay in the queue/i);
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));

      expect(queue.removeAction).not.toHaveBeenCalled();
      expect(queue.clearActions).not.toHaveBeenCalled();
      expect(stopped.discard).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('does not take a supply out of the queue for a draft that completed before this submission', () => {
      const steps = [APPROVE_STEP, SUPPLY_STEP];
      const earlier = supplyState('complete', steps, [confirmed(), confirmed()], 1);
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      // The start is accepted, but the lifecycle still shows the earlier draft, as it does until the
      // new review's first render.
      const lending = lendingWith(controller(earlier));
      const { rerenderHome } = renderHome(lending, { queue });

      act(() => positionCard().onSubmitClicked());
      rerenderHome(lending, { queue });

      expect(lending.write.supply).toHaveBeenCalledTimes(1);
      expect(queue.removeAction).not.toHaveBeenCalled();
    });

    it('explains a refused start, and lets the user stop waiting for an interrupted request', () => {
      const action = controller({ phase: 'idle' }, { canDismissRecovered: true });
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      renderHome(lendingWith(action, { supplyRefusal: 'transaction-pending' }), { queue });

      act(() => positionCard().onSubmitClicked());

      expect(dialog()).toHaveTextContent('another wrapped transaction from this account is still pending');
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Stop waiting' }));
      expect(action.dismissRecovered).toHaveBeenCalledTimes(1);
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

  describe('keeps a submission across a visit to another page', () => {
    it('shows the submission again on return, and takes the supply out of the queue once it confirmed meanwhile', () => {
      const steps = [APPROVE_STEP, SUPPLY_STEP];
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lendingWith(controller()), { queue });
      act(() => positionCard().onSubmitClicked());
      const signing = supplyState('signing', steps, [confirmed(), { status: 'submitted', hash: HASH }], 1);
      rerenderHome(lendingWith(controller(signing)), { queue });

      // The user opens another page while the supply is pending, and it confirms there.
      const complete = supplyState(
        'complete',
        steps,
        [confirmed(), confirmed()],
        1,
        signing.phase === 'signing' ? signing.draft : undefined
      );
      rerenderHome(lendingWith(controller(signing)), { queue, isDashboard: false });
      rerenderHome(lendingWith(controller(complete)), { queue, isDashboard: false });
      expect(queue.removeAction).not.toHaveBeenCalled();

      rerenderHome(lendingWith(controller(complete)), { queue });
      expect(queue.removeAction).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('dialog', { name: 'Transactions Confirmed' })).toBeInTheDocument();
    });

    it('shows a review the user left on another page, so its next step can be confirmed or closed', () => {
      const steps = [APPROVE_STEP, SUPPLY_STEP];
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lendingWith(controller()), { queue });
      act(() => positionCard().onSubmitClicked());
      rerenderHome(lendingWith(controller()), { queue, isDashboard: false });

      const nextStep = controller(supplyState('review', steps, [confirmed(), { status: 'waiting' }], 1));
      rerenderHome(lendingWith(nextStep), { queue });
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Supply 1,000.000000 USDC' }));
      expect(nextStep.confirm).toHaveBeenCalledTimes(1);
    });
  });

  describe('holds the queue still while it is submitted', () => {
    it('ignores edits, removals, clears and new amounts while the dialog is hidden', () => {
      const steps = [APPROVE_STEP, SUPPLY_STEP];
      const supply: Action = [ActionType.Supply, BASE_ASSET, AMOUNT];
      const queue = actionQueue([supply], [ActionType.Supply, BASE_ASSET, undefined]);
      const { rerenderHome } = renderHome(lendingWith(controller()), { queue });
      act(() => positionCard().onSubmitClicked());
      rerenderHome(
        lendingWith(controller(supplyState('signing', steps, [{ status: 'checking' }, { status: 'waiting' }]))),
        {
          queue,
        }
      );
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('dialog')).toBeNull();
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
    it('holds both collateral row families still, and disables them, while a step is checked before its signature', () => {
      // stETH is listed apart from the market's collateral, as "Other Assets".
      const stETH = mockEthCollateralAsset({
        address: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84',
        symbol: 'stETH',
        name: 'Lido Staked ETH',
      });
      const state = cometState();
      const withStETH = [state[0], { ...state[1], collateralAssets: [COLLATERAL, stETH] }] as unknown as CometState;
      const collateralSupply: Action = [ActionType.SupplyCollateral, COLLATERAL, 10n ** 17n];
      const stETHSupply: Action = [ActionType.SupplyCollateral, stETH, 10n ** 17n];
      const queue = actionQueue([collateralSupply, stETHSupply, [ActionType.Supply, BASE_ASSET, AMOUNT]]);
      // An amount form open on a row, which its Cancel closes and takes out of the queue.
      let pending: PendingAction | undefined;
      queue.getPendingAction = () => pending;
      const options = { queue, state: withStETH };
      const { rerenderHome } = renderHome(lendingWith(controller()), options);
      act(() => positionCard().onSubmitClicked());
      // The check before the signature is held open: the wallet has not been asked, so the
      // transaction manager tracks nothing yet.
      const checking = lendingWith(controller(supplyState('signing', [SUPPLY_STEP], [{ status: 'checking' }])));
      rerenderHome(checking, options);
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      queue.setPendingAction.mockClear();

      for (const [asset, action] of [
        [COLLATERAL, collateralSupply],
        [stETH, stETHSupply],
      ] as const) {
        const row = () => mockAssetRows[asset.symbol].state[1];
        expect(row().isLocked).toBe(true);
        act(() => row().onEditClicked());
        act(() => row().onSupplyClicked());
        act(() => row().onWithdrawClicked?.());
        pending = [ActionType.SupplyCollateral, asset, action[2]];
        rerenderHome(checking, options);
        act(() => row().onCancelClicked());
        pending = undefined;
      }

      expect(queue.setPendingAction).not.toHaveBeenCalled();
      expect(queue.removeAction).not.toHaveBeenCalled();
    });
  });

  describe('a wrapper action that stops where it can still go through', () => {
    it('leaves the queue when its last step may still execute, and says so', () => {
      const steps = [APPROVE_STEP, SUPPLY_STEP];
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lendingWith(controller()), { queue });
      act(() => positionCard().onSubmitClicked());
      const pending: WrappedStepState = {
        status: 'provider-failure',
        message: 'The request can still complete (4900)',
        isPendingInWallet: true,
      };
      rerenderHome(lendingWith(controller(supplyState('stopped', steps, [confirmed(), pending], 1))), { queue });

      expect(queue.removeAction).toHaveBeenCalledTimes(1);
      expect(dialog()).toHaveTextContent(/may still go through, so it was taken out of your queue/);
    });

    it('stays queued when only its approval may still execute, since the supply was never sent', () => {
      const steps = [APPROVE_STEP, SUPPLY_STEP];
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lendingWith(controller()), { queue });
      act(() => positionCard().onSubmitClicked());
      const failed: WrappedStepState = { status: 'provider-failure', message: 'Internal error' };
      rerenderHome(lendingWith(controller(supplyState('stopped', steps, [failed, { status: 'waiting' }], 0))), {
        queue,
      });

      expect(queue.removeAction).not.toHaveBeenCalled();
      expect(dialog()).toHaveTextContent(/stay in the queue/);
    });

    it('stays queued when its last step reverted', () => {
      const steps = [SUPPLY_STEP];
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lendingWith(controller()), { queue });
      act(() => positionCard().onSubmitClicked());
      const reverted: WrappedStepState = {
        status: 'reverted',
        hash: HASH,
        receipt: { transactionHash: HASH, status: 0 } as TransactionReceipt,
      };
      rerenderHome(lendingWith(controller(supplyState('stopped', steps, [reverted], 0))), { queue });

      expect(queue.removeAction).not.toHaveBeenCalled();
    });
  });

  describe('submits a queued base withdrawal through the wrapper', () => {
    it('asks the wrapper for the queued cash', () => {
      const lending = lendingWith();
      renderHome(lending, { queue: actionQueue([[ActionType.Withdraw, BASE_ASSET, 400_000_000n]]) });

      act(() => positionCard().onSubmitClicked());

      expect(lending.write.withdraw).toHaveBeenCalledWith({ kind: 'partial', cash: 400_000_000n }, undefined);
      expect(mockWriteState.withdraw).not.toHaveBeenCalled();
      expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
    });

    it('asks for a full exit for a maximum withdrawal, with the cash the page showed', () => {
      const lending = lendingWith();
      renderHome(lending, { queue: actionQueue([[ActionType.Withdraw, BASE_ASSET, MAX_UINT256]]) });

      act(() => positionCard().onSubmitClicked());

      expect(lending.write.withdraw).toHaveBeenCalledWith({ kind: 'full' }, POSITION.fullExitCash);
      expect(mockWriteState.withdraw).not.toHaveBeenCalled();
    });

    it('limits a partial withdrawal to what the wrapper pays, net of its rounding buffer', () => {
      renderHome(lendingWith());
      const { actionRules } = positionCard();

      expect(actionRules.wrappedBase.maxPartialWithdrawal).toBeGreaterThan(0n);
      expect(actionRules.wrappedBase.maxPartialWithdrawal).toBeLessThan(POSITION.grossAssets);
      expect(actionRules.wrappedBase.canWithdrawAll).toBe(true);
    });

    it('shows the quote figures and the cash rounding before the exit is confirmed', () => {
      const draft: WrappedActionDraft = {
        ...draftFor('withdraw', [WITHDRAW_STEP], SHARES),
        withdrawal: {
          request: { kind: 'partial', cash: 400_000_000n },
          quote: {
            kind: 'partial',
            shares: SHARES,
            grossAssets: 400_000_004n,
            redeemBuffer: 3n,
            cash: 400_000_001n,
            leavesDust: false,
          },
          shownCash: undefined,
          blockNumber: 1,
        },
      };
      const queue = actionQueue([[ActionType.Withdraw, BASE_ASSET, 400_000_000n]]);
      const { rerenderHome } = renderHome(lendingWith(), { queue });
      act(() => positionCard().onSubmitClicked());
      const action = controller({ phase: 'review', draft, steps: [{ status: 'waiting' }], stepIndex: 0 });
      rerenderHome(lendingWith(action), { queue });

      expect(within(dialog()).getByTestId('wrapped-withdraw-cash')).toHaveTextContent('400.000001 USDC');
      expect(dialog()).toHaveTextContent(/because shares are burned in whole units/);
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Withdraw About 400.000001 USDC' }));
      expect(action.confirm).toHaveBeenCalledTimes(1);
    });
  });

  describe('orders a mixed queue: the wrapper steps first, then the direct actions', () => {
    const supplyCollateral: Action = [ActionType.SupplyCollateral, COLLATERAL, 10n ** 17n];
    const withdrawCollateral: Action = [ActionType.WithdrawCollateral, COLLATERAL, 10n ** 16n];

    it('starts the wrapper action alone and lists the direct actions after it', () => {
      const lending = lendingWith();
      const queue = actionQueue([supplyCollateral, [ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lending, { queue });

      act(() => positionCard().onSubmitClicked());
      expect(lending.write.supply).toHaveBeenCalledWith(AMOUNT);
      expect(mockWriteState.supply).not.toHaveBeenCalled();
      expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();

      const steps = [APPROVE_STEP, SUPPLY_STEP];
      rerenderHome(
        lendingWith(
          controller(
            supplyState(
              'review',
              steps,
              steps.map(() => ({ status: 'waiting' }))
            )
          )
        ),
        {
          queue,
        }
      );
      const items = within(dialog()).getAllByRole('listitem');
      expect(items).toHaveLength(3);
      expect(items[2]).toHaveTextContent('1 other action');
      expect(items[2]).toHaveTextContent('Sent after the steps above, as a separate transaction.');
    });

    it('sends the direct actions only after the wrapper action completes, and the Bulker never gets the wrapper action', () => {
      const queue = actionQueue([supplyCollateral, withdrawCollateral, [ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lendingWith(), { queue });
      act(() => positionCard().onSubmitClicked());

      const steps = [SUPPLY_STEP];
      rerenderHome(lendingWith(controller(supplyState('complete', steps, [confirmed()]))), { queue });
      expect(queue.removeAction).toHaveBeenCalledTimes(1);
      expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();

      // The queue no longer holds the supply.
      const remaining = actionQueue([supplyCollateral, withdrawCollateral]);
      rerenderHome(lendingWith(controller(supplyState('complete', steps, [confirmed()]))), { queue: remaining });
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Submit 2 Remaining Actions' }));

      expect(mockWriteState.invokeBulker).toHaveBeenCalledTimes(1);
      const bulkerActions: Action[] = mockWriteState.invokeBulker.mock.calls[0][1];
      expect(bulkerActions.map((action) => action[0])).toEqual([
        ActionType.SupplyCollateral,
        ActionType.WithdrawCollateral,
      ]);
      expect(mockWriteState.supply).not.toHaveBeenCalled();
    });

    it('keeps every action queued when the wrapper action stops', () => {
      const queue = actionQueue([supplyCollateral, [ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const { rerenderHome } = renderHome(lendingWith(), { queue });
      act(() => positionCard().onSubmitClicked());

      const steps = [APPROVE_STEP, SUPPLY_STEP];
      rerenderHome(
        lendingWith(
          controller(
            supplyState('stopped', steps, [{ status: 'blocked', reason: 'supply-paused' }, { status: 'waiting' }])
          )
        ),
        { queue }
      );

      expect(within(dialog()).getAllByRole('listitem')[2]).toHaveTextContent('Not sent. It stays in your queue.');
      expect(screen.queryByRole('button', { name: /remaining action/i })).toBeNull();
      expect(queue.removeAction).not.toHaveBeenCalled();
      expect(mockWriteState.supply).not.toHaveBeenCalled();
      expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
    });
  });

  describe('drops a submission when the session or market changes', () => {
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

    it.each(variants)('closes the submission and ignores its kept callbacks after a change of %s', (_name, change) => {
      const steps = [APPROVE_STEP, SUPPLY_STEP];
      const queue = actionQueue([[ActionType.Supply, BASE_ASSET, AMOUNT]]);
      const reviewed = controller(
        supplyState(
          'review',
          steps,
          steps.map(() => ({ status: 'waiting' }))
        )
      );
      const { rerenderHome } = renderHome(lendingWith(), { queue });
      const keptSubmit = positionCard().onSubmitClicked;
      act(() => keptSubmit());
      rerenderHome(lendingWith(reviewed), { queue });
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      const changed = lendingWith(reviewed, change.market === undefined ? {} : { route: routeFor(OPEN, USDT_COMET) });
      rerenderHome(changed, { queue, ...change });

      expect(screen.queryByRole('dialog')).toBeNull();
      act(() => keptSubmit());
      expect(changed.write.supply).not.toHaveBeenCalled();
    });
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
