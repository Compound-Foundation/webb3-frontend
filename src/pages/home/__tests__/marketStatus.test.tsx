import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import '@testing-library/jest-dom';

import { getActionQueueContext, initializeContext as initializeActionQueue } from '@contexts/ActionQueueContext';
import { getSelectedMarketContext, initializeContext as initializeSelectedMarket } from '@contexts/SelectedMarketContext';
import { Theme } from '@hooks/useThemeManager';
import {
  Action,
  ActionQueue,
  ActionType,
  CometState,
  MarketData,
  MarketStatus,
  PendingAction,
  SelectedMarketData,
  StateType,
} from '@types';

import { mockBaseAsset } from '../../../../__tests__/mocks/mockBaseAsset';
import { mockWbtcCollateralAsset } from '../../../../__tests__/mocks/mockCollateralAssets';
import { MOCK_DEFAULT_MARKET, MockMarketsProvider } from '../../../../__tests__/mocks/mockMarkets';
import { mockWeb3 } from '../../../../__tests__/mocks/mockWeb3';
import Home from '../index';

const writeState = { approve: jest.fn(), supply: jest.fn(), withdraw: jest.fn() };
jest.mock('@hooks/useWriteCometState', () => ({ useWriteCometState: () => writeState }));

beforeEach(() => jest.clearAllMocks());

const selected: SelectedMarketData = {
  selectedMarket: [StateType.Hydrated, MOCK_DEFAULT_MARKET],
  selectMarket: jest.fn(),
  selectMarketByAddress: jest.fn(),
};
initializeSelectedMarket(selected);

const MAX_UINT256 = 2n ** 256n - 1n;
const wbtc = mockWbtcCollateralAsset({ balance: 10n ** 7n, walletBalance: 10n ** 8n, allowance: MAX_UINT256 });

const makeActionQueue = (actions: Action[] = [], pendingAction?: PendingAction): ActionQueue => ({
  addOrUpdateAction: jest.fn(),
  clearActions: jest.fn(),
  queueActions: jest.fn(),
  getActions: () => actions,
  getPendingAction: () => pendingAction,
  removeAction: jest.fn(),
  setPendingAction: jest.fn(),
});
initializeActionQueue(makeActionQueue());

const cometState: CometState = [
  StateType.Hydrated,
  {
    baseAsset: mockBaseAsset(),
    borrowAPR: 0n,
    collateralAssets: [wbtc],
    earnAPR: 0n,
    totalBaseSupplyUsd: 0n,
    borrowRewardsAPR: 0n,
    supplyRewardsAPR: 0n,
    collateralValue: 0n,
    isBulkerAllowed: true,
    liquidationCapacity: 0n,
  },
];

type RenderOptions = {
  status?: MarketStatus;
  isWbtcError?: boolean;
  actions?: Action[];
  pendingAction?: PendingAction;
};

const renderHome = ({
  status = 'success',
  isWbtcError = false,
  actions,
  pendingAction,
}: RenderOptions) => {
  const SelectedMarketContext = getSelectedMarketContext();
  const ActionQueueContext = getActionQueueContext();
  const actionQueue = makeActionQueue(actions, pendingAction);
  const market: MarketData = {
    ...MOCK_DEFAULT_MARKET,
    status,
    collaterals: [{ address: wbtc.address.toLowerCase(), symbol: wbtc.symbol, status: isWbtcError ? 'error' : 'success' }],
  };
  const selectedMarketData: SelectedMarketData = { ...selected, selectedMarket: [StateType.Hydrated, market] };

  render(
    <MemoryRouter>
      <div id="overlay"></div>
      <MockMarketsProvider>
        <SelectedMarketContext.Provider value={selectedMarketData}>
          <ActionQueueContext.Provider value={actionQueue}>
            <Home
              transactions={[]}
              web3={mockWeb3}
              selectedMarketData={selectedMarketData}
              cometState={cometState}
              addTransaction={jest.fn()}
              switchWriteNetwork={jest.fn()}
              estimatedGasMap={new Map()}
              theme={Theme.Dark}
            />
          </ActionQueueContext.Provider>
        </SelectedMarketContext.Provider>
      </MockMarketsProvider>
    </MemoryRouter>
  );
  return actionQueue;
};

describe('Home — market status', () => {
  test('shows the dashboard of a market that is not in the error status', () => {
    renderHome({ status: 'partially' });
    expect(screen.getByRole('button', { name: /Supply USDC/ })).toBeEnabled();
  });

  test('shows skeletons with every button disabled when the market is in the error status', () => {
    renderHome({ status: 'error' });
    expect(screen.queryByRole('button', { name: /Supply USDC/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/in wallet/)).not.toBeInTheDocument();
    screen.getAllByRole('button').forEach((button) => expect(button).toBeDisabled());
  });
});

describe('Home — collateral status', () => {
  test('an error collateral row is marked and can be neither supplied nor withdrawn', () => {
    renderHome({ isWbtcError: true });
    const row = document.querySelector('.asset-row--error') as HTMLElement;

    expect(row).not.toBeNull();
    expect(within(row).getAllByRole('button', { name: /Supply/ })[0]).toBeDisabled();
    expect(within(row).getAllByRole('button', { name: /Withdraw/ })[0]).toBeDisabled();
  });

  test.each<[string, PendingAction]>([
    ['supply', [ActionType.SupplyCollateral, { ...wbtc, allowance: 0n }, 10n ** 7n]],
    ['withdraw', [ActionType.WithdrawCollateral, wbtc, mockBaseAsset(), 10n ** 7n]],
  ])(
    'confirming a pending %s of an error collateral neither approves nor queues it',
    async (_, pendingAction) => {
      const actionQueue = renderHome({ isWbtcError: true, pendingAction });

      // The confirm (or enable) button sits right after Cancel in the action input
      const [confirmButton] = screen
        .getAllByRole('button', { name: 'Cancel' })
        .map((cancel) => cancel.nextElementSibling);
      await userEvent.click(confirmButton as HTMLElement);

      expect(writeState.approve).not.toHaveBeenCalled();
      expect(actionQueue.addOrUpdateAction).not.toHaveBeenCalled();
    }
  );

  test.each([ActionType.SupplyCollateral, ActionType.WithdrawCollateral] as const)(
    'a queued %s of an error collateral is not submitted',
    async (actionType) => {
      renderHome({ isWbtcError: true, actions: [[actionType, wbtc, 10n ** 7n]] });

      await userEvent.click(screen.getAllByRole('button', { name: 'Submit Transaction' })[0]);

      expect(writeState.supply).not.toHaveBeenCalled();
      expect(writeState.withdraw).not.toHaveBeenCalled();
    }
  );
});
