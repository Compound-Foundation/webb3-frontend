import { Interface } from '@ethersproject/abi';
import { TransactionReceipt } from '@ethersproject/providers';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useLayoutEffect } from 'react';

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
import { recordCometStateSource } from '@helpers/cometStateSource';
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
    isRecoveredRequestPendingInWallet: false,
    canDismissRecovered: false,
    hasUnansweredWalletRequest: false,
    walletRefusalMessage: undefined,
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

type Lending = WrappedLending & { write: { supply: jest.Mock; withdraw: jest.Mock } };

function lendingWith(action: Controller, registry = OPEN): Lending {
  return {
    route: routeFor(registry),
    position: { status: 'loaded', position: POSITION },
    retry: jest.fn(),
    action,
    write: { supply: jest.fn(() => undefined), withdraw: jest.fn(() => undefined) },
  };
}

const BASE_ASSET = mockBaseAsset({ address: USDC, symbol: 'USDC', decimals: 6 });

function cometState(baseAsset: BaseAssetWithAccountState, cometAddress = USDC_COMET, account = ACCOUNT): CometState {
  const state = [
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
  // As useCometState records it: read for the given market and account.
  recordCometStateSource(state, { chainId: 1, cometAddress }, account);
  return state;
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

/** The dimmed area around the open dialog. It has no role, so the test finds it by its class. */
function backdrop(): HTMLElement {
  const backdrops = document.querySelectorAll<HTMLElement>('.modal__backdrop');
  if (backdrops.length !== 1) throw new Error('exactly one dialog backdrop must be shown');
  return backdrops[0];
}

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
      const state = cometState(BORROWER, USDT_COMET);
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
      const other = '0x0000000000000000000000000000000000000bb2';
      const otherAccount = { ...WEB3, read: { ...WEB3.read, account: other } };
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
                cometState={cometState(BORROWER, USDC_COMET, other)}
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

    it.each(['0', '0.0', '00', '.0', '0.000000'])('says why it refuses %p, an amount of zero', (value) => {
      const onReview = renderPanel(lendingWith(controller()));

      fireEvent.click(supplyButton());
      const input = screen.getByRole('textbox', { name: /amount of usdc to supply/i });
      fireEvent.change(input, { target: { value } });

      expect(screen.getByText('Enter an amount greater than 0')).toBeInTheDocument();
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('button', { name: 'Review' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Review' }));
      expect(onReview).not.toHaveBeenCalled();

      fireEvent.change(input, { target: { value: '' } });
      expect(screen.queryByText('Enter an amount greater than 0')).not.toBeInTheDocument();
      expect(input).toHaveAttribute('aria-invalid', 'false');
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

    it('closes the amount form when the session or market changes, from the first render under the new key', () => {
      const lending = lendingWith(controller());
      const props = {
        position: lending.position,
        baseAsset: { symbol: 'USDC', baseAssetPriceInDollars: 100_000_000n, balanceOfComet: 10n ** 12n },
        earnAPR: 0n,
        supply: { blockedReason: undefined, onReview: jest.fn(() => undefined) },
        onRetry: jest.fn(),
      };
      const amountInput = () => screen.queryByRole('textbox', { name: /amount of usdc to supply/i });
      // Whether the form was on screen at each commit, seen before the panel's passive effects run.
      const committed: boolean[] = [];
      function Panel({ route }: { route: Extract<LendingRoute, { kind: 'wrapped' }> }) {
        useLayoutEffect(() => {
          committed.push(amountInput() !== null);
        });
        return <WrappedPositionPanel route={route} {...props} />;
      }
      const { rerender } = render(<Panel route={routeFor(OPEN)} />);
      fireEvent.click(supplyButton());
      fireEvent.change(amountInput() as HTMLElement, { target: { value: '123.456789' } });
      expect(amountInput()).toHaveValue('123.456789');

      // A reconnect gives the route a new validation key. No commit under it shows the old form.
      committed.length = 0;
      rerender(<Panel route={{ ...routeFor(OPEN), validationKey: 'another-session' }} />);
      expect(committed.length).toBeGreaterThan(0);
      expect(committed).not.toContain(true);
      expect(amountInput()).not.toBeInTheDocument();

      // The session returns to the key the form was opened for. The form stays closed.
      committed.length = 0;
      rerender(<Panel route={routeFor(OPEN)} />);
      expect(committed.length).toBeGreaterThan(0);
      expect(committed).not.toContain(true);
      expect(amountInput()).not.toBeInTheDocument();
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

    it('says from Home how to stop waiting for a wallet request with no answer, and offers no dismissal', () => {
      const action = { ...controller({ phase: 'idle' }, 'transaction-pending'), hasUnansweredWalletRequest: true };
      render(homeElement(lendingWith(action), cometState(BASE_ASSET)));

      const guidance = screen.getByText(/your wallet has not answered a request/i);
      expect(guidance).toHaveTextContent(/new wrapped deposits and withdrawals wait for that answer/i);
      expect(guidance).toHaveTextContent(/look for the request in your wallet app/i);
      expect(guidance).toHaveTextContent(/if it is not there, reload the page and reconnect your wallet/i);
      expect(guidance).toHaveTextContent(/you can then stop waiting for it/i);
      expect(screen.queryByRole('button', { name: 'Stop waiting' })).not.toBeInTheDocument();
      expect(supplyButton()).toBeDisabled();
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
      // The amount in the token's base units. Porto's approval screen showed a withdrawal's amount so (COM-284).
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

    it('shows the review being read, and cancels it', () => {
      const { onClose } = renderModal({ phase: 'reading', identity: draftFor([SUPPLY_STEP]).identity });

      expect(screen.getByRole('dialog')).toHaveTextContent(/checking your balance/i);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it.each<[string, WrappedStepState, RegExp]>([
      ['checking', { status: 'checking' }, /checking your balance, allowance and wallet/i],
      ['awaiting the wallet', { status: 'awaiting-signature' }, /waiting for your wallet/i],
    ])('says what a step being signed is %s, with nothing to confirm', (_name, step, text) => {
      renderModal({ ...inReview(), phase: 'signing', steps: [step, { status: 'waiting' }] });

      expect(screen.getByRole('dialog')).toHaveTextContent(text);
      expect(screen.queryByRole('button', { name: /approve 1,000/i })).not.toBeInTheDocument();
    });

    it.each<[string, WrappedStepState]>([
      ['checked before the wallet is asked', { status: 'checking' }],
      ['in the wallet', { status: 'awaiting-signature' }],
      ['on the network', { status: 'submitted', hash: HASH }],
    ])(
      'stays open on a click on the backdrop while a step is %s, and closes with the close control or Close',
      (_name, step) => {
        const { onClose } = renderModal({ ...inReview(), phase: 'signing', steps: [step, { status: 'waiting' }] });

        fireEvent.click(backdrop());
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(2);
      }
    );

    it.each<[string, WrappedActionState]>([
      ['being read', { phase: 'reading', identity: draftFor([SUPPLY_STEP]).identity }],
      [
        'not ready after a failed read',
        { phase: 'read-failed', identity: draftFor([SUPPLY_STEP]).identity, message: 'The read failed.' },
      ],
      ['in review', inReview()],
      [
        'in review of its next step',
        inReview(undefined, 1, [
          { status: 'confirmed', hash: HASH, receipt: { transactionHash: HASH, status: 1 } as TransactionReceipt },
          { status: 'waiting' },
        ]),
      ],
      [
        'confirmed',
        {
          ...inReview([SUPPLY_STEP]),
          phase: 'complete',
          steps: [
            { status: 'confirmed', hash: HASH, receipt: { transactionHash: HASH, status: 1 } as TransactionReceipt },
          ],
        },
      ],
      ['stopped', { ...inReview(), phase: 'stopped', steps: [{ status: 'rejected' }, { status: 'waiting' }] }],
      [
        'closed with a request still open in the wallet',
        {
          phase: 'discarded',
          reason: 'cleared',
          type: 'supply',
          chainId: 1,
          submittedHashes: [],
          isWalletRequestOpen: true,
        },
      ],
    ])('closes on a click on the backdrop while the supply is %s', (_name, state) => {
      const { onClose } = renderModal(state);

      fireEvent.click(backdrop());
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it.each<[WrappedStepState, RegExp]>([
      [{ status: 'blocked', reason: 'identity-changed' }, /your wallet, network or market changed/],
      [{ status: 'blocked', reason: 'session-unusable' }, /your wallet stopped responding/],
      [
        { status: 'blocked', reason: 'transaction-pending' },
        /another wrapped transaction from this account is still pending/,
      ],
      [{ status: 'blocked', reason: 'supply-paused' }, /supplying to this market is paused/],
      [{ status: 'blocked', reason: 'restriction-unknown' }, /pause state could not be read/],
      [{ status: 'blocked', reason: 'deposits-disabled' }, /wrapped deposits are closed/],
      [{ status: 'blocked', reason: 'screening' }, /has not passed screening/],
      [{ status: 'blocked', reason: 'no-signer' }, /not connected and ready/],
      [
        { status: 'blocked', reason: 'not-sent', message: 'out of gas' },
        /failed before your wallet was asked \(out of gas\)/,
      ],
      [{ status: 'blocked', reason: 'wrong-spender' }, /did not pass this page's checks \(wrong-spender\)/],
    ])('says why a step was stopped before the wallet was asked: %p', (step, text) => {
      renderModal({ ...inReview(), phase: 'stopped', steps: [step, { status: 'waiting' }] });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(/nothing was sent/i);
      expect(dialog).toHaveTextContent(text);
      expect(dialog).toHaveTextContent('Not sent.');
    });

    it('says a wallet error may still go through, and to check the wallet', () => {
      renderModal({
        ...inReview(),
        phase: 'stopped',
        steps: [{ status: 'provider-failure', message: 'Internal error (-32603)' }, { status: 'waiting' }],
      });

      expect(
        screen.getByText(
          'Your wallet reported an error (Internal error (-32603)). The request may still go through, so check your ' +
            'wallet before you try again.'
        )
      ).toBeInTheDocument();
      expect(screen.getByRole('dialog')).not.toHaveTextContent(/Anchorage app/);
    });

    it('says how to answer a request the wallet still holds, and that this page cannot follow it', () => {
      const message =
        'This request is still pending and can still complete after this message. Check its status in the ' +
        'Anchorage extension before you try again. (-32005)';
      renderModal({
        ...inReview(),
        phase: 'stopped',
        steps: [{ status: 'provider-failure', message, isPendingInWallet: true }, { status: 'waiting' }],
      });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('Supply Stopped');
      expect(
        within(dialog).getByText(
          'Your wallet still has this request open. Approve or reject it in the Anchorage app on your phone. ' +
            'Approving it still sends the transaction, but this page cannot follow that transaction. ' +
            'The request may still go through, so check your wallet before you try again. ' +
            'Once your wallet shows the request done, reload this page. The panel then shows the result. ' +
            'After you press Stop waiting there, a new review starts from the new balances. ' +
            `(Your wallet reported: ${message})`
        )
      ).toBeInTheDocument();
      expect(dialog).not.toHaveTextContent(/your wallet reported an error/i);
      // The supply still stops there: nothing more is sent, and there is nothing to confirm.
      expect(dialog).toHaveTextContent('Not sent.');
      expect(dialog).toHaveTextContent('This supply stopped, and nothing more is sent from it.');
      expect(within(dialog).queryByRole('button', { name: /approve|supply 1,000/i })).not.toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Close' })).toBeEnabled();
    });

    it('says the wallet refused the request before handling it, names its code, and says to reconnect', () => {
      renderModal({
        ...inReview(),
        phase: 'stopped',
        steps: [{ status: 'refused', message: 'Unauthorized (4100)' }, { status: 'waiting' }],
      });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('Supply Stopped');
      expect(
        within(dialog).getByText(
          'Your wallet refused this request before handling it (Unauthorized (4100)), so nothing was sent. ' +
            'Disconnect and reconnect your wallet on this page, then start a new review.'
        )
      ).toBeInTheDocument();
      // Nothing was sent, so the dialog does not say that the request may still go through.
      expect(dialog).not.toHaveTextContent(/may still go through/i);
      expect(dialog).not.toHaveTextContent(/your wallet reported an error/i);
      expect(dialog).toHaveTextContent('Not sent.');
      expect(dialog).toHaveTextContent('This supply stopped, and nothing more is sent from it.');
      expect(within(dialog).queryByRole('button', { name: /approve|supply 1,000/i })).not.toBeInTheDocument();
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

    it('says how to stop waiting for a request still open in the wallet, not to start a new review', () => {
      renderModal({
        phase: 'discarded',
        reason: 'cleared',
        type: 'supply',
        chainId: 1,
        submittedHashes: [],
        isWalletRequestOpen: true,
      });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(/approving it there still sends it/i);
      expect(dialog).toHaveTextContent(/new supplies from this account wait until your wallet answers the request/i);
      expect(dialog).toHaveTextContent(/look for the request in your wallet app/i);
      expect(dialog).toHaveTextContent(/if it is not there, reload the page and reconnect your wallet/i);
      expect(dialog).toHaveTextContent(/you can then stop waiting for it/i);
      expect(dialog).not.toHaveTextContent(/start a new review/i);
    });

    it('says to start a new review when no request is left open in the wallet', () => {
      renderModal({
        phase: 'discarded',
        reason: 'cleared',
        type: 'supply',
        chainId: 1,
        submittedHashes: [HASH],
        isWalletRequestOpen: false,
      });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('Nothing more is sent from this review. Start a new review to continue.');
      expect(dialog).not.toHaveTextContent(/look for the request/i);
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

    it('says when a broken wallet closed the supply', () => {
      renderModal({
        phase: 'discarded',
        reason: 'session-unusable',
        type: 'supply',
        chainId: 1,
        submittedHashes: [],
        isWalletRequestOpen: true,
      });

      expect(screen.getByRole('dialog')).toHaveTextContent(
        /your wallet stopped responding, so this supply was closed/i
      );
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

    it('Home keeps the supply on a click on the backdrop while the wallet has its request', () => {
      const action = controller({
        ...inReview(),
        phase: 'signing',
        steps: [{ status: 'awaiting-signature' }, { status: 'waiting' }],
      });
      render(homeElement(lendingWith(action), cometState(BASE_ASSET)));

      fireEvent.click(backdrop());
      expect(action.discard).not.toHaveBeenCalled();
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close dialog' }));
      expect(action.discard).toHaveBeenCalledTimes(1);
    });
  });
});
