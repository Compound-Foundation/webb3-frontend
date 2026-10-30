import { Interface } from '@ethersproject/abi';
import { TransactionReceipt } from '@ethersproject/providers';
import { act, render, screen, waitFor } from '@testing-library/react';
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
import { MAX_UINT256 } from '@helpers/numbers';
import { WrappedSession } from '@helpers/wrappedActions';
import { useActionQueue } from '@hooks/useActionQueue';
import { useSubmissionStore } from '@hooks/useSubmissionStore';
import { Theme } from '@hooks/useThemeManager';
import { useTransactionManager } from '@hooks/useTransactionManager';
import { useSignWhenReady, useWrappedAction } from '@hooks/useWrappedAction';
import { useWriteWrappedState } from '@hooks/useWriteWrappedState';
import { Action, ActionType, CometState, MarketData, StateType, TransactionState } from '@types';

import { mockBaseAsset } from '../../../../__tests__/mocks/mockBaseAsset';
import { MOCK_MARKETS, MockMarketsProvider } from '../../../../__tests__/mocks/mockMarkets';
import { mockWeb3 } from '../../../../__tests__/mocks/mockWeb3';
import Home from '../index';

// uuid ships ESM only, which Jest does not load here. The transaction manager uses it.
let mockNextId = 0;
jest.mock('uuid', () => ({ v4: () => `transaction-${++mockNextId}` }));

// Home's children record their props.
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
const USDC_MARKET = getMarket(MOCK_MARKETS, 1, USDC_COMET) as MarketData;

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
  useSignWhenReady(action);
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
    <MockMarketsProvider>
      <WrappedLendingContext.Provider value={lending}>
        <MarketContext.Provider value={SELECTED as never}>
          <QueueContext.Provider value={queue}>
            <Home
              transactions={manager.transactions}
              web3={web3}
              selectedMarketData={SELECTED as never}
              cometState={state}
              addTransaction={manager.addTransaction}
              switchWriteNetwork={switchWriteNetwork}
              estimatedGasMap={new Map()}
              theme={Theme.Dark}
            />
          </QueueContext.Provider>
        </MarketContext.Provider>
      </WrappedLendingContext.Provider>
    </MockMarketsProvider>
  );
}

const switchWriteNetwork = jest.fn(async () => true);

const queued = () => live.queue.getActions(BASE_ASSET, [], [StateType.Loading]);
const positionCard = () => mockLastProps.PositionCard.state[1];

/** Lets the reads, the wallet and the receipt poll run. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 100)));

/** Presses Submit Transaction and lets whatever it starts run. */
async function submit() {
  act(() => positionCard().onSubmitClicked());
  await settle();
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
 * Submits the queued wrapper action, then switches the wallet to Base while its receipt is held
 * back, as a user can while the transaction is pending. Submit asks the wallet at once, with no
 * dialog, and the position card shows the transaction as production shows one to Comet.
 */
async function sendThenSwitchNetwork(wallet: Wallet, show: (changes: Partial<DashboardProps>) => void) {
  wallet.holdReceipts();
  act(() => positionCard().onSubmitClicked());
  await waitFor(() => expect(live.manager.transactions[0]?.state).toBe(TransactionState.Pending));
  expect(positionCard().transaction?.state).toBe(TransactionState.Pending);
  expect(screen.queryByRole('dialog')).toBeNull();

  show({ walletChainId: 8453 });
  await waitFor(() => expect(live.action.state.phase).toBe('discarded'));
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

  it('is supplied once: it is held while its receipt is pending on either network, and leaves the queue once it confirms', async () => {
    const chain = chainFor({ allowance: AMOUNT });
    const { wallet, show } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason('supply')).toBeUndefined());
    const supply: Action = [ActionType.Supply, BASE_ASSET, AMOUNT];
    act(() => live.queue.addOrUpdateAction(supply));

    await sendThenSwitchNetwork(wallet, show);
    // The run was dropped with the network, and only the sent supply holds the queue. The card
    // still shows the pending transaction, as it shows one to Comet, and says nothing more.
    expectQueueHeld(supply);
    expect(positionCard().transaction?.state).toBe(TransactionState.Pending);
    expect(positionCard().actionRules.wrappedBase.stopped).toBeUndefined();
    // The card's Submit is disabled meanwhile. A Submit callback kept from before sends nothing.
    switchWriteNetwork.mockClear();
    await submit();
    expect(sentCalls(wallet, 'supplyAndWrap')).toHaveLength(1);

    // Back on the market's network, the receipt is still pending: the entry is held, and Submit
    // sends nothing more.
    show({ walletChainId: 1 });
    await submit();
    expect(sentCalls(wallet, 'supplyAndWrap')).toHaveLength(1);
    expectQueueHeld(supply);
    expect(positionCard().transaction?.state).toBe(TransactionState.Pending);

    wallet.releaseReceipts();
    await waitFor(() => expect(live.manager.settledTransactions).toHaveLength(1));
    await waitFor(() => expect(queued()).toEqual([]));
    await settle();

    expect(sentCalls(wallet, 'supplyAndWrap')).toHaveLength(1);
    expect(chain.balance).toBe(10_000_000_000n - AMOUNT);
  });

  it('withdraws once: a partial withdrawal leaves the queue once it confirms', async () => {
    const chain = chainFor({ shares: 250n * 10n ** 18n });
    const { wallet, show } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, AMOUNT]));

    await sendThenSwitchNetwork(wallet, show);
    wallet.releaseReceipts();
    show({ walletChainId: 1 });
    await waitFor(() => expect(live.manager.settledTransactions).toHaveLength(1));
    await waitFor(() => expect(queued()).toEqual([]));
    await submit();

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

    await sendThenSwitchNetwork(wallet, show);
    wallet.releaseReceipts();
    show({ walletChainId: 1 });
    await waitFor(() => expect(live.manager.settledTransactions[0]?.outcome.status).toBe('reverted'));
    await settle();

    // It is queued again, and Submit sends it again, with no dialog.
    expect(queued()).toHaveLength(1);
    await submit();
    await waitFor(() => expect(sentCalls(wallet, 'supplyAndWrap')).toHaveLength(2));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(queued()).toEqual([]));
    expect(chain.balance).toBe(10_000_000_000n - AMOUNT);
  });
});

describe('the wrapped route through the real hooks, in the production order', () => {
  beforeEach(() => {
    mockNextId = 0;
  });

  it('Approve & Add asks the wallet for the exact approval at once and queues the supply; Submit then asks for the supply alone', async () => {
    const chain = chainFor();
    const { wallet } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason('supply')).toBeUndefined());
    wallet.holdReceipts();

    act(() => live.queue.setPendingAction([ActionType.Supply, BASE_ASSET, undefined]));
    act(() => positionCard().onPendingActionConfirm(AMOUNT));
    expect(queued()).toEqual([[ActionType.Supply, expect.anything(), AMOUNT]]);

    // The approval reaches the wallet with no other press, and its row shows Approval Pending.
    await waitFor(() => expect(sentCalls(wallet, 'approve')).toHaveLength(1));
    expect(CALLS.parseTransaction(sentCalls(wallet, 'approve')[0][0]).args.map(String)).toEqual([
      MARKET.wrapperAddress,
      String(AMOUNT),
    ]);
    await waitFor(() =>
      expect(positionCard().approvalTransactions).toEqual([
        expect.objectContaining({ key: BASE_ASSET.address, state: TransactionState.Pending }),
      ])
    );
    // An approval does not hold the dashboard.
    expect(positionCard().transaction).toBeUndefined();
    expect(sentCalls(wallet, 'supplyAndWrap')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();

    wallet.releaseReceipts();
    await waitFor(() => expect(live.action.state.phase).toBe('complete'));
    await waitFor(() => expect(positionCard().approvalTransactions).toEqual([]));
    expect(chain.allowance).toBe(AMOUNT);

    await submit();
    await waitFor(() => expect(queued()).toEqual([]));
    expect(wallet.sendUncheckedTransaction.mock.calls.map(([request]) => CALLS.parseTransaction(request).name)).toEqual(
      ['approve', 'supplyAndWrap']
    );
    expect(chain.balance).toBe(10_000_000_000n - AMOUNT);
    expect(chain.allowance).toBe(0n);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('returns the queue to Submit after a rejection in the wallet, and Submit sends the supply again', async () => {
    const chain = chainFor({ allowance: AMOUNT });
    const { wallet } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason('supply')).toBeUndefined());
    const supply: Action = [ActionType.Supply, BASE_ASSET, AMOUNT];
    act(() => live.queue.addOrUpdateAction(supply));
    wallet.sendUncheckedTransaction.mockRejectedValueOnce({ code: 4001, message: 'User rejected the request.' });

    await submit();
    await waitFor(() => expect(live.action.state.phase).toBe('stopped'));
    await settle();

    expect(queued()).toEqual([supply]);
    expect(positionCard().transaction).toBeUndefined();
    expect(positionCard().actionRules.wrappedBase.stopped).toBeUndefined();
    expect(screen.queryByRole('dialog')).toBeNull();

    await submit();
    await waitFor(() => expect(queued()).toEqual([]));
    expect(sentCalls(wallet, 'supplyAndWrap')).toHaveLength(2);
    expect(chain.balance).toBe(10_000_000_000n - AMOUNT);
  });

  it('withdraws everything for a Max withdrawal with Confirm Transaction then Transaction Pending..., and clears it on the receipt', async () => {
    const chain = chainFor({ shares: 250n * 10n ** 18n });
    const { wallet } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, MAX_UINT256]));
    wallet.holdReceipts();
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const send = wallet.sendUncheckedTransaction.getMockImplementation();
    if (send === undefined) throw new Error('the wallet must send');
    wallet.sendUncheckedTransaction.mockImplementationOnce(async (request) => {
      await answered;
      return send(request);
    });

    act(() => positionCard().onSubmitClicked());
    // From the press until the wallet answers.
    expect(positionCard().transaction?.state).toBe(TransactionState.AwaitingConfirmation);
    await waitFor(() => expect(wallet.sendUncheckedTransaction).toHaveBeenCalledTimes(1));
    expect(positionCard().transaction?.state).toBe(TransactionState.AwaitingConfirmation);
    answer();
    await waitFor(() => expect(positionCard().transaction?.state).toBe(TransactionState.Pending));
    expect(screen.queryByRole('dialog')).toBeNull();

    wallet.releaseReceipts();
    await waitFor(() => expect(queued()).toEqual([]));
    expect(positionCard().transaction).toBeUndefined();
    expect(sentCalls(wallet, 'unwrapAndWithdraw')).toHaveLength(1);
    expect(chain.shares).toBe(0n);
  });

  it('asks the wallet to switch network on Submit from another network, as production does, and sends nothing', async () => {
    const chain = chainFor({ allowance: AMOUNT });
    const { wallet, show } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason('supply')).toBeUndefined());
    act(() => live.queue.addOrUpdateAction([ActionType.Supply, BASE_ASSET, AMOUNT]));
    show({ walletChainId: 8453 });
    switchWriteNetwork.mockClear();

    await submit();

    expect(switchWriteNetwork).toHaveBeenCalledWith(1);
    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(positionCard().transaction).toBeUndefined();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

/**
 * Another write through the same wallet provider fails as a provider broken by an extension update
 * does, so the transaction manager marks the wallet session unusable.
 */
async function breakSessionByAnotherWrite() {
  await act(async () => {
    await live.manager.submitTransaction({
      key: '0x0000000000000000000000000000000000000bb2',
      description: 'Another write',
      send: async () => {
        throw new Error("Cannot read properties of undefined (reading 'sendMessage')");
      },
    });
  });
  expect(live.action.session.status).toBe('unusable');
}

/** A promise the test resolves. */
function held<T>() {
  let release: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => (release = resolve));
  return { promise, release };
}

describe('a queued wrapper action when the wallet session breaks while it is being sent', () => {
  // The lifecycle warns of a step it stopped, and the manager logs the other write's error.
  let quiet: jest.SpyInstance[] = [];
  beforeEach(() => {
    mockNextId = 0;
    quiet = [
      jest.spyOn(console, 'warn').mockImplementation(() => undefined),
      jest.spyOn(console, 'log').mockImplementation(() => undefined),
    ];
  });

  afterEach(() => {
    quiet.forEach((spy) => spy.mockRestore());
  });

  it.each<[string, ActionType.Supply | ActionType.Withdraw, 'estimateGas' | 'getTransactionCount']>([
    ['a withdrawal whose gas is being estimated', ActionType.Withdraw, 'estimateGas'],
    ['a withdrawal whose nonce the manager is reading', ActionType.Withdraw, 'getTransactionCount'],
    ['a supply whose gas is being estimated', ActionType.Supply, 'estimateGas'],
  ])('keeps %s queued as not sent, and never asks the wallet to sign it', async (_name, type, heldRead) => {
    const isWithdraw = type === ActionType.Withdraw;
    const chain = isWithdraw ? chainFor({ shares: 250n * 10n ** 18n }) : chainFor({ allowance: AMOUNT });
    const { wallet } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason(isWithdraw ? 'withdraw' : 'supply')).toBeUndefined());
    const entry: Action = [type, BASE_ASSET, AMOUNT];
    act(() => live.queue.addOrUpdateAction(entry));
    // The read the request waits on before the wallet is asked to sign it.
    const read = held<unknown>();
    let isReadStarted = false;
    const readNow = wallet[heldRead].getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
    (wallet[heldRead] as jest.Mock).mockImplementationOnce(async (...args: unknown[]) => {
      isReadStarted = true;
      await read.promise;
      return readNow(...args);
    });

    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(isReadStarted).toBe(true));
    const { state } = live.action;
    expect(state.phase === 'signing' && state.steps[state.stepIndex]).toEqual({ status: 'awaiting-signature' });

    await breakSessionByAnotherWrite();
    await waitFor(() => expect(live.action.state.phase).toBe('stopped'));
    await settle();

    // Nothing reached the wallet, so the action stays queued, and its row asks for another try.
    expect(queued()).toEqual([entry]);
    expect(positionCard().actionRules.wrappedBase.stopped).toEqual({ action: entry, label: 'Not Sent, Try Again' });
    const stopped = live.action.state;
    if (stopped.phase !== 'stopped') throw new Error('the action must be stopped');
    expect(stopped.steps[stopped.stepIndex]).toEqual({ status: 'blocked', reason: 'session-unusable' });

    // The read answers late. The request is withdrawn at its next check, before the wallet.
    read.release(undefined);
    await settle();
    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(live.manager.transactions).toEqual([]);

    // Submit again is refused while the session stays unusable, and sends nothing.
    await submit();
    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(queued()).toEqual([entry]);
  });

  it('takes a withdrawal the wallet was asked to sign out of the queue, and asks for it only once', async () => {
    const chain = chainFor({ shares: 250n * 10n ** 18n });
    const { wallet } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, AMOUNT];
    act(() => live.queue.addOrUpdateAction(entry));
    // The wallet holds the request and never answers.
    wallet.sendUncheckedTransaction.mockImplementationOnce(() => new Promise<string>(() => undefined));

    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(wallet.sendUncheckedTransaction).toHaveBeenCalledTimes(1));

    await breakSessionByAnotherWrite();
    await waitFor(() => expect(live.action.state.phase).toBe('stopped'));
    await settle();

    // The wallet can still send it, so it leaves the queue, as any stop that can still execute does.
    expect(queued()).toEqual([]);
    expect(positionCard().actionRules.wrappedBase.stopped).toBeUndefined();
    await submit();
    expect(wallet.sendUncheckedTransaction).toHaveBeenCalledTimes(1);

    const stopped = live.action.state;
    if (stopped.phase !== 'stopped') throw new Error('the action must be stopped');
    expect(stopped.steps[stopped.stepIndex]).toEqual({
      status: 'provider-failure',
      message:
        'The wallet stopped responding while it had the request. The request can still be approved in the wallet.',
      isStoppedBySessionFailure: true,
    });
  });
});
