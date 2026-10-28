import { Interface } from '@ethersproject/abi';
import { TransactionReceipt } from '@ethersproject/providers';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { BigNumber } from 'ethers';

import {
  ANCHORAGE_CONNECTOR_ID,
  buildWrappedMarketRegistry,
  HARDCODED_WRAPPED_LENDING_SOURCE,
  WrappedMarket,
} from '@constants/wrappedMarkets';
import * as ActionQueueContextHelpers from '@contexts/ActionQueueContext';
import * as SelectedMarketContextHelpers from '@contexts/SelectedMarketContext';
import { Web3 } from '@contexts/Web3Context';
import { queueScope, submissionScope, WrappedLendingContext } from '@contexts/WrappedLendingContext';
import CometAbi from '@helpers/abis/Comet';
import { LendingSession, resolveLendingRoute, wrappedRouteKey } from '@helpers/lendingRoute';
import { getMarket } from '@helpers/markets';
import { WrappedSession } from '@helpers/wrappedActions';
import { useActionQueue } from '@hooks/useActionQueue';
import { useSubmissionStore } from '@hooks/useSubmissionStore';
import { Theme } from '@hooks/useThemeManager';
import { useTransactionManager } from '@hooks/useTransactionManager';
import { useWrappedAction } from '@hooks/useWrappedAction';
import { useWriteWrappedState } from '@hooks/useWriteWrappedState';
import { Action, ActionType, CometState, MarketData, StateType, TransactionState } from '@types';

import { mockBaseAsset } from '../../../../__tests__/mocks/mockBaseAsset';
import { mockWeb3 } from '../../../../__tests__/mocks/mockWeb3';
import Home from '../index';

// uuid ships ESM only, which Jest does not load here. The transaction manager uses it.
let mockNextId = 0;
jest.mock('uuid', () => ({ v4: () => `transaction-${++mockNextId}` }));

// Home's children record their props. The submission dialog is real.
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

const ACCOUNT = '0x0000000000000000000000000000000000000aa1';
const AMOUNT = 100_000_000n;

/** The committed registry with deposits and exits open, as a release would set them. */
const OPEN = buildWrappedMarketRegistry({
  markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({
    ...market,
    isDepositEnabled: true,
    isExitEnabled: true,
  })),
});
const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const lookup = OPEN.lookup(1, USDC_COMET);
if (lookup.status !== 'valid') throw new Error('the mapping must be valid');
const MARKET: WrappedMarket = lookup.market;
const USDC_MARKET = getMarket(1, USDC_COMET) as MarketData;

const isSame = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

const CALLS = new Interface([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount)',
  'function supplyAndWrap(uint256 amount) returns (uint256 shares)',
  'function isSupplyPaused() view returns (bool)',
  'function unwrapAndWithdraw(uint256 shares) returns (uint256 amount)',
  'function totalSupply() view returns (uint256)',
  'function isWithdrawPaused() view returns (bool)',
]);
const COMET = new Interface(CometAbi);

/** What the chain holds for the account and its market. Every mined transaction is a new block. */
type Chain = {
  balance: bigint;
  allowance: bigint;
  shares: bigint;
  totalSupply: bigint;
  totalAssets: bigint;
  baseSupplyIndex: bigint;
  cometCash: bigint;
  block: number;
  /** The next mined call reverts. */
  shouldRevertNext: boolean;
};

/**
 * The wrapper holds 1,000.5 USDC for 1,000 whole shares, counting its 10^12 virtual shares, of
 * which the account holds `shares`. The supply index 1.05e15 gives a buffer of 3 base units.
 */
function chainFor({ allowance = 0n, shares = 0n } = {}): Chain {
  return {
    balance: 10_000_000_000n,
    allowance,
    shares,
    totalSupply: 1_000n * 10n ** 18n - 10n ** 12n,
    totalAssets: 1_000_500_000n,
    baseSupplyIndex: 1_050_000_000_000_000n,
    cometCash: 10n ** 15n,
    block: 100,
    shouldRevertNext: false,
  };
}

/** The cash `unwrapAndWithdraw(shares)` pays: the shares' value less the buffer. */
function exitCashAt(chain: Chain, shares: bigint): bigint {
  const worth = (shares * (chain.totalAssets + 1n)) / (chain.totalSupply + 10n ** 12n);
  const buffer = chain.baseSupplyIndex / 10n ** 15n + 2n;
  return worth <= buffer ? 0n : worth - buffer;
}

/** Mines a call as the base token and the wrapper do. Returns whether it succeeded. */
function mine(chain: Chain, { to, data }: { to: string; data: string }): boolean {
  chain.block += 1;
  if (chain.shouldRevertNext) {
    chain.shouldRevertNext = false;
    return false;
  }
  const call = CALLS.parseTransaction({ data });
  if (call.name === 'approve' && isSame(to, MARKET.baseTokenAddress) && isSame(call.args[0], MARKET.wrapperAddress)) {
    chain.allowance = BigInt(call.args[1].toString());
    return true;
  }
  if (call.name === 'supplyAndWrap' && isSame(to, MARKET.wrapperAddress)) {
    const amount = BigInt(call.args[0].toString());
    if (amount > chain.allowance || amount > chain.balance) return false;
    chain.allowance -= amount;
    chain.balance -= amount;
    chain.shares += amount * 10n ** 12n;
    return true;
  }
  if (call.name === 'unwrapAndWithdraw' && isSame(to, MARKET.wrapperAddress)) {
    const shares = BigInt(call.args[0].toString());
    const cash = exitCashAt(chain, shares);
    if (shares === 0n || shares > chain.shares || cash === 0n || cash > chain.cometCash) return false;
    chain.shares -= shares;
    chain.totalSupply -= shares;
    chain.totalAssets -= cash + 1n;
    chain.cometCash -= cash;
    chain.balance += cash;
    return true;
  }
  return false;
}

/** The configured chain's public provider, at the newest block. */
function readProviderFor(chain: Chain) {
  return {
    getBlockNumber: jest.fn(async () => chain.block),
    call: jest.fn(async ({ from, to, data }: { from?: string; to?: string; data?: string }) => {
      const call = CALLS.parseTransaction({ data: data ?? '0x' });
      if (call.name === 'isSupplyPaused' || call.name === 'isWithdrawPaused') {
        return CALLS.encodeFunctionResult(call.name, [false]);
      }
      if (call.name === 'balanceOf' && isSame(to, MARKET.baseTokenAddress) && isSame(call.args[0], ACCOUNT)) {
        return CALLS.encodeFunctionResult('balanceOf', [chain.balance]);
      }
      if (
        call.name === 'balanceOf' &&
        isSame(to, MARKET.baseTokenAddress) &&
        isSame(call.args[0], MARKET.cometAddress)
      ) {
        return CALLS.encodeFunctionResult('balanceOf', [chain.cometCash]);
      }
      if (call.name === 'allowance' && isSame(to, MARKET.baseTokenAddress)) {
        return CALLS.encodeFunctionResult('allowance', [chain.allowance]);
      }
      if (call.name === 'balanceOf' && isSame(to, MARKET.wrapperAddress) && isSame(call.args[0], ACCOUNT)) {
        return CALLS.encodeFunctionResult('balanceOf', [chain.shares]);
      }
      if (call.name === 'balanceOf' && isSame(to, MARKET.cometAddress) && isSame(call.args[0], MARKET.wrapperAddress)) {
        return CALLS.encodeFunctionResult('balanceOf', [chain.totalAssets]);
      }
      if (call.name === 'totalSupply' && isSame(to, MARKET.wrapperAddress)) {
        return CALLS.encodeFunctionResult('totalSupply', [chain.totalSupply]);
      }
      if (call.name === 'supplyAndWrap' && isSame(from, ACCOUNT)) {
        return CALLS.encodeFunctionResult('supplyAndWrap', [BigInt(call.args[0].toString()) * 10n ** 12n]);
      }
      if (call.name === 'unwrapAndWithdraw' && isSame(from, ACCOUNT)) {
        return CALLS.encodeFunctionResult('unwrapAndWithdraw', [exitCashAt(chain, BigInt(call.args[0].toString()))]);
      }
      throw new Error(`unexpected read of ${to} from ${from}`);
    }),
  };
}
// Comet's `totalsBasic` is read through the Comet ABI.
function withTotals(chain: Chain, provider: ReturnType<typeof readProviderFor>) {
  const read = provider.call.getMockImplementation();
  provider.call.mockImplementation(async (request: { from?: string; to?: string; data?: string }) => {
    if (request.data?.startsWith(COMET.getSighash('totalsBasic')) && isSame(request.to, MARKET.cometAddress)) {
      return COMET.encodeFunctionResult('totalsBasic', [
        {
          baseSupplyIndex: chain.baseSupplyIndex,
          baseBorrowIndex: 1_100_000_000_000_000n,
          trackingSupplyIndex: 0n,
          trackingBorrowIndex: 0n,
          totalSupplyBase: 0n,
          totalBorrowBase: 0n,
          lastAccrualTime: 0n,
          pauseFlags: 0n,
        },
      ]);
    }
    return (read as NonNullable<typeof read>)(request);
  });
  return provider;
}

/**
 * The wallet on `chainId`. Each request is mined as soon as it is sent, on the chain of mainnet.
 * While the test holds receipts back, a receipt lookup waits until they are released.
 */
function walletFor(chain: Chain, chainId: number) {
  let sentCount = 0;
  const receipts = new Map<string, TransactionReceipt>();
  let receiptsReleased: Promise<void> = Promise.resolve();
  let releaseReceipts: () => void = () => undefined;
  const sendUncheckedTransaction = jest.fn(async (request: { to: string; data: string; chainId: number }) => {
    const hash = `0x${chainId.toString(16)}${(++sentCount).toString(16).padStart(60, '0')}`;
    const status = mine(chain, request) ? 1 : 0;
    receipts.set(hash, { transactionHash: hash, status, blockNumber: chain.block } as TransactionReceipt);
    return hash;
  });
  return {
    holdReceipts: () => {
      receiptsReleased = new Promise((resolve) => (releaseReceipts = resolve));
    },
    releaseReceipts: () => releaseReceipts(),
    send: jest.fn(
      async (method: string): Promise<unknown> => (method === 'eth_chainId' ? `0x${chainId.toString(16)}` : '0x10')
    ),
    estimateGas: jest.fn(async () => BigNumber.from(100_000)),
    getNetwork: jest.fn(async () => ({ chainId, name: chainId === 1 ? 'homestead' : 'base' })),
    getTransactionCount: jest.fn(async () => 5),
    getTransactionReceipt: jest.fn(async (hash: string) => {
      await receiptsReleased;
      return receipts.get(hash) ?? null;
    }),
    getTransaction: jest.fn(async () => null),
    getSigner: jest.fn(() => ({ sendUncheckedTransaction })),
    sendUncheckedTransaction,
  };
}
type Wallet = ReturnType<typeof walletFor>;

/** The names of the wallet requests the wrapper was asked to carry out. */
const sentCalls = (wallet: Wallet, method: string) =>
  wallet.sendUncheckedTransaction.mock.calls.filter(([request]) => CALLS.parseTransaction(request).name === method);

function sessionFor(wallet: object, chainId: number): WrappedSession {
  const lending: LendingSession = {
    connector: { id: ANCHORAGE_CONNECTOR_ID, uid: 'uid-1' },
    status: 'connected',
    account: ACCOUNT,
    chainId,
    isWatchOnly: false,
    isSignerReady: true,
    screeningStatus: 'allowed',
  };
  const route = resolveLendingRoute({
    market: { chainId: 1, cometAddress: USDC_COMET },
    session: lending,
    conflictedRdns: new Set(),
    validation: { key: wrappedRouteKey(MARKET, lending), status: 'matched' },
    registry: OPEN,
  });
  return { route, account: ACCOUNT, chainId, screeningStatus: 'allowed', provider: wallet };
}

const SELECTED = {
  selectedMarket: [StateType.Hydrated, USDC_MARKET] as const,
  selectMarket: jest.fn(),
  selectMarketByAddress: jest.fn(),
};
SelectedMarketContextHelpers.initializeContext(SELECTED as never);

const BASE_ASSET = mockBaseAsset({
  address: MARKET.baseTokenAddress,
  symbol: 'USDC',
  decimals: 6,
  balance: 0n,
  allowance: 0n,
  walletBalance: 10_000_000_000n,
  balanceOfComet: 10n ** 15n,
});
const COMET_STATE = [
  StateType.Hydrated,
  {
    baseAsset: BASE_ASSET,
    collateralAssets: [],
    borrowAPR: 0n,
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

type Live = {
  queue: ReturnType<typeof useActionQueue>;
  manager: ReturnType<typeof useTransactionManager>;
  action: ReturnType<typeof useWrappedAction>;
};
let live: Live;

type DashboardProps = {
  wallets: Record<number, Wallet>;
  readProvider: ReturnType<typeof readProviderFor>;
  walletChainId: number;
  state: CometState;
};

/**
 * The dashboard as App wires it: the transaction manager, the lifecycle and the wrapped writes,
 * the queue, and App's submission store, all through the fake wallets and provider.
 */
function Dashboard({ wallets, readProvider, walletChainId, state }: DashboardProps) {
  const wallet = wallets[walletChainId];
  const web3: Web3 = {
    ...mockWeb3,
    read: { ...mockWeb3.read, account: ACCOUNT, chainId: 1 },
    write: {
      ...mockWeb3.write,
      account: ACCOUNT,
      status: 'connected',
      chainId: walletChainId,
      connector: { id: ANCHORAGE_CONNECTOR_ID, uid: 'uid-1' } as Web3['write']['connector'],
      provider: wallet as never,
    },
  };
  const manager = useTransactionManager(web3);
  const session = sessionFor(wallet, walletChainId);
  const action = useWrappedAction({ session, manager, readProvider });
  const write = useWriteWrappedState({
    action,
    route: session.route,
    readProvider,
    baseSymbol: 'USDC',
    blockWait: { attempts: 200, intervalMs: 5 },
  });
  const queue = useActionQueue(SELECTED.selectedMarket as never, () => undefined, {
    account: ACCOUNT,
    connector: 'uid-1',
    status: 'connected',
  });
  const market = { chainId: 1, cometAddress: USDC_COMET };
  const submission = useSubmissionStore({
    scope: submissionScope(web3.write, market),
    queueScope: queueScope(web3.write, market),
    transactions: manager.transactions,
    settledTransactions: manager.settledTransactions,
    removeAction: queue.removeAction,
  });
  live = { queue, manager, action };
  ActionQueueContextHelpers.initializeContext(queue);
  const QueueContext = ActionQueueContextHelpers.getActionQueueContext();
  const MarketContext = SelectedMarketContextHelpers.getSelectedMarketContext();
  const lending = {
    route: session.route,
    action,
    write,
    position: { status: 'loading' as const },
    retry: jest.fn(),
    submission,
  };
  return (
    <WrappedLendingContext.Provider value={lending}>
      <MarketContext.Provider value={SELECTED as never}>
        <QueueContext.Provider value={queue}>
          <Home
            transactions={manager.transactions}
            web3={web3}
            selectedMarketData={SELECTED as never}
            cometState={state}
            addTransaction={manager.addTransaction}
            switchWriteNetwork={jest.fn()}
            estimatedGasMap={new Map()}
            theme={Theme.Dark}
          />
        </QueueContext.Provider>
      </MarketContext.Provider>
    </WrappedLendingContext.Provider>
  );
}

const queued = () => live.queue.getActions(BASE_ASSET, [], [StateType.Loading]);
const positionCard = () => mockLastProps.PositionCard.state[1];
const CONFIRM = /^(Approve|Supply|Withdraw About)/;

/** Lets the reads, the wallet and the receipt poll run. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 100)));

/**
 * Submits the queue, and confirms each step the dialog offers, as a user who wants it done would.
 * Then closes the dialog, if one is shown.
 */
async function submitAndConfirmEverything() {
  act(() => positionCard().onSubmitClicked());
  for (let step = 0; step < 3; step++) {
    await settle();
    // A step being read or signed offers its next confirmation once it settles.
    await waitFor(() => expect(['reading', 'signing']).not.toContain(live.action.state.phase));
    const confirm = screen.queryByRole('button', { name: CONFIRM });
    if (confirm === null) break;
    fireEvent.click(confirm);
  }
  const dialog = screen.queryByRole('dialog');
  if (dialog !== null) fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
}

function renderDashboard(chain: Chain) {
  window.localStorage.clear();
  const wallets = { 1: walletFor(chain, 1), 8453: walletFor(chain, 8453) };
  const props: DashboardProps = {
    wallets,
    readProvider: withTotals(chain, readProviderFor(chain)),
    walletChainId: 1,
    state: [StateType.Loading, undefined] as unknown as CometState,
  };
  const view = render(<Dashboard {...props} />);
  const show = (changes: Partial<DashboardProps>) =>
    view.rerender(<Dashboard {...props} {...changes} state={COMET_STATE} />);
  show({});
  return { wallet: wallets[1], show };
}

/**
 * Confirms the queued wrapper action's last step, then switches the wallet to Base while its
 * receipt is held back, as a user can while the transaction is pending.
 */
async function sendThenSwitchNetwork(wallet: Wallet, show: (changes: Partial<DashboardProps>) => void, label: RegExp) {
  act(() => positionCard().onSubmitClicked());
  const confirm = await screen.findByRole('button', { name: label });
  wallet.holdReceipts();
  fireEvent.click(confirm);
  await waitFor(() => expect(live.manager.transactions[0]?.state).toBe(TransactionState.Pending));

  show({ walletChainId: 8453 });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(live.action.state.phase).toBe('discarded');
}

/**
 * Tries every change the dashboard offers to the queue: select, delete and clear in the position
 * card, and a new amount from the masthead. None of them may change it.
 */
function expectQueueHeld(entry: Action) {
  act(() => positionCard().onSelectAction(entry));
  act(() => positionCard().onDeleteAction(entry));
  act(() => positionCard().onClearClicked());
  act(() => mockLastProps.Masthead.state[1].onSupplyAction([ActionType.Supply, BASE_ASSET, undefined]));
  act(() => mockLastProps.Masthead.state[1].onWithdrawAction([ActionType.Withdraw, BASE_ASSET, undefined]));

  expect(queued()).toEqual([entry]);
  expect(live.queue.getPendingAction(BASE_ASSET, [])).toBeUndefined();
}

describe('a queued wrapper action sent before a change of network', () => {
  beforeEach(() => {
    mockNextId = 0;
  });

  it('is supplied once: it is held while its receipt is pending, and leaves the queue once it confirms', async () => {
    const chain = chainFor({ allowance: AMOUNT });
    const { wallet, show } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason('supply')).toBeUndefined());
    const supply: Action = [ActionType.Supply, BASE_ASSET, AMOUNT];
    act(() => live.queue.addOrUpdateAction(supply));

    await sendThenSwitchNetwork(wallet, show, /^Supply 100\.000000 USDC$/);
    // The submission was dropped, so only the sent supply holds the queue. The position card says
    // which network holds it.
    expectQueueHeld(supply);
    expect(positionCard().queueNotice).toEqual({
      message:
        'Your USDC supply is pending on Ethereum. The queue stays as it is until it settles. Switch your wallet to Ethereum to follow it.',
    });
    // Back on the market's network, the receipt is still pending: the entry is held, and nothing
    // more is sent.
    show({ walletChainId: 1 });
    await submitAndConfirmEverything();
    expect(sentCalls(wallet, 'supplyAndWrap')).toHaveLength(1);
    expectQueueHeld(supply);
    expect(positionCard().queueNotice).toEqual({
      message: 'Your USDC supply is pending on Ethereum. The queue stays as it is until it settles.',
    });

    wallet.releaseReceipts();
    await waitFor(() => expect(live.manager.settledTransactions).toHaveLength(1));
    await waitFor(() => expect(positionCard().queueNotice).toBeUndefined());
    await submitAndConfirmEverything();

    expect(sentCalls(wallet, 'supplyAndWrap')).toHaveLength(1);
    expect(chain.balance).toBe(10_000_000_000n - AMOUNT);
    expect(queued()).toEqual([]);
  });

  it('withdraws once: a partial withdrawal leaves the queue once it confirms', async () => {
    const chain = chainFor({ shares: 250n * 10n ** 18n });
    const { wallet, show } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, AMOUNT]));

    await sendThenSwitchNetwork(wallet, show, /^Withdraw About/);
    wallet.releaseReceipts();
    show({ walletChainId: 1 });
    await waitFor(() => expect(live.manager.settledTransactions).toHaveLength(1));
    await submitAndConfirmEverything();

    expect(sentCalls(wallet, 'unwrapAndWithdraw')).toHaveLength(1);
    expect(chain.balance).toBe(10_000_000_000n + AMOUNT);
    expect(queued()).toEqual([]);
  });

  it('returns to the queue, and can be submitted again, once its last step reverted', async () => {
    const chain = chainFor({ allowance: AMOUNT });
    const { wallet, show } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason('supply')).toBeUndefined());
    const supply: Action = [ActionType.Supply, BASE_ASSET, AMOUNT];
    act(() => live.queue.addOrUpdateAction(supply));
    chain.shouldRevertNext = true;

    await sendThenSwitchNetwork(wallet, show, /^Supply 100\.000000 USDC$/);
    wallet.releaseReceipts();
    show({ walletChainId: 1 });
    await waitFor(() => expect(live.manager.settledTransactions[0]?.outcome.status).toBe('reverted'));
    await settle();

    expect(queued()).toHaveLength(1);
    act(() => positionCard().onSubmitClicked());
    expect(await screen.findByRole('button', { name: /^Supply 100\.000000 USDC$/ })).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).queryByText(/may still go through/)).toBeNull();
    expect(sentCalls(wallet, 'supplyAndWrap')).toHaveLength(1);
    expect(chain.balance).toBe(10_000_000_000n);
  });
});
