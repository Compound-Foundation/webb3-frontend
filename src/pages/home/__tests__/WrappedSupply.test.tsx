import { Interface } from '@ethersproject/abi';
import { TransactionReceipt } from '@ethersproject/providers';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  ANCHORAGE_CONNECTOR_ID,
  buildWrappedMarketRegistry,
  HARDCODED_WRAPPED_LENDING_SOURCE,
  WRAPPED_MARKET_REGISTRY,
  WrappedMarketRegistry,
} from '@constants/wrappedMarkets';
import * as ActionQueueContextHelpers from '@contexts/ActionQueueContext';
import * as SelectedMarketContextHelpers from '@contexts/SelectedMarketContext';
import { Web3 } from '@contexts/Web3Context';
import { WrappedLending, WrappedLendingContext } from '@contexts/WrappedLendingContext';
import { LendingRoute, LendingSession, resolveLendingRoute, wrappedRouteKey } from '@helpers/lendingRoute';
import { getMarket } from '@helpers/markets';
import { getBlockExplorerUrl } from '@helpers/urls';
import {
  WRAPPED_ACTION,
  WrappedActionDraft,
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
} from '@types';

import { mockBaseAsset } from '../../../../__tests__/mocks/mockBaseAsset';
import { mockWeb3 } from '../../../../__tests__/mocks/mockWeb3';
import WrappedSupplyModal from '../components/ActionModal/WrappedSupplyModal';
import WrappedPositionPanel from '../components/WrappedPositionPanel';
import Home from '../index';

// The wrapped panel and the supply dialog are real. Home's other children record their props.
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

const ACCOUNT = '0x0000000000000000000000000000000000000aa1';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const USDC_WRAPPER = '0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73';
const USDC_MARKET = getMarket(1, USDC_COMET) as MarketData;
const USDT_COMET = '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840';
const USDT_MARKET = getMarket(1, USDT_COMET) as MarketData;
const WALLET = { name: 'wallet provider' };
const AMOUNT = 1_000_000_000n;
const HASH = `0x${'7'.repeat(64)}`;
const EXPLORER_LINK = `${getBlockExplorerUrl(1)}/tx/${HASH}`;

const CALLS = new Interface([
  'function approve(address spender, uint256 amount)',
  'function supplyAndWrap(uint256 amount)',
]);

function registryWith({ deposits }: { deposits: boolean }): WrappedMarketRegistry {
  return buildWrappedMarketRegistry({
    markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({ ...market, isDepositEnabled: deposits })),
  });
}
/** A fixture with deposits enabled. The committed configuration keeps them off until COM-292. */
const OPEN = registryWith({ deposits: true });

const SESSION: LendingSession = {
  connector: { id: ANCHORAGE_CONNECTOR_ID, uid: 'uid-1' },
  status: 'connected',
  account: ACCOUNT,
  chainId: 1,
  isWatchOnly: false,
  isSignerReady: true,
  screeningStatus: 'allowed',
};

/** The route the resolver gives the session, with the wrapper validated for it. */
function routeFor(
  registry: WrappedMarketRegistry,
  cometAddress = USDC_COMET
): Extract<LendingRoute, { kind: 'wrapped' }> {
  const lookup = registry.lookup(1, cometAddress);
  if (lookup.status !== 'valid') throw new Error('the mapping must be valid');
  const route = resolveLendingRoute({
    market: { chainId: 1, cometAddress },
    session: SESSION,
    conflictedRdns: new Set(),
    validation: { key: wrappedRouteKey(lookup.market, SESSION), status: 'matched' },
    registry,
  });
  if (route.kind !== 'wrapped') throw new Error('the route must be wrapped');
  return route;
}

function draftFor(steps: WrappedStep[], registry = OPEN): WrappedActionDraft {
  const identity = wrappedActionIdentity('supply', {
    route: routeFor(registry),
    account: ACCOUNT,
    chainId: 1,
    screeningStatus: 'allowed',
    provider: WALLET,
  });
  if (identity === undefined) throw new Error('the session must have an identity');
  return { kind: WRAPPED_ACTION, id: 'draft-1', identity, amount: AMOUNT, steps };
}

const APPROVE_STEP: WrappedStep = {
  id: 'approve',
  kind: 'approve',
  description: 'Approve 1,000.000000 USDC for the wrapper',
  request: { to: USDC, data: CALLS.encodeFunctionData('approve', [USDC_WRAPPER, AMOUNT]) },
};
const RESET_STEP: WrappedStep = {
  id: 'reset-allowance',
  kind: 'approve',
  description: 'Reset the USDC allowance for the wrapper to 0',
  request: { to: USDC, data: CALLS.encodeFunctionData('approve', [USDC_WRAPPER, 0n]) },
};
const SUPPLY_STEP: WrappedStep = {
  id: 'supply',
  kind: 'supply-and-wrap',
  description: 'Supply 1,000.000000 USDC through the wrapper',
  request: { to: USDC_WRAPPER, data: CALLS.encodeFunctionData('supplyAndWrap', [AMOUNT]) },
};

type Review = Extract<WrappedActionState, { phase: 'review' }>;

function inReview(steps = [APPROVE_STEP, SUPPLY_STEP], stepIndex = 0, statuses?: WrappedStepState[]): Review {
  return {
    phase: 'review',
    draft: draftFor(steps),
    steps: statuses ?? steps.map(() => ({ status: 'waiting' })),
    stepIndex,
  };
}

type Controller = WrappedActionController & { confirm: jest.Mock; discard: jest.Mock };

function controller(
  state: WrappedActionState = { phase: 'idle' },
  blockedReason: WrappedBlockReason | undefined = undefined
): Controller {
  return {
    state,
    session: { status: 'usable' },
    recovered: { pending: [], settled: [] },
    canDismissRecovered: false,
    blockedReason: () => blockedReason,
    start: jest.fn(),
    confirm: jest.fn(),
    discard: jest.fn(),
    dismissRecovered: jest.fn(),
  };
}

const POSITION: WrappedPosition = {
  shares: 0n,
  shareDecimals: 18,
  grossAssets: 0n,
  baseDecimals: 6,
  baseWalletBalance: 42_500_001n,
  wrapperAllowance: 0n,
  redeemBuffer: 3n,
  fullExitCash: 0n,
  isWithdrawPaused: false,
  snapshot: { totalSupply: 0n, totalAssets: 0n, baseSupplyIndex: 0n },
};

type Lending = WrappedLending & { write: { supply: jest.Mock } };

function lendingWith(action: Controller, registry = OPEN): Lending {
  return {
    route: routeFor(registry),
    position: { status: 'loaded', position: POSITION },
    retry: jest.fn(),
    action,
    write: { supply: jest.fn(() => undefined) },
  };
}

const BASE_ASSET = mockBaseAsset({ address: USDC, symbol: 'USDC', decimals: 6 });

function cometState(baseAsset: BaseAssetWithAccountState): CometState {
  return [
    StateType.Hydrated,
    {
      baseAsset,
      borrowAPR: 0n,
      collateralAssets: [],
      collateralValue: 0n,
      earnAPR: 0n,
      liquidationCapacity: 0n,
      borrowRewardsAPR: 0n,
      supplyRewardsAPR: 0n,
      isInstitutional: false,
      rewardsAssetSymbol: 'COMP',
      isRewardsLoading: false,
      isBulkerAllowed: true,
      totalBaseSupplyUsd: 0n,
    },
  ] as unknown as CometState;
}

function actionQueue(actions: Action[] = []): ActionQueue & { setPendingAction: jest.Mock } {
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

const WEB3: Web3 = {
  ...mockWeb3,
  read: { ...mockWeb3.read, account: ACCOUNT, chainId: 1 },
  write: { ...mockWeb3.write, account: ACCOUNT, chainId: 1, connector: { uid: 'uid-1' } as Web3['write']['connector'] },
};

SelectedMarketContextHelpers.initializeContext({
  selectedMarket: [StateType.Hydrated, USDC_MARKET],
  selectMarket: jest.fn(),
  selectMarketByAddress: jest.fn(),
});
ActionQueueContextHelpers.initializeContext(actionQueue());

function homeElement(
  lending: WrappedLending,
  state: CometState,
  queue: ActionQueue = actionQueue(),
  market: MarketData = USDC_MARKET
) {
  const SelectedMarketContext = SelectedMarketContextHelpers.getSelectedMarketContext();
  const ActionQueueContext = ActionQueueContextHelpers.getActionQueueContext();
  const selectedMarketData = {
    selectedMarket: [StateType.Hydrated, market] as const,
    selectMarket: jest.fn(),
    selectMarketByAddress: jest.fn(),
  };
  return (
    <WrappedLendingContext.Provider value={lending}>
      <SelectedMarketContext.Provider value={selectedMarketData as never}>
        <ActionQueueContext.Provider value={queue}>
          <Home
            transactions={[]}
            web3={WEB3}
            selectedMarketData={selectedMarketData as never}
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

function renderModal(state: WrappedActionState, directBorrowBalance: bigint | undefined = 0n) {
  const onConfirm = jest.fn();
  const onClose = jest.fn();
  render(
    <WrappedSupplyModal
      state={state}
      symbol="USDC"
      decimals={6}
      directBorrowBalance={directBorrowBalance}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
  return { onConfirm, onClose };
}

const explorerLinks = () =>
  screen.queryAllByRole('link', { name: /view on explorer/i }).map((link) => link.getAttribute('href'));

describe('WrappedSupply', () => {
  beforeEach(() => {
    Object.values(mockWriteState).forEach((fn) => fn.mockReset());
  });

  describe('WrappedSupply: warns that lending does not repay direct debt and keeps Repay separate', () => {
    const BORROWER = { ...BASE_ASSET, balance: -2_500_000_000n };

    it('warns before the first signature, and Repay stays a direct action', () => {
      const action = controller(inReview());
      const lending = lendingWith(action);
      const queue = actionQueue();
      render(homeElement(lending, cometState(BORROWER), queue));

      const dialog = screen.getByRole('dialog');
      const warning = within(dialog).getByRole('alert');
      expect(warning).toHaveTextContent('2,500.000000 USDC');
      expect(warning).toHaveTextContent(/lends/i);
      expect(warning).toHaveTextContent(/does not repay/i);
      expect(warning).toHaveTextContent(/Repay/);

      // The dialog signs the wrapped supply's own step, through the wrapper lifecycle.
      fireEvent.click(within(dialog).getByRole('button', { name: /approve 1,000\.000000 usdc/i }));
      expect(action.confirm).toHaveBeenCalledTimes(1);

      // Repay remains available on its own, as a direct Comet action.
      const [, masthead] = mockLastProps.Masthead.state;
      expect(masthead.isDirectBaseSupplyBlocked).toBe(true);
      const repay = [ActionType.Repay, BORROWER, undefined] as PendingAction;
      act(() => masthead.onSupplyAction(repay));
      expect(queue.setPendingAction).toHaveBeenCalledWith(repay);
      expect(lending.write.supply).not.toHaveBeenCalled();
      expect(mockWriteState.supply).not.toHaveBeenCalled();
      expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
      expect(queue.addOrUpdateAction).not.toHaveBeenCalled();
    });

    it('keeps the warning for the next step, and while the wallet is asked to sign it', () => {
      const confirmed: WrappedStepState = {
        status: 'confirmed',
        hash: HASH,
        receipt: { transactionHash: HASH, status: 1 } as TransactionReceipt,
      };
      const review = inReview([APPROVE_STEP, SUPPLY_STEP], 1, [confirmed, { status: 'waiting' }]);
      const { rerender } = render(homeElement(lendingWith(controller(review)), cometState(BORROWER)));

      expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent(/does not repay/i);
      expect(screen.getByRole('button', { name: /supply 1,000\.000000 usdc/i })).toBeEnabled();

      const signing: WrappedActionState = {
        ...review,
        phase: 'signing',
        steps: [confirmed, { status: 'awaiting-signature' }],
      };
      rerender(homeElement(lendingWith(controller(signing)), cometState(BORROWER)));
      expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent(/does not repay/i);
    });

    it("warns without an amount while the direct position shown is still the previous market's", () => {
      const state = cometState(BORROWER);
      const usdt = { ...lendingWith(controller()), route: routeFor(OPEN, USDT_COMET) };
      const { rerender } = render(homeElement(usdt, state, actionQueue(), USDT_MARKET));

      // The user switches to USDC and reviews a supply before USDC's Comet state arrives.
      rerender(homeElement(lendingWith(controller(inReview())), state, actionQueue(), USDC_MARKET));

      const warning = within(screen.getByRole('dialog')).getByRole('alert');
      expect(warning).toHaveTextContent(/does not repay/i);
      expect(warning).not.toHaveTextContent(/2,500/);
    });

    it('warns without an amount while the direct position is not loaded', () => {
      render(homeElement(lendingWith(controller(inReview())), [StateType.Loading, undefined]));

      const warning = within(screen.getByRole('dialog')).getByRole('alert');
      expect(warning).toHaveTextContent(/does not repay/i);
      expect(warning).not.toHaveTextContent(/2,500/);
    });

    it("warns without an amount when the direct position read is another account's", () => {
      const otherAccount = { ...WEB3, read: { ...WEB3.read, account: '0x0000000000000000000000000000000000000bb2' } };
      const SelectedMarketContext = SelectedMarketContextHelpers.getSelectedMarketContext();
      const ActionQueueContext = ActionQueueContextHelpers.getActionQueueContext();
      const selectedMarketData = {
        selectedMarket: [StateType.Hydrated, USDC_MARKET],
        selectMarket: jest.fn(),
        selectMarketByAddress: jest.fn(),
      };
      render(
        <WrappedLendingContext.Provider value={lendingWith(controller(inReview()))}>
          <SelectedMarketContext.Provider value={selectedMarketData as never}>
            <ActionQueueContext.Provider value={actionQueue()}>
              <Home
                transactions={[]}
                web3={otherAccount}
                selectedMarketData={selectedMarketData as never}
                cometState={cometState(BORROWER)}
                addTransaction={jest.fn()}
                switchWriteNetwork={jest.fn()}
                estimatedGasMap={new Map()}
                theme={Theme.Dark}
              />
            </ActionQueueContext.Provider>
          </SelectedMarketContext.Provider>
        </WrappedLendingContext.Provider>
      );

      const warning = within(screen.getByRole('dialog')).getByRole('alert');
      expect(warning).toHaveTextContent(/does not repay/i);
      expect(warning).not.toHaveTextContent(/2,500/);
    });

    it('shows no warning to an account without a direct borrow', () => {
      render(homeElement(lendingWith(controller(inReview())), cometState({ ...BASE_ASSET, balance: 0n })));

      expect(within(screen.getByRole('dialog')).queryByRole('alert')).not.toBeInTheDocument();
      // A borrow made elsewhere can be newer than this page's read, so the dialog still says it.
      expect(screen.getByRole('dialog')).toHaveTextContent(/does not repay a direct borrow/i);
    });
  });

  describe('supply entry', () => {
    function renderPanel(
      lending: Lending,
      { blockedReason, onReview }: { blockedReason?: WrappedBlockReason; onReview?: jest.Mock } = {}
    ) {
      const review = onReview ?? jest.fn(() => undefined);
      render(
        <WrappedPositionPanel
          route={lending.route as Extract<LendingRoute, { kind: 'wrapped' }>}
          position={lending.position}
          baseAsset={{ symbol: 'USDC', baseAssetPriceInDollars: 100_000_000n, balanceOfComet: 10n ** 12n }}
          earnAPR={0n}
          supply={{ blockedReason, onReview: review }}
          onRetry={jest.fn()}
        />
      );
      return review;
    }
    const supplyButton = () => screen.getByRole('button', { name: 'Supply USDC through the wrapper' });

    it('keeps the supply control disabled by the committed release control', () => {
      expect(HARDCODED_WRAPPED_LENDING_SOURCE.markets.every((market) => market.isDepositEnabled === false)).toBe(true);
      const lending = lendingWith(controller(), WRAPPED_MARKET_REGISTRY);
      renderPanel(lending, { blockedReason: 'deposits-disabled' });

      expect(supplyButton()).toBeDisabled();
      expect(screen.getByText('Wrapped deposits are not open yet.')).toBeInTheDocument();
    });

    it('reviews the exact amount typed, in raw 6-decimal units', () => {
      const onReview = renderPanel(lendingWith(controller()));

      fireEvent.click(supplyButton());
      fireEvent.change(screen.getByRole('textbox', { name: /amount of usdc to supply/i }), {
        target: { value: '12.345678' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Review' }));

      expect(onReview).toHaveBeenCalledWith(12_345_678n);
    });

    it('takes the whole wallet balance with Max, never an unlimited amount', () => {
      const onReview = renderPanel(lendingWith(controller()));

      fireEvent.click(supplyButton());
      fireEvent.click(screen.getByRole('button', { name: 'Max' }));
      expect(screen.getByRole('textbox', { name: /amount of usdc to supply/i })).toHaveValue('42.500001');
      fireEvent.click(screen.getByRole('button', { name: 'Review' }));

      expect(onReview).toHaveBeenCalledWith(42_500_001n);
    });

    it.each(['1.1234567', '1,5', '1.000.000', '1e6', '-1', '0x10', 'one'])(
      'keeps %p as typed and refuses to review it, rather than dropping characters',
      (value) => {
        const onReview = renderPanel(lendingWith(controller()));

        fireEvent.click(supplyButton());
        const input = screen.getByRole('textbox', { name: /amount of usdc to supply/i });
        fireEvent.change(input, { target: { value } });

        expect(input).toHaveValue(value);
        expect(screen.getByText(/use digits and one point, with up to 6 decimals/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Review' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Review' }));
        expect(onReview).not.toHaveBeenCalled();
      }
    );

    it('reviews an amount pasted with spaces around it', () => {
      const onReview = renderPanel(lendingWith(controller()));

      fireEvent.click(supplyButton());
      fireEvent.change(screen.getByRole('textbox', { name: /amount of usdc to supply/i }), {
        target: { value: ' 2.5 ' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Review' }));

      expect(onReview).toHaveBeenCalledWith(2_500_000n);
    });

    it.each<[string, string]>([
      ['above the wallet balance', '42.500002'],
      ['zero', '0'],
      ['empty', ''],
    ])('does not review an amount that is %s', (_name, value) => {
      const onReview = renderPanel(lendingWith(controller()));

      fireEvent.click(supplyButton());
      fireEvent.change(screen.getByRole('textbox', { name: /amount of usdc to supply/i }), { target: { value } });

      expect(screen.getByRole('button', { name: 'Review' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Review' }));
      expect(onReview).not.toHaveBeenCalled();
      if (value === '42.500002') expect(screen.getByText(/exceeds your wallet balance/i)).toBeInTheDocument();
    });

    it.each<[WrappedBlockReason, RegExp]>([
      ['transaction-pending', /earlier wrapped transaction/i],
      ['action-in-progress', /already in review/i],
    ])('disables the supply control while %s', (reason, message) => {
      renderPanel(lendingWith(controller()), { blockedReason: reason });

      expect(supplyButton()).toBeDisabled();
      expect(screen.getByText(message)).toBeInTheDocument();
    });

    it('says why a review did not start', () => {
      renderPanel(lendingWith(controller()), { onReview: jest.fn(() => 'transaction-pending') });

      fireEvent.click(supplyButton());
      fireEvent.change(screen.getByRole('textbox', { name: /amount of usdc to supply/i }), { target: { value: '1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Review' }));

      expect(screen.getByText(/earlier wrapped transaction/i)).toBeInTheDocument();
    });

    it('keeps the supply control disabled when the route refuses deposits, whatever the lifecycle reports', () => {
      renderPanel(lendingWith(controller(), WRAPPED_MARKET_REGISTRY), { blockedReason: undefined });

      expect(supplyButton()).toBeDisabled();
      expect(screen.getByText('Wrapped deposits are not open yet.')).toBeInTheDocument();
    });

    it('waits for the wrapped position, with the wallet balance it reads, before the supply can start', () => {
      renderPanel({ ...lendingWith(controller()), position: { status: 'loading' } });

      expect(supplyButton()).toBeDisabled();
      expect(screen.getByText(/waiting for your wrapped position/i)).toBeInTheDocument();
    });

    it('closes the amount form when the session or market changes', () => {
      const lending = lendingWith(controller());
      const props = {
        position: lending.position,
        baseAsset: { symbol: 'USDC', baseAssetPriceInDollars: 100_000_000n, balanceOfComet: 10n ** 12n },
        earnAPR: 0n,
        supply: { blockedReason: undefined, onReview: jest.fn(() => undefined) },
        onRetry: jest.fn(),
      };
      const { rerender } = render(<WrappedPositionPanel route={routeFor(OPEN)} {...props} />);
      fireEvent.click(supplyButton());
      expect(screen.getByRole('textbox', { name: /amount of usdc to supply/i })).toBeInTheDocument();

      // A reconnect gives the route a new validation key.
      rerender(<WrappedPositionPanel route={{ ...routeFor(OPEN), validationKey: 'another-session' }} {...props} />);
      expect(screen.queryByRole('textbox', { name: /amount of usdc to supply/i })).not.toBeInTheDocument();

      // The session returns to the key the form was opened for. The form stays closed.
      rerender(<WrappedPositionPanel route={routeFor(OPEN)} {...props} />);
      expect(screen.queryByRole('textbox', { name: /amount of usdc to supply/i })).not.toBeInTheDocument();
    });

    it('keeps the withdraw control disabled', () => {
      renderPanel(lendingWith(controller()));

      expect(screen.getByRole('button', { name: 'Withdraw USDC from the wrapper' })).toBeDisabled();
    });

    it('starts the review from Home through the wrapped supply, not the standard queue', () => {
      const lending = lendingWith(controller());
      const queue = actionQueue();
      render(homeElement(lending, cometState(BASE_ASSET), queue));

      fireEvent.click(supplyButton());
      fireEvent.change(screen.getByRole('textbox', { name: /amount of usdc to supply/i }), { target: { value: '5' } });
      fireEvent.click(screen.getByRole('button', { name: 'Review' }));

      expect(lending.write.supply).toHaveBeenCalledWith(5_000_000n);
      expect(queue.addOrUpdateAction).not.toHaveBeenCalled();
      expect(mockWriteState.approve).not.toHaveBeenCalled();
      expect(mockWriteState.supply).not.toHaveBeenCalled();
    });
  });

  describe('review dialog', () => {
    it('names each step and confirms only the one in review', () => {
      const { onConfirm } = renderModal(inReview([RESET_STEP, APPROVE_STEP, SUPPLY_STEP]));

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('Reset the USDC allowance for the wrapper to 0');
      expect(dialog).toHaveTextContent('Approve 1,000.000000 USDC for the wrapper');
      expect(dialog).toHaveTextContent('Supply 1,000.000000 USDC through the wrapper');
      expect(dialog).toHaveTextContent('1,000.000000 USDC');
      // The amount in the token's base units, as Anchorage's approval screen shows it.
      expect(dialog).toHaveTextContent('1000000000');
      fireEvent.click(within(dialog).getByRole('button', { name: /reset allowance/i }));
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(within(dialog).queryByRole('button', { name: /approve 1,000/i })).not.toBeInTheDocument();
    });

    it('shows the broadcast step with its transaction link and nothing to confirm', () => {
      renderModal({
        ...inReview(),
        phase: 'signing',
        steps: [{ status: 'submitted', hash: HASH }, { status: 'waiting' }],
      });

      expect(explorerLinks()).toEqual([EXPLORER_LINK]);
      expect(screen.queryByRole('button', { name: /approve|supply 1,000/i })).not.toBeInTheDocument();
    });

    it('confirms success with the supply transaction link, and closes', () => {
      const receipt = { transactionHash: HASH, status: 1 } as TransactionReceipt;
      const { onClose } = renderModal({
        ...inReview([SUPPLY_STEP]),
        phase: 'complete',
        steps: [{ status: 'confirmed', hash: HASH, receipt }],
      });

      expect(screen.getByRole('dialog')).toHaveTextContent(/supply confirmed/i);
      expect(explorerLinks()).toEqual([EXPLORER_LINK]);
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('says a stopped supply sends nothing more, and why', () => {
      renderModal({
        ...inReview(),
        phase: 'stopped',
        steps: [
          {
            status: 'blocked',
            reason: 'step-check-failed',
            message: 'The allowance changed. Review the supply again.',
          },
          { status: 'waiting' },
        ],
      });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('The allowance changed. Review the supply again.');
      expect(dialog).toHaveTextContent(/nothing was sent/i);
      expect(within(dialog).getByRole('button', { name: 'Close' })).toBeEnabled();
    });

    it('lists what was already sent when an identity change closed the supply', () => {
      renderModal({
        phase: 'discarded',
        reason: 'identity-changed',
        type: 'supply',
        chainId: 1,
        submittedHashes: [HASH],
        isWalletRequestOpen: true,
      });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(/changed/i);
      expect(dialog).toHaveTextContent(/not cancelled/i);
      expect(dialog).toHaveTextContent(/still open in your wallet/i);
      expect(explorerLinks()).toEqual([EXPLORER_LINK]);
    });

    it('shows a failed read and closes', () => {
      const identity = draftFor([SUPPLY_STEP]).identity;
      const { onClose } = renderModal({
        phase: 'read-failed',
        identity,
        message: 'The amount is more than your wallet holds.',
      });

      expect(screen.getByRole('dialog')).toHaveTextContent('The amount is more than your wallet holds.');
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("keeps a confirmed supply on screen, in its own market's terms, after a switch to another market", () => {
      const receipt = { transactionHash: HASH, status: 1 } as TransactionReceipt;
      const complete: WrappedActionState = {
        ...inReview([SUPPLY_STEP]),
        phase: 'complete',
        steps: [{ status: 'confirmed', hash: HASH, receipt }],
      };
      const usdt = { ...lendingWith(controller(complete)), route: routeFor(OPEN, USDT_COMET) };
      render(homeElement(usdt, cometState(BASE_ASSET), actionQueue(), USDT_MARKET));

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(/supply confirmed/i);
      expect(dialog).toHaveTextContent('Supplied 1,000.000000 USDC');
      expect(dialog).not.toHaveTextContent(/USDT/);
    });

    it.each<[string, WrappedActionState]>([
      ['nothing is in progress', { phase: 'idle' }],
      [
        'the user closed a review that had sent nothing',
        {
          phase: 'discarded',
          reason: 'cleared',
          type: 'supply',
          chainId: 1,
          submittedHashes: [],
          isWalletRequestOpen: false,
        },
      ],
    ])('Home shows no dialog when %s', (_name, state) => {
      render(homeElement(lendingWith(controller(state)), cometState(BASE_ASSET)));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('Home closes the dialog through the wrapper lifecycle', () => {
      const action = controller(inReview());
      render(homeElement(lendingWith(action), cometState(BASE_ASSET)));

      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close dialog' }));
      expect(action.discard).toHaveBeenCalledTimes(2);
      expect(action.confirm).not.toHaveBeenCalled();
    });
  });
});
