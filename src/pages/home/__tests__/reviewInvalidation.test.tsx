import { TransactionResponse } from '@ethersproject/providers';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { WRAPPED_MARKET_REGISTRY } from '@constants/wrappedMarkets';
import * as ActionQueueContextHelpers from '@contexts/ActionQueueContext';
import * as SelectedMarketContextHelpers from '@contexts/SelectedMarketContext';
import { Web3 } from '@contexts/Web3Context';
import { STANDARD_LENDING, WrappedLending } from '@contexts/WrappedLendingContext';
import { getKeyForActions } from '@helpers/gasEstimator';
import { getMarket } from '@helpers/markets';
import { MAX_UINT256 } from '@helpers/numbers';
import { SendWithdrawnError } from '@helpers/walletErrors';
import { Theme } from '@hooks/useThemeManager';
import type { AddTransaction } from '@hooks/useTransactionManager';
import { IDLE_WRAPPED_ACTION, WalletSessionHealth, WrappedActionController } from '@hooks/useWrappedAction';
import { IDLE_WRITE_WRAPPED_STATE } from '@hooks/useWriteWrappedState';
import {
  Action,
  ActionQueue,
  ActionType,
  CometState,
  MarketData,
  ModalType,
  PendingAction,
  StateType,
  TokenWithAccountState,
} from '@types';

import { mockBaseAsset } from '../../../../__tests__/mocks/mockBaseAsset';
import { mockCompCollateralAsset } from '../../../../__tests__/mocks/mockCollateralAssets';
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
// The add-transaction function Home gives its writes. The tests call it as the real writes do.
const mockWriteDependencies: { addTransaction?: AddTransaction } = {};
jest.mock('@hooks/useWriteCometState', () => ({
  useWriteCometState: (_web3: unknown, addTransaction: AddTransaction) => {
    mockWriteDependencies.addTransaction = addTransaction;
    return mockWriteState;
  },
}));

const ACCOUNT = '0x0000000000000000000000000000000000000aa1';
const OTHER_ACCOUNT = '0x0000000000000000000000000000000000000bb2';
const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const USDT_COMET = '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840';
const USDC_MARKET = getMarket(1, USDC_COMET) as MarketData;
const USDT_MARKET = getMarket(1, USDT_COMET) as MarketData;

const BASE_ASSET = mockBaseAsset({ address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' });
const COMP = mockCompCollateralAsset({ walletBalance: 10n ** 20n, allowance: 0n });
const BORROW: Action = [ActionType.Borrow, BASE_ASSET, 1_000_000_000n];
const SUPPLY_COMP: Action = [ActionType.SupplyCollateral, COMP, 10n ** 18n];

function web3For({
  account = ACCOUNT,
  connector = 'uid-1',
  chainId = 1,
  status = 'connected' as Web3['write']['status'],
} = {}): Web3 {
  return {
    ...mockWeb3,
    read: { ...mockWeb3.read, account, chainId: 1 },
    write: {
      ...mockWeb3.write,
      account,
      chainId,
      status,
      connector: { uid: connector } as Web3['write']['connector'],
    },
  };
}

function cometState(isBulkerAllowed: boolean): CometState {
  return [
    StateType.Hydrated,
    {
      baseAsset: BASE_ASSET,
      borrowAPR: 0n,
      collateralAssets: [COMP],
      collateralValue: 0n,
      earnAPR: 0n,
      liquidationCapacity: 0n,
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

function actionQueue(actions: Action[], pendingAction?: PendingAction): ActionQueue {
  return {
    addOrUpdateAction: jest.fn(),
    clearActions: jest.fn(),
    queueActions: jest.fn(),
    getActions: () => actions,
    getPendingAction: () => pendingAction,
    removeAction: jest.fn(),
    setPendingAction: jest.fn(),
  };
}

const STANDARD: WrappedLending = {
  route: { kind: 'standard', writes: { isEligible: true } },
  position: { status: 'not-applicable' },
  retry: jest.fn(),
  action: IDLE_WRAPPED_ACTION,
  write: IDLE_WRITE_WRAPPED_STATE,
  submission: STANDARD_LENDING.submission,
};

function wrappedLending(session: WalletSessionHealth): WrappedLending {
  const lookup = WRAPPED_MARKET_REGISTRY.lookup(1, USDC_COMET);
  if (lookup.status !== 'valid') throw new Error('the mapping must be valid');
  return {
    route: {
      kind: 'wrapped',
      chainId: 1,
      cometAddress: USDC_COMET,
      lookup,
      market: lookup.market,
      validationKey: 'key',
      reads: { isEligible: true },
      deposit: { isEligible: false, reason: 'deposits-disabled' },
      exit: { isEligible: false, reason: 'exits-disabled' },
    },
    position: { status: 'loading' },
    retry: jest.fn(),
    action: { ...IDLE_WRAPPED_ACTION, session },
    write: IDLE_WRITE_WRAPPED_STATE,
    submission: STANDARD_LENDING.submission,
  };
}

type Setup = {
  web3?: Web3;
  market?: MarketData;
  queue: ActionQueue;
  lending?: WrappedLending;
  isBulkerAllowed?: boolean;
  addTransaction?: AddTransaction;
  switchWriteNetwork?: (chainId: number) => Promise<boolean>;
  estimatedGasMap?: Map<string, number>;
};

SelectedMarketContextHelpers.initializeContext({
  selectedMarket: [StateType.Hydrated, USDC_MARKET],
  selectMarket: jest.fn(),
  selectMarketByAddress: jest.fn(),
});
ActionQueueContextHelpers.initializeContext(actionQueue([]));

function homeElement({
  web3 = web3For(),
  market = USDC_MARKET,
  queue,
  lending = STANDARD,
  isBulkerAllowed = false,
  addTransaction = jest.fn(),
  switchWriteNetwork = jest.fn(),
  estimatedGasMap = new Map(),
}: Setup) {
  const SelectedMarketContext = SelectedMarketContextHelpers.getSelectedMarketContext();
  const ActionQueueContext = ActionQueueContextHelpers.getActionQueueContext();
  const selectedMarketData = {
    selectedMarket: [StateType.Hydrated, market] as [StateType.Hydrated, MarketData],
    selectMarket: jest.fn(),
    selectMarketByAddress: jest.fn(),
  };
  return (
    <TestLendingProvider value={lending}>
      <SelectedMarketContext.Provider value={selectedMarketData}>
        <ActionQueueContext.Provider value={queue}>
          <Home
            transactions={[]}
            web3={web3}
            selectedMarketData={selectedMarketData}
            cometState={cometState(isBulkerAllowed)}
            addTransaction={addTransaction}
            switchWriteNetwork={switchWriteNetwork}
            estimatedGasMap={estimatedGasMap}
            theme={Theme.Dark}
          />
        </ActionQueueContext.Provider>
      </SelectedMarketContext.Provider>
    </TestLendingProvider>
  );
}

const positionCard = () => mockLastProps.PositionCard.state[1];
const openDialog = () => mockLastProps.ActionModal.state;

describe('Home review dialogs', () => {
  beforeEach(() => {
    Object.values(mockWriteState).forEach((fn) => fn.mockReset());
  });

  it.each<[string, Partial<Setup>]>([
    ['account', { web3: web3For({ account: OTHER_ACCOUNT }) }],
    ['connector', { web3: web3For({ connector: 'uid-2' }) }],
    ['network', { web3: web3For({ chainId: 137 }) }],
    ['connection status (a reconnect)', { web3: web3For({ status: 'reconnecting' }) }],
    ['market', { market: USDT_MARKET }],
  ])('closes the review dialog when the %s changes, and does not reopen it on return', (_change, changed) => {
    const queue = actionQueue([BORROW, SUPPLY_COMP]);
    const { rerender } = render(homeElement({ queue }));
    act(() => positionCard().onSubmitClicked());
    expect(openDialog()).toEqual([ModalType.BulkerApprove, expect.anything()]);

    rerender(homeElement({ queue, ...changed }));
    expect(openDialog()).toBeUndefined();

    rerender(homeElement({ queue }));
    expect(openDialog()).toBeUndefined();
  });

  it('keeps the dialog while nothing it belongs to changes', () => {
    const queue = actionQueue([BORROW, SUPPLY_COMP]);
    const { rerender } = render(homeElement({ queue }));
    act(() => positionCard().onSubmitClicked());

    rerender(homeElement({ queue, web3: web3For({ account: ACCOUNT.toUpperCase().replace('0X', '0x') }) }));

    expect(openDialog()).toEqual([ModalType.BulkerApprove, expect.anything()]);
  });

  it("refuses a dialog's submit kept from an earlier account", () => {
    const queue = actionQueue([BORROW, SUPPLY_COMP]);
    const { rerender } = render(homeElement({ queue }));
    act(() => positionCard().onSubmitClicked());
    const { onCompleteClicked } = openDialog()[1];

    rerender(homeElement({ queue, web3: web3For({ account: OTHER_ACCOUNT }) }));
    act(() => onCompleteClicked());

    expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
    expect(openDialog()).toBeUndefined();
  });

  it('submits from the dialog while its account is current', () => {
    const queue = actionQueue([BORROW, SUPPLY_COMP]);
    render(homeElement({ queue }));
    act(() => positionCard().onSubmitClicked());

    act(() => openDialog()[1].onCompleteClicked());

    expect(mockWriteState.invokeBulker).toHaveBeenCalledTimes(1);
  });

  it('ignores callbacks kept from an earlier visit with the same account', () => {
    const queue = actionQueue([BORROW, SUPPLY_COMP]);
    const { rerender } = render(homeElement({ queue }));
    act(() => positionCard().onSubmitClicked());
    const { onCompleteClicked: keptSubmit, onRequestClose: keptClose } = openDialog()[1];

    rerender(homeElement({ queue, web3: web3For({ account: OTHER_ACCOUNT }) }));
    rerender(homeElement({ queue }));
    act(() => positionCard().onSubmitClicked());
    expect(openDialog()).toEqual([ModalType.BulkerApprove, expect.anything()]);

    act(() => keptSubmit());
    act(() => keptClose());

    expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
    expect(openDialog()).toEqual([ModalType.BulkerApprove, expect.anything()]);
  });

  it('submits from a kept dialog with the gas estimate made after the dialog opened', () => {
    const queuedActions = [BORROW, SUPPLY_COMP];
    const actionsKey = getKeyForActions(queuedActions);
    const queue = actionQueue(queuedActions);
    // The Bulker needs the account's approval first, so the queue's estimate is 0 when the dialog opens.
    const { rerender } = render(homeElement({ queue, estimatedGasMap: new Map([[actionsKey, 0]]) }));
    act(() => positionCard().onSubmitClicked());
    const { onCompleteClicked } = openDialog()[1];

    // The approval settles, and App estimates the queue again, into a new map.
    rerender(homeElement({ queue, isBulkerAllowed: true, estimatedGasMap: new Map([[actionsKey, 451_234]]) }));
    act(() => onCompleteClicked());

    expect(mockWriteState.invokeBulker).toHaveBeenCalledTimes(1);
    expect(mockWriteState.invokeBulker.mock.calls[0][5]).toBe(451_234);
  });

  it("does not let a settled transaction's callback close another account's dialog", () => {
    const queue = actionQueue([BORROW, SUPPLY_COMP]);
    const { rerender } = render(homeElement({ queue, isBulkerAllowed: true }));
    act(() => positionCard().onSubmitClicked());
    const onSettled = mockWriteState.invokeBulker.mock.calls[0][6];

    rerender(homeElement({ queue, isBulkerAllowed: false, web3: web3For({ account: OTHER_ACCOUNT }) }));
    act(() => positionCard().onSubmitClicked());
    expect(openDialog()).toEqual([ModalType.BulkerApprove, expect.anything()]);

    act(() => onSettled({ status: 'confirmed' }));
    rerender(homeElement({ queue, isBulkerAllowed: false, web3: web3For({ account: OTHER_ACCOUNT }) }));

    expect(openDialog()).toEqual([ModalType.BulkerApprove, expect.anything()]);
  });
});

describe('Home submission guards', () => {
  const USDC_WRAPPER = '0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73';
  const WRAPPER_SHARES = { ...COMP, address: USDC_WRAPPER, symbol: 'wcUSDCv3' } as TokenWithAccountState;

  beforeEach(() => {
    Object.values(mockWriteState).forEach((fn) => fn.mockReset());
  });

  it.each<[string, Partial<Setup>]>([
    ['account', { web3: web3For({ account: OTHER_ACCOUNT }) }],
    ['connector', { web3: web3For({ connector: 'uid-2' }) }],
    ['wallet network', { web3: web3For({ chainId: 137 }) }],
    ['connection status (a reconnect)', { web3: web3For({ status: 'reconnecting' }) }],
    ['market', { market: USDT_MARKET }],
  ])(
    'ignores an amount confirmation kept from before a change of %s, and asks the wallet nothing',
    (_change, changed) => {
      const switchWriteNetwork = jest.fn();
      const pendingSupply: PendingAction = [ActionType.SupplyCollateral, COMP, 10n ** 18n];
      const queue = actionQueue([], pendingSupply);
      const { rerender } = render(homeElement({ queue, switchWriteNetwork }));
      // The amount form keeps its confirm handler from the render that opened it.
      const confirmKeptAmount = positionCard().onPendingActionConfirm;

      rerender(homeElement({ queue: actionQueue([]), switchWriteNetwork, ...changed }));
      act(() => confirmKeptAmount(10n ** 18n));

      expect(mockWriteState.approve).not.toHaveBeenCalled();
      expect(switchWriteNetwork).not.toHaveBeenCalled();
      expect(queue.addOrUpdateAction).not.toHaveBeenCalled();
    }
  );

  it.each<[string, Partial<Setup>]>([
    ['account', { web3: web3For({ account: OTHER_ACCOUNT }) }],
    ['connection status (a reconnect)', { web3: web3For({ status: 'reconnecting' }) }],
    ['wallet network', { web3: web3For({ chainId: 137 }) }],
    ['market', { market: USDT_MARKET }],
  ])('ignores faucet clicks kept from before a change of %s', (_change, changed) => {
    const queue = actionQueue([]);
    const { rerender } = render(homeElement({ queue }));
    // The base asset's faucet button is on the position card, and each collateral row has its own.
    const dripBaseAssetKept = positionCard().onDripClicked;
    const dripCollateralKept = mockLastProps.AssetRow.state[1].onDripClicked;

    rerender(homeElement({ queue, ...changed }));
    act(() => {
      dripBaseAssetKept();
      dripCollateralKept();
    });

    expect(mockWriteState.drip).not.toHaveBeenCalled();
  });

  it('asks the faucet while its visit is current', () => {
    render(homeElement({ queue: actionQueue([]) }));

    act(() => {
      positionCard().onDripClicked();
      mockLastProps.AssetRow.state[1].onDripClicked();
    });

    expect(mockWriteState.drip).toHaveBeenCalledTimes(2);
  });

  it('ignores a submit kept from before a change of wallet network, and asks for no switch', () => {
    const switchWriteNetwork = jest.fn();
    const queue = actionQueue([BORROW]);
    // The wallet is on Polygon, so a submit asks for a switch to the market's chain first.
    const { rerender } = render(homeElement({ queue, switchWriteNetwork, web3: web3For({ chainId: 137 }) }));
    const submitKeptQueue = positionCard().onSubmitClicked;

    rerender(homeElement({ queue, switchWriteNetwork }));
    act(() => submitKeptQueue());

    expect(switchWriteNetwork).not.toHaveBeenCalled();
    Object.values(mockWriteState).forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });

  describe('while the transaction manager prepares a write', () => {
    /** Simulates the manager: it reads the network and nonce, then asks the wallet, unless the write is withdrawn. */
    function preparingManager() {
      let finishPreparing: () => void = () => undefined;
      const outcomes: string[] = [];
      const addTransaction = jest.fn<ReturnType<AddTransaction>, Parameters<AddTransaction>>(
        async (_key, _description, trxFn, estimatedGas, _estimateGas, fnArgs, value) => {
          await new Promise<void>((resolve) => (finishPreparing = resolve));
          try {
            const response = await trxFn(...fnArgs, { value, gasLimit: estimatedGas });
            outcomes.push('sent');
            return response;
          } catch (error) {
            outcomes.push(error instanceof SendWithdrawnError ? 'withdrawn' : 'failed');
            return undefined;
          }
        }
      );
      return { addTransaction, outcomes, finishPreparing: () => finishPreparing() };
    }

    const walletApprove = jest.fn(async () => ({ hash: '0xapproval' } as unknown as TransactionResponse));

    beforeEach(() => {
      walletApprove.mockClear();
      // As useWriteCometState's approve does: one call to the add-transaction function Home gave it.
      mockWriteState.approve.mockImplementation(
        (spender: string, asset: string, description: string, estimatedGas: number, callback?: () => void) =>
          mockWriteDependencies.addTransaction?.(
            asset,
            description,
            walletApprove,
            estimatedGas,
            jest.fn(),
            [spender, MAX_UINT256.toString()],
            0n,
            callback
          )
      );
    });

    it.each<[string, Partial<Setup>]>([
      ['account', { web3: web3For({ account: OTHER_ACCOUNT }) }],
      ['wallet network', { web3: web3For({ chainId: 137 }) }],
      ['connection status (a reconnect)', { web3: web3For({ status: 'reconnecting' }) }],
      ['market', { market: USDT_MARKET }],
    ])(
      'withdraws an approval whose visit ends with a change of %s before the wallet is asked',
      async (_change, changed) => {
        const manager = preparingManager();
        const pendingSupply: PendingAction = [ActionType.SupplyCollateral, COMP, 10n ** 18n];
        const { rerender } = render(
          homeElement({ queue: actionQueue([], pendingSupply), addTransaction: manager.addTransaction })
        );
        act(() => positionCard().onPendingActionConfirm(10n ** 18n));
        expect(manager.addTransaction).toHaveBeenCalledTimes(1);

        rerender(homeElement({ queue: actionQueue([]), addTransaction: manager.addTransaction, ...changed }));
        await act(async () => manager.finishPreparing());

        expect(walletApprove).not.toHaveBeenCalled();
        expect(manager.outcomes).toEqual(['withdrawn']);
      }
    );

    it('asks the wallet for an approval whose visit is still current', async () => {
      const manager = preparingManager();
      const pendingSupply: PendingAction = [ActionType.SupplyCollateral, COMP, 10n ** 18n];
      const queue = actionQueue([], pendingSupply);
      const { rerender } = render(homeElement({ queue, addTransaction: manager.addTransaction }));
      act(() => positionCard().onPendingActionConfirm(10n ** 18n));

      rerender(homeElement({ queue, addTransaction: manager.addTransaction }));
      await act(async () => manager.finishPreparing());

      expect(walletApprove).toHaveBeenCalledWith(USDC_COMET, MAX_UINT256.toString(), { value: 0n, gasLimit: 0 });
      expect(manager.outcomes).toEqual(['sent']);
    });

    it('withdraws an approval once the wallet session is found unusable while it is prepared', async () => {
      const manager = preparingManager();
      const pendingSupply: PendingAction = [ActionType.SupplyCollateral, COMP, 10n ** 18n];
      const queue = actionQueue([], pendingSupply);
      const usable = wrappedLending({ status: 'usable' });
      const { rerender } = render(homeElement({ queue, lending: usable, addTransaction: manager.addTransaction }));
      act(() => positionCard().onPendingActionConfirm(10n ** 18n));

      const unusable = wrappedLending({ status: 'unusable', reason: 'provider-broken', instruction: 'Reload.' });
      rerender(homeElement({ queue, lending: unusable, addTransaction: manager.addTransaction }));
      await act(async () => manager.finishPreparing());

      expect(walletApprove).not.toHaveBeenCalled();
      expect(manager.outcomes).toEqual(['withdrawn']);
    });
  });

  it('refuses a queue holding a wrapper action whole, submitting none of it', () => {
    const queue = actionQueue([BORROW, [ActionType.SupplyCollateral, WRAPPER_SHARES, 1n]]);
    render(homeElement({ queue, isBulkerAllowed: true }));

    act(() => positionCard().onSubmitClicked());

    Object.values(mockWriteState).forEach((fn) => expect(fn).not.toHaveBeenCalled());
    expect(openDialog()).toBeUndefined();
  });

  it('submits an ordinary borrow', () => {
    render(homeElement({ queue: actionQueue([BORROW]) }));

    act(() => positionCard().onSubmitClicked());

    expect(mockWriteState.withdraw).toHaveBeenCalledTimes(1);
  });

  it('stops direct writes while the wallet session is unusable, and shows the instruction in the masthead', () => {
    const unusable: WalletSessionHealth = {
      status: 'unusable',
      reason: 'provider-broken',
      instruction: 'Reload the page and reconnect your wallet before you continue.',
    };
    const pendingSupply: PendingAction = [ActionType.SupplyCollateral, COMP, 10n ** 18n];
    render(homeElement({ queue: actionQueue([BORROW], pendingSupply), lending: wrappedLending(unusable) }));

    act(() => positionCard().onSubmitClicked());
    act(() => positionCard().onPendingActionConfirm(10n ** 18n));

    Object.values(mockWriteState).forEach((fn) => expect(fn).not.toHaveBeenCalled());
    expect(mockLastProps.Masthead.state[1].notice).toMatchObject({
      message: unusable.instruction,
      actionLabel: 'Reload',
    });
  });

  describe('a queued base supply that an earlier wrapped request holds back', () => {
    const SUPPLY: Action = [ActionType.Supply, BASE_ASSET, 1_000_000n];
    function heldBack(overrides: Partial<WrappedActionController>): WrappedLending {
      const lending = wrappedLending({ status: 'usable' });
      return {
        ...lending,
        action: { ...lending.action, ...overrides },
        write: { supply: () => 'transaction-pending', withdraw: () => 'transaction-pending' },
      };
    }
    const submit = (lending: WrappedLending) => {
      render(homeElement({ queue: actionQueue([SUPPLY]), lending }));
      act(() => positionCard().onSubmitClicked());
      return screen.getByRole('dialog');
    };

    it('offers the dismissal of earlier wrapped transactions in the submission dialog', () => {
      const dismissRecovered = jest.fn();
      const dialog = submit(heldBack({ canDismissRecovered: true, dismissRecovered }));

      fireEvent.click(within(dialog).getByRole('button', { name: 'Stop waiting' }));
      expect(dismissRecovered).toHaveBeenCalledTimes(1);
      Object.values(mockWriteState).forEach((fn) => expect(fn).not.toHaveBeenCalled());
    });

    it('says which earlier wrapped request the wallet still holds', () => {
      const dialog = submit(heldBack({ canDismissRecovered: true, isRecoveredRequestPendingInWallet: true }));

      expect(dialog).toHaveTextContent(/still has a request open for an earlier wrapped transaction/);
    });

    it("shows the wallet's answer when it refused the last wrapped request", () => {
      const dialog = submit(heldBack({ walletRefusalMessage: 'Unauthorized (4100)' }));

      expect(dialog).toHaveTextContent('Unauthorized (4100)');
    });
  });

  it("stops the dialog's operator approval once the wallet session is unusable", () => {
    const queue = actionQueue([BORROW, SUPPLY_COMP]);
    const usable = wrappedLending({ status: 'usable' });
    const { rerender } = render(homeElement({ queue, lending: usable }));
    act(() => positionCard().onSubmitClicked());
    const { onActionClicked: approveOperator } = openDialog()[1];

    act(() => approveOperator());
    expect(mockWriteState.allowOperator).toHaveBeenCalledTimes(1);

    const unusable = wrappedLending({ status: 'unusable', reason: 'chain-mismatch', instruction: 'Reload.' });
    rerender(homeElement({ queue, lending: unusable }));
    act(() => approveOperator());

    expect(mockWriteState.allowOperator).toHaveBeenCalledTimes(1);
  });

  it('allows direct writes on the wrapped route while the wallet session is usable', () => {
    const pendingSupply: PendingAction = [ActionType.SupplyCollateral, COMP, 10n ** 18n];
    render(homeElement({ queue: actionQueue([BORROW], pendingSupply), lending: wrappedLending({ status: 'usable' }) }));

    act(() => positionCard().onSubmitClicked());
    act(() => positionCard().onPendingActionConfirm(10n ** 18n));

    expect(mockWriteState.withdraw).toHaveBeenCalledTimes(1);
    expect(mockWriteState.approve).toHaveBeenCalledTimes(1);
  });
});
