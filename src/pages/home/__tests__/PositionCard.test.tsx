import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import * as SelectedMarketContextHelpers from '@contexts/SelectedMarketContext';
import { getMarket } from '@helpers/markets';
import { Theme } from '@hooks/useThemeManager';
import { Action, ActionType, MarketData, StateType } from '@types';

import { mockBaseAsset } from '../../../../__tests__/mocks/mockBaseAsset';
import PositionCard, { PositionCardNotice } from '../components/PositionCard';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_MARKET = getMarket(1, '0xc3d688B66703497DAA19211EEdff47f25384cdc3') as MarketData;
SelectedMarketContextHelpers.initializeContext({
  selectedMarket: [StateType.Hydrated, USDC_MARKET],
  selectMarket: jest.fn(),
  selectMarketByAddress: jest.fn(),
} as never);

const BASE_ASSET = mockBaseAsset({ address: USDC, symbol: 'USDC', decimals: 6, walletBalance: 1_000_000_000n });

function renderCard(queueNotice: PositionCardNotice | undefined) {
  const actions: Action[] = [[ActionType.Supply, BASE_ASSET, 100_000_000n]];
  render(
    <>
      <PositionCard
        state={[
          StateType.Hydrated,
          {
            actions,
            approvalTransactions: [],
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
            queueNotice,
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
}

describe('the position card queue notice', () => {
  it('says why the queue is held', () => {
    const message = 'Your USDC supply is pending on Ethereum. The queue stays as it is until it settles.';
    renderCard({ message });

    // The desktop and the mobile copy of the queue each show it.
    expect(screen.getAllByRole('status')[0]).toHaveTextContent(message);
    expect(screen.queryByRole('button', { name: 'Show Progress' })).toBeNull();
  });

  it("offers the notice's action", () => {
    const onAction = jest.fn();
    renderCard({ message: 'Your USDC supply is in progress.', actionLabel: 'Show Progress', onAction });

    fireEvent.click(screen.getAllByRole('button', { name: 'Show Progress' })[0]);

    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('shows no notice while the queue is not held', () => {
    renderCard(undefined);

    expect(screen.queryByRole('status')).toBeNull();
  });
});
