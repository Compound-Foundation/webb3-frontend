import { Interface } from '@ethersproject/abi';
import { TransactionReceipt } from '@ethersproject/providers';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
  RecheckedWithdrawal,
  WRAPPED_ACTION,
  WrappedActionDraft,
  WrappedActionType,
  WrappedBlockReason,
  WrappedStep,
  wrappedActionIdentity,
} from '@helpers/wrappedActions';
import { WrappedPosition } from '@helpers/wrappedPositions';
import { WithdrawalReview } from '@helpers/wrappedWithdrawals';
import { Theme } from '@hooks/useThemeManager';
import { WrappedActionController, WrappedActionState, WrappedStepState } from '@hooks/useWrappedAction';
import { ActionQueue, BaseAssetWithAccountState, CometState, MarketData, StateType } from '@types';

import { mockBaseAsset } from '../../../../__tests__/mocks/mockBaseAsset';
import { mockWeb3 } from '../../../../__tests__/mocks/mockWeb3';
import WrappedWithdrawModal from '../components/ActionModal/WrappedWithdrawModal';
import WrappedPositionPanel from '../components/WrappedPositionPanel';
import Home from '../index';

// The wrapped panel and the dialogs are real. Home's other children record their props.
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
const WALLET = { name: 'wallet provider' };
const HASH = `0x${'7'.repeat(64)}`;
const EXPLORER_LINK = `${getBlockExplorerUrl(1)}/tx/${HASH}`;

/** 250 of the wrapper's 1,000 whole shares of 1,000.5 USDC: a full exit pays 250.124997 USDC. */
const SHARES = 250n * 10n ** 18n;
/** The fewest shares that pay 100 USDC. */
const SHARES_FOR_100 = 99_950_027_886_106_918_655n;

const CALLS = new Interface(['function unwrapAndWithdraw(uint256 shares)']);

function registryWith({ exits }: { exits: boolean }): WrappedMarketRegistry {
  return buildWrappedMarketRegistry({
    markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({ ...market, isExitEnabled: exits })),
  });
}
/** A fixture with exits enabled. The committed configuration keeps them off until COM-292. */
const OPEN = registryWith({ exits: true });

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
function routeFor(registry: WrappedMarketRegistry): Extract<LendingRoute, { kind: 'wrapped' }> {
  const lookup = registry.lookup(1, USDC_COMET);
  if (lookup.status !== 'valid') throw new Error('the mapping must be valid');
  const route = resolveLendingRoute({
    market: { chainId: 1, cometAddress: USDC_COMET },
    session: SESSION,
    conflictedRdns: new Set(),
    validation: { key: wrappedRouteKey(lookup.market, SESSION), status: 'matched' },
    registry,
  });
  if (route.kind !== 'wrapped') throw new Error('the route must be wrapped');
  return route;
}

const PARTIAL_REVIEW: WithdrawalReview = {
  request: { kind: 'partial', cash: 100_000_000n },
  quote: {
    kind: 'partial',
    shares: SHARES_FOR_100,
    grossAssets: 100_000_003n,
    redeemBuffer: 3n,
    cash: 100_000_000n,
    leavesDust: false,
  },
  shownCash: undefined,
  blockNumber: 100,
};
const FULL_REVIEW: WithdrawalReview = {
  request: { kind: 'full' },
  quote: {
    kind: 'full',
    shares: SHARES,
    grossAssets: 250_125_000n,
    redeemBuffer: 3n,
    cash: 250_124_997n,
    leavesDust: false,
  },
  shownCash: 250_124_997n,
  blockNumber: 100,
};

/** The partial exit as its check found it just before the signature, after interest raised its cash. */
const PARTIAL_RECHECKED: RecheckedWithdrawal = {
  quote: { ...PARTIAL_REVIEW.quote, grossAssets: 100_049_978n, cash: 100_049_975n },
  blockNumber: 101,
  description: 'Withdraw about 100.049975 USDC from the wrapper',
};
/** The full exit as its check found it just before the signature, after interest raised its cash. */
const FULL_RECHECKED: RecheckedWithdrawal = {
  quote: { ...FULL_REVIEW.quote, grossAssets: 250_250_000n, cash: 250_249_997n },
  blockNumber: 101,
  description: 'Withdraw all your wrapped USDC, about 250.249997 USDC',
};

function exitStep(review: WithdrawalReview): WrappedStep {
  return {
    id: 'withdraw',
    kind: 'unwrap-and-withdraw',
    description:
      review.quote.kind === 'full'
        ? 'Withdraw all your wrapped USDC, about 250.124997 USDC'
        : 'Withdraw about 100.000000 USDC from the wrapper',
    request: { to: USDC_WRAPPER, data: CALLS.encodeFunctionData('unwrapAndWithdraw', [review.quote.shares]) },
    // The dialog shows the state it is given, and never runs the step's check.
    check: async () => {
      throw new Error('The dialog never runs the check.');
    },
  };
}

function draftFor(review: WithdrawalReview): WrappedActionDraft {
  const identity = wrappedActionIdentity('withdraw', {
    route: routeFor(OPEN),
    account: ACCOUNT,
    chainId: 1,
    screeningStatus: 'allowed',
    provider: WALLET,
  });
  if (identity === undefined) throw new Error('the session must have an identity');
  return {
    kind: WRAPPED_ACTION,
    id: 'draft-1',
    identity,
    amount: review.quote.shares,
    steps: [exitStep(review)],
    withdrawal: review,
  };
}

type Review = Extract<WrappedActionState, { phase: 'review' }>;

function inReview(review: WithdrawalReview = PARTIAL_REVIEW, step: WrappedStepState = { status: 'waiting' }): Review {
  return { phase: 'review', draft: draftFor(review), steps: [step], stepIndex: 0 };
}

type Controller = WrappedActionController & { confirm: jest.Mock; discard: jest.Mock };

function controller(state: WrappedActionState = { phase: 'idle' }): Controller {
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
  };
}

const POSITION: WrappedPosition = {
  shares: SHARES,
  shareDecimals: 18,
  grossAssets: 250_125_000n,
  baseDecimals: 6,
  baseWalletBalance: 42_500_001n,
  wrapperAllowance: 0n,
  redeemBuffer: 3n,
  fullExitCash: 250_124_997n,
  isWithdrawPaused: false,
  snapshot: {
    totalSupply: 1_000n * 10n ** 18n - 10n ** 12n,
    totalAssets: 1_000_500_000n,
    baseSupplyIndex: 1_050_000_000_000_000n,
  },
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

function homeElement(lending: WrappedLending, state: CometState, queue: ActionQueue = actionQueue()) {
  const SelectedMarketContext = SelectedMarketContextHelpers.getSelectedMarketContext();
  const ActionQueueContext = ActionQueueContextHelpers.getActionQueueContext();
  const selectedMarketData = {
    selectedMarket: [StateType.Hydrated, USDC_MARKET] as const,
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

function renderModal(state: WrappedActionState) {
  const onConfirm = jest.fn();
  const onClose = jest.fn();
  render(<WrappedWithdrawModal state={state} symbol="USDC" decimals={6} onConfirm={onConfirm} onClose={onClose} />);
  return { onConfirm, onClose };
}

const explorerLinks = () =>
  screen.queryAllByRole('link', { name: /view on explorer/i }).map((link) => link.getAttribute('href'));

describe('WrappedWithdraw', () => {
  beforeEach(() => {
    Object.values(mockWriteState).forEach((fn) => fn.mockReset());
  });

  describe('withdraw entry', () => {
    type PanelSetup = {
      registry?: WrappedMarketRegistry;
      position?: WrappedPosition | 'loading';
      cometCash?: bigint;
      blockedReason?: WrappedBlockReason;
      onReview?: jest.Mock;
    };

    function renderPanel({
      registry = OPEN,
      position = POSITION,
      cometCash = 10n ** 15n,
      blockedReason,
      onReview,
    }: PanelSetup = {}) {
      const review = onReview ?? jest.fn(() => undefined);
      render(
        <WrappedPositionPanel
          route={routeFor(registry)}
          position={position === 'loading' ? { status: 'loading' } : { status: 'loaded', position }}
          baseAsset={{ symbol: 'USDC', baseAssetPriceInDollars: 100_000_000n, balanceOfComet: cometCash }}
          earnAPR={0n}
          withdraw={{ blockedReason, onReview: review }}
          onRetry={jest.fn()}
        />
      );
      return review;
    }
    const withdrawButton = () => screen.getByRole('button', { name: 'Withdraw USDC from the wrapper' });
    const amountInput = () => screen.getByRole('textbox', { name: /amount of usdc to withdraw/i });
    const reviewButton = () => screen.getByRole('button', { name: 'Review' });

    it('keeps the withdraw control disabled by the committed release control', () => {
      expect(HARDCODED_WRAPPED_LENDING_SOURCE.markets.every((market) => market.isExitEnabled === false)).toBe(true);
      renderPanel({ registry: WRAPPED_MARKET_REGISTRY, blockedReason: 'exits-disabled' });

      expect(withdrawButton()).toBeDisabled();
      expect(screen.getByTestId('wrapped-withdraw-message')).toHaveTextContent('Wrapped withdrawals are not open yet.');
    });

    it('keeps the withdraw control disabled when the route refuses exits, whatever the lifecycle reports', () => {
      renderPanel({ registry: WRAPPED_MARKET_REGISTRY, blockedReason: undefined });

      expect(withdrawButton()).toBeDisabled();
      expect(screen.getByTestId('wrapped-withdraw-message')).toHaveTextContent('Wrapped withdrawals are not open yet.');
    });

    it('reviews the exact amount typed as a partial exit, which is the choice the form starts with', () => {
      const onReview = renderPanel();

      fireEvent.click(withdrawButton());
      expect(screen.getByRole('radio', { name: /an amount/i })).toBeChecked();
      expect(screen.getByRole('radio', { name: /everything/i })).not.toBeChecked();
      expect(screen.getByTestId('wrapped-withdraw-limit')).toHaveTextContent('Up to 250.124997 USDC now');
      fireEvent.change(amountInput(), { target: { value: '100' } });
      fireEvent.click(reviewButton());

      expect(onReview).toHaveBeenCalledWith({ kind: 'partial', cash: 100_000_000n }, undefined);
    });

    it('reviews the whole position only when the user chooses Everything, with the cash the form showed', () => {
      const onReview = renderPanel();

      fireEvent.click(withdrawButton());
      fireEvent.click(screen.getByRole('radio', { name: /everything/i }));
      expect(screen.queryByRole('textbox', { name: /amount of usdc to withdraw/i })).not.toBeInTheDocument();
      expect(screen.getByTestId('wrapped-withdraw-limit')).toHaveTextContent(
        'About 250.124997 USDC for all your shares'
      );
      fireEvent.click(reviewButton());

      expect(onReview).toHaveBeenCalledWith({ kind: 'full' }, 250_124_997n);
    });

    it('refuses an amount above what the position pays, offers the full exit, and keeps the amount as typed', () => {
      const onReview = renderPanel();

      fireEvent.click(withdrawButton());
      fireEvent.change(amountInput(), { target: { value: '250.124998' } });

      expect(screen.getByText(/more than you can withdraw now/i)).toHaveTextContent(
        /enter at most 250\.124997 USDC, or choose Everything/i
      );
      expect(amountInput()).toHaveValue('250.124998');
      expect(reviewButton()).toBeDisabled();
      fireEvent.click(reviewButton());
      expect(onReview).not.toHaveBeenCalled();
    });

    it('says when the amount typed leaves shares that cannot be withdrawn on their own, and lets the user go on', () => {
      const onReview = renderPanel();

      fireEvent.click(withdrawButton());
      // The fewest shares that pay the whole position's cash leave shares worth less than a base unit.
      fireEvent.change(amountInput(), { target: { value: '250.124997' } });

      expect(screen.getByTestId('wrapped-withdraw-hint')).toHaveTextContent(
        /cannot be withdrawn on its own\. To withdraw it all, choose Everything/
      );
      fireEvent.click(reviewButton());
      expect(onReview).toHaveBeenCalledWith({ kind: 'partial', cash: 250_124_997n }, undefined);
    });

    it("refuses an amount above the market's cash, and a full exit the market cannot pay", () => {
      const onReview = renderPanel({ cometCash: 100_000_000n });

      fireEvent.click(withdrawButton());
      fireEvent.change(amountInput(), { target: { value: '100.000001' } });
      expect(screen.getByText(/the market holds only 100\.000000 USDC now/i)).toHaveTextContent(
        /enter at most 100\.000000 USDC/i
      );
      expect(reviewButton()).toBeDisabled();

      fireEvent.click(screen.getByRole('radio', { name: /everything/i }));
      expect(screen.getByText(/less than a full exit pays/i)).toHaveTextContent(/at most 100\.000000 USDC/);
      expect(reviewButton()).toBeDisabled();

      fireEvent.click(screen.getByRole('radio', { name: /an amount/i }));
      fireEvent.change(amountInput(), { target: { value: '100' } });
      fireEvent.click(reviewButton());
      expect(onReview).toHaveBeenCalledTimes(1);
      expect(onReview).toHaveBeenCalledWith({ kind: 'partial', cash: 100_000_000n }, undefined);
    });

    it.each(['1.1234567', '1,5', '1.000.000', '1e6', '-1', '0x10', 'one'])(
      'keeps %p as typed and refuses to review it, rather than dropping characters',
      (value) => {
        const onReview = renderPanel();

        fireEvent.click(withdrawButton());
        fireEvent.change(amountInput(), { target: { value } });

        expect(amountInput()).toHaveValue(value);
        expect(screen.getByText(/use digits and one point, with up to 6 decimals/i)).toBeInTheDocument();
        expect(reviewButton()).toBeDisabled();
        fireEvent.click(reviewButton());
        expect(onReview).not.toHaveBeenCalled();
      }
    );

    it.each(['0', ''])('does not review an amount of %p', (value) => {
      const onReview = renderPanel();

      fireEvent.click(withdrawButton());
      fireEvent.change(amountInput(), { target: { value } });

      expect(reviewButton()).toBeDisabled();
      fireEvent.click(reviewButton());
      expect(onReview).not.toHaveBeenCalled();
    });

    it.each(['0', '0.0', '00', '.0', '0.000000'])('says why it refuses %p, an amount of zero', (value) => {
      const onReview = renderPanel();

      fireEvent.click(withdrawButton());
      fireEvent.change(amountInput(), { target: { value } });

      expect(screen.getByText('Enter an amount greater than 0')).toBeInTheDocument();
      expect(amountInput()).toHaveAttribute('aria-invalid', 'true');
      expect(reviewButton()).toBeDisabled();
      fireEvent.click(reviewButton());
      expect(onReview).not.toHaveBeenCalled();

      fireEvent.change(amountInput(), { target: { value: '' } });
      expect(screen.queryByText('Enter an amount greater than 0')).not.toBeInTheDocument();
      expect(amountInput()).toHaveAttribute('aria-invalid', 'false');
    });

    it.each<[string, PanelSetup, RegExp]>([
      [
        'withdrawals are paused',
        { position: { ...POSITION, isWithdrawPaused: true } },
        /withdrawals from this market are paused/i,
      ],
      [
        'the position is worth no more than the buffer',
        { position: { ...POSITION, shares: 2_998_500_746_629n, grossAssets: 3n, fullExitCash: 0n } },
        /too small to withdraw.*rounding buffer/i,
      ],
      [
        'the account holds no shares',
        { position: { ...POSITION, shares: 0n, grossAssets: 0n, fullExitCash: 0n } },
        /you hold no wrapped USDC/i,
      ],
      ['the position is loading', { position: 'loading' }, /waiting for your wrapped position/i],
      [
        'an earlier wrapped transaction is pending',
        { blockedReason: 'transaction-pending' },
        /earlier wrapped transaction/i,
      ],
      ['another wrapped transaction is in review', { blockedReason: 'action-in-progress' }, /already in review/i],
    ])('disables the withdraw control and says why when %s', (_name, setup, message) => {
      renderPanel(setup);

      expect(withdrawButton()).toBeDisabled();
      expect(screen.getByTestId('wrapped-withdraw-message')).toHaveTextContent(message);
    });

    it('says why a review did not start', () => {
      renderPanel({ onReview: jest.fn(() => 'transaction-pending') });

      fireEvent.click(withdrawButton());
      fireEvent.change(amountInput(), { target: { value: '1' } });
      fireEvent.click(reviewButton());

      expect(screen.getByText(/earlier wrapped transaction/i)).toBeInTheDocument();
      expect(amountInput()).toHaveValue('1');
    });

    it('opens one form at a time, and closes it when the session or market changes', () => {
      const props = {
        position: { status: 'loaded' as const, position: POSITION },
        baseAsset: { symbol: 'USDC', baseAssetPriceInDollars: 100_000_000n, balanceOfComet: 10n ** 15n },
        earnAPR: 0n,
        supply: { blockedReason: undefined, onReview: jest.fn(() => undefined) },
        withdraw: { blockedReason: undefined, onReview: jest.fn(() => undefined) },
        onRetry: jest.fn(),
      };
      const both = buildWrappedMarketRegistry({
        markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({
          ...market,
          isDepositEnabled: true,
          isExitEnabled: true,
        })),
      });
      const { rerender } = render(<WrappedPositionPanel route={routeFor(both)} {...props} />);

      fireEvent.click(screen.getByRole('button', { name: 'Supply USDC through the wrapper' }));
      expect(screen.getByRole('textbox', { name: /amount of usdc to supply/i })).toBeInTheDocument();
      fireEvent.click(withdrawButton());
      expect(screen.queryByRole('textbox', { name: /amount of usdc to supply/i })).not.toBeInTheDocument();
      expect(amountInput()).toBeInTheDocument();

      // A reconnect gives the route a new validation key.
      rerender(<WrappedPositionPanel route={{ ...routeFor(both), validationKey: 'another-session' }} {...props} />);
      expect(screen.queryByRole('textbox', { name: /amount of usdc to withdraw/i })).not.toBeInTheDocument();

      // The session returns to the key the form was opened for. The form stays closed.
      rerender(<WrappedPositionPanel route={routeFor(both)} {...props} />);
      expect(screen.queryByRole('textbox', { name: /amount of usdc to withdraw/i })).not.toBeInTheDocument();
    });

    it("gives the withdraw control the lifecycle's reason for withdrawals, not for supplies", () => {
      const action = {
        ...controller(),
        blockedReason: (type: WrappedActionType): WrappedBlockReason | undefined =>
          type === 'withdraw' ? 'action-in-progress' : undefined,
      };
      render(homeElement(lendingWith(action), cometState(BASE_ASSET)));

      expect(withdrawButton()).toBeDisabled();
      expect(screen.getByTestId('wrapped-withdraw-message')).toHaveTextContent(/already in review/i);
    });

    it('starts the review from Home through the wrapped withdrawal, never the standard queue or a direct withdraw', () => {
      const lending = lendingWith(controller());
      const queue = actionQueue();
      render(homeElement(lending, cometState(BASE_ASSET), queue));

      fireEvent.click(withdrawButton());
      fireEvent.change(amountInput(), { target: { value: '5' } });
      fireEvent.click(reviewButton());

      expect(lending.write.withdraw).toHaveBeenCalledWith({ kind: 'partial', cash: 5_000_000n }, undefined);
      expect(queue.addOrUpdateAction).not.toHaveBeenCalled();
      expect(mockWriteState.withdraw).not.toHaveBeenCalled();
      expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
      expect(mockWriteState.approve).not.toHaveBeenCalled();
    });
  });

  describe('review dialog', () => {
    it('shows the estimated cash next to the gross value and the buffer, and the shares it burns', () => {
      const { onConfirm } = renderModal(inReview());

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('Withdraw about 100.000000 USDC from the wrapper to your wallet.');
      expect(within(dialog).getByTestId('wrapped-withdraw-cash')).toHaveTextContent('100.000000 USDC');
      expect(within(dialog).getByTestId('wrapped-withdraw-gross')).toHaveTextContent('100.000003 USDC');
      expect(within(dialog).getByTestId('wrapped-withdraw-buffer')).toHaveTextContent('0.000003 USDC');
      expect(within(dialog).getByTestId('wrapped-withdraw-shares')).toHaveTextContent('99.950027886106918655');
      // The shares in their base units, as a wallet can show them.
      expect(dialog).toHaveTextContent('99950027886106918655');

      fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw About 100.000000 USDC' }));
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it.each<[string, WithdrawalReview]>([
      ['a partial exit', PARTIAL_REVIEW],
      ['a full exit', FULL_REVIEW],
    ])('says the simulation enforces no minimum amount and no deadline, for %s', (_name, review) => {
      renderModal(inReview(review));

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(/no minimum amount and no deadline/i);
      expect(dialog).toHaveTextContent(/simulates the withdrawal from your account/i);
      expect(dialog).toHaveTextContent(/can pay a different amount, or fail/i);
      expect(dialog).toHaveTextContent(/cannot open a borrow/i);
    });

    it('confirms a full exit as Everything', () => {
      const { onConfirm } = renderModal(inReview(FULL_REVIEW));

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(
        'Withdraw all your wrapped USDC, about 250.124997 USDC, from the wrapper to your wallet.'
      );
      expect(within(dialog).getByTestId('wrapped-withdraw-shares')).toHaveTextContent('250.000000000000000000');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw Everything' }));
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it.each<[string, bigint, RegExp]>([
      ['rose', 250_000_000n, /now 250\.124997 USDC, 0\.124997 USDC more than the 250\.000000 USDC shown before/],
      ['fell', 250_200_000n, /now 250\.124997 USDC, 0\.075003 USDC less than the 250\.200000 USDC shown before/],
    ])('asks the user to check a full exit whose estimate %s since the panel showed it', (_name, shownCash, text) => {
      renderModal(inReview({ ...FULL_REVIEW, shownCash }));

      const alert = within(screen.getByRole('dialog')).getByRole('alert');
      expect(alert).toHaveTextContent(text);
      expect(alert).toHaveTextContent(/check it before you confirm/i);
    });

    it('shows no change notice when the estimate is what the panel showed', () => {
      renderModal(inReview(FULL_REVIEW));

      expect(within(screen.getByRole('dialog')).queryByRole('alert')).not.toBeInTheDocument();
    });

    it.each<[string, bigint, boolean]>([
      // One share is worth more than a base unit on an 18-decimal market, so the fewest shares can pay one more.
      ['pays more than the amount entered', 100_000_001n, true],
      ['pays exactly the amount entered', 100_000_000n, false],
    ])('says when a partial exit %s', (_name, cash, isShown) => {
      renderModal(inReview({ ...PARTIAL_REVIEW, quote: { ...PARTIAL_REVIEW.quote, cash } }));

      const notice =
        /0\.000001 USDC more than the 100\.000000 USDC you entered, because shares are burned in whole units/;
      if (isShown) expect(screen.getByRole('dialog')).toHaveTextContent(notice);
      else expect(screen.getByRole('dialog')).not.toHaveTextContent(/you entered/);
    });

    it('says when a partial exit leaves shares that cannot be withdrawn on their own', () => {
      renderModal(inReview({ ...PARTIAL_REVIEW, quote: { ...PARTIAL_REVIEW.quote, leavesDust: true } }));

      expect(screen.getByRole('dialog')).toHaveTextContent(/cannot be withdrawn on its own.*choose Everything/i);
    });

    it('shows the exit being checked and signed, with nothing to confirm', () => {
      renderModal({ ...inReview(), phase: 'signing', steps: [{ status: 'checking' }] });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(/simulating the withdrawal from your account, before asking your wallet/i);
      expect(within(dialog).queryByRole('button', { name: /withdraw 100/i })).not.toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Checking' })).toBeDisabled();
    });

    it('confirms success with the transaction link, and closes', () => {
      const receipt = { transactionHash: HASH, status: 1 } as TransactionReceipt;
      const { onClose } = renderModal({
        ...inReview(),
        phase: 'complete',
        steps: [{ status: 'confirmed', hash: HASH, receipt }],
      });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(/withdrawal confirmed/i);
      expect(dialog).toHaveTextContent(/withdrew about 100\.000000 USDC/i);
      expect(explorerLinks()).toEqual([EXPLORER_LINK]);
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('shows the cash its check before the signature found, never the reviewed cash, while the wallet has the request', () => {
      renderModal({
        ...inReview(),
        phase: 'signing',
        steps: [{ status: 'awaiting-signature' }],
        rechecked: PARTIAL_RECHECKED,
      });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('Withdraw about 100.049975 USDC from the wrapper to your wallet.');
      expect(within(dialog).getByTestId('wrapped-withdraw-cash')).toHaveTextContent('100.049975 USDC');
      expect(within(dialog).getByTestId('wrapped-withdraw-gross')).toHaveTextContent('100.049978 USDC');
      expect(within(dialog).getByTestId('wrapped-withdraw-buffer')).toHaveTextContent('0.000003 USDC');
      expect(within(dialog).getByTestId('wrapped-withdraw-shares')).toHaveTextContent('99.950027886106918655');
      expect(within(dialog).getByRole('listitem')).toHaveTextContent('Withdraw about 100.049975 USDC from the wrapper');
      expect(dialog).not.toHaveTextContent(/about 100\.000000 USDC/);
      // The notice of a payout above the amount entered gives whole shares as the reason, which no longer holds.
      expect(dialog).not.toHaveTextContent(/you entered/);
      const alert = within(dialog).getByRole('alert');
      expect(alert).toHaveTextContent(
        /now 100\.049975 USDC, 0\.049975 USDC more than the 100\.000000 USDC you reviewed/
      );
      expect(alert).toHaveTextContent(
        /if you do not want to withdraw about this amount, reject the request in your wallet/i
      );
      expect(alert).toHaveTextContent(/the amount can still change before the transaction is mined/i);
    });

    it('no longer tells the user to reject the request once the wallet has sent the transaction', () => {
      renderModal({
        ...inReview(),
        phase: 'signing',
        steps: [{ status: 'submitted', hash: HASH }],
        rechecked: PARTIAL_RECHECKED,
      });

      const alert = within(screen.getByRole('dialog')).getByRole('alert');
      expect(alert).toHaveTextContent(
        /now 100\.049975 USDC, 0\.049975 USDC more than the 100\.000000 USDC you reviewed/
      );
      expect(alert).not.toHaveTextContent(/reject/i);
      expect(alert).toHaveTextContent(/the amount can still change before the transaction is mined/i);
    });

    it("shows a full exit's cash as its check before the signature found it, in the one alert", () => {
      renderModal({
        ...inReview({ ...FULL_REVIEW, shownCash: 250_000_000n }),
        phase: 'signing',
        steps: [{ status: 'awaiting-signature' }],
        rechecked: FULL_RECHECKED,
      });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(
        'Withdraw all your wrapped USDC, about 250.249997 USDC, from the wrapper to your wallet.'
      );
      expect(within(dialog).getByRole('listitem')).toHaveTextContent(
        'Withdraw all your wrapped USDC, about 250.249997 USDC'
      );
      expect(within(dialog).getAllByRole('alert')).toHaveLength(1);
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        /now 250\.249997 USDC, 0\.125000 USDC more than the 250\.124997 USDC you reviewed/
      );
    });

    it('shows no change alert when its check before the signature finds the reviewed cash', () => {
      renderModal({
        ...inReview(),
        phase: 'signing',
        steps: [{ status: 'awaiting-signature' }],
        rechecked: {
          quote: PARTIAL_REVIEW.quote,
          blockNumber: 101,
          description: 'Withdraw about 100.000000 USDC from the wrapper',
        },
      });

      expect(within(screen.getByRole('dialog')).queryByRole('alert')).not.toBeInTheDocument();
    });

    it('confirms success with the cash its check before the signature found', () => {
      const receipt = { transactionHash: HASH, status: 1 } as TransactionReceipt;
      renderModal({
        ...inReview(),
        phase: 'complete',
        steps: [{ status: 'confirmed', hash: HASH, receipt }],
        rechecked: PARTIAL_RECHECKED,
      });

      expect(screen.getByRole('dialog')).toHaveTextContent(/withdrew about 100\.049975 USDC/i);
    });

    it.each<[WrappedStepState, RegExp]>([
      [{ status: 'blocked', reason: 'withdraw-paused' }, /withdrawals from this market are paused/],
      [{ status: 'blocked', reason: 'exits-disabled' }, /wrapped withdrawals are closed/],
      [{ status: 'blocked', reason: 'restriction-unknown' }, /pause state could not be read/],
      [
        {
          status: 'blocked',
          reason: 'step-check-failed',
          message: 'Your wrapped balance changed since the review. Review the withdrawal again.',
        },
        /your wrapped balance changed since the review/i,
      ],
    ])('says why the exit stopped before the wallet was asked: %p', (step, text) => {
      renderModal({ ...inReview(), phase: 'stopped', steps: [step] });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(/withdrawal stopped/i);
      expect(dialog).toHaveTextContent(/nothing was sent/i);
      expect(dialog).toHaveTextContent(text);
      expect(within(dialog).getByRole('button', { name: 'Close' })).toBeEnabled();
    });

    it('says a wallet error may still go through, and to check the wallet', () => {
      renderModal({
        ...inReview(),
        phase: 'stopped',
        steps: [{ status: 'provider-failure', message: 'Internal error (-32603)' }],
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
        steps: [{ status: 'provider-failure', message, isPendingInWallet: true }],
      });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(/withdrawal stopped/i);
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
      expect(dialog).toHaveTextContent('This withdrawal stopped, and nothing more is sent from it.');
      expect(within(dialog).getByRole('button', { name: 'Close' })).toBeEnabled();
    });

    it('says the wallet refused the request before handling it, names its code, and says to reconnect', () => {
      renderModal({
        ...inReview(),
        phase: 'stopped',
        steps: [{ status: 'refused', message: 'Unauthorized (4100)' }],
      });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(/withdrawal stopped/i);
      expect(
        within(dialog).getByText(
          'Your wallet refused this request before handling it (Unauthorized (4100)), so nothing was sent. ' +
            'Disconnect and reconnect your wallet on this page, then start a new review.'
        )
      ).toBeInTheDocument();
      // Nothing was sent, so the dialog does not say that the request may still go through.
      expect(dialog).not.toHaveTextContent(/may still go through/i);
      expect(dialog).not.toHaveTextContent(/your wallet reported an error/i);
      expect(dialog).toHaveTextContent('This withdrawal stopped, and nothing more is sent from it.');
      expect(within(dialog).getByRole('button', { name: 'Close' })).toBeEnabled();
    });

    it('shows the position being read', () => {
      const identity = draftFor(PARTIAL_REVIEW).identity;
      renderModal({ phase: 'reading', identity });
      expect(screen.getByRole('dialog')).toHaveTextContent(/reading your wrapped position/i);
    });

    it('shows a refused review and closes', () => {
      const identity = draftFor(PARTIAL_REVIEW).identity;
      const message = 'The amount is more than your wrapped position pays now. Enter at most 250.124997 USDC.';
      const { onClose } = renderModal({ phase: 'read-failed', identity, message });

      expect(screen.getByRole('dialog')).toHaveTextContent(/withdrawal not ready/i);
      expect(screen.getByRole('dialog')).toHaveTextContent(message);
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('lists what was already sent when an identity change closed the withdrawal', () => {
      renderModal({
        phase: 'discarded',
        reason: 'identity-changed',
        type: 'withdraw',
        chainId: 1,
        submittedHashes: [HASH],
        isWalletRequestOpen: false,
      });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(/so this withdrawal was closed/i);
      expect(dialog).toHaveTextContent(/not cancelled/i);
      expect(explorerLinks()).toEqual([EXPLORER_LINK]);
    });

    it('says how to stop waiting for a request still open in the wallet, not to start a new review', () => {
      renderModal({
        phase: 'discarded',
        reason: 'cleared',
        type: 'withdraw',
        chainId: 1,
        submittedHashes: [],
        isWalletRequestOpen: true,
      });

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(/approving it there still sends it/i);
      expect(dialog).toHaveTextContent(/new withdrawals from this account wait until your wallet answers the request/i);
      expect(dialog).toHaveTextContent(/look for the request in your wallet app/i);
      expect(dialog).toHaveTextContent(/if it is not there, reload the page and reconnect your wallet/i);
      expect(dialog).toHaveTextContent(/you can then stop waiting for it/i);
      expect(dialog).not.toHaveTextContent(/start a new review/i);
    });

    it('Home shows the withdrawal dialog for a withdrawal only, and closes it through the wrapper lifecycle', () => {
      const action = controller(inReview());
      render(homeElement(lendingWith(action), cometState(BASE_ASSET)));

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAccessibleName('Withdraw USDC From the Wrapper');
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
      expect(action.discard).toHaveBeenCalledTimes(2);
      expect(action.confirm).not.toHaveBeenCalled();
    });

    it('Home shows only the supply dialog while a supply review is read', () => {
      const supplyIdentity = wrappedActionIdentity('supply', {
        route: routeFor(OPEN),
        account: ACCOUNT,
        chainId: 1,
        screeningStatus: 'allowed',
        provider: WALLET,
      });
      if (supplyIdentity === undefined) throw new Error('the session must have an identity');
      render(
        homeElement(lendingWith(controller({ phase: 'reading', identity: supplyIdentity })), cometState(BASE_ASSET))
      );

      const dialogs = screen.getAllByRole('dialog');
      expect(dialogs).toHaveLength(1);
      expect(dialogs[0]).toHaveAccessibleName('Checking Your Balance');
    });

    it.each<[string, WrappedActionState]>([
      ['nothing is in progress', { phase: 'idle' }],
      [
        'the user closed a withdrawal that had sent nothing',
        {
          phase: 'discarded',
          reason: 'cleared',
          type: 'withdraw',
          chainId: 1,
          submittedHashes: [],
          isWalletRequestOpen: false,
        },
      ],
    ])('Home shows no dialog when %s', (_name, state) => {
      render(homeElement(lendingWith(controller(state)), cometState(BASE_ASSET)));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('scroll lock', () => {
    /** A wrapped supply in review, which only the supply dialog shows. */
    function supplyReview(): WrappedActionState {
      const identity = wrappedActionIdentity('supply', {
        route: routeFor(OPEN),
        account: ACCOUNT,
        chainId: 1,
        screeningStatus: 'allowed',
        provider: WALLET,
      });
      if (identity === undefined) throw new Error('the session must have an identity');
      const supply = new Interface(['function supplyAndWrap(uint256 amount)']);
      return {
        phase: 'review',
        draft: {
          kind: WRAPPED_ACTION,
          id: 'draft-2',
          identity,
          amount: 1_000_000n,
          steps: [
            {
              id: 'supply',
              kind: 'supply-and-wrap',
              description: 'Supply 1.000000 USDC through the wrapper',
              request: { to: USDC_WRAPPER, data: supply.encodeFunctionData('supplyAndWrap', [1_000_000n]) },
            },
          ],
        },
        steps: [{ status: 'waiting' }],
        stepIndex: 0,
      };
    }

    it('locks no scrolling for a supply review, which it does not show', () => {
      renderModal(supplyReview());

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(document.body).not.toHaveClass('no-scroll');
    });

    it("Home keeps the supply dialog's scroll lock while the withdrawal dialog is closed", () => {
      render(homeElement(lendingWith(controller(supplyReview())), cometState(BASE_ASSET)));

      expect(screen.getByRole('dialog')).toHaveAccessibleName('Supply USDC Through the Wrapper');
      expect(document.body).toHaveClass('no-scroll');
    });
  });
});
