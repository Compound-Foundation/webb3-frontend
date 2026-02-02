import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import '@testing-library/jest-dom';

import { MAX_UINT256 } from '@helpers/numbers';
import {
  Action,
  ActionType,
  BaseAssetWithAccountState,
  MarketData,
  PendingAction,
  TokenWithAccountState,
} from '@types';

import {
  mockPendingBaseAction,
  mockPendingSupplyCollateralAction,
  mockPendingWithdrawCollateralAction,
} from '../../../../__tests__/mocks/mockAction';
import { mockBaseAsset } from '../../../../__tests__/mocks/mockBaseAsset';
import { mockEthCollateralAsset } from '../../../../__tests__/mocks/mockCollateralAssets';
import { mockMarket } from '../../../../__tests__/mocks/mockMarket';
import ActionInputView from '../components/ActionInputView';

type WrappedActionInputViewProps = {
  actions: Action[];
  baseAsset: BaseAssetWithAccountState;
  collateralAssets: TokenWithAccountState[];
  initialValue?: [string, boolean];
  pendingAction: PendingAction;
  market: MarketData;
  onCancel: () => void;
  onConfirm: () => void;
};
/**
 * Lightweight wrapper around ActionInputView to allow for state management
 */
const WrappedActionInputView = ({ pendingAction: initialPendingAction, ...props }: WrappedActionInputViewProps) => {
  const [pendingAction, setPendingAction] = useState<PendingAction>(initialPendingAction);

  const setPendingActionAmount = (amount?: bigint) => {
    const newPendingAction: PendingAction = [...pendingAction];
    // Withdraw collateral is the only action that puts the amount in the third position
    if (pendingAction[0] === ActionType.WithdrawCollateral) {
      newPendingAction[3] = amount ?? 0n;
    } else {
      newPendingAction[2] = amount ?? 0n;
    }
    setPendingAction(newPendingAction);
  };

  return <ActionInputView {...props} pendingAction={pendingAction} setPendingActionAmount={setPendingActionAmount} />;
};

/**
 * The full suite of possible errors shown in the ActionInputView has been tested
 * with unit tests. Thus this integration test does not need to cover all cases again
 */

describe('ActionInputView', () => {
  let baseAsset: BaseAssetWithAccountState;
  let collateralAssets: TokenWithAccountState[];
  let market: MarketData;
  let actions: Action[];
  let pendingAction: PendingAction;

  describe('Borrow', () => {
    beforeEach(() => {
      baseAsset = mockBaseAsset({
        balance: 0n,
        walletBalance: 20_000_000_000n,
      });
      collateralAssets = [
        mockEthCollateralAsset({
          balance: BigInt(10e18), // 10 ETH
        }),
      ];
      market = mockMarket();
      actions = [];
      pendingAction = mockPendingBaseAction({
        actionType: ActionType.Borrow,
      });
    });

    it('adds a borrow action successfully', async () => {
      const user = userEvent.setup();
      const onConfirm = jest.fn();
      const onCancel = jest.fn();

      const { getByText, getByPlaceholderText } = render(
        <WrappedActionInputView
          actions={actions}
          baseAsset={baseAsset}
          collateralAssets={collateralAssets}
          initialValue={undefined}
          pendingAction={pendingAction}
          market={market}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      await user.type(getByPlaceholderText('0'), '1000');

      expect(getByText('Borrow USDC')).toBeInTheDocument();
      expect(getByText('Add Action')).toBeEnabled();
      expect(getByText('Cancel')).toBeEnabled();

      await user.click(getByText('Add Action'));
      expect(onConfirm).toHaveBeenCalledWith(1000000000n, 'Borrow 1,000 USDC');

      await user.click(getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });

    it('clicking max works as expected', async () => {
      const user = userEvent.setup();
      const onConfirm = jest.fn();
      const onCancel = jest.fn();

      const { getByText, getByPlaceholderText } = render(
        <WrappedActionInputView
          actions={actions}
          baseAsset={baseAsset}
          collateralAssets={collateralAssets}
          initialValue={undefined}
          pendingAction={pendingAction}
          market={market}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      await user.click(getByText('Max'));
      // The max borrow given 10Eth collateral at the mock prices
      expect(getByPlaceholderText('0')).toHaveValue('15,467.708097');
      expect(getByText('Add Action')).toBeEnabled();
      expect(getByText('Cancel')).toBeEnabled();

      await user.click(getByText('Add Action'));
      expect(onConfirm).toHaveBeenCalledWith(MAX_UINT256, 'Borrow 15,467.708097 USDC');

      await user.click(getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });

    it('shows an error message as expected', async () => {
      const user = userEvent.setup();
      const onConfirm = jest.fn();
      const onCancel = jest.fn();

      const { getByText, getByPlaceholderText } = render(
        <WrappedActionInputView
          actions={actions}
          baseAsset={baseAsset}
          collateralAssets={collateralAssets}
          initialValue={undefined}
          pendingAction={pendingAction}
          market={market}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      await user.type(getByPlaceholderText('0'), '10000000');

      expect(getByText('Amount Exceeds Borrow Capacity')).toBeInTheDocument();
      expect(getByText('Add Action')).toBeDisabled();
      expect(getByText('Cancel')).toBeEnabled();

      await user.click(getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });
  });

  describe('Supply', () => {
    beforeEach(() => {
      baseAsset = mockBaseAsset({
        balance: 0n,
        walletBalance: 20_000_000_000n,
      });
      collateralAssets = [mockEthCollateralAsset()];
      market = mockMarket();
      actions = [];
      pendingAction = mockPendingBaseAction({
        actionType: ActionType.Supply,
      });
    });

    it('adds a supply action successfully', async () => {
      const user = userEvent.setup();
      const onConfirm = jest.fn();
      const onCancel = jest.fn();

      const { getByText, getByPlaceholderText } = render(
        <WrappedActionInputView
          actions={actions}
          baseAsset={baseAsset}
          collateralAssets={collateralAssets}
          initialValue={undefined}
          pendingAction={pendingAction}
          market={market}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      await user.type(getByPlaceholderText('0'), '1000');

      expect(getByText('Supply USDC')).toBeInTheDocument();
      expect(getByText('Add Action')).toBeEnabled();
      expect(getByText('Cancel')).toBeEnabled();

      await user.click(getByText('Add Action'));
      expect(onConfirm).toHaveBeenCalledWith(1000000000n, 'Supply 1,000 USDC');

      await user.click(getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });

    it('clicking max works as expected', async () => {
      const user = userEvent.setup();
      const onConfirm = jest.fn();
      const onCancel = jest.fn();

      const { getByText, getByPlaceholderText } = render(
        <WrappedActionInputView
          actions={actions}
          baseAsset={baseAsset}
          collateralAssets={collateralAssets}
          initialValue={undefined}
          pendingAction={pendingAction}
          market={market}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      await user.click(getByText('Max'));
      expect(getByPlaceholderText('0')).toHaveValue('20,000');
      expect(getByText('Add Action')).toBeEnabled();
      expect(getByText('Cancel')).toBeEnabled();

      await user.click(getByText('Add Action'));
      expect(onConfirm).toHaveBeenCalledWith(MAX_UINT256, 'Supply 20,000 USDC');

      await user.click(getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });

    it('shows an error message as expected', async () => {
      const user = userEvent.setup();
      const onConfirm = jest.fn();
      const onCancel = jest.fn();

      const { getByText, getByPlaceholderText } = render(
        <WrappedActionInputView
          actions={actions}
          baseAsset={baseAsset}
          collateralAssets={collateralAssets}
          initialValue={undefined}
          pendingAction={pendingAction}
          market={market}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      await user.type(getByPlaceholderText('0'), '10000000');

      expect(getByText('Amount Exceeds Wallet Balance')).toBeInTheDocument();
      expect(getByText('Add Action')).toBeDisabled();
      expect(getByText('Cancel')).toBeEnabled();

      await user.click(getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });
  });

  describe('Repay', () => {
    beforeEach(() => {
      baseAsset = mockBaseAsset({
        balance: -10_000_000_000n,
        walletBalance: 20_000_000_000n,
      });
      collateralAssets = [mockEthCollateralAsset()];
      market = mockMarket();
      actions = [];
      pendingAction = mockPendingBaseAction({
        actionType: ActionType.Repay,
      });
    });

    it('adds a repay action successfully', async () => {
      const user = userEvent.setup();
      const onConfirm = jest.fn();
      const onCancel = jest.fn();

      const { getByText, getByPlaceholderText } = render(
        <WrappedActionInputView
          actions={actions}
          baseAsset={baseAsset}
          collateralAssets={collateralAssets}
          initialValue={undefined}
          pendingAction={pendingAction}
          market={market}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      await user.type(getByPlaceholderText('0'), '1000');

      expect(getByText('Repay USDC')).toBeInTheDocument();
      expect(getByText('Add Action')).toBeEnabled();
      expect(getByText('Cancel')).toBeEnabled();

      await user.click(getByText('Add Action'));
      expect(onConfirm).toHaveBeenCalledWith(1000000000n, 'Repay 1,000 USDC');

      await user.click(getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });

    it('clicking max works as expected', async () => {
      const user = userEvent.setup();
      const onConfirm = jest.fn();
      const onCancel = jest.fn();

      const { getByText, getByPlaceholderText } = render(
        <WrappedActionInputView
          actions={actions}
          baseAsset={baseAsset}
          collateralAssets={collateralAssets}
          initialValue={undefined}
          pendingAction={pendingAction}
          market={market}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      await user.click(getByText('Max'));
      expect(getByPlaceholderText('0')).toHaveValue('10,000');
      expect(getByText('Add Action')).toBeEnabled();
      expect(getByText('Cancel')).toBeEnabled();

      await user.click(getByText('Add Action'));
      expect(onConfirm).toHaveBeenCalledWith(MAX_UINT256, 'Repay 10,000 USDC');

      await user.click(getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });

    it('shows an error message as expected', async () => {
      const user = userEvent.setup();
      const onConfirm = jest.fn();
      const onCancel = jest.fn();

      const { getByText, getByPlaceholderText } = render(
        <WrappedActionInputView
          actions={actions}
          baseAsset={baseAsset}
          collateralAssets={collateralAssets}
          initialValue={undefined}
          pendingAction={pendingAction}
          market={market}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      await user.type(getByPlaceholderText('0'), '10000000');

      expect(getByText('Repay USDC')).toBeInTheDocument();
      expect(getByText('Amount Exceeds Wallet Balance')).toBeInTheDocument();
      expect(getByText('Add Action')).toBeDisabled();
      expect(getByText('Cancel')).toBeEnabled();

      await user.click(getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });
  });

  describe('Withdraw', () => {
    beforeEach(() => {
      baseAsset = mockBaseAsset({
        balance: 10_000_000_000n,
        walletBalance: 20_000_000_000n,
      });
      collateralAssets = [mockEthCollateralAsset()];
      market = mockMarket();
      actions = [];
      pendingAction = mockPendingBaseAction({
        actionType: ActionType.Withdraw,
      });
    });

    it('adds a withdraw action successfully', async () => {
      const user = userEvent.setup();
      const onConfirm = jest.fn();
      const onCancel = jest.fn();

      const { getByText, getByPlaceholderText } = render(
        <WrappedActionInputView
          actions={actions}
          baseAsset={baseAsset}
          collateralAssets={collateralAssets}
          initialValue={undefined}
          pendingAction={pendingAction}
          market={market}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      await user.type(getByPlaceholderText('0'), '1000');

      expect(getByText('Withdraw USDC')).toBeInTheDocument();
      expect(getByText('Add Action')).toBeEnabled();
      expect(getByText('Cancel')).toBeEnabled();

      await user.click(getByText('Add Action'));
      expect(onConfirm).toHaveBeenCalledWith(1000000000n, 'Withdraw 1,000 USDC');

      await user.click(getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });

    it('clicking max works as expected', async () => {
      const user = userEvent.setup();
      const onConfirm = jest.fn();
      const onCancel = jest.fn();

      const { getByText, getByPlaceholderText } = render(
        <WrappedActionInputView
          actions={actions}
          baseAsset={baseAsset}
          collateralAssets={collateralAssets}
          initialValue={undefined}
          pendingAction={pendingAction}
          market={market}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      await user.click(getByText('Max'));
      expect(getByPlaceholderText('0')).toHaveValue('10,000');
      expect(getByText('Add Action')).toBeEnabled();
      expect(getByText('Cancel')).toBeEnabled();

      await user.click(getByText('Add Action'));
      expect(onConfirm).toHaveBeenCalledWith(MAX_UINT256, 'Withdraw 10,000 USDC');

      await user.click(getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });

    it('shows an error message as expected', async () => {
      const user = userEvent.setup();
      const onConfirm = jest.fn();
      const onCancel = jest.fn();

      const { getByText, getByPlaceholderText } = render(
        <WrappedActionInputView
          actions={actions}
          baseAsset={baseAsset}
          collateralAssets={collateralAssets}
          initialValue={undefined}
          pendingAction={pendingAction}
          market={market}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      await user.type(getByPlaceholderText('0'), '10000000');

      expect(getByText('Amount Exceeds Balance')).toBeInTheDocument();
      expect(getByText('Add Action')).toBeDisabled();
      expect(getByText('Cancel')).toBeEnabled();

      await user.click(getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });
  });

  describe('SupplyCollateral', () => {
    beforeEach(() => {
      baseAsset = mockBaseAsset({
        balance: 0n,
      });
      collateralAssets = [mockEthCollateralAsset({ walletBalance: BigInt(10e18) })];
      market = mockMarket();
      actions = [];
      pendingAction = mockPendingSupplyCollateralAction();
    });

    it('adds a supply collateral action successfully', async () => {
      const user = userEvent.setup();
      const onConfirm = jest.fn();
      const onCancel = jest.fn();

      const { getByText, getByPlaceholderText } = render(
        <WrappedActionInputView
          actions={actions}
          baseAsset={baseAsset}
          collateralAssets={collateralAssets}
          initialValue={undefined}
          pendingAction={pendingAction}
          market={market}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      await user.type(getByPlaceholderText('0'), '5');

      expect(getByText('Supply ETH')).toBeInTheDocument();
      expect(getByText('Add Action')).toBeEnabled();
      expect(getByText('Cancel')).toBeEnabled();

      await user.click(getByText('Add Action'));
      expect(onConfirm).toHaveBeenCalledWith(BigInt(5 * 1e18), 'Supply 5 ETH');

      await user.click(getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });

    it('clicking max works as expected', async () => {
      const user = userEvent.setup();
      const onConfirm = jest.fn();
      const onCancel = jest.fn();

      const { getByText, getByPlaceholderText } = render(
        <WrappedActionInputView
          actions={actions}
          baseAsset={baseAsset}
          collateralAssets={collateralAssets}
          initialValue={undefined}
          pendingAction={pendingAction}
          market={market}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      await user.click(getByText('Max'));
      expect(getByPlaceholderText('0')).toHaveValue('10');
      expect(getByText('Add Action')).toBeEnabled();
      expect(getByText('Cancel')).toBeEnabled();

      await user.click(getByText('Add Action'));
      expect(onConfirm).toHaveBeenCalledWith(BigInt(10e18), 'Supply 10 ETH');

      await user.click(getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });

    it('shows an error message as expected', async () => {
      const user = userEvent.setup();
      const onConfirm = jest.fn();
      const onCancel = jest.fn();

      const { getByText, getByPlaceholderText } = render(
        <WrappedActionInputView
          actions={actions}
          baseAsset={baseAsset}
          collateralAssets={collateralAssets}
          initialValue={undefined}
          pendingAction={pendingAction}
          market={market}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      await user.type(getByPlaceholderText('0'), '100');

      expect(getByText('Amount Exceeds Wallet Balance')).toBeInTheDocument();
      expect(getByText('Add Action')).toBeDisabled();
      expect(getByText('Cancel')).toBeEnabled();

      await user.click(getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });
  });

  describe('WithdrawCollateral', () => {
    beforeEach(() => {
      baseAsset = mockBaseAsset();
      collateralAssets = [mockEthCollateralAsset({ balance: BigInt(10e18) })];
      market = mockMarket();
      actions = [];
      pendingAction = mockPendingWithdrawCollateralAction();
    });

    it('adds a withdraw collateral action successfully', async () => {
      const user = userEvent.setup();
      const onConfirm = jest.fn();
      const onCancel = jest.fn();

      const { getByText, getByPlaceholderText } = render(
        <WrappedActionInputView
          actions={actions}
          baseAsset={baseAsset}
          collateralAssets={collateralAssets}
          initialValue={undefined}
          pendingAction={pendingAction}
          market={market}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      await user.type(getByPlaceholderText('0'), '10');

      expect(getByText('Withdraw ETH')).toBeInTheDocument();
      expect(getByText('Add Action')).toBeEnabled();
      expect(getByText('Cancel')).toBeEnabled();

      await user.click(getByText('Add Action'));
      expect(onConfirm).toHaveBeenCalledWith(BigInt(10e18), 'Withdraw 10 ETH');

      await user.click(getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });

    it('clicking max works as expected', async () => {
      const user = userEvent.setup();
      const onConfirm = jest.fn();
      const onCancel = jest.fn();

      const { getByText, getByPlaceholderText } = render(
        <WrappedActionInputView
          actions={actions}
          baseAsset={baseAsset}
          collateralAssets={collateralAssets}
          initialValue={undefined}
          pendingAction={pendingAction}
          market={market}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      await user.click(getByText('Max'));
      // We lose some precision in the computation of the max value
      expect(getByPlaceholderText('0')).toHaveValue('9.999999999575620809');
      expect(getByText('Add Action')).toBeEnabled();
      expect(getByText('Cancel')).toBeEnabled();

      await user.click(getByText('Add Action'));
      expect(onConfirm).toHaveBeenCalledWith(9999999999575620809n, 'Withdraw 9.999999999575620809 ETH');

      await user.click(getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });

    it('shows an error message as expected', async () => {
      const user = userEvent.setup();
      const onConfirm = jest.fn();
      const onCancel = jest.fn();

      const { getByText, getByPlaceholderText } = render(
        <WrappedActionInputView
          actions={actions}
          baseAsset={baseAsset}
          collateralAssets={collateralAssets}
          initialValue={undefined}
          pendingAction={pendingAction}
          market={market}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      await user.type(getByPlaceholderText('0'), '100');

      expect(getByText('Amount Exceeds Balance')).toBeInTheDocument();
      expect(getByText('Add Action')).toBeDisabled();
      expect(getByText('Cancel')).toBeEnabled();

      await user.click(getByText('Cancel'));
      expect(onCancel).toHaveBeenCalled();
    });
  });
});
