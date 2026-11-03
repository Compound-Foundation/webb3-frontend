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
import { recordCometStateSource } from '@helpers/cometStateSource';
import { TRANSACTION_LOCALSTORAGE_KEY } from '@helpers/constants';
import { DIRECT_WITHDRAWAL_HOLDS_KEY } from '@helpers/directWithdrawalHold';
import { LendingSession, resolveLendingRoute, wrappedRouteKey } from '@helpers/lendingRoute';
import { getMarket } from '@helpers/markets';
import { MAX_UINT256 } from '@helpers/numbers';
import { WrappedSession } from '@helpers/wrappedActions';
import { WrappedPosition } from '@helpers/wrappedPositions';
import { useActionQueue } from '@hooks/useActionQueue';
import { useSubmissionStore } from '@hooks/useSubmissionStore';
import { Theme } from '@hooks/useThemeManager';
import { useTransactionManager } from '@hooks/useTransactionManager';
import { useSignWhenReady, useWrappedAction } from '@hooks/useWrappedAction';
import { useWriteWrappedState } from '@hooks/useWriteWrappedState';
import { Action, ActionType, CometState, MarketData, StateType, TransactionState } from '@types';

import { mockBaseAsset } from '../../../../__tests__/mocks/mockBaseAsset';
import { mockEthCollateralAsset } from '../../../../__tests__/mocks/mockCollateralAssets';
import { mockWeb3 } from '../../../../__tests__/mocks/mockWeb3';
import Home from '../index';

// uuid ships ESM only, which Jest does not load here. The transaction manager uses it.
let mockNextId = 0;
jest.mock('uuid', () => ({ v4: () => `transaction-${++mockNextId}` }));

// Home's children record their props: those of the first tab in `mockLastProps`, and every tab's in
// `mockTabProps`.
const mockLastProps: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
const mockTabProps: Record<string, Record<string, any>> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
const mockTab = jest.requireActual('react').createContext('a');
function mockRecordProps(name: string) {
  return {
    __esModule: true,
    default: (props: unknown) => {
      const tab: string = jest.requireActual('react').useContext(mockTab);
      if (tab === 'a') mockLastProps[name] = props;
      mockTabProps[tab] = { ...mockTabProps[tab], [name]: props };
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
  'function withdraw(address asset, uint256 amount)',
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

type MinedCall = {
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
function chainFor({ allowance = 0n, shares = 0n, directSupply = 0n } = {}): Chain {
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
function exitCashAt(chain: Chain, shares: bigint): bigint {
  const worth = (shares * (chain.totalAssets + 1n)) / (chain.totalSupply + 10n ** 12n);
  const buffer = chain.baseSupplyIndex / 10n ** 15n + 2n;
  return worth <= buffer ? 0n : worth - buffer;
}

/**
 * Mines a call from the account as the base token and the wrapper do, and keeps it in the chain's
 * history under `hash`. Returns whether it succeeded.
 */
function mine(chain: Chain, call: { to: string; data: string }, hash?: string): boolean {
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

function execute(chain: Chain, { to, data }: { to: string; data: string }): boolean {
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
const blockHashAt = (blockNumber: number) => `0x${'b'.repeat(56)}${blockNumber.toString(16).padStart(8, '0')}`;

/** The configured chain's public provider, at the newest block. */
function readProviderFor(chain: Chain) {
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
function withTotals(chain: Chain, provider: ReturnType<typeof readProviderFor>) {
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
function walletFor(chain: Chain, chainId: number) {
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
type Wallet = ReturnType<typeof walletFor>;

/** The names of the wallet requests the wrapper was asked to carry out. */
const sentCalls = (wallet: Wallet, method: string) =>
  wallet.sendUncheckedTransaction.mock.calls.filter(([request]) => CALLS.parseTransaction(request).name === method);

function sessionFor(wallet: object, chainId: number, connectorId = ANCHORAGE_CONNECTOR_ID): WrappedSession {
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
/** Every open tab's hooks, by tab. */
const lives: Record<string, Live> = {};

type DashboardProps = {
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
function Dashboard({
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
  const manager = useTransactionManager(web3);
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
  const queue = useActionQueue(SELECTED.selectedMarket as never, () => undefined, {
    account: ACCOUNT,
    connector: `${connectorId}-1`,
    status: 'connected',
  });
  const market = storeMarket;
  const submission = useSubmissionStore({
    scope: submissionScope(web3.write, market),
    queueScope: queueScope(web3.write, market),
    transactions: manager.transactions,
    settledTransactions: manager.settledTransactions,
    removeAction: queue.removeAction,
  });
  lives[tab] = { queue, manager, action };
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

function renderDashboard(
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

/** 250 USDC supplied to Comet directly, outside the wrapper. */
const DIRECT = 250_000_000n;
const WRAPPED_SHARES = 250n * 10n ** 18n;

/** The Comet state with `directSupply` supplied to Comet directly, as useCometState reads it for the account. */
function stateWithDirectSupply(directSupply: bigint, collateralAssets: unknown[] = []): CometState {
  const state = [
    StateType.Hydrated,
    { ...COMET_STATE[1], baseAsset: { ...BASE_ASSET, balance: directSupply }, collateralAssets },
  ] as unknown as CometState;
  recordCometStateSource(state, { chainId: 1, cometAddress: USDC_COMET }, ACCOUNT);
  return state;
}

/** The account's wrapped position on the chain, as useWrappedPosition reads it. */
function positionOn(chain: Chain): WrappedPosition {
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
const requestedCalls = (wallet: Wallet) =>
  wallet.sendUncheckedTransaction.mock.calls.map(([request]) => CALLS.parseTransaction(request).name);

/** The Comet base withdrawals the wallet was asked for: the contract, the data and its arguments. */
const cometWithdrawals = (wallet: Wallet) =>
  sentCalls(wallet, 'withdraw').map(([request]) => {
    const call = CALLS.parseTransaction(request);
    return { to: request.to, data: request.data, args: [String(call.args[0]), BigInt(call.args[1].toString())] };
  });

/** Comet's `withdraw(asset, amount)` as production's useWriteCometState encodes it. */
const productionWithdrawData = (amount: bigint) =>
  COMET.encodeFunctionData('withdraw', [MARKET.baseTokenAddress, amount.toString()]);

describe('a withdrawal on the wrapped route from an account with a direct Comet supply', () => {
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

  /** As `renderMixed`, with the configured chain's provider the dashboard reads through. */
  async function renderMixedWithProvider() {
    const mixed = await renderMixed();
    return { ...mixed, readProvider: mockLastProps.readProvider as ReturnType<typeof readProviderFor> };
  }

  /** A chain with the direct supply and the wrapped shares, and the dashboard showing both. */
  async function renderMixed() {
    const chain = chainFor({ shares: WRAPPED_SHARES, directSupply: DIRECT });
    const { wallet, show, reload, readProvider } = renderDashboard(chain, {
      state: stateWithDirectSupply(DIRECT),
      position: positionOn(chain),
    });
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    return { chain, wallet, show, reload, readProvider };
  }

  it.each([
    // A part below the direct supply is withdrawn as itself.
    ['below', 100_000_000n, 100_000_000n],
    // An amount equal to it is withdrawn with type(uint256).max, which never borrows.
    ['equal to', DIRECT, MAX_UINT256],
  ])(
    'sends an amount %s the direct supply as one Comet base withdrawal, the transaction production sends, and never calls the wrapper',
    async (_name, amount, sentAmount) => {
      const { chain, wallet } = await renderMixed();
      act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, amount]));

      await submit();
      await waitFor(() => expect(queued()).toEqual([]));

      expect(live.manager.settledTransactions.map(({ key, outcome }) => [key, outcome.status])).toEqual([
        [USDC_COMET, 'confirmed'],
      ]);
      expect(requestedCalls(wallet)).toEqual(['withdraw']);
      expect(cometWithdrawals(wallet)).toEqual([
        { to: USDC_COMET, data: productionWithdrawData(sentAmount), args: [MARKET.baseTokenAddress, sentAmount] },
      ]);
      expect(chain.directSupply).toBe(DIRECT - amount);
      expect(chain.borrowed).toBe(0n);
      expect(chain.shares).toBe(WRAPPED_SHARES);
      expect(chain.balance).toBe(10_000_000_000n + amount);
      expect(screen.queryByRole('dialog')).toBeNull();
    }
  );

  it('withdraws an amount equal to the direct supply without borrowing when the supply falls before signing', async () => {
    const { chain, wallet } = await renderMixed();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, DIRECT]));
    // 50 USDC of the direct supply leaves in another transaction after the fresh read, before the
    // Comet step executes. A finite withdraw(base, 250 USDC) would borrow 50 USDC.
    const send = wallet.cometSigner.sendTransaction.getMockImplementation();
    if (send === undefined) throw new Error('the signer must send');
    wallet.cometSigner.sendTransaction.mockImplementationOnce(async (request) => {
      chain.directSupply -= 50_000_000n;
      return send(request);
    });

    await submit();
    await waitFor(() => expect(live.manager.settledTransactions).toHaveLength(1));
    await settle();

    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([MAX_UINT256]);
    expect(chain.borrowed).toBe(0n);
    expect(chain.directSupply).toBe(0n);
    // Comet paid the 200 USDC it held. The split planned no wrapper step, so none is asked for: the
    // row keeps the 50 USDC rest and asks for a new amount.
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(queued()).toEqual([[ActionType.Withdraw, expect.anything(), 50_000_000n]]);
    expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
      action: [ActionType.Withdraw, expect.anything(), 50_000_000n],
      label: 'Balance Changed, Edit Amount',
    });
  });

  it('sends a larger amount as Comet withdraw(base, max), then unwrapAndWithdraw for the rest only once the Comet step confirms', async () => {
    const { chain, wallet } = await renderMixed();
    const amount = 300_000_000n;
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, amount];
    act(() => live.queue.addOrUpdateAction(entry));
    const send = wallet.sendUncheckedTransaction.getMockImplementation();
    if (send === undefined) throw new Error('the wallet must send');
    const wrapperAnswer = held<void>();
    wallet.sendUncheckedTransaction.mockImplementationOnce(send).mockImplementationOnce(async (request) => {
      await wrapperAnswer.promise;
      return send(request);
    });
    wallet.holdReceipts();

    act(() => positionCard().onSubmitClicked());
    // From the press, the dashboard is held as for a transaction to Comet.
    expect(positionCard().transaction?.state).toBe(TransactionState.AwaitingConfirmation);
    await waitFor(() => expect(requestedCalls(wallet)).toEqual(['withdraw']));
    await settle();
    // The Comet step's receipt is pending: nothing is asked of the wrapper, and the row is held.
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(cometWithdrawals(wallet)).toEqual([
      { to: USDC_COMET, data: productionWithdrawData(MAX_UINT256), args: [MARKET.baseTokenAddress, MAX_UINT256] },
    ]);
    expectQueueHeld(entry);
    expect(positionCard().transaction?.state).toBe(TransactionState.Pending);

    wallet.releaseReceipts();
    await waitFor(() => expect(requestedCalls(wallet)).toEqual(['withdraw', 'unwrapAndWithdraw']));
    // The row now holds what the wrapper still pays, and stays held while the wallet has the request.
    expect(queued()).toEqual([[ActionType.Withdraw, expect.anything(), amount - DIRECT]]);
    expect(positionCard().transaction?.state).toBe(TransactionState.AwaitingConfirmation);
    expect(chain.directSupply).toBe(0n);

    const beforeExit = { ...chain };
    wrapperAnswer.release();
    await waitFor(() => expect(queued()).toEqual([]));
    const [unwrap] = sentCalls(wallet, 'unwrapAndWithdraw');
    const burned = BigInt(CALLS.parseTransaction(unwrap[0]).args[0].toString());
    expect(beforeExit.shares - chain.shares).toBe(burned);
    // The fewest shares that pay the rest: one share fewer pays less.
    expect(exitCashAt(beforeExit, burned)).toBeGreaterThanOrEqual(amount - DIRECT);
    expect(exitCashAt(beforeExit, burned - 1n)).toBeLessThan(amount - DIRECT);
    expect(chain.borrowed).toBe(0n);
    expect(chain.balance - 10_000_000_000n).toBeGreaterThanOrEqual(amount);
    expect(chain.balance - 10_000_000_000n).toBeLessThan(amount + 10n);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('withdraws everything for Max: Comet withdraw(base, max), then a full exit of every share', async () => {
    const { chain, wallet } = await renderMixed();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, MAX_UINT256]));

    await submit();
    await waitFor(() => expect(queued()).toEqual([]));

    expect(requestedCalls(wallet)).toEqual(['withdraw', 'unwrapAndWithdraw']);
    expect(cometWithdrawals(wallet)[0].args).toEqual([MARKET.baseTokenAddress, MAX_UINT256]);
    const [unwrap] = sentCalls(wallet, 'unwrapAndWithdraw');
    expect(BigInt(CALLS.parseTransaction(unwrap[0]).args[0].toString())).toBe(WRAPPED_SHARES);
    expect(chain.directSupply).toBe(0n);
    expect(chain.shares).toBe(0n);
    expect(chain.borrowed).toBe(0n);
  });

  it.each<[string, (wallet: Wallet, chain: Chain) => void, { queue: 'kept' | 'rest'; label?: string }]>([
    [
      'is declined in the wallet',
      (wallet) => wallet.sendUncheckedTransaction.mockRejectedValueOnce({ code: 4001, message: 'User rejected.' }),
      { queue: 'kept' },
    ],
    ['reverts', (_wallet, chain) => (chain.shouldRevertNext = true), { queue: 'kept', label: 'Transaction Failed' }],
    [
      'is refused by the wallet before it handles it',
      (wallet) => wallet.sendUncheckedTransaction.mockRejectedValueOnce({ code: 4100, message: 'Unauthorized' }),
      { queue: 'kept', label: 'Reconnect Your Wallet' },
    ],
    [
      'fails in the wallet after it had the request',
      (wallet) => wallet.sendUncheckedTransaction.mockRejectedValueOnce({ code: -32603, message: 'Internal error' }),
      { queue: 'rest' },
    ],
  ])('sends nothing to the wrapper when the Comet step %s', async (_name, fail, expected) => {
    const { chain, wallet } = await renderMixed();
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 300_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    fail(wallet, chain);

    await submit();
    await settle();

    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(sentCalls(wallet, 'unwrapAndWithdraw')).toHaveLength(0);
    expect(chain.shares).toBe(WRAPPED_SHARES);
    expect(chain.borrowed).toBe(0n);
    expect(queued()).toEqual(
      expected.queue === 'kept' ? [entry] : [[ActionType.Withdraw, expect.anything(), 300_000_000n - DIRECT]]
    );
    const stopped = positionCard().actionRules.wrappedBase.stopped;
    expect(stopped).toEqual(
      expected.label === undefined
        ? undefined
        : { action: [ActionType.Withdraw, expect.anything(), entry[2]], label: expected.label }
    );
    expect(positionCard().transaction).toBeUndefined();
  });

  it('leaves the rest queued, and asks the wrapper for nothing, when the Comet step confirms while another page is shown', async () => {
    const { chain, wallet, show } = await renderMixed();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 300_000_000n]));
    wallet.holdReceipts();
    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(requestedCalls(wallet)).toEqual(['withdraw']));

    show({ isHomeShown: false });
    wallet.releaseReceipts();
    await waitFor(() => expect(live.manager.settledTransactions).toHaveLength(1));
    await settle();

    // No wallet request opens on another page. The row holds what the wrapper still pays.
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(chain.directSupply).toBe(0n);
    expect(queued()).toEqual([[ActionType.Withdraw, expect.anything(), 50_000_000n]]);

    show({ isHomeShown: true });
    await settle();
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(positionCard().transaction).toBeUndefined();
  });

  it.each<[string, (collateral: ReturnType<typeof mockEthCollateralAsset>) => Action]>([
    ['a collateral supply', (collateral) => [ActionType.SupplyCollateral, collateral, 10n ** 17n]],
    // isSubmissionRefused refuses this borrow beside the direct supply, and the row still says why.
    ['a borrow', () => [ActionType.Borrow, BASE_ASSET, 100_000_000n]],
  ])('sends nothing, and says why on the row, when the withdrawal is queued with %s', async (_name, other) => {
    const chain = chainFor({ shares: WRAPPED_SHARES, directSupply: DIRECT });
    const collateral = mockEthCollateralAsset({ walletBalance: 10n ** 18n, allowance: MAX_UINT256 });
    const { wallet } = renderDashboard(chain, {
      state: stateWithDirectSupply(DIRECT, [collateral]),
      position: positionOn(chain),
    });
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, MAX_UINT256];
    act(() => live.queue.addOrUpdateAction(entry));
    act(() => live.queue.addOrUpdateAction(other(collateral)));

    await submit();

    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(live.manager.transactions).toEqual([]);
    expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
      action: [ActionType.Withdraw, expect.anything(), entry[2]],
      label: 'Submit The Withdrawal On Its Own',
    });
    expect(chain.directSupply).toBe(DIRECT);
  });

  /** Anchorage's answer to a request it still holds: it can still complete in the wallet. */
  const answer4900 = (wallet: Wallet) =>
    wallet.sendUncheckedTransaction.mockImplementationOnce(async () =>
      Promise.reject({ code: 4900, message: 'The request can still complete in the wallet.' })
    );
  /**
   * The held 200 USDC request executes after all: the wallet sends it outside the app, from the
   * account to Comet with the calldata the app asked it to sign.
   */
  const executeLate = (chain: Chain) => mine(chain, { to: USDC_COMET, data: productionWithdrawData(200_000_000n) });
  const storedHolds = () => JSON.parse(window.localStorage.getItem(DIRECT_WITHDRAWAL_HOLDS_KEY) ?? '[]');
  const storedRecords = () => JSON.parse(window.localStorage.getItem(TRANSACTION_LOCALSTORAGE_KEY) ?? '[]');
  /** The hash the replaced cases' wallet returns, which the node never mines. */
  const REPLACED_HASH = `0x${'ab'.repeat(32)}`;
  /** The configured chain's node reports `hash`'s own nonce as 5, and the account's count as 6. */
  const reportOwnNonceTaken = (readProvider: ReturnType<typeof readProviderFor>, hash: string) => {
    const lookUp = readProvider.getTransaction.getMockImplementation() as (hash: string) => Promise<unknown>;
    readProvider.getTransaction.mockImplementation((async (asked: string) =>
      asked === hash ? { nonce: 5 } : lookUp(asked)) as never);
    readProvider.getTransactionCount.mockImplementation(async () => 6);
  };

  /** A 200 USDC withdrawal whose Comet step the wallet answers with 4900, against `direct` supplied directly. */
  async function holdFirstStep(direct = DIRECT) {
    const chain = chainFor({ shares: WRAPPED_SHARES, directSupply: direct });
    const view = renderDashboard(chain, { state: stateWithDirectSupply(direct), position: positionOn(chain) });
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    answer4900(view.wallet);
    await submit();
    await waitFor(() => expect(queued()).toEqual([]));
    await settle();
    expect(requestedCalls(view.wallet)).toEqual(['withdraw']);
    return { ...view, chain, entry };
  }

  /** Submits `entry` again and checks that nothing reaches the wallet and the row says why. */
  async function expectHeldBack(wallet: Wallet, chain: Chain, entry: Action) {
    await submit();
    await settle();
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(queued()).toEqual([entry]);
    expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
      action: [ActionType.Withdraw, expect.anything(), entry[2]],
      label: 'Earlier Request Still Pending',
    });
    // Should the held request now execute, Comet takes 200 USDC of the supply and lends nothing.
    executeLate(chain);
    expect(chain.borrowed).toBe(0n);
  }

  it('stores a Comet step the wallet still holds (Anchorage 4900) as a hold with its calldata and block', async () => {
    await holdFirstStep();

    // Not shown as a transaction to follow: the dashboard is free, and the next Comet step is held.
    expect(positionCard().transaction).toBeUndefined();
    expect(storedHolds()).toEqual([
      {
        kind: 'held',
        id: expect.any(String),
        account: ACCOUNT.toLowerCase(),
        chainId: 1,
        cometAddress: USDC_COMET.toLowerCase(),
        calldata: productionWithdrawData(200_000_000n).toLowerCase(),
        amount: '200000000',
        blockNumber: 100,
      },
    ]);
  });

  it('holds back a second partial withdrawal after a 4900, so the two never borrow', async () => {
    const { chain, wallet, entry } = await holdFirstStep();
    act(() => live.queue.addOrUpdateAction(entry));
    await expectHeldBack(wallet, chain, entry);
  });

  it('keeps the hold after a change of market and back', async () => {
    const { chain, wallet, show, entry } = await holdFirstStep();
    // USDT is selected, then USDC again: App's store follows the other market meanwhile.
    show({
      isHomeShown: false,
      storeMarket: { chainId: 1, cometAddress: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840' },
    });
    await settle();
    show({ isHomeShown: true });
    await settle();
    act(() => live.queue.addOrUpdateAction(entry));
    await expectHeldBack(wallet, chain, entry);
  });

  it('keeps the hold when the row is removed and added again, or edited', async () => {
    const { chain, wallet, entry } = await holdFirstStep();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 150_000_000n]));
    act(() => live.queue.removeAction([ActionType.Withdraw, BASE_ASSET, 150_000_000n]));
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 100_000_000n]));
    // Edited to the same 200 USDC.
    act(() => live.queue.addOrUpdateAction(entry));
    await expectHeldBack(wallet, chain, entry);
  });

  it('keeps the hold across a reload, from what storage holds', async () => {
    const { chain, wallet, reload, entry } = await holdFirstStep();
    reload();
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    act(() => live.queue.addOrUpdateAction(entry));
    await expectHeldBack(wallet, chain, entry);
  });

  it('keeps the hold when the transaction list is cleared', async () => {
    const { chain, wallet, entry } = await holdFirstStep();
    act(() => live.manager.clearTransactions());
    await settle();
    act(() => live.queue.addOrUpdateAction(entry));
    await expectHeldBack(wallet, chain, entry);
  });

  it('ends the hold once the held calldata is found mined from the account, and then sends the next Comet step', async () => {
    const { chain, wallet, entry } = await holdFirstStep();
    executeLate(chain);
    // 30 USDC more: within the 50 USDC the direct supply still holds.
    const next: Action = [ActionType.Withdraw, BASE_ASSET, 30_000_000n];
    act(() => live.queue.addOrUpdateAction(next));

    await submit();
    await waitFor(() => expect(queued()).toEqual([]));

    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([entry[2], 30_000_000n]);
    await waitFor(() => expect(storedHolds()).toEqual([]));
    expect(chain.directSupply).toBe(20_000_000n);
    expect(chain.borrowed).toBe(0n);
  });

  it('ends the hold once the Comet state is read again and the held calldata is found mined', async () => {
    const { chain, show } = await holdFirstStep();
    executeLate(chain);
    // useCometState reads the account again, and finds 50 USDC.
    show({ state: stateWithDirectSupply(50_000_000n) });
    await waitFor(() => expect(storedHolds()).toEqual([]));
  });

  it('keeps the hold when another interface supplies 100 USDC and withdraws 301, which leaves the held request funded', async () => {
    // Sol's case: 450 USDC supplied directly when the 200 USDC request is held.
    const { chain, wallet, show, entry } = await holdFirstStep(450_000_000n);
    chain.directSupply += 100_000_000n;
    mine(chain, { to: USDC_COMET, data: productionWithdrawData(301_000_000n) });
    expect(chain.directSupply).toBe(249_000_000n);
    show({ state: stateWithDirectSupply(chain.directSupply) });
    await settle();

    act(() => live.queue.addOrUpdateAction(entry));
    await submit();
    await settle();
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(positionCard().actionRules.wrappedBase.stopped?.label).toBe('Earlier Request Still Pending');
    // The held request executes after all: 49 USDC stay, and Comet lends nothing.
    executeLate(chain);
    expect(chain.directSupply).toBe(49_000_000n);
    expect(chain.borrowed).toBe(0n);
  });

  it('keeps the hold when the direct supply is gone by other means, which does not show the request is dead', async () => {
    const { chain, wallet, show, entry } = await holdFirstStep();
    // Another interface withdraws the whole direct supply, and the dashboard reads none.
    mine(chain, { to: USDC_COMET, data: productionWithdrawData(MAX_UINT256) });
    show({ state: stateWithDirectSupply(0n) });
    await settle();
    // 250 USDC is supplied directly again from elsewhere.
    chain.directSupply = DIRECT;
    show({ state: stateWithDirectSupply(DIRECT) });
    await settle();

    act(() => live.queue.addOrUpdateAction(entry));
    await expectHeldBack(wallet, chain, entry);
  });

  it('keeps the hold while the direct supply grows and the held request has not executed', async () => {
    const { chain, wallet, show, entry } = await holdFirstStep();
    chain.baseSupplyIndex += 10n ** 12n;
    chain.directSupply += 300_000_000n;
    show({ state: stateWithDirectSupply(chain.directSupply) });
    await settle();
    act(() => live.queue.addOrUpdateAction(entry));
    await expectHeldBack(wallet, chain, entry);
  });

  it('sends the next Comet step once another transaction took the own nonce of the last, which can then no longer execute', async () => {
    const { chain, wallet, readProvider } = await renderMixed();
    reportOwnNonceTaken(readProvider, REPLACED_HASH);
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    // The step is sent, but the node never shows a receipt for it, and its own nonce has passed.
    wallet.sendUncheckedTransaction.mockImplementationOnce(async () => `0x${'ab'.repeat(32)}`);
    wallet.getTransaction.mockImplementation(async () => ({ nonce: 5 } as never));
    wallet.getTransactionCount.mockImplementationOnce(async () => 5).mockImplementation(async () => 6);

    await submit();
    await waitFor(() => expect(queued()).toEqual([]));
    await settle();
    expect(live.manager.transactions).toEqual([]);
    expect(live.manager.settledTransactions.map(({ outcome }) => outcome.status)).toEqual(['replaced']);
    await waitFor(() => expect(storedHolds()).toEqual([]));

    act(() => live.queue.addOrUpdateAction(entry));
    await submit();
    await waitFor(() => expect(queued()).toEqual([]));

    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([entry[2], entry[2]]);
    expect(chain.borrowed).toBe(0n);
  });

  it('holds nothing when the Comet step fails before the wallet is asked, as when its gas estimate fails', async () => {
    const { chain, wallet } = await renderMixed();
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    wallet.cometSigner.estimateGas.mockRejectedValueOnce(new Error('request timed out'));

    await submit();
    await settle();
    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(live.manager.transactions).toEqual([]);
    expect(storedRecords()).toEqual([]);
    await waitFor(() => expect(storedHolds()).toEqual([]));
    expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
      action: [ActionType.Withdraw, expect.anything(), entry[2]],
      label: 'Not Sent, Try Again',
    });

    // Nothing reached the wallet, so the next Submit sends the step.
    await submit();
    await waitFor(() => expect(queued()).toEqual([]));
    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([entry[2]]);
    expect(chain.borrowed).toBe(0n);
  });

  it('estimates the call the fresh split sends, withdraw(base, max), when the supply fell below a planned part', async () => {
    const { chain, wallet } = await renderMixed();
    const amount = 200_000_000n;
    // As Comet's estimate does: a part above the supply would borrow, and the account has no collateral.
    wallet.cometSigner.estimateGas.mockImplementation(async (request: { data: string }) => {
      const asked = BigInt(COMET.decodeFunctionData('withdraw', request.data)[1].toString());
      if (asked !== MAX_UINT256 && asked > chain.directSupply) throw new Error('execution reverted: NotCollateralized');
      return BigNumber.from(100_000);
    });
    // The dashboard read 250 USDC, so Submit plans withdraw(base, 200 USDC). 150 USDC has left since.
    chain.directSupply = 100_000_000n;
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, amount]));

    await submit();
    await waitFor(() => expect(queued()).toEqual([]));

    const estimated = wallet.cometSigner.estimateGas.mock.calls.map(([request]) =>
      BigInt(COMET.decodeFunctionData('withdraw', request.data)[1].toString())
    );
    expect(estimated).toEqual([MAX_UINT256]);
    expect(requestedCalls(wallet)).toEqual(['withdraw', 'unwrapAndWithdraw']);
    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([MAX_UINT256]);
    expect(chain.balance - 10_000_000_000n).toBeGreaterThanOrEqual(amount);
    expect(chain.borrowed).toBe(0n);
  });

  it('estimates and sends withdraw(base, 40 USDC) when Comet holds less cash than the direct supply but enough for the part', async () => {
    const { chain, wallet } = await renderMixed();
    const amount = 40_000_000n;
    // Comet holds 100 USDC of cash beside the 250 USDC direct supply, so withdraw(base, max) cannot
    // transfer, while withdraw(base, 40 USDC) can.
    chain.cometCash = 100_000_000n;
    wallet.cometSigner.estimateGas.mockImplementation(async (request: { data: string }) => {
      const asked = BigInt(COMET.decodeFunctionData('withdraw', request.data)[1].toString());
      const taken = asked === MAX_UINT256 ? chain.directSupply : asked;
      if (taken > chain.cometCash) throw new Error('execution reverted: ERC20: transfer amount exceeds balance');
      return BigNumber.from(100_000);
    });
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, amount]));

    await submit();
    await settle();

    // The estimate is of the call the wallet is then asked for, byte for byte.
    const estimated = wallet.cometSigner.estimateGas.mock.calls.map(([request]) => request.data);
    expect(estimated).toEqual([productionWithdrawData(amount)]);
    expect(positionCard().actionRules.wrappedBase.stopped).toBeUndefined();
    await waitFor(() => expect(queued()).toEqual([]));
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(cometWithdrawals(wallet)).toEqual([
      { to: USDC_COMET, data: estimated[0], args: [MARKET.baseTokenAddress, amount] },
    ]);
    expect(chain.directSupply).toBe(DIRECT - amount);
    expect(chain.cometCash).toBe(100_000_000n - amount);
    expect(chain.borrowed).toBe(0n);
  });

  it('keeps the hold, with its calldata, when the app reloads while the Comet request is open in the wallet', async () => {
    const { chain, wallet, reload } = await renderMixed();
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    // The request waits for approval on a phone, and the tab reloads meanwhile.
    wallet.sendUncheckedTransaction.mockImplementationOnce(async () => new Promise<string>(() => undefined));
    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(requestedCalls(wallet)).toEqual(['withdraw']));
    expect(storedHolds()).toEqual([
      expect.objectContaining({ kind: 'held', calldata: productionWithdrawData(200_000_000n).toLowerCase() }),
    ]);

    reload();
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    act(() => live.queue.addOrUpdateAction(entry));
    await submit();
    await settle();
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(positionCard().actionRules.wrappedBase.stopped?.label).toBe('Earlier Request Still Pending');

    // The holder approves it, and it executes: its calldata is found mined, so the hold ends.
    executeLate(chain);
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 30_000_000n]));
    await submit();
    await waitFor(() => expect(queued()).toEqual([]));
    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([entry[2], 30_000_000n]);
    expect(chain.borrowed).toBe(0n);
  });

  it('holds back the Comet step while another tab of the app has stored a hold for the account', async () => {
    const { chain, wallet } = await renderMixed();
    // Another tab's open request, stored as it stores one just before it asks the wallet.
    window.localStorage.setItem(
      DIRECT_WITHDRAWAL_HOLDS_KEY,
      JSON.stringify([
        {
          kind: 'held',
          id: 'other-tab',
          account: ACCOUNT.toLowerCase(),
          chainId: 1,
          cometAddress: USDC_COMET.toLowerCase(),
          calldata: productionWithdrawData(200_000_000n).toLowerCase(),
          amount: '200000000',
          blockNumber: chain.block,
        },
      ])
    );
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));

    await submit();
    await settle();
    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(positionCard().actionRules.wrappedBase.stopped?.label).toBe('Earlier Request Still Pending');

    // Once the other tab's request has executed, its calldata is found mined, and this one goes.
    executeLate(chain);
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 30_000_000n]));
    await submit();
    await waitFor(() => expect(queued()).toEqual([]));
    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([30_000_000n]);
    expect(chain.borrowed).toBe(0n);
  });

  it('asks the wallet once when a second tab opens and submits while the first is between its reservation and the wallet', async () => {
    const { chain, wallet, readProvider } = await renderMixed();
    // The first tab's fresh read of the direct supply waits until the test answers it.
    const read = held<void>();
    const answer = readProvider.call.getMockImplementation();
    if (answer === undefined) throw new Error('the provider must answer');
    let isReadStarted = false;
    readProvider.call.mockImplementation(async (request: { to?: string; data?: string }, ...rest: unknown[]) => {
      if (isSame(request.to, USDC_COMET) && request.data === COMET.encodeFunctionData('balanceOf', [ACCOUNT])) {
        isReadStarted = true;
        await read.promise;
      }
      return (answer as (...args: unknown[]) => Promise<string>)(request, ...rest);
    });
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 200_000_000n]));
    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(isReadStarted).toBe(true));
    // The first tab has reserved its step, and estimates its gas only after the fresh read.
    expect(wallet.cometSigner.estimateGas).not.toHaveBeenCalled();

    // A second tab opens, restores what storage holds, and submits the same 200 USDC.
    const second = renderDashboard(chain, {
      state: stateWithDirectSupply(DIRECT),
      position: positionOn(chain),
      tab: 'b',
    });
    await waitFor(() => expect(lives.b.action.blockedReason('withdraw')).toBeUndefined());
    act(() => lives.b.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 200_000_000n]));
    act(() => mockTabProps.b.PositionCard.state[1].onSubmitClicked());
    await settle();
    read.release();
    await settle();
    await settle();

    // Exactly one withdraw reaches the wallet, and the second tab's row says why it sent nothing.
    expect([...requestedCalls(wallet), ...requestedCalls(second.wallet)]).toEqual(['withdraw']);
    expect(mockTabProps.b.PositionCard.state[1].actionRules.wrappedBase.stopped?.label).toBe(
      'Earlier Request Still Pending'
    );
    expect(chain.directSupply).toBe(50_000_000n);
    expect(chain.borrowed).toBe(0n);
  });

  it("keeps the hold while the configured chain's provider has not reached the wallet node's block", async () => {
    const { chain, wallet, show, entry, readProvider } = await holdFirstStep();
    const heldBlock = chain.block;
    // The wallet's node is three blocks on. The configured chain's provider stays one block past the
    // hold, where it shows 50 USDC left, as if the held request had executed there.
    chain.block += 3;
    readProvider.getBlockNumber.mockImplementation(async () => heldBlock + 1);
    const answer = readProvider.call.getMockImplementation() as (...args: unknown[]) => Promise<string>;
    readProvider.call.mockImplementation(async (request: { to?: string; data?: string }, ...rest: unknown[]) => {
      if (isSame(request.to, USDC_COMET) && request.data === COMET.encodeFunctionData('balanceOf', [ACCOUNT])) {
        return COMET.encodeFunctionResult('balanceOf', [50_000_000n]);
      }
      if (isSame(request.to, USDC_COMET) && request.data?.startsWith(COMET.getSighash('userBasic'))) {
        return COMET.encodeFunctionResult('userBasic', [
          (50_000_000n * 10n ** 15n) / chain.baseSupplyIndex,
          0n,
          0n,
          0n,
          0n,
        ]);
      }
      return answer(request, ...rest);
    });
    show({ state: stateWithDirectSupply(DIRECT) });
    await settle();

    // The provider catches up. Nothing shows the held request executed, so it still holds.
    readProvider.getBlockNumber.mockImplementation(async () => chain.block);
    act(() => live.queue.addOrUpdateAction(entry));
    await submit();
    await settle();
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(positionCard().actionRules.wrappedBase.stopped?.label).toBe('Earlier Request Still Pending');
    for (const [filter] of readProvider.getLogs.mock.calls) expect(filter.toBlock).toBeGreaterThanOrEqual(chain.block);
  });

  it("sends nothing when the wallet node's block cannot be read, whatever a lagging provider shows", async () => {
    const { chain, wallet, readProvider } = await renderMixedWithProvider();
    // 50 USDC is left. The configured chain's provider is a block behind and still shows 250.
    chain.directSupply = 50_000_000n;
    readProvider.getBlockNumber.mockImplementation(async () => chain.block - 1);
    const answer = readProvider.call.getMockImplementation() as (...args: unknown[]) => Promise<string>;
    readProvider.call.mockImplementation(async (request: { to?: string; data?: string }, ...rest: unknown[]) => {
      if (isSame(request.to, USDC_COMET) && request.data === COMET.encodeFunctionData('balanceOf', [ACCOUNT])) {
        return COMET.encodeFunctionResult('balanceOf', [DIRECT]);
      }
      if (isSame(request.to, USDC_COMET) && request.data?.startsWith(COMET.getSighash('userBasic'))) {
        return COMET.encodeFunctionResult('userBasic', [(DIRECT * 10n ** 15n) / chain.baseSupplyIndex, 0n, 0n, 0n, 0n]);
      }
      return answer(request, ...rest);
    });
    wallet.getBlockNumber.mockRejectedValue(new Error('wallet read timeout'));
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));

    await submit();
    await settle();
    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(chain.borrowed).toBe(0n);
    expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
      action: [ActionType.Withdraw, expect.anything(), entry[2]],
      label: 'Not Sent, Try Again',
    });
    await waitFor(() => expect(storedHolds()).toEqual([]));
  });

  it('keeps the row locked and the hold stored while the block of a replaced Comet step cannot be read', async () => {
    const { chain, wallet } = await renderMixed();
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    wallet.sendUncheckedTransaction.mockImplementationOnce(async () => `0x${'ab'.repeat(32)}`);
    wallet.getTransaction.mockImplementation(async () => ({ nonce: 5 } as never));
    wallet.getTransactionCount.mockImplementationOnce(async () => 5).mockImplementation(async () => 6);
    // The first two lookups are the reads before and after the gas estimate. Every later one fails.
    wallet.getBlockNumber
      .mockImplementationOnce(async () => chain.block)
      .mockImplementationOnce(async () => chain.block)
      .mockRejectedValue(new Error('block timeout'));

    await submit();
    await waitFor(() => expect(live.manager.settledTransactions).toHaveLength(1));
    await settle();
    expect(queued()).toEqual([entry]);
    expect(positionCard().transaction).toBeDefined();
    expect(storedHolds()).toEqual([expect.objectContaining({ hash: `0x${'ab'.repeat(32)}` })]);
  });

  it('keeps the row held until the block of a replaced Comet step is known', async () => {
    const { chain, wallet, readProvider } = await renderMixed();
    reportOwnNonceTaken(readProvider, REPLACED_HASH);
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    wallet.sendUncheckedTransaction.mockImplementationOnce(async () => `0x${'ab'.repeat(32)}`);
    wallet.getTransaction.mockImplementation(async () => ({ nonce: 5 } as never));
    wallet.getTransactionCount.mockImplementationOnce(async () => 5).mockImplementation(async () => 6);
    // The first two reads are before and after the gas estimate, the third the one after the step
    // was replaced.
    const block = held<void>();
    wallet.getBlockNumber
      .mockImplementationOnce(async () => chain.block)
      .mockImplementationOnce(async () => chain.block)
      .mockImplementationOnce(async () => {
        await block.promise;
        return chain.block;
      });

    await submit();
    await waitFor(() => expect(live.manager.settledTransactions).toHaveLength(1));
    await settle();
    // Replaced, but the wallet node's block is not known yet: the row and the run stay as they are.
    expect(queued()).toEqual([entry]);
    expect(positionCard().transaction).toBeDefined();

    block.release();
    await waitFor(() => expect(queued()).toEqual([]));
    await waitFor(() => expect(storedHolds()).toEqual([]));
  });

  it('keeps the hold when the manager judges the step replaced by the nonce it read before sending, while the node does not know it', async () => {
    const { chain, wallet, show } = await renderMixed();
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    // Another transaction of the account is pending at nonce 5, so the step is sent at 6. The node
    // does not know the step yet, and nonce 5 mines: the manager reports the step replaced.
    wallet.sendUncheckedTransaction.mockImplementationOnce(async () => REPLACED_HASH);
    wallet.getTransactionCount.mockImplementationOnce(async () => 5).mockImplementation(async () => 6);

    await submit();
    await waitFor(() =>
      expect(live.manager.settledTransactions.map(({ outcome }) => outcome.status)).toEqual(['replaced'])
    );
    await settle();
    expect(storedHolds()).toEqual([expect.objectContaining({ hash: REPLACED_HASH })]);

    // The same 200 USDC again is held back.
    act(() => live.queue.addOrUpdateAction(entry));
    await expectHeldBack(wallet, chain, entry);

    // Once the step's own receipt is found, the hold ends.
    chain.history.push({
      hash: REPLACED_HASH,
      blockNumber: chain.block,
      from: ACCOUNT,
      to: USDC_COMET,
      data: productionWithdrawData(200_000_000n),
      status: 1,
      logs: [],
    });
    show({ state: stateWithDirectSupply(50_000_000n) });
    await waitFor(() => expect(storedHolds()).toEqual([]));
  });

  it('asks the wallet for nothing while storage cannot be written, so no reload can lose a request', async () => {
    const { chain, wallet, reload } = await renderMixed();
    const quietError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    try {
      await submit();
      await settle();
      expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
      expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
        action: [ActionType.Withdraw, expect.anything(), entry[2]],
        label: 'Not Sent, Try Again',
      });
    } finally {
      setItem.mockRestore();
      quietError.mockRestore();
    }

    // Storage works again after a reload: one request goes, and Comet lends nothing.
    reload();
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    act(() => live.queue.addOrUpdateAction(entry));
    await submit();
    await waitFor(() => expect(queued()).toEqual([]));
    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([entry[2]]);
    expect(chain.borrowed).toBe(0n);
  });

  it('refuses every Comet step while storage cannot be read, and holds again once it can', async () => {
    const { chain, wallet, reload, entry } = await holdFirstStep();
    const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      // A reload while storage cannot be read: whether a hold exists is unknown, never none.
      reload();
      await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
      act(() => live.queue.addOrUpdateAction(entry));
      await submit();
      await settle();
      expect(requestedCalls(wallet)).toEqual(['withdraw']);
      expect(positionCard().actionRules.wrappedBase.stopped?.label).toBe('Earlier Request Still Pending');
    } finally {
      getItem.mockRestore();
    }

    reload();
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    act(() => live.queue.addOrUpdateAction(entry));
    await expectHeldBack(wallet, chain, entry);
  });

  /** A wallet connector on the standard route, which the wrapped route never uses. */
  const STANDARD_CONNECTOR = 'io.metamask';

  it('refuses a base withdrawal for the held account through another connector, on the standard route', async () => {
    const { chain, wallet, show, entry } = await holdFirstStep();
    // The same account connects through a standard-route wallet.
    show({ connectorId: STANDARD_CONNECTOR });
    await settle();
    act(() => live.queue.addOrUpdateAction(entry));
    await submit();
    await settle();
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(queued()).toEqual([entry]);
    // Should the held request now execute, Comet takes 200 USDC of the 250 and lends nothing.
    executeLate(chain);
    expect(chain.borrowed).toBe(0n);

    // Its calldata is found mined at the next Comet read, and the standard withdrawal goes as on main.
    show({ connectorId: STANDARD_CONNECTOR, state: stateWithDirectSupply(50_000_000n) });
    await waitFor(() => expect(storedHolds()).toEqual([]));
    const rest: Action = [ActionType.Withdraw, BASE_ASSET, 30_000_000n];
    act(() => live.queue.clearActions());
    act(() => live.queue.addOrUpdateAction(rest));
    await submit();
    await waitFor(() => expect(requestedCalls(wallet)).toEqual(['withdraw', 'withdraw']));
    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([entry[2], 30_000_000n]);
  });

  it('sends a base withdrawal on the standard route exactly as on main when no hold is stored', async () => {
    const chain = chainFor({ shares: WRAPPED_SHARES, directSupply: DIRECT });
    const { wallet, show } = renderDashboard(chain, { state: stateWithDirectSupply(DIRECT) });
    show({ connectorId: STANDARD_CONNECTOR, state: stateWithDirectSupply(DIRECT) });
    await settle();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 200_000_000n]));

    await submit();
    await waitFor(() => expect(requestedCalls(wallet)).toEqual(['withdraw']));
    expect(cometWithdrawals(wallet)).toEqual([
      { to: USDC_COMET, data: productionWithdrawData(200_000_000n), args: [MARKET.baseTokenAddress, 200_000_000n] },
    ]);
    expect(storedHolds()).toEqual([]);
    expect(chain.directSupply).toBe(50_000_000n);
  });

  it('sends nothing on the standard route when a hold is stored while the withdrawal is estimated', async () => {
    const chain = chainFor({ shares: WRAPPED_SHARES, directSupply: DIRECT });
    const { wallet, show } = renderDashboard(chain, { state: stateWithDirectSupply(DIRECT) });
    show({ connectorId: STANDARD_CONNECTOR, state: stateWithDirectSupply(DIRECT) });
    await settle();
    // An Anchorage tab of the same account stores its hold while this request's gas is estimated.
    wallet.cometSigner.estimateGas.mockImplementationOnce(async () => {
      window.localStorage.setItem(
        DIRECT_WITHDRAWAL_HOLDS_KEY,
        JSON.stringify([
          {
            kind: 'held',
            id: 'anchorage-tab',
            account: ACCOUNT.toLowerCase(),
            chainId: 1,
            cometAddress: USDC_COMET.toLowerCase(),
            calldata: productionWithdrawData(200_000_000n).toLowerCase(),
            amount: '200000000',
            blockNumber: chain.block,
          },
        ])
      );
      return BigNumber.from(100_000);
    });
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 200_000_000n]));

    await submit();
    await settle();
    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(chain.directSupply).toBe(DIRECT);
  });

  /** Makes the stored holds unreadable: a read of their key throws, or finds no JSON list. */
  const UNREADABLE_HOLDS: [string, () => () => void][] = [
    [
      'a read of the key throws',
      () => {
        const read = Storage.prototype.getItem;
        const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name) {
          if (name === DIRECT_WITHDRAWAL_HOLDS_KEY) throw new Error('SecurityError');
          return read.call(this, name);
        });
        return () => getItem.mockRestore();
      },
    ],
    [
      'the key holds invalid JSON',
      () => {
        window.localStorage.setItem(DIRECT_WITHDRAWAL_HOLDS_KEY, '{not json');
        return () => undefined;
      },
    ],
  ];

  it.each(UNREADABLE_HOLDS)(
    'refuses a base withdrawal on the standard route at Submit while the holds are unreadable, when %s',
    async (_name, makeUnreadable) => {
      const { chain, wallet, show, entry } = await holdFirstStep();
      show({ connectorId: STANDARD_CONNECTOR });
      await settle();
      const restore = makeUnreadable();
      try {
        act(() => live.queue.addOrUpdateAction(entry));
        await settle();
        const estimates = wallet.cometSigner.estimateGas.mock.calls.length;
        await submit();
        await settle();
        expect(requestedCalls(wallet)).toEqual(['withdraw']);
        expect(queued()).toEqual([entry]);
        // Refused at Submit, before the manager estimates gas, not only just before the wallet.
        expect(wallet.cometSigner.estimateGas.mock.calls.length).toBe(estimates);
      } finally {
        restore();
      }
      // Should the held request now execute, Comet takes 200 USDC of the 250 and lends nothing.
      executeLate(chain);
      expect(chain.borrowed).toBe(0n);
    }
  );

  it.each(UNREADABLE_HOLDS)(
    'sends nothing on the standard route when the holds become unreadable while the withdrawal is estimated, when %s',
    async (_name, makeUnreadable) => {
      const chain = chainFor({ shares: WRAPPED_SHARES, directSupply: DIRECT });
      const { wallet, show } = renderDashboard(chain, { state: stateWithDirectSupply(DIRECT) });
      show({ connectorId: STANDARD_CONNECTOR, state: stateWithDirectSupply(DIRECT) });
      await settle();
      let restore = () => undefined as void;
      wallet.cometSigner.estimateGas.mockImplementationOnce(async () => {
        restore = makeUnreadable();
        return BigNumber.from(100_000);
      });
      act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 200_000_000n]));
      try {
        await submit();
        await settle();
        expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
        expect(chain.directSupply).toBe(DIRECT);
      } finally {
        restore();
      }
    }
  );

  it('sends nothing when the session changes while the direct supply is read again', async () => {
    const { chain, wallet, show } = await renderMixed();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 100_000_000n]));
    // The fresh read of the direct supply waits until the test answers it.
    const read = held<void>();
    const readProvider = mockLastProps.readProvider as ReturnType<typeof readProviderFor>;
    const answer = readProvider.call.getMockImplementation();
    if (answer === undefined) throw new Error('the provider must answer');
    let isReadStarted = false;
    readProvider.call.mockImplementation(async (request: { to?: string; data?: string }, ...rest: unknown[]) => {
      if (isSame(request.to, MARKET.cometAddress) && request.data?.startsWith(COMET.getSighash('balanceOf'))) {
        isReadStarted = true;
        await read.promise;
      }
      return (answer as (...args: unknown[]) => Promise<string>)(request, ...rest);
    });

    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(isReadStarted).toBe(true));
    show({ walletChainId: 8453 });
    read.release();
    await settle();

    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(chain.directSupply).toBe(DIRECT);
  });

  it('sends nothing, and holds nothing, when the Comet state shows no direct supply by the end of the gas estimate', async () => {
    const { chain, wallet, show } = await renderMixed();
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 100_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    // The Comet step's gas estimate waits until the test answers it.
    const estimate = held<void>();
    let isEstimateStarted = false;
    wallet.cometSigner.estimateGas.mockImplementationOnce(async () => {
      isEstimateStarted = true;
      await estimate.promise;
      return BigNumber.from(100_000);
    });

    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(isEstimateStarted).toBe(true));
    // The Comet state is read again and shows no direct supply, in the same visit and session.
    show({ state: stateWithDirectSupply(0n) });
    estimate.release();
    await settle();

    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(storedHolds()).toEqual([]);
    expect(positionCard().actionRules.wrappedBase.stopped?.label).toBe('Not Sent, Try Again');
    expect(chain.directSupply).toBe(DIRECT);
  });

  it('sends nothing, and holds nothing, when the Comet state shows no direct supply during the read after the gas estimate', async () => {
    const { chain, wallet, show, readProvider } = await renderMixed();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 100_000_000n]));
    // The second read of the direct supply, made after the gas estimate, waits until the test answers it.
    const read = held<void>();
    const answer = readProvider.call.getMockImplementation();
    if (answer === undefined) throw new Error('the provider must answer');
    let directReads = 0;
    let isSecondReadStarted = false;
    readProvider.call.mockImplementation(async (request: { to?: string; data?: string }, ...rest: unknown[]) => {
      if (
        isSame(request.to, MARKET.cometAddress) &&
        request.data === COMET.encodeFunctionData('balanceOf', [ACCOUNT])
      ) {
        directReads += 1;
        if (directReads === 2) {
          isSecondReadStarted = true;
          await read.promise;
        }
      }
      return (answer as (...args: unknown[]) => Promise<string>)(request, ...rest);
    });

    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(isSecondReadStarted).toBe(true));
    expect(wallet.cometSigner.estimateGas).toHaveBeenCalledTimes(1);
    // The Comet state is read again and shows no direct supply, in the same visit and session.
    show({ state: stateWithDirectSupply(0n) });
    read.release();
    await settle();

    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(storedHolds()).toEqual([]);
    expect(positionCard().actionRules.wrappedBase.stopped?.label).toBe('Not Sent, Try Again');
    expect(chain.directSupply).toBe(DIRECT);
  });

  it('refuses the Comet step while the Comet state was read for another account', async () => {
    const chain = chainFor({ shares: WRAPPED_SHARES, directSupply: DIRECT });
    const state = stateWithDirectSupply(DIRECT);
    // As useCometState records it for another account, before the next read for this one.
    recordCometStateSource(
      state,
      { chainId: 1, cometAddress: USDC_COMET },
      '0x0000000000000000000000000000000000000bb2'
    );
    const { wallet } = renderDashboard(chain, { state, position: positionOn(chain) });
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 100_000_000n]));

    await submit();

    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(chain.directSupply).toBe(DIRECT);
  });

  it('reads the direct supply again at a block no older than the last confirmed Comet step, so a stale dashboard never borrows', async () => {
    const { chain, wallet, readProvider } = await renderMixedWithProvider();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 300_000_000n]));
    const send = wallet.sendUncheckedTransaction.getMockImplementation();
    if (send === undefined) throw new Error('the wallet must send');
    wallet.sendUncheckedTransaction
      .mockImplementationOnce(send)
      .mockRejectedValueOnce({ code: 4001, message: 'User rejected.' });
    await submit();
    await waitFor(() => expect(live.action.state.phase).toBe('stopped'));
    await settle();
    // The Comet step took the 250 USDC. The dashboard still shows it, so the 50 USDC rest plans a
    // partial Comet step. The configured chain's provider is one block behind the wallet's node.
    const cometReceiptBlock = live.manager.settledTransactions[0].outcome;
    if (cometReceiptBlock.status !== 'confirmed') throw new Error('the Comet step must confirm');
    const lagging = cometReceiptBlock.receipt.blockNumber - 1;
    readProvider.getBlockNumber.mockImplementationOnce(async () => lagging);
    readProvider.call.mockClear();
    const directReads = () =>
      readProvider.call.mock.calls.filter(
        ([request]) =>
          isSame(request.to, MARKET.cometAddress) && request.data === COMET.encodeFunctionData('balanceOf', [ACCOUNT])
      );

    await submit();
    // The read waits for the provider to reach the Comet step's block, polling every 1.5 seconds.
    await waitFor(() => expect(directReads()).toHaveLength(1), { timeout: 5_000 });
    await settle();

    expect(directReads()[0][1]).toBeGreaterThanOrEqual(cometReceiptBlock.receipt.blockNumber);
    expect(requestedCalls(wallet)).toEqual(['withdraw', 'unwrapAndWithdraw']);
    expect(chain.borrowed).toBe(0n);
    expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
      action: [ActionType.Withdraw, expect.anything(), 50_000_000n],
      label: 'Balance Changed, Edit Amount',
    });
  });

  it('keeps the rest queued when the wrapper step is declined after the Comet step confirmed', async () => {
    const { chain, wallet } = await renderMixed();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 300_000_000n]));
    const send = wallet.sendUncheckedTransaction.getMockImplementation();
    if (send === undefined) throw new Error('the wallet must send');
    wallet.sendUncheckedTransaction
      .mockImplementationOnce(send)
      .mockRejectedValueOnce({ code: 4001, message: 'User rejected.' });

    await submit();
    await waitFor(() => expect(live.action.state.phase).toBe('stopped'));
    await settle();

    expect(requestedCalls(wallet)).toEqual(['withdraw', 'unwrapAndWithdraw']);
    expect(chain.directSupply).toBe(0n);
    expect(chain.shares).toBe(WRAPPED_SHARES);
    expect(queued()).toEqual([[ActionType.Withdraw, expect.anything(), 50_000_000n]]);
    expect(positionCard().actionRules.wrappedBase.stopped).toBeUndefined();
    expect(positionCard().transaction).toBeUndefined();
  });

  it('pays exactly the queued amount from Comet alone when the direct supply rose above it before signing', async () => {
    const { chain, wallet } = await renderMixed();
    const amount = 300_000_000n;
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, amount]));
    // The dashboard read 250 USDC, so Submit plans withdraw(base, max) and 50 USDC from the wrapper.
    // Another 150 USDC is supplied to Comet directly before signing.
    chain.directSupply = 400_000_000n;

    await submit();
    await waitFor(() => expect(queued()).toEqual([]));
    await settle();

    // One Comet withdraw(base, 300 USDC), production's encoding, and nothing from the wrapper.
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(cometWithdrawals(wallet)).toEqual([
      { to: USDC_COMET, data: productionWithdrawData(amount), args: [MARKET.baseTokenAddress, amount] },
    ]);
    expect(chain.balance - 10_000_000_000n).toBe(amount);
    expect(chain.directSupply).toBe(100_000_000n);
    expect(chain.shares).toBe(WRAPPED_SHARES);
    expect(chain.borrowed).toBe(0n);
  });

  it('takes the fallen direct supply with max, then the rest of the queued amount from the wrapper, by what Comet took', async () => {
    const { chain, wallet } = await renderMixed();
    const amount = 300_000_000n;
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, amount];
    act(() => live.queue.addOrUpdateAction(entry));
    // 150 USDC of the direct supply leaves in another transaction after the fresh read, while the
    // manager estimates the Comet step's gas. The dashboard still shows the 250 USDC it read.
    wallet.cometSigner.estimateGas.mockImplementationOnce(async () => {
      chain.directSupply = 100_000_000n;
      return BigNumber.from(100_000);
    });
    // Between the fresh read and execution the supply earns 7 base units, which max also takes.
    const send = wallet.cometSigner.sendTransaction.getMockImplementation();
    if (send === undefined) throw new Error('the signer must send');
    wallet.cometSigner.sendTransaction.mockImplementationOnce(async (request) => {
      chain.directSupply += 7n;
      return send(request);
    });
    const send2 = wallet.sendUncheckedTransaction.getMockImplementation();
    if (send2 === undefined) throw new Error('the wallet must send');
    const wrapperAnswer = held<void>();
    wallet.sendUncheckedTransaction.mockImplementationOnce(send2).mockImplementationOnce(async (request) => {
      await wrapperAnswer.promise;
      return send2(request);
    });

    await submit();
    await waitFor(() => expect(requestedCalls(wallet)).toEqual(['withdraw', 'unwrapAndWithdraw']));
    // Comet withdrew the 100.000007 USDC it held. The row shows the queued amount less that.
    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([MAX_UINT256]);
    expect(queued()).toEqual([[ActionType.Withdraw, expect.anything(), amount - 100_000_007n]]);
    const beforeExit = { ...chain };
    wrapperAnswer.release();
    await waitFor(() => expect(queued()).toEqual([]));

    const [unwrap] = sentCalls(wallet, 'unwrapAndWithdraw');
    const burned = BigInt(CALLS.parseTransaction(unwrap[0]).args[0].toString());
    // The fewest shares that pay the 199.999993 USDC rest, from the wrapper's state then.
    expect(exitCashAt(beforeExit, burned)).toBeGreaterThanOrEqual(amount - 100_000_007n);
    expect(exitCashAt(beforeExit, burned - 1n)).toBeLessThan(amount - 100_000_007n);
    // The payout is the queued amount, short of the shares' rounding: at most what one share pays.
    const paid = chain.balance - 10_000_000_000n;
    expect(paid).toBeGreaterThanOrEqual(amount);
    expect(paid - amount).toBeLessThanOrEqual(exitCashAt(beforeExit, burned) - exitCashAt(beforeExit, burned - 1n));
    expect(chain.directSupply).toBe(0n);
    expect(chain.borrowed).toBe(0n);
  });

  it('keeps the rest by the fresh read, and asks the wrapper for nothing, when the Comet receipt names no amount', async () => {
    const { chain, wallet } = await renderMixed();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 300_000_000n]));
    const lookUp = wallet.getTransactionReceipt.getMockImplementation();
    if (lookUp === undefined) throw new Error('the wallet must look up receipts');
    wallet.getTransactionReceipt.mockImplementation(async (hash: string) => {
      const receipt = await lookUp(hash);
      return receipt === null ? null : ({ ...receipt, logs: [] } as unknown as TransactionReceipt);
    });

    await submit();
    await waitFor(() => expect(live.manager.settledTransactions).toHaveLength(1));
    await settle();

    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(chain.directSupply).toBe(0n);
    expect(queued()).toEqual([[ActionType.Withdraw, expect.anything(), 50_000_000n]]);
    expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
      action: [ActionType.Withdraw, expect.anything(), 50_000_000n],
      label: 'Balance Changed, Edit Amount',
    });
  });

  it('sends nothing, and asks for a new amount, when the direct supply is gone before signing', async () => {
    const { chain, wallet } = await renderMixed();
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    // After the fresh read, while the manager estimates the Comet step's gas, the whole direct supply
    // leaves in another transaction. The dashboard still shows the 250 USDC it read. The finite
    // withdraw(base, 200 USDC) now borrows, so the read made after the estimate sends nothing.
    wallet.cometSigner.estimateGas.mockImplementationOnce(async () => {
      chain.directSupply = 0n;
      return BigNumber.from(100_000);
    });

    await submit();
    await settle();

    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(chain.borrowed).toBe(0n);
    expect(queued()).toEqual([entry]);
    expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
      action: [ActionType.Withdraw, expect.anything(), entry[2]],
      label: 'Balance Changed, Edit Amount',
    });
    expect(live.manager.transactions).toEqual([]);
    await waitFor(() => expect(storedHolds()).toEqual([]));
  });

  it('sends nothing when the direct supply falls below a finite part during the estimate, though the wrapper could pay the rest', async () => {
    const { chain, wallet } = await renderMixed();
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    // The fresh read shows 250 USDC, so the Comet step is withdraw(base, 200 USDC). While its gas is
    // estimated, 150 USDC of the supply leaves. That call now borrows 100 USDC, while a split from the
    // 100 USDC left, max then 100 USDC from the wrapper, could pay.
    wallet.cometSigner.estimateGas.mockImplementationOnce(async () => {
      chain.directSupply = 100_000_000n;
      return BigNumber.from(100_000);
    });

    await submit();
    await settle();

    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(chain.borrowed).toBe(0n);
    expect(queued()).toEqual([entry]);
    expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
      action: [ActionType.Withdraw, expect.anything(), entry[2]],
      label: 'Balance Changed, Edit Amount',
    });
    await waitFor(() => expect(storedHolds()).toEqual([]));
  });

  it('sends nothing when the direct supply fell further than the wrapper can make up before signing', async () => {
    // A 10 USDC wrapped position beside the 250 USDC direct supply.
    const chain = chainFor({ shares: 10n * 10n ** 18n, directSupply: DIRECT });
    const { wallet } = renderDashboard(chain, { state: stateWithDirectSupply(DIRECT), position: positionOn(chain) });
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 255_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    // 200 USDC of the direct supply leaves after the fresh read, while the manager estimates the
    // Comet step's gas, which leaves 205 USDC for a wrapper that pays at most 10 USDC.
    wallet.cometSigner.estimateGas.mockImplementationOnce(async () => {
      chain.directSupply = 50_000_000n;
      return BigNumber.from(100_000);
      await waitFor(() => expect(storedHolds()).toEqual([]));
    });

    await submit();
    await settle();

    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(queued()).toEqual([entry]);
    expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
      action: [ActionType.Withdraw, expect.anything(), entry[2]],
      label: 'Balance Changed, Edit Amount',
    });
  });
});
