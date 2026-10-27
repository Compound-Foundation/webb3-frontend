import { render } from '@testing-library/react';
import '@testing-library/jest-dom';

import { Action, ActionType, PendingAction, StateType } from '@types';

import { mockBaseAsset } from '../../../../__tests__/mocks/mockBaseAsset';
import { mockEthCollateralAsset } from '../../../../__tests__/mocks/mockCollateralAssets';
import AssetRow from '../components/AssetRow';

const ASSET = mockEthCollateralAsset({ walletBalance: 10n ** 18n });

function rowButtons({
  action,
  pendingAction,
  isLocked,
}: {
  action?: Action;
  pendingAction?: PendingAction;
  isLocked?: boolean;
}): HTMLButtonElement[] {
  const { container } = render(
    <AssetRow
      state={[
        StateType.Hydrated,
        {
          action,
          asset: ASSET,
          baseAsset: mockBaseAsset(),
          pendingAction,
          isLocked,
          onCancelClicked: jest.fn(),
          onEditClicked: jest.fn(),
          onSupplyClicked: jest.fn(),
          onWithdrawClicked: jest.fn(),
        },
      ]}
    />
  );
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.asset-row__actions button'));
}

describe('AssetRow while the queue is held still', () => {
  const cases: [string, { action?: Action; pendingAction?: PendingAction }][] = [
    ['Supply and Withdraw', {}],
    ['the queued action', { action: [ActionType.SupplyCollateral, ASSET, 10n ** 17n] }],
    ['the open amount form', { pendingAction: [ActionType.SupplyCollateral, ASSET, undefined] }],
  ];

  it.each(cases)('disables %s', (_, state) => {
    const buttons = rowButtons({ ...state, isLocked: true });

    expect(buttons.length).toBeGreaterThan(0);
    buttons.forEach((button) => expect(button).toBeDisabled());
  });

  it.each(cases)('leaves %s enabled otherwise', (_, state) => {
    rowButtons(state).forEach((button) => expect(button).toBeEnabled());
  });
});
