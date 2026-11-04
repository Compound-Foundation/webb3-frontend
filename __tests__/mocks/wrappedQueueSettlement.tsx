import { Interface } from '@ethersproject/abi';
import { TransactionReceipt } from '@ethersproject/providers';
import { act, render, screen, waitFor } from '@testing-library/react';
import { BigNumber } from 'ethers';
import { useMemo, useRef } from 'react';

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
import { recordCometStateSource } from '@helpers/cometStateSource';
import { TRANSACTION_LOCALSTORAGE_KEY } from '@helpers/constants';
import * as DirectWithdrawalHold from '@helpers/directWithdrawalHold';
import { LendingSession, resolveLendingRoute, wrappedRouteKey } from '@helpers/lendingRoute';
import { getMarket } from '@helpers/markets';
import { MAX_UINT256 } from '@helpers/numbers';
import { isSingleActionRoute } from '@helpers/queuedExecution';
import { WrappedSession } from '@helpers/wrappedActions';
import { WrappedPosition } from '@helpers/wrappedPositions';
import { useActionQueue } from '@hooks/useActionQueue';
import { useSubmissionStore } from '@hooks/useSubmissionStore';
import { Theme } from '@hooks/useThemeManager';
import { useTransactionManager } from '@hooks/useTransactionManager';
import { useSignWhenReady, useWrappedAction } from '@hooks/useWrappedAction';
import { useWriteWrappedState } from '@hooks/useWriteWrappedState';
import Home from '@pages/home';
import { Action, ActionType, CometState, MarketData, StateType, TransactionState } from '@types';

import { mockBaseAsset } from './mockBaseAsset';
import { mockWeb3 } from './mockWeb3';
import { mockLastProps, mockTab } from './wrappedQueueSettlementProps';

/**
 * The dashboard as App wires it, through a fake chain, wallets and provider, for the
 * wrappedQueueSettlement test files in src/pages/home/__tests__. Each of those files mocks uuid and
 * Home's children itself, as Jest hoists `jest.mock` per test file.
 */
export const ACCOUNT = '0x0000000000000000000000000000000000000aa1';
export const AMOUNT = 100_000_000n;

/** The committed registry with deposits and exits open, as a release would set them. */
export const OPEN = buildWrappedMarketRegistry({
  markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({
    ...market,
    isDepositEnabled: true,
    isExitEnabled: true,
  })),
});
export const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
export const lookup = OPEN.lookup(1, USDC_COMET);
if (lookup.status !== 'valid') throw new Error('the mapping must be valid');
export const MARKET: WrappedMarket = lookup.market;
export const USDC_MARKET = getMarket(1, USDC_COMET) as MarketData;

export const isSame = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

export const CALLS = new Interface([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount)',
  'function supplyAndWrap(uint256 amount) returns (uint256 shares)',
  'function isSupplyPaused() view returns (bool)',
  'function unwrapAndWithdraw(uint256 shares) returns (uint256 amount)',
  'function totalSupply() view returns (uint256)',
  'function isWithdrawPaused() view returns (bool)',
  'function withdraw(address asset, uint256 amount)',
]);
export const COMET = new Interface(CometAbi);

/** What the chain holds for the account and its market. Every mined transaction is a new block. */
export type Chain = {
  balance: bigint;
  allowance: bigint;
  shares: bigint;
  totalSupply: bigint;
  totalAssets: bigint;
  baseSupplyIndex: bigint;
  cometCash: bigint;
  /** The account's base supply to Comet directly, outside the wrapper. */
  directSupply: bigint;
  /** What Comet lent the account: a `withdraw` above the direct supply borrows the difference. */
  borrowed: bigint;
  block: number;
  /** The next mined call reverts. */
  shouldRevertNext: boolean;
  /** The events the last mined call emitted, as its receipt holds them. */
  logs: { address: string; topics: string[]; data: string }[];
  /** Every mined call, as the chain's node keeps it. */
  history: MinedCall[];
};

export type MinedCall = {
  hash: string;
  blockNumber: number;
  from: string;
  to: string;
  data: string;
  status: number;
  logs: Chain['logs'];
};

/**
 * The wrapper holds 1,000.5 USDC for 1,000 whole shares, counting its 10^12 virtual shares, of
 * which the account holds `shares`. The supply index 1.05e15 gives a buffer of 3 base units.
 */
export function chainFor({ allowance = 0n, shares = 0n, directSupply = 0n } = {}): Chain {
  return {
    balance: 10_000_000_000n,
    allowance,
    shares,
    totalSupply: 1_000n * 10n ** 18n - 10n ** 12n,
    totalAssets: 1_000_500_000n,
    baseSupplyIndex: 1_050_000_000_000_000n,
    cometCash: 10n ** 15n,
    directSupply,
    borrowed: 0n,
    block: 100,
    shouldRevertNext: false,
    logs: [],
    history: [],
  };
}

/** The cash `unwrapAndWithdraw(shares)` pays: the shares' value less the buffer. */
export function exitCashAt(chain: Chain, shares: bigint): bigint {
  const worth = (shares * (chain.totalAssets + 1n)) / (chain.totalSupply + 10n ** 12n);
  const buffer = chain.baseSupplyIndex / 10n ** 15n + 2n;
  return worth <= buffer ? 0n : worth - buffer;
}

/**
 * Mines a call from the account as the base token and the wrapper do, and keeps it in the chain's
 * history under `hash`. Returns whether it succeeded.
 */
export function mine(chain: Chain, call: { to: string; data: string }, hash?: string): boolean {
  const isSuccess = execute(chain, call);
  chain.history.push({
    hash: hash ?? `0xfe${(chain.history.length + 1).toString(16).padStart(62, '0')}`,
    blockNumber: chain.block,
    from: ACCOUNT,
    to: call.to,
    data: call.data,
    status: isSuccess ? 1 : 0,
    logs: isSuccess ? chain.logs : [],
  });
  return isSuccess;
}

export function execute(chain: Chain, { to, data }: { to: string; data: string }): boolean {
  chain.block += 1;
  chain.logs = [];
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
  // Comet's own base withdrawal: `MAX_UINT256` takes the whole direct supply, and more than the
  // supply borrows the difference.
  if (call.name === 'withdraw' && isSame(to, MARKET.cometAddress) && isSame(call.args[0], MARKET.baseTokenAddress)) {
    const asked = BigInt(call.args[1].toString());
    const amount = asked === MAX_UINT256 ? chain.directSupply : asked;
    if (amount > chain.directSupply) chain.borrowed += amount - chain.directSupply;
    chain.directSupply = amount > chain.directSupply ? 0n : chain.directSupply - amount;
    chain.cometCash -= amount;
    chain.balance += amount;
    // Comet names the amount it withdrew, the whole supply for `MAX_UINT256`.
    chain.logs = [
      { address: MARKET.cometAddress, ...COMET.encodeEventLog(COMET.getEvent('Withdraw'), [ACCOUNT, ACCOUNT, amount]) },
    ];
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

/** The hash of the simulated chain's block at `blockNumber`. */
export const blockHashAt = (blockNumber: number) => `0x${'b'.repeat(56)}${blockNumber.toString(16).padStart(8, '0')}`;

/** The configured chain's public provider, at the newest block. */
export function readProviderFor(chain: Chain) {
  const minedCall = (hash: string) => chain.history.find((mined) => mined.hash === hash);
  return {
    getBlockNumber: jest.fn(async () => chain.block),
    // The node's logs, by address, event, indexed sender and block range.
    getLogs: jest.fn(
      async (filter: { address?: string; topics?: (string | null)[]; fromBlock?: number; toBlock?: number }) =>
        chain.history.flatMap((mined) =>
          mined.logs
            .filter(
              (log) =>
                isSame(log.address, filter.address ?? '') &&
                mined.blockNumber >= (filter.fromBlock ?? 0) &&
                mined.blockNumber <= (filter.toBlock ?? Number.MAX_SAFE_INTEGER) &&
                (filter.topics ?? []).every((topic, index) => topic === null || isSame(log.topics[index], topic))
            )
            .map((log) => ({
              ...log,
              blockNumber: mined.blockNumber,
              blockHash: blockHashAt(mined.blockNumber),
              transactionHash: mined.hash,
            }))
        )
    ),
    getTransaction: jest.fn(async (hash: string) => {
      const mined = minedCall(hash);
      return mined === undefined ? null : { ...mined, blockHash: blockHashAt(mined.blockNumber) };
    }),
    getBlock: jest.fn(async (blockNumber: number) => ({ number: blockNumber, hash: blockHashAt(blockNumber) })),
    getTransactionReceipt: jest.fn(async (hash: string) => {
      const mined = minedCall(hash);
      return mined === undefined
        ? null
        : { transactionHash: hash, status: mined.status, blockNumber: mined.blockNumber, logs: mined.logs };
    }),
    getTransactionCount: jest.fn(async () => 5),
    // The block tag, the second argument, is ignored: the simulated chain keeps only its newest state.
    call: jest.fn<Promise<string>, [{ from?: string; to?: string; data?: string }, unknown?]>(
      async ({ from, to, data }) => {
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
        if (
          call.name === 'balanceOf' &&
          isSame(to, MARKET.cometAddress) &&
          isSame(call.args[0], MARKET.wrapperAddress)
        ) {
          return CALLS.encodeFunctionResult('balanceOf', [chain.totalAssets]);
        }
        if (call.name === 'balanceOf' && isSame(to, MARKET.cometAddress) && isSame(call.args[0], ACCOUNT)) {
          return CALLS.encodeFunctionResult('balanceOf', [chain.directSupply]);
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
      }
    ),
  };
}
// Comet's `totalsBasic` is read through the Comet ABI.
export function withTotals(chain: Chain, provider: ReturnType<typeof readProviderFor>) {
  const read = provider.call.getMockImplementation();
  provider.call.mockImplementation(async (request: { from?: string; to?: string; data?: string }) => {
    // The account's principal, which interest does not change: its direct supply at the supply index.
    if (request.data?.startsWith(COMET.getSighash('userBasic')) && isSame(request.to, MARKET.cometAddress)) {
      const principal = (chain.directSupply * 10n ** 15n) / chain.baseSupplyIndex;
      return COMET.encodeFunctionResult('userBasic', [principal, 0n, 0n, 0n, 0n]);
    }
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
export function walletFor(chain: Chain, chainId: number) {
  let sentCount = 0;
  const receipts = new Map<string, TransactionReceipt>();
  let receiptsReleased: Promise<void> = Promise.resolve();
  let releaseReceipts: () => void = () => undefined;
  const sendUncheckedTransaction = jest.fn(async (request: { to: string; data: string; chainId: number }) => {
    const hash = `0x${chainId.toString(16)}${(++sentCount).toString(16).padStart(60, '0')}`;
    const status = mine(chain, request, hash) ? 1 : 0;
    receipts.set(hash, {
      transactionHash: hash,
      status,
      blockNumber: chain.block,
      logs: chain.logs,
    } as unknown as TransactionReceipt);
    return hash;
  });
  // The signer Comet's own writes use, as ethers' contracts call it. Its sends join the same list of
  // wallet requests, so their order with the wrapper's shows.
  const cometSigner = {
    _isSigner: true,
    getAddress: async () => ACCOUNT,
    resolveName: async (name: string) => name,
    // Called with the transaction ethers estimates, whose `data` is the call's encoding.
    estimateGas: jest.fn<Promise<BigNumber>, [{ to?: string; data: string }]>(async () => BigNumber.from(100_000)),
    sendTransaction: jest.fn(async (request: { to: string; data: string }) => ({
      hash: await sendUncheckedTransaction({ to: request.to, data: request.data, chainId }),
      wait: async () => ({}),
    })),
  };
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
    getBlockNumber: jest.fn(async () => chain.block),
    getTransactionReceipt: jest.fn(async (hash: string) => {
      await receiptsReleased;
      return receipts.get(hash) ?? null;
    }),
    getTransaction: jest.fn(async () => null),
    getSigner: jest.fn(() => ({ sendUncheckedTransaction, connectUnchecked: () => cometSigner })),
    sendUncheckedTransaction,
    cometSigner,
  };
}
export type Wallet = ReturnType<typeof walletFor>;

/** The names of the wallet requests the wrapper was asked to carry out. */
export const sentCalls = (wallet: Wallet, method: string) =>
  wallet.sendUncheckedTransaction.mock.calls.filter(([request]) => CALLS.parseTransaction(request).name === method);

export function sessionFor(wallet: object, chainId: number, connectorId = ANCHORAGE_CONNECTOR_ID): WrappedSession {
  const lending: LendingSession = {
    connector: { id: connectorId, uid: `${connectorId}-1` },
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

export const SELECTED = {
  selectedMarket: [StateType.Hydrated, USDC_MARKET] as const,
  selectMarket: jest.fn(),
  selectMarketByAddress: jest.fn(),
};
SelectedMarketContextHelpers.initializeContext(SELECTED as never);

export const BASE_ASSET = mockBaseAsset({
  address: MARKET.baseTokenAddress,
  symbol: 'USDC',
  decimals: 6,
  balance: 0n,
  allowance: 0n,
  walletBalance: 10_000_000_000n,
  balanceOfComet: 10n ** 15n,
});
export const COMET_STATE = [
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

export type Live = {
  queue: ReturnType<typeof useActionQueue>;
  manager: ReturnType<typeof useTransactionManager>;
  action: ReturnType<typeof useWrappedAction>;
  submission: ReturnType<typeof useSubmissionStore>;
  /** The writes handed to the transaction manager that have not returned yet. */
  writes: Set<Promise<unknown>>;
};
export let live: Live;
/** Every open tab's hooks, by tab. */
export const lives: Record<string, Live> = {};

export type DashboardProps = {
  wallets: Record<number, Wallet>;
  readProvider: ReturnType<typeof readProviderFor>;
  walletChainId: number;
  state: CometState;
  /** The wrapped position the dashboard shows, or none while it is read. */
  position?: WrappedPosition;
  /** False while another page is shown: App's hooks stay, and Home is unmounted. */
  isHomeShown?: boolean;
  /** The market App's submission store is for. Another one is selected while another market is shown. */
  storeMarket?: { chainId: number; cometAddress: string };
  /** The wallet connector: Anchorage's, for the wrapped route, unless another is given. */
  connectorId?: string;
  /** The tab of the app: `a` unless a test opens another one over the same storage. */
  tab?: string;
};

/**
 * The dashboard as App wires it: the transaction manager, the lifecycle and the wrapped writes,
 * the queue, and App's submission store, all through the fake wallets and provider.
 */
export function Dashboard({
  wallets,
  readProvider,
  walletChainId,
  state,
  position,
  isHomeShown = true,
  storeMarket = { chainId: 1, cometAddress: USDC_COMET },
  connectorId = ANCHORAGE_CONNECTOR_ID,
  tab = 'a',
}: DashboardProps) {
  const wallet = wallets[walletChainId];
  const writes = useRef(new Set<Promise<unknown>>()).current;
  const web3: Web3 = {
    ...mockWeb3,
    read: { ...mockWeb3.read, account: ACCOUNT, chainId: 1, provider: readProvider as never },
    write: {
      ...mockWeb3.write,
      account: ACCOUNT,
      status: 'connected',
      chainId: walletChainId,
      connector: { id: connectorId, uid: `${connectorId}-1` } as Web3['write']['connector'],
      provider: wallet as never,
    },
  };
  const managed = useTransactionManager(web3);
  // The manager, with each write it is handed kept in `writes` until it returns.
  const addTransaction = useMemo(() => tracked(writes, managed.addTransaction), [managed.addTransaction]);
  const submitTransaction = useMemo(() => tracked(writes, managed.submitTransaction), [managed.submitTransaction]);
  const manager = { ...managed, addTransaction, submitTransaction };
  const session = sessionFor(wallet, walletChainId, connectorId);
  const action = useWrappedAction({ session, manager, readProvider });
  useSignWhenReady(action);
  const write = useWriteWrappedState({
    action,
    route: session.route,
    readProvider,
    baseSymbol: 'USDC',
    blockWait: { attempts: 200, intervalMs: 5 },
  });
  const queue = useActionQueue(
    SELECTED.selectedMarket as never,
    () => undefined,
    { account: ACCOUNT, connector: `${connectorId}-1`, status: 'connected' },
    isSingleActionRoute(session.route)
  );
  const market = storeMarket;
  const submission = useSubmissionStore({
    scope: submissionScope(web3.write, market),
    queueScope: queueScope(web3.write, market),
    transactions: manager.transactions,
    settledTransactions: manager.settledTransactions,
    removeAction: queue.removeAction,
  });
  lives[tab] = { queue, manager, action, submission, writes };
  if (tab === 'a') {
    live = lives[tab];
    mockLastProps.readProvider = readProvider;
  }
  ActionQueueContextHelpers.initializeContext(queue);
  const QueueContext = ActionQueueContextHelpers.getActionQueueContext();
  const MarketContext = SelectedMarketContextHelpers.getSelectedMarketContext();
  const lending = {
    route: session.route,
    action,
    write,
    position: position === undefined ? { status: 'loading' as const } : { status: 'loaded' as const, position },
    retry: jest.fn(),
    submission,
  };
  return (
    <mockTab.Provider value={tab}>
      <WrappedLendingContext.Provider value={lending}>
        <MarketContext.Provider value={SELECTED as never}>
          <QueueContext.Provider value={queue}>
            {isHomeShown && (
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
            )}
          </QueueContext.Provider>
        </MarketContext.Provider>
      </WrappedLendingContext.Provider>
    </mockTab.Provider>
  );
}

export const switchWriteNetwork = jest.fn(async () => true);

/** `write`, which keeps each call's promise in `writes` until it settles. */
function tracked<A extends unknown[], R>(writes: Set<Promise<unknown>>, write: (...args: A) => Promise<R>) {
  return (...args: A) => {
    const pending = write(...args);
    writes.add(pending);
    const forget = () => writes.delete(pending);
    pending.then(forget, forget);
    return pending;
  };
}

export const queued = () => live.queue.getActions(BASE_ASSET, [], [StateType.Loading]);
export const positionCard = () => mockLastProps.PositionCard.state[1];

/** Whether `record` is a wrapped run still being checked, signed or followed to its receipt. */
export const isRunInFlight = (record = live.submission.record) =>
  record !== undefined && record.status.kind !== 'stopped';

/** Whether a change to the stored holds is in progress: the store's lock lease is in storage. */
export const isHoldStoreChanging = () =>
  Object.keys(window.localStorage).some((key) =>
    key.startsWith(`${DirectWithdrawalHold.DIRECT_WITHDRAWAL_HOLDS_KEY}:lock:`)
  );

/**
 * Waits until no wrapped run is in flight, no wrapper action it sent still locks the queue, no change
 * to the stored holds is in progress, and every write handed to the manager has returned.
 */
export const waitForIdle = () =>
  waitFor(() => {
    expect(isRunInFlight()).toBe(false);
    expect(live.submission.sent).toBeUndefined();
    expect(isHoldStoreChanging()).toBe(false);
    expect(live.writes.size).toBe(0);
  });

/**
 * Presses Submit Transaction and waits until the run and the writes the press started have ended,
 * the queue is unlocked again and the run's changes to the stored holds are done. A press that
 * starts no run or write returns at once.
 */
export async function submit() {
  const recordBefore = live.submission.record;
  const writesBefore = new Set(live.writes);
  act(() => positionCard().onSubmitClicked());
  // A run sets its record in the press itself.
  const isRunStarted = live.submission.record !== recordBefore;
  await waitFor(() => {
    if (isRunStarted) {
      expect(isRunInFlight()).toBe(false);
      expect(live.submission.sent).toBeUndefined();
      expect(isHoldStoreChanging()).toBe(false);
    }
    expect([...live.writes].filter((write) => !writesBefore.has(write))).toEqual([]);
  });
}

/** Every look at whether a stored hold's request can no longer execute. */
export const holdLooks = jest.spyOn(DirectWithdrawalHold, 'isHoldResolved');

/** Waits for a look at the stored holds after the first `since`, and until every such look has ended. */
export async function waitForHoldLook(since: number) {
  await waitFor(() => expect(holdLooks.mock.calls.length).toBeGreaterThan(since));
  await act(async () => {
    await Promise.allSettled(holdLooks.mock.results.slice(since).map(({ value }) => value));
  });
}

export function renderDashboard(
  chain: Chain,
  { state = COMET_STATE, position, tab = 'a' }: { state?: CometState; position?: WrappedPosition; tab?: string } = {}
) {
  // The first tab starts from empty storage. Another tab opens over what storage holds.
  if (tab === 'a') window.localStorage.clear();
  const wallets = { 1: walletFor(chain, 1), 8453: walletFor(chain, 8453) };
  const props: DashboardProps = {
    wallets,
    readProvider: withTotals(chain, readProviderFor(chain)),
    walletChainId: 1,
    state: [StateType.Loading, undefined] as unknown as CometState,
    position,
    tab,
  };
  let view = render(<Dashboard {...props} />);
  const show = (changes: Partial<DashboardProps>) => view.rerender(<Dashboard {...props} state={state} {...changes} />);
  show({});
  // A reload: App and every hook start again from what storage holds, with the same wallet.
  const reload = (changes: Partial<DashboardProps> = {}) => {
    view.unmount();
    view = render(<Dashboard {...props} {...changes} />);
    view.rerender(<Dashboard {...props} {...changes} state={state} />);
  };
  return { wallet: wallets[1], show, reload, readProvider: props.readProvider };
}

/**
 * Submits the queued wrapper action, then switches the wallet to Base while its receipt is held
 * back, as a user can while the transaction is pending. Submit asks the wallet at once, with no
 * dialog, and the position card shows the transaction as production shows one to Comet.
 */
export async function sendThenSwitchNetwork(wallet: Wallet, show: (changes: Partial<DashboardProps>) => void) {
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
export function expectQueueHeld(entry: Action) {
  act(() => positionCard().onSelectAction(entry));
  act(() => positionCard().onDeleteAction(entry));
  act(() => positionCard().onClearClicked());
  act(() => mockLastProps.Masthead.state[1].onSupplyAction([ActionType.Supply, BASE_ASSET, undefined]));
  act(() => mockLastProps.Masthead.state[1].onWithdrawAction([ActionType.Withdraw, BASE_ASSET, undefined]));

  expect(queued()).toEqual([entry]);
  expect(live.queue.getPendingAction(BASE_ASSET, [])).toBeUndefined();
}

/** A promise the test resolves. */
export function held<T>() {
  let release: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => (release = resolve));
  return { promise, release };
}

/** 250 USDC supplied to Comet directly, outside the wrapper. */
export const DIRECT = 250_000_000n;
export const WRAPPED_SHARES = 250n * 10n ** 18n;

/** The Comet state with `directSupply` supplied to Comet directly, as useCometState reads it for the account. */
export function stateWithDirectSupply(directSupply: bigint, collateralAssets: unknown[] = []): CometState {
  const state = [
    StateType.Hydrated,
    { ...COMET_STATE[1], baseAsset: { ...BASE_ASSET, balance: directSupply }, collateralAssets },
  ] as unknown as CometState;
  recordCometStateSource(state, { chainId: 1, cometAddress: USDC_COMET }, ACCOUNT);
  return state;
}

/** The account's wrapped position on the chain, as useWrappedPosition reads it. */
export function positionOn(chain: Chain): WrappedPosition {
  const grossAssets = (chain.shares * (chain.totalAssets + 1n)) / (chain.totalSupply + 10n ** 12n);
  return {
    shares: chain.shares,
    shareDecimals: 18,
    grossAssets,
    baseDecimals: 6,
    baseWalletBalance: chain.balance,
    wrapperAllowance: chain.allowance,
    redeemBuffer: chain.baseSupplyIndex / 10n ** 15n + 2n,
    fullExitCash: exitCashAt(chain, chain.shares),
    isWithdrawPaused: false,
    snapshot: {
      totalSupply: chain.totalSupply,
      totalAssets: chain.totalAssets,
      baseSupplyIndex: chain.baseSupplyIndex,
    },
  };
}

/** The wallet's requests in the order the dashboard made them, by method. */
export const requestedCalls = (wallet: Wallet) =>
  wallet.sendUncheckedTransaction.mock.calls.map(([request]) => CALLS.parseTransaction(request).name);

/** The Comet base withdrawals the wallet was asked for: the contract, the data and its arguments. */
export const cometWithdrawals = (wallet: Wallet) =>
  sentCalls(wallet, 'withdraw').map(([request]) => {
    const call = CALLS.parseTransaction(request);
    return { to: request.to, data: request.data, args: [String(call.args[0]), BigInt(call.args[1].toString())] };
  });

/** Comet's `withdraw(asset, amount)` as production's useWriteCometState encodes it. */
export const productionWithdrawData = (amount: bigint) =>
  COMET.encodeFunctionData('withdraw', [MARKET.baseTokenAddress, amount.toString()]);

/** As `renderMixed`, with the configured chain's provider the dashboard reads through. */
export async function renderMixedWithProvider() {
  const mixed = await renderMixed();
  return { ...mixed, readProvider: mockLastProps.readProvider as ReturnType<typeof readProviderFor> };
}

/** A chain with the direct supply and the wrapped shares, and the dashboard showing both. */
export async function renderMixed() {
  const chain = chainFor({ shares: WRAPPED_SHARES, directSupply: DIRECT });
  const { wallet, show, reload, readProvider } = renderDashboard(chain, {
    state: stateWithDirectSupply(DIRECT),
    position: positionOn(chain),
  });
  await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
  return { chain, wallet, show, reload, readProvider };
}

/** Anchorage's answer to a request it still holds: it can still complete in the wallet. */
export const answer4900 = (wallet: Wallet) =>
  wallet.sendUncheckedTransaction.mockImplementationOnce(async () =>
    Promise.reject({ code: 4900, message: 'The request can still complete in the wallet.' })
  );
/**
 * The held 200 USDC request executes after all: the wallet sends it outside the app, from the
 * account to Comet with the calldata the app asked it to sign.
 */
export const executeLate = (chain: Chain) =>
  mine(chain, { to: USDC_COMET, data: productionWithdrawData(200_000_000n) });
export const storedHolds = () =>
  JSON.parse(window.localStorage.getItem(DirectWithdrawalHold.DIRECT_WITHDRAWAL_HOLDS_KEY) ?? '[]');
export const storedRecords = () => JSON.parse(window.localStorage.getItem(TRANSACTION_LOCALSTORAGE_KEY) ?? '[]');
/** The hash the replaced cases' wallet returns, which the node never mines. */
export const REPLACED_HASH = `0x${'ab'.repeat(32)}`;
/** The configured chain's node reports `hash`'s own nonce as 5, and the account's count as 6. */
export const reportOwnNonceTaken = (readProvider: ReturnType<typeof readProviderFor>, hash: string) => {
  const lookUp = readProvider.getTransaction.getMockImplementation() as (hash: string) => Promise<unknown>;
  readProvider.getTransaction.mockImplementation((async (asked: string) =>
    asked === hash ? { nonce: 5 } : lookUp(asked)) as never);
  readProvider.getTransactionCount.mockImplementation(async () => 6);
};

/** A 200 USDC withdrawal whose Comet step the wallet answers with 4900, against `direct` supplied directly. */
export async function holdFirstStep(direct = DIRECT) {
  const chain = chainFor({ shares: WRAPPED_SHARES, directSupply: direct });
  const view = renderDashboard(chain, { state: stateWithDirectSupply(direct), position: positionOn(chain) });
  await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
  const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
  act(() => live.queue.addOrUpdateAction(entry));
  answer4900(view.wallet);
  await submit();
  expect(queued()).toEqual([]);
  expect(requestedCalls(view.wallet)).toEqual(['withdraw']);
  return { ...view, chain, entry };
}

/** Submits `entry` again and checks that nothing reaches the wallet and the row says why. */
export async function expectHeldBack(wallet: Wallet, chain: Chain, entry: Action) {
  const looks = holdLooks.mock.calls.length;
  await submit();
  expect(requestedCalls(wallet)).toEqual(['withdraw']);
  expect(queued()).toEqual([entry]);
  expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
    action: [ActionType.Withdraw, expect.anything(), entry[2]],
    label: 'Earlier Request Still Pending',
  });
  // Every look at the hold has ended, and any change it made to the stored holds is done: the hold stays.
  await waitForHoldLook(looks);
  await waitForIdle();
  expect(storedHolds()).toEqual([expect.objectContaining({ kind: 'held', amount: String(entry[2]) })]);
  // Should the held request now execute, Comet takes 200 USDC of the supply and lends nothing.
  executeLate(chain);
  expect(chain.borrowed).toBe(0n);
}
