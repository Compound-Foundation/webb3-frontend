import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import * as SelectedMarketContextHelpers from '@contexts/SelectedMarketContext';
import { ActionRules, WrappedBaseRules } from '@helpers/actions';
import { getMarket } from '@helpers/markets';
import { MAX_UINT256 } from '@helpers/numbers';
import { Theme } from '@hooks/useThemeManager';
import { Action, ActionType, MarketData, StateType, Transaction, TransactionState } from '@types';

import { mockBaseAsset } from '../../../../__tests__/mocks/mockBaseAsset';
import PositionCard from '../components/PositionCard';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_MARKET = getMarket(1, '0xc3d688B66703497DAA19211EEdff47f25384cdc3') as MarketData;
SelectedMarketContextHelpers.initializeContext({
  selectedMarket: [StateType.Hydrated, USDC_MARKET],
  selectMarket: jest.fn(),
  selectMarketByAddress: jest.fn(),
} as never);

const BASE_ASSET = mockBaseAsset({
  address: USDC,
  symbol: 'USDC',
  decimals: 6,
  balance: 250_000_000n,
  walletBalance: 1_000_000_000n,
  balanceOfComet: 10n ** 15n,
});
const SUPPLY: Action = [ActionType.Supply, BASE_ASSET, 100_000_000n];

/** The wrapped route's rules, with the allowance to the wrapper covering a 100 USDC supply. */
const WRAPPED: WrappedBaseRules = {
  supplyBlockedReason: undefined,
  withdrawBlockedReason: undefined,
  maxPartialWithdrawal: 249_990_000n,
  canWithdrawAll: true,
  fullExitCash: 249_990_000n,
  supplyAllowance: 100_000_000n,
};

function transaction(state: TransactionState, key: string): Transaction {
  const base = { id: 'id-1', key, networkId: 1, networkName: 'homestead', description: 'Supply USDC', nonce: 1 };
  return state === TransactionState.Pending
    ? { ...base, state, hash: `0x${'1'.repeat(64)}` }
    : { ...base, state: TransactionState.AwaitingConfirmation };
}

function renderCard({
  actions = [SUPPLY],
  rules = {},
  approvalTransactions = [],
  blocking,
}: {
  actions?: Action[];
  rules?: Partial<WrappedBaseRules>;
  approvalTransactions?: Transaction[];
  blocking?: Transaction;
} = {}) {
  const actionRules: ActionRules = { wrappedBase: { ...WRAPPED, ...rules } };
  const view = render(
    <>
      <PositionCard
        state={[
          StateType.Hydrated,
          {
            actions,
            approvalTransactions,
            baseAsset: BASE_ASSET,
            baseAssetPost: BASE_ASSET,
            borrowAPR: 0n,
            collateralAssets: [],
            collateralValue: 0n,
            collateralValuePost: 0n,
            earnAPR: 0n,
            liquidationCapacity: 0n,
            liquidationCapacityPost: 0n,
            theme: Theme.Dark,
            actionRules,
            transaction: blocking,
            onClearClicked: jest.fn(),
            onCompareClicked: jest.fn(),
            onDeleteAction: jest.fn(),
            onPendingActionCancel: jest.fn(),
            onPendingActionConfirm: jest.fn(),
            onPendingActionUpdateAmount: jest.fn(),
            onSelectAction: jest.fn(),
            onSubmitClicked: jest.fn(),
          },
        ]}
      />
      {/* The mobile copy of the queue renders here. */}
      <div id="overlay"></div>
    </>
  );
  // The desktop copy of the queue.
  const desktop = view.container.querySelector('.position-card__actions') as HTMLElement;
  const submit = () => desktop.querySelector('.position-card__button-row button') as HTMLButtonElement;
  return { ...view, desktop, submit };
}

describe('the position card queue on the wrapped route', () => {
  it("shows a queued supply as production does, once the wrapper's allowance covers it", () => {
    const { desktop, submit } = renderCard();

    expect(desktop).toHaveTextContent('1 Pending Actions');
    expect(desktop).toHaveTextContent('Supply USDC');
    expect(desktop).toHaveTextContent('Clear All');
    expect(submit()).toHaveTextContent('Submit Transaction');
    expect(submit()).toBeEnabled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it("shows Approval Pending on the supply's row while its approval of the wrapper is pending", () => {
    const approval = { ...transaction(TransactionState.Pending, USDC), description: 'Enable USDC' };
    const { desktop, submit } = renderCard({ rules: { supplyAllowance: 0n }, approvalTransactions: [approval] });

    expect(desktop).toHaveTextContent('Approval Pending');
    expect(submit()).toHaveTextContent('Submit Transaction');
    expect(submit()).toBeDisabled();
  });

  it('says Approval Failed on the row, as production does, when the allowance to the wrapper does not cover it', () => {
    const { desktop, submit } = renderCard({ rules: { supplyAllowance: 99_999_999n } });

    expect(desktop).toHaveTextContent('Approval Failed');
    expect(submit()).toBeDisabled();
  });

  it.each<[TransactionState, string]>([
    [TransactionState.AwaitingConfirmation, 'Confirm Transaction'],
    [TransactionState.Pending, 'Transaction Pending...'],
  ])('shows a wrapper transaction %s as production shows a Comet one: %s', (state, label) => {
    const { desktop, submit } = renderCard({ blocking: transaction(state, '0xwrapper') });

    expect(submit()).toHaveTextContent(label);
    expect(submit()).toBeDisabled();
    expect(desktop).not.toHaveTextContent('Clear All');
  });

  it('labels a wrapper action that stopped with nothing sent, and leaves Submit enabled to send it again', () => {
    const { desktop, submit } = renderCard({ rules: { stopped: { action: SUPPLY, label: 'Not Sent, Try Again' } } });

    expect(desktop).toHaveTextContent('Not Sent, Try Again');
    expect(submit()).toBeEnabled();
  });

  it("shows a Max withdrawal as the full exit's cash, and a spinner while that is not known, never a share count", () => {
    const max: Action = [ActionType.Withdraw, BASE_ASSET, MAX_UINT256];
    const loaded = renderCard({ actions: [max] });
    expect(loaded.desktop).toHaveTextContent('Withdraw USDC');
    expect(loaded.desktop).toHaveTextContent('249.9900');
    loaded.unmount();

    const unknown = renderCard({ actions: [max], rules: { fullExitCash: undefined, maxPartialWithdrawal: undefined } });
    expect(unknown.desktop.querySelector('.action-queue-item__balance .load-spinner--new')).not.toBeNull();
    expect(unknown.desktop).not.toHaveTextContent(/share/i);
    expect(unknown.submit()).toBeDisabled();
  });
});
