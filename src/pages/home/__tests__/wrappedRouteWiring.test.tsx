import { act, render } from '@testing-library/react';

import { WRAPPED_MARKET_REGISTRY } from '@constants/wrappedMarkets';
import * as ActionQueueContextHelpers from '@contexts/ActionQueueContext';
import * as SelectedMarketContextHelpers from '@contexts/SelectedMarketContext';
import type { Web3 } from '@contexts/Web3Context';
import { WrappedLending, WrappedLendingContext } from '@contexts/WrappedLendingContext';
import { recordCometStateSource } from '@helpers/cometStateSource';
import { LendingRoute } from '@helpers/lendingRoute';
import { getMarket } from '@helpers/markets';
import { MAX_UINT256 } from '@helpers/numbers';
import { Theme } from '@hooks/useThemeManager';
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
jest.mock('../components/WrappedPositionPanel', () => mockRecordProps('WrappedPositionPanel'));
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
  return { route, position: { status: 'loading' }, retry: jest.fn() };
}

const LOADED: WrappedLending['position'] = {
  status: 'loaded',
  position: {
    shares: 1n,
    shareDecimals: 18,
    grossAssets: 0n,
    baseDecimals: 6,
    baseWalletBalance: 0n,
    wrapperAllowance: 0n,
    redeemBuffer: 3n,
    fullExitCash: 0n,
    isWithdrawPaused: false,
    snapshot: { totalSupply: 0n, totalAssets: 0n, baseSupplyIndex: 0n },
  },
};

const STANDARD: WrappedLending = {
  route: { kind: 'standard', writes: { isEligible: true } },
  position: { status: 'not-applicable' },
  retry: jest.fn(),
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

const EMPTY_ACCOUNT = mockBaseAsset({ address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' });
const supplyAction = (asset: BaseAssetWithAccountState): Action => [ActionType.Supply, asset, 1_000_000n];

describe('Home on the wrapped route', () => {
  beforeEach(() => {
    Object.values(mockWriteState).forEach((fn) => fn.mockReset());
  });

  it('offers no direct base supply and shows no supply incentives', () => {
    render(homeElement({ lending: wrappedLending(), state: cometState(EMPTY_ACCOUNT), queue: actionQueue([]) }));

    const [, masthead] = mockLastProps.Masthead.state;
    expect(masthead.isDirectBaseSupplyBlocked).toBe(true);
    expect(masthead.earnRewardsAPR).toBe(0n);
    expect(masthead.isInstitutional).toBe(false);

    const [, positionCard] = mockLastProps.PositionCard.state;
    expect(positionCard.actionRules).toEqual({ blockDirectBaseSupply: true });
    expect(positionCard.earnRewardsAPR).toBe(0n);
    expect(positionCard.isInstitutional).toBe(false);
  });

  it('keeps the incentives a direct supply earns', () => {
    const directSupplier = { ...EMPTY_ACCOUNT, balance: 5_000_000n };
    render(homeElement({ lending: wrappedLending(), state: cometState(directSupplier), queue: actionQueue([]) }));

    const [, positionCard] = mockLastProps.PositionCard.state;
    expect(positionCard.earnRewardsAPR).toBe(12_000_000_000_000_000n);
  });

  it('ignores a request to start a base supply', () => {
    const queue = actionQueue([]);
    render(homeElement({ lending: wrappedLending(), state: cometState(EMPTY_ACCOUNT), queue }));

    const [, masthead] = mockLastProps.Masthead.state;
    masthead.onSupplyAction([ActionType.Supply, EMPTY_ACCOUNT, undefined] as PendingAction);
    expect(queue.setPendingAction).not.toHaveBeenCalled();
  });

  it('refuses to submit a queued base supply', () => {
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

  it('refuses a submit callback kept from before the route became wrapped', () => {
    const queue = actionQueue([supplyAction(EMPTY_ACCOUNT)]);
    const state = cometState(EMPTY_ACCOUNT);
    const { rerender } = render(homeElement({ lending: STANDARD, state, queue }));
    const keptSubmit = mockLastProps.PositionCard.state[1].onSubmitClicked;

    rerender(homeElement({ lending: wrappedLending(), state, queue }));
    keptSubmit();

    expect(mockWriteState.supply).not.toHaveBeenCalled();
    expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
  });

  it('shows the panel loading while the Comet state still belongs to the previous market', () => {
    const state = cometState(EMPTY_ACCOUNT, { market: USDT_MARKET });
    const loaded: WrappedLending = { ...wrappedLending(), position: LOADED };
    const { rerender } = render(
      homeElement({ lending: wrappedLending(USDT_COMET), market: USDT_MARKET, state, queue: actionQueue([]) })
    );

    rerender(homeElement({ lending: loaded, market: USDC_MARKET, state, queue: actionQueue([]) }));
    expect(mockLastProps.WrappedPositionPanel.position).toEqual({ status: 'loading' });

    rerender(
      homeElement({ lending: loaded, market: USDC_MARKET, state: cometState(EMPTY_ACCOUNT), queue: actionQueue([]) })
    );
    expect(mockLastProps.WrappedPositionPanel.position).toEqual(loaded.position);
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
    return { ...view, completeTransaction: dialog.onCompleteClicked as () => void };
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

describe('Home on the wrapped route while Comet state loads', () => {
  const LOADING: CometState = [StateType.Loading, undefined];

  beforeEach(() => {
    delete mockLastProps.WrappedPositionPanel;
  });

  it('still shows a wrapped read failure and its retry', () => {
    const failed: WrappedLending = { ...wrappedLending(), position: { status: 'error', message: 'Read failed.' } };
    render(homeElement({ lending: failed, state: LOADING, queue: actionQueue([]) }));

    expect(mockLastProps.WrappedPositionPanel.position).toEqual(failed.position);
    expect(mockLastProps.WrappedPositionPanel.onRetry).toBe(failed.retry);
  });

  it('still shows why wrapped reads are unavailable', () => {
    const unavailable: WrappedLending = {
      ...wrappedLending(),
      position: { status: 'unavailable', reason: 'validation-failed' },
    };
    render(homeElement({ lending: unavailable, state: LOADING, queue: actionQueue([]) }));

    expect(mockLastProps.WrappedPositionPanel.position).toEqual(unavailable.position);
  });

  it('holds back loaded figures until the Comet state for the market arrives', () => {
    render(homeElement({ lending: { ...wrappedLending(), position: LOADED }, state: LOADING, queue: actionQueue([]) }));

    expect(mockLastProps.WrappedPositionPanel.position).toEqual({ status: 'loading' });
    expect(mockLastProps.WrappedPositionPanel.baseAsset.symbol).toBe('USDC');
  });
});

describe('Home on the standard route', () => {
  it('keeps the direct supply and the market incentives', () => {
    render(homeElement({ lending: STANDARD, state: cometState(EMPTY_ACCOUNT), queue: actionQueue([]) }));

    const [, masthead] = mockLastProps.Masthead.state;
    expect(masthead.isDirectBaseSupplyBlocked).toBe(false);
    expect(masthead.earnRewardsAPR).toBe(12_000_000_000_000_000n);
    expect(mockLastProps.PositionCard.state[1].actionRules).toEqual({ blockDirectBaseSupply: false });
  });
});
