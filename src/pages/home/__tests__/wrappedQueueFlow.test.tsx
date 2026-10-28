import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import {
  ANCHORAGE_CONNECTOR_ID,
  buildWrappedMarketRegistry,
  HARDCODED_WRAPPED_LENDING_SOURCE,
} from '@constants/wrappedMarkets';
import * as ActionQueueContextHelpers from '@contexts/ActionQueueContext';
import * as SelectedMarketContextHelpers from '@contexts/SelectedMarketContext';
import { Web3 } from '@contexts/Web3Context';
import { STANDARD_LENDING, WrappedLending } from '@contexts/WrappedLendingContext';
import { LendingSession, resolveLendingRoute, wrappedRouteKey } from '@helpers/lendingRoute';
import { getMarket } from '@helpers/markets';
import { WrappedBlockReason } from '@helpers/wrappedActions';
import { WrappedPosition } from '@helpers/wrappedPositions';
import { useActionQueue } from '@hooks/useActionQueue';
import { Theme } from '@hooks/useThemeManager';
import { IDLE_WRAPPED_ACTION } from '@hooks/useWrappedAction';
import { ActionQueue, CometState, MarketData, StateType } from '@types';

import { mockBaseAsset } from '../../../../__tests__/mocks/mockBaseAsset';
import { mockWeb3 } from '../../../../__tests__/mocks/mockWeb3';
import { TestLendingProvider } from '../../../../__tests__/mocks/wrappedLending';
import Home from '../index';

// The masthead, the amount form, the position card and the queue are real. Only the collateral
// rows, the institutional banner and the Bulker dialogs are left out.
jest.mock('../components/AssetRow', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/InstitutionalBanner', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/ActionModal', () => ({ __esModule: true, default: () => null }));

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
const USDC_MARKET = getMarket(1, USDC_COMET) as MarketData;

const OPEN = buildWrappedMarketRegistry({
  markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({
    ...market,
    isDepositEnabled: true,
    isExitEnabled: true,
  })),
});
const SESSION: LendingSession = {
  connector: { id: ANCHORAGE_CONNECTOR_ID, uid: 'uid-1' },
  status: 'connected',
  account: ACCOUNT,
  chainId: 1,
  isWatchOnly: false,
  isSignerReady: true,
  screeningStatus: 'allowed',
};
const lookup = OPEN.lookup(1, USDC_COMET);
if (lookup.status !== 'valid') throw new Error('the mapping must be valid');
const ROUTE = resolveLendingRoute({
  market: { chainId: 1, cometAddress: USDC_COMET },
  session: SESSION,
  conflictedRdns: new Set(),
  validation: { key: wrappedRouteKey(lookup.market, SESSION), status: 'matched' },
  registry: OPEN,
});

// 250 USDC supplied through the wrapper. A full exit pays 249.999997 USDC.
const POSITION: WrappedPosition = {
  shares: 250n * 10n ** 18n,
  shareDecimals: 18,
  grossAssets: 250_000_000n,
  baseDecimals: 6,
  baseWalletBalance: 1_000_000_000n,
  wrapperAllowance: 0n,
  redeemBuffer: 3n,
  fullExitCash: 249_999_997n,
  isWithdrawPaused: false,
  snapshot: { totalSupply: 250n * 10n ** 18n, totalAssets: 250_000_000n, baseSupplyIndex: 10n ** 15n },
};

type Lending = WrappedLending & { write: { approve: jest.Mock; supply: jest.Mock; withdraw: jest.Mock } };

function lending(position: WrappedPosition | undefined): Lending {
  return {
    route: ROUTE,
    position: position === undefined ? { status: 'loading' } : { status: 'loaded', position },
    retry: jest.fn(),
    action: IDLE_WRAPPED_ACTION,
    write: { approve: jest.fn(() => undefined), supply: jest.fn(() => undefined), withdraw: jest.fn(() => undefined) },
    submission: STANDARD_LENDING.submission,
  };
}

/** The position after the user approved the wrapper for `allowance`. */
const approvedFor = (allowance: bigint): WrappedPosition => ({ ...POSITION, wrapperAllowance: allowance });

// An empty Comet account with 1,000 USDC in the wallet and no allowance to Comet.
const BASE_ASSET = mockBaseAsset({
  address: USDC,
  symbol: 'USDC',
  decimals: 6,
  balance: 0n,
  allowance: 0n,
  walletBalance: 1_000_000_000n,
  balanceOfComet: 10n ** 15n,
  price: 100_000_000n,
  baseAssetPriceInDollars: 100_000_000n,
});
const COMET_STATE = [
  StateType.Hydrated,
  {
    baseAsset: BASE_ASSET,
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

const WEB3: Web3 = {
  ...mockWeb3,
  read: { ...mockWeb3.read, account: ACCOUNT, chainId: 1 },
  write: {
    ...mockWeb3.write,
    account: ACCOUNT,
    chainId: 1,
    connector: { id: ANCHORAGE_CONNECTOR_ID, uid: 'uid-1' } as Web3['write']['connector'],
  },
};
const SELECTED = {
  selectedMarket: [StateType.Hydrated, USDC_MARKET] as const,
  selectMarket: jest.fn(),
  selectMarketByAddress: jest.fn(),
};
SelectedMarketContextHelpers.initializeContext(SELECTED as never);

function Dashboard({ value, state }: { value: WrappedLending; state: CometState }) {
  const queue = useActionQueue(SELECTED.selectedMarket as never, () => undefined, {
    account: ACCOUNT,
    connector: 'uid-1',
    status: 'connected',
  });
  ActionQueueContextHelpers.initializeContext(queue);
  const ActionQueueContext = ActionQueueContextHelpers.getActionQueueContext();
  const SelectedMarketContext = SelectedMarketContextHelpers.getSelectedMarketContext();
  return (
    <TestLendingProvider value={value} web3={WEB3} market={USDC_MARKET}>
      <SelectedMarketContext.Provider value={SELECTED as never}>
        <ActionQueueContext.Provider value={queue as ActionQueue}>
          <Home
            transactions={[]}
            web3={WEB3}
            selectedMarketData={SELECTED as never}
            cometState={state}
            addTransaction={jest.fn()}
            switchWriteNetwork={jest.fn()}
            estimatedGasMap={new Map()}
            theme={Theme.Dark}
          />
          {/* Detail sheets, such as the mobile copy of the queue, render here, after the dashboard. */}
          <div id="overlay"></div>
        </ActionQueueContext.Provider>
      </SelectedMarketContext.Provider>
    </TestLendingProvider>
  );
}

// Home trusts the Comet state for the account once it arrives while the dashboard is mounted.
function renderDashboard(value: Lending) {
  const view = render(<Dashboard value={value} state={[StateType.Loading, undefined] as never} />);
  view.rerender(<Dashboard value={value} state={COMET_STATE} />);
  return view;
}

const headline = () => screen.getByRole('heading', { level: 1 });
// The position card renders a desktop and a mobile copy of the amount form and the queue. The
// desktop copy comes first, and the mobile queue renders in the overlay after it.
const desktopQueue = () => document.querySelector('.position-card__actions') as HTMLElement;
const amountInput = () => screen.getAllByPlaceholderText('0')[0];
const formButton = (name: string) => screen.getAllByRole('button', { name })[0];

describe('the wrapped route through the normal form, queue and comparison', () => {
  beforeEach(() => {
    Object.values(mockWriteState).forEach((fn) => fn.mockReset());
  });

  it("adds a supply with Approve & Add and production's approval hint, and submits it once the wrapper is approved", async () => {
    const user = userEvent.setup();
    const value = lending(POSITION);
    const view = renderDashboard(value);

    await user.click(screen.getByRole('button', { name: 'Supply USDC' }));
    await user.type(amountInput(), '100');
    // Production's hint, without its promise that one approval is enough: the exact approval is spent.
    expect(
      screen.getAllByText('You need to approve Compound on the USDC contract before you can use this asset.')[0]
    ).toBeInTheDocument();
    expect(screen.queryByText(/You only need to do this once/)).toBeNull();
    await user.click(formButton('Approve & Add'));

    expect(value.write.approve).toHaveBeenCalledWith(100_000_000n);
    expect(mockWriteState.approve).not.toHaveBeenCalled();
    expect(within(desktopQueue()).getByText('Supply USDC')).toBeInTheDocument();
    // Until the allowance covers it, the row says so and Submit waits, as production's does.
    expect(within(desktopQueue()).getByText('Approval Failed')).toBeInTheDocument();
    expect(within(desktopQueue()).getByRole('button', { name: 'Submit Transaction' })).toBeDisabled();
    expect(screen.queryByRole('dialog')).toBeNull();

    // The approval confirms.
    const approved = lending(approvedFor(100_000_000n));
    view.rerender(<Dashboard value={approved} state={COMET_STATE} />);
    expect(within(desktopQueue()).queryByText('Approval Failed')).toBeNull();

    // Raising the amount above the allowance asks for an increase, as production's form does.
    await user.click(within(desktopQueue()).getByText('Supply USDC'));
    const input = amountInput();
    await user.clear(input);
    await user.type(input, '150');
    expect(
      screen.getAllByText(
        'This amount exceeds the allowance you previously set for this asset. You will be asked to approve an increase when you add this action.'
      )[0]
    ).toBeInTheDocument();
    expect(formButton('Approve & Add')).toBeEnabled();
    await user.clear(input);
    await user.type(input, '100');
    await user.click(formButton('Update Action'));

    await user.click(within(desktopQueue()).getByRole('button', { name: 'Submit Transaction' }));
    expect(approved.write.supply).toHaveBeenCalledWith(100_000_000n);
    expect(approved.write.approve).not.toHaveBeenCalled();
    expect(mockWriteState.supply).not.toHaveBeenCalled();
    expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('adds, edits, removes and clears a base supply, and submits it through the wrapper', async () => {
    const user = userEvent.setup();
    const value = lending(approvedFor(1_000_000_000n));
    renderDashboard(value);

    // The wrapped position is the base balance, before any action.
    expect(headline()).toHaveTextContent('250.00');
    expect(document.querySelector('.wrapped-position-panel')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Supply USDC' }));
    await user.type(amountInput(), '100');
    await user.click(formButton('Add Action'));
    expect(mockWriteState.approve).not.toHaveBeenCalled();
    expect(value.write.approve).not.toHaveBeenCalled();

    expect(within(desktopQueue()).getByText('Supply USDC')).toBeInTheDocument();
    expect(within(desktopQueue()).getByText('100.0000')).toBeInTheDocument();
    // After the queued supply, the balance is 350 USDC; before it, 250 USDC.
    expect(screen.getByText('After Transaction')).toBeInTheDocument();
    expect(headline()).toHaveTextContent('350.00');

    // Edit the queued supply.
    await user.click(within(desktopQueue()).getByText('Supply USDC'));
    const input = amountInput();
    await user.clear(input);
    await user.type(input, '200');
    await user.click(formButton('Update Action'));
    expect(within(desktopQueue()).getByText('200.0000')).toBeInTheDocument();
    expect(headline()).toHaveTextContent('450.00');

    // Remove it.
    fireEvent.click(desktopQueue().querySelector('.action-queue-item__remove-button') as Element);
    expect(desktopQueue()).toBeNull();
    expect(headline()).toHaveTextContent('250.00');

    // Queue it again, and clear the queue.
    await user.click(screen.getByRole('button', { name: 'Supply USDC' }));
    await user.type(amountInput(), '200');
    await user.click(formButton('Add Action'));
    await user.click(within(desktopQueue()).getByText('Clear All'));
    expect(desktopQueue()).toBeNull();

    // Queue it once more and submit it.
    await user.click(screen.getByRole('button', { name: 'Supply USDC' }));
    await user.type(amountInput(), '200');
    await user.click(formButton('Add Action'));
    await user.click(within(desktopQueue()).getByRole('button', { name: 'Submit Transaction' }));

    expect(value.write.supply).toHaveBeenCalledWith(200_000_000n);
    expect(mockWriteState.supply).not.toHaveBeenCalled();
    expect(mockWriteState.invokeBulker).not.toHaveBeenCalled();
  });

  it.each<[WrappedBlockReason, string]>([
    ['transaction-pending', 'Earlier Request Still Pending'],
    ['session-unusable', 'Not Sent, Try Again'],
  ])('labels the real queue row when Submit is refused with %s, and keeps Submit enabled', async (refusal, label) => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const user = userEvent.setup();
    const value = lending(approvedFor(1_000_000_000n));
    value.write.supply.mockReturnValue(refusal);
    renderDashboard(value);

    await user.click(screen.getByRole('button', { name: 'Supply USDC' }));
    await user.type(amountInput(), '100');
    await user.click(formButton('Add Action'));
    await user.click(within(desktopQueue()).getByRole('button', { name: 'Submit Transaction' }));

    expect(within(desktopQueue()).getByText(label)).toBeInTheDocument();
    expect(within(desktopQueue()).getByRole('button', { name: 'Submit Transaction' })).toBeEnabled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('queues a full withdrawal of the wrapped position with Max and submits it as a full exit', async () => {
    const user = userEvent.setup();
    const value = lending(POSITION);
    renderDashboard(value);

    await user.click(screen.getByRole('button', { name: 'Withdraw USDC' }));
    await user.click(formButton('Max'));
    await user.click(formButton('Add Action'));

    expect(within(desktopQueue()).getByText('Withdraw USDC')).toBeInTheDocument();
    expect(headline()).toHaveTextContent('0.00');

    await user.click(within(desktopQueue()).getByRole('button', { name: 'Submit Transaction' }));

    expect(value.write.withdraw).toHaveBeenCalledWith({ kind: 'full' });
    expect(mockWriteState.withdraw).not.toHaveBeenCalled();
  });

  it('shows what a full exit pays on a Max withdrawal row, and a spinner while that is not known', async () => {
    const user = userEvent.setup();
    // 10 USDC supplied to Comet directly beside the wrapped position. The dashboard shows 260 USDC
    // supplied, and a full exit through the wrapper pays 249.999997 USDC.
    const mixed = [
      COMET_STATE[0],
      { ...COMET_STATE[1], baseAsset: { ...BASE_ASSET, balance: 10_000_000n } },
    ] as unknown as CometState;
    const value = lending(POSITION);
    const view = render(<Dashboard value={value} state={[StateType.Loading, undefined] as never} />);
    view.rerender(<Dashboard value={value} state={mixed} />);

    await user.click(screen.getByRole('button', { name: 'Withdraw USDC' }));
    await user.click(formButton('Max'));
    await user.click(formButton('Add Action'));

    const row = within(desktopQueue()).getByText('Withdraw USDC').closest('.action-queue-item') as HTMLElement;
    expect(row).toHaveTextContent('250.0000');
    expect(row).not.toHaveTextContent('260.0000');

    view.rerender(<Dashboard value={lending(undefined)} state={mixed} />);

    expect(row.querySelector('.action-queue-item__balance .load-spinner--new')).not.toBeNull();
    expect(row).not.toHaveTextContent(/share/i);
    expect(row).not.toHaveTextContent('260.0000');
  });

  it('refuses a partial withdrawal above what the wrapper pays now', async () => {
    const user = userEvent.setup();
    renderDashboard(lending(POSITION));

    await user.click(screen.getByRole('button', { name: 'Withdraw USDC' }));
    await user.type(amountInput(), '250');

    expect(screen.getAllByText('Amount Exceeds Withdrawable Balance')[0]).toBeInTheDocument();
    expect(formButton('Add Action')).toBeDisabled();
  });

  it('offers no withdrawal until the wrapped position is read', () => {
    renderDashboard(lending(undefined));
    act(() => undefined);

    expect(screen.queryByRole('button', { name: 'Withdraw USDC' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Supply USDC' })).toBeEnabled();
  });
});
