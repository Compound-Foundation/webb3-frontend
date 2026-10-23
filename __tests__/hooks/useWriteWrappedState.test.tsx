import { Interface } from '@ethersproject/abi';
import { JsonRpcProvider, TransactionReceipt } from '@ethersproject/providers';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { BigNumber, utils } from 'ethers';

import {
  ANCHORAGE_CONNECTOR_ID,
  buildWrappedMarketRegistry,
  HARDCODED_WRAPPED_LENDING_SOURCE,
  WRAPPED_MARKET_REGISTRY,
  WrappedMarket,
  WrappedMarketRegistry,
} from '@constants/wrappedMarkets';
import CometAbi from '@helpers/abis/Comet';
import { LendingSession, resolveLendingRoute, ValidationStatus, wrappedRouteKey } from '@helpers/lendingRoute';
import { getMarket } from '@helpers/markets';
import { MAX_UINT256 } from '@helpers/numbers';
import { getBlockExplorerUrl } from '@helpers/urls';
import {
  MarketRestriction,
  WrappedActionIdentity,
  WrappedSession,
  wrappedActionIdentity,
} from '@helpers/wrappedActions';
import { BlockWait, WrappedPosition } from '@helpers/wrappedPositions';
import { WithdrawalRequest } from '@helpers/wrappedWithdrawals';
import {
  SendResult,
  TransactionManager,
  TransactionRequest,
  useTransactionManager,
} from '@hooks/useTransactionManager';
import { useWrappedAction, WrappedActionController, WrappedActionState } from '@hooks/useWrappedAction';
import { positionRefreshToken, useWrappedPosition } from '@hooks/useWrappedPosition';
import {
  newestReceiptBlock,
  parseExactUnits,
  prepareWrappedSupply,
  prepareWrappedWithdrawal,
  useWriteWrappedState,
  WRAPPED_WITHDRAW_STEP_ID,
  WriteWrappedState,
} from '@hooks/useWriteWrappedState';
import WrappedSupplyModal from '@pages/home/components/ActionModal/WrappedSupplyModal';
import WrappedWithdrawModal from '@pages/home/components/ActionModal/WrappedWithdrawModal';
import { MarketData, SettledTransaction, TransactionState } from '@types';

import { mockWeb3 } from '../mocks/mockWeb3';

// uuid ships ESM only, which Jest does not load here. The transaction manager uses it.
let mockNextId = 0;
jest.mock('uuid', () => ({ v4: () => `transaction-${++mockNextId}` }));

const ACCOUNT = '0x0000000000000000000000000000000000000aa1';
const OTHER_ACCOUNT = '0x0000000000000000000000000000000000000bb2';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

/** The committed registry with the release controls set by the test. Release belongs to COM-292. */
function registryWith({ deposits = true, exits = true } = {}): WrappedMarketRegistry {
  return buildWrappedMarketRegistry({
    markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({
      ...market,
      isDepositEnabled: deposits,
      isExitEnabled: exits,
    })),
  });
}
const OPEN = registryWith();

function marketAt(cometAddress: string): WrappedMarket {
  const lookup = OPEN.lookup(1, cometAddress);
  if (lookup.status !== 'valid') throw new Error('the mapping must be valid');
  return lookup.market;
}
const USDC_MARKET = marketAt('0xc3d688B66703497DAA19211EEdff47f25384cdc3');
const USDT_MARKET = marketAt('0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840');
const INSTITUTIONAL_USDC_MARKET = marketAt('0x207158a267CBD2598BB3d611D8CBdEE2709F2F8C');
const MARKETS: [string, WrappedMarket][] = [
  ['USDC', USDC_MARKET],
  ['USDT', USDT_MARKET],
  ['institutional USDC', INSTITUTIONAL_USDC_MARKET],
];

const isSame = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const symbolOf = (market: WrappedMarket) => (isSame(market.baseTokenAddress, USDT) ? 'USDT' : 'USDC');

/** Every call these tests decode, including the ones a wrapped supply must never make. */
const CALLS = new Interface([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount)',
  'function supplyAndWrap(uint256 amount) returns (uint256 shares)',
  'function supplyAndWrapWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function supplyAndWrapWithPermit2(uint256 amount)',
  'function allow(address manager, bool isAllowed)',
  'function supply(address asset, uint256 amount)',
  'function invoke(bytes32[] actions, bytes[] data)',
  'function isSupplyPaused() view returns (bool)',
  'error ZeroSharesMinted()',
  // A wrapped exit's reads and call, and the Comet calls it must never make.
  'function unwrapAndWithdraw(uint256 shares) returns (uint256 amount)',
  'function totalSupply() view returns (uint256)',
  'function totalsBasic()',
  'function isWithdrawPaused() view returns (bool)',
  'function withdraw(address asset, uint256 amount)',
  'function withdrawTo(address to, address asset, uint256 amount)',
  'function withdrawFrom(address src, address to, address asset, uint256 amount)',
  'error ZeroAssetsTransferred()',
  'error ZeroSharesBurned()',
  'error ExcessiveAssetsDebited(uint256 sharesRequired, uint256 sharesBurned)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error Paused()',
  'error TransferOutFailed()',
]);
const COMET = new Interface(CometAbi);

/** What the chain records at the end of a block, for the account and its market. */
type Ledger = {
  balance: bigint;
  allowance: bigint;
  shares: bigint;
  /** Wrapper shares in existence. */
  totalSupply: bigint;
  /** The wrapper's Comet balance. */
  totalAssets: bigint;
  /** Comet's stored supply index. */
  baseSupplyIndex: bigint;
  /** The base token Comet holds. */
  cometCash: bigint;
  isWithdrawPaused: boolean;
};

/** What the chain holds for the account in one market. */
type Chain = Ledger & {
  market: WrappedMarket;
  /** The newest block. Each mined transaction makes a new one. */
  block: number;
  /** The ledger at the end of each earlier block. */
  history: Map<number, Ledger>;
  /** How many blocks the configured chain's provider trails the wallet's node by. */
  providerLag: number;
  /** The provider fails the balance and allowance reads. */
  failsFundReads: boolean;
  /** How many more balance reads fail as a node a block behind fails them. */
  laggingNodeReads: number;
  /** How many more supply or exit simulations fail the same way. */
  laggingNodeSimulations: number;
  /** The next mined call reverts. */
  shouldRevertNext: boolean;
  /** The supply or exit simulation reverts with this error. */
  simulationRevert: Error | undefined;
  /** The supply or exit simulation returns this instead, as ethers returns a reverted call's data. */
  simulationResult: string | undefined;
};

/**
 * A chain where the account holds no shares. The wrapper holds 1,000.5 USDC for 1,000 whole shares,
 * counting its 10^12 virtual shares, and the supply index 1.05e15 gives a buffer of 3 base units.
 */
function chainFor(market: WrappedMarket, { balance = 10_000_000_000n, allowance = 0n } = {}): Chain {
  return {
    market,
    balance,
    allowance,
    shares: 0n,
    totalSupply: 1_000n * 10n ** 18n - 10n ** 12n,
    totalAssets: 1_000_500_000n,
    baseSupplyIndex: 1_050_000_000_000_000n,
    cometCash: 10n ** 15n,
    isWithdrawPaused: false,
    block: 100,
    history: new Map(),
    providerLag: 0,
    failsFundReads: false,
    laggingNodeReads: 0,
    laggingNodeSimulations: 0,
    shouldRevertNext: false,
    simulationRevert: undefined,
    simulationResult: undefined,
  };
}

function ledgerOf(chain: Chain): Ledger {
  const { balance, allowance, shares, totalSupply, totalAssets, baseSupplyIndex, cometCash, isWithdrawPaused } = chain;
  return { balance, allowance, shares, totalSupply, totalAssets, baseSupplyIndex, cometCash, isWithdrawPaused };
}

/** The ledger at the end of `block`. */
function stateAt(chain: Chain, block: number): Ledger {
  const latest = ledgerOf(chain);
  return block >= chain.block ? latest : chain.history.get(block) ?? latest;
}

/** Mines a call in a new block, as the base token and the wrapper do. Returns whether it succeeded. */
function mine(chain: Chain, request: { to: string; data: string }): boolean {
  chain.history.set(chain.block, ledgerOf(chain));
  chain.block += 1;
  return applyCall(chain, request);
}

/**
 * The cash `unwrapAndWithdraw(shares)` pays, transcribed from the wrapper at 1152de2: the shares'
 * value `shares × (totalAssets + 1) ÷ (totalSupply + 10^12)`, rounded down, less the buffer
 * `baseSupplyIndex ÷ 10^15 + 2`. Shares worth no more than the buffer pay nothing.
 */
function exitCashAt(ledger: Ledger, shares: bigint): bigint {
  const worth = (shares * (ledger.totalAssets + 1n)) / (ledger.totalSupply + 10n ** 12n);
  const buffer = ledger.baseSupplyIndex / 10n ** 15n + 2n;
  return worth <= buffer ? 0n : worth - buffer;
}

function applyCall(chain: Chain, { to, data }: { to: string; data: string }): boolean {
  if (chain.shouldRevertNext) {
    chain.shouldRevertNext = false;
    return false;
  }
  const call = CALLS.parseTransaction({ data });
  const { market } = chain;
  if (call.name === 'approve' && isSame(to, market.baseTokenAddress) && isSame(call.args[0], market.wrapperAddress)) {
    const amount = BigInt(call.args[1].toString());
    // USDT's approve reverts when it changes one nonzero allowance to another.
    if (isSame(market.baseTokenAddress, USDT) && chain.allowance > 0n && amount > 0n) return false;
    chain.allowance = amount;
    return true;
  }
  if (call.name === 'supplyAndWrap' && isSame(to, market.wrapperAddress)) {
    const amount = BigInt(call.args[0].toString());
    if (amount > chain.allowance || amount > chain.balance) return false;
    chain.allowance -= amount;
    chain.balance -= amount;
    chain.shares += amount * 10n ** 12n;
    return true;
  }
  if (call.name === 'unwrapAndWithdraw' && isSame(to, market.wrapperAddress)) {
    const shares = BigInt(call.args[0].toString());
    const cash = exitCashAt(chain, shares);
    if (shares === 0n || shares > chain.shares || cash === 0n || chain.isWithdrawPaused || cash > chain.cometCash) {
      return false;
    }
    chain.shares -= shares;
    chain.totalSupply -= shares;
    // Comet takes a unit more from the wrapper than it pays, as its rounding can.
    chain.totalAssets -= cash + 1n;
    chain.cometCash -= cash;
    chain.balance += cash;
    return true;
  }
  return false;
}

function positionOf({ shares, balance, allowance }: Ledger) {
  const position: WrappedPosition = {
    shares,
    shareDecimals: 18,
    grossAssets: shares / 10n ** 12n,
    baseDecimals: 6,
    baseWalletBalance: balance,
    wrapperAllowance: allowance,
    redeemBuffer: 3n,
    fullExitCash: 0n,
    isWithdrawPaused: false,
    snapshot: { totalSupply: 0n, totalAssets: 0n, baseSupplyIndex: 0n },
  };
  return position;
}

/** A reverted `eth_call` as ethers reports it, with the revert data on the error. */
function revertWith(data: string): Error {
  return Object.assign(new Error('call revert exception'), { code: 'CALL_EXCEPTION', data });
}
const errorString = (reason: string) => `0x08c379a0${utils.defaultAbiCoder.encode(['string'], [reason]).slice(2)}`;

/**
 * The order in which the fakes were used: the supply's and the exit's own reads, the panel's
 * position reads, simulations and wallet requests.
 */
type Event =
  | 'read'
  | 'exit-read'
  | 'position-read'
  | 'simulate'
  | 'send:approve'
  | 'send:supplyAndWrap'
  | 'send:unwrapAndWithdraw';

/**
 * The configured chain's public provider: Comet's pause reads, the supply's balance and allowance
 * reads, the exit's position and market reads, and both simulations. It trails the wallet's node by
 * `providerLag` blocks.
 */
function readProviderFor(chain: Chain, events: Event[]) {
  const latest = () => chain.block - chain.providerLag;
  return {
    getBlockNumber: jest.fn(async () => latest()),
    call: jest.fn(
      async ({ from, to, data }: { from?: string; to?: string; data?: string }, blockTag?: number | string) => {
        const block = typeof blockTag === 'number' ? blockTag : latest();
        if (block > latest()) throw new Error('header not found');
        const state = stateAt(chain, block);
        const call = CALLS.parseTransaction({ data: data ?? '0x' });
        const { market } = chain;
        if (call.name === 'isSupplyPaused' && isSame(to, market.cometAddress)) {
          return CALLS.encodeFunctionResult('isSupplyPaused', [false]);
        }
        if (chain.failsFundReads && (call.name === 'balanceOf' || call.name === 'allowance')) {
          throw new Error('rate limited');
        }
        if (chain.laggingNodeReads > 0 && call.name === 'balanceOf') {
          chain.laggingNodeReads -= 1;
          throw new Error('header not found');
        }
        if (call.name === 'balanceOf' && isSame(to, market.baseTokenAddress) && isSame(call.args[0], ACCOUNT)) {
          events.push('read');
          return CALLS.encodeFunctionResult('balanceOf', [state.balance]);
        }
        if (
          call.name === 'allowance' &&
          isSame(to, market.baseTokenAddress) &&
          isSame(call.args[0], ACCOUNT) &&
          isSame(call.args[1], market.wrapperAddress)
        ) {
          return CALLS.encodeFunctionResult('allowance', [state.allowance]);
        }
        if (call.name === 'supplyAndWrap' && isSame(to, market.wrapperAddress) && isSame(from, ACCOUNT)) {
          events.push('simulate');
          if (chain.laggingNodeSimulations > 0) {
            chain.laggingNodeSimulations -= 1;
            throw Object.assign(new Error('missing revert data in call exception'), {
              code: 'CALL_EXCEPTION',
              data: '0x',
              error: { code: -32000, message: 'header not found' },
            });
          }
          if (chain.simulationRevert !== undefined) throw chain.simulationRevert;
          if (chain.simulationResult !== undefined) return chain.simulationResult;
          const amount = BigInt(call.args[0].toString());
          if (amount > state.allowance) throw revertWith(errorString('ERC20: transfer amount exceeds allowance'));
          return CALLS.encodeFunctionResult('supplyAndWrap', [amount * 10n ** 12n]);
        }
        if (call.name === 'isWithdrawPaused' && isSame(to, market.cometAddress)) {
          return CALLS.encodeFunctionResult('isWithdrawPaused', [state.isWithdrawPaused]);
        }
        if (call.name === 'balanceOf' && isSame(to, market.wrapperAddress) && isSame(call.args[0], ACCOUNT)) {
          events.push('exit-read');
          return CALLS.encodeFunctionResult('balanceOf', [state.shares]);
        }
        if (call.name === 'totalSupply' && isSame(to, market.wrapperAddress)) {
          return CALLS.encodeFunctionResult('totalSupply', [state.totalSupply]);
        }
        if (
          call.name === 'balanceOf' &&
          isSame(to, market.cometAddress) &&
          isSame(call.args[0], market.wrapperAddress)
        ) {
          return CALLS.encodeFunctionResult('balanceOf', [state.totalAssets]);
        }
        if (call.name === 'totalsBasic' && isSame(to, market.cometAddress)) {
          return COMET.encodeFunctionResult('totalsBasic', [
            {
              baseSupplyIndex: state.baseSupplyIndex,
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
        if (
          call.name === 'balanceOf' &&
          isSame(to, market.baseTokenAddress) &&
          isSame(call.args[0], market.cometAddress)
        ) {
          return CALLS.encodeFunctionResult('balanceOf', [state.cometCash]);
        }
        if (call.name === 'unwrapAndWithdraw' && isSame(to, market.wrapperAddress) && isSame(from, ACCOUNT)) {
          events.push('simulate');
          if (chain.laggingNodeSimulations > 0) {
            chain.laggingNodeSimulations -= 1;
            throw Object.assign(new Error('missing revert data in call exception'), {
              code: 'CALL_EXCEPTION',
              data: '0x',
              error: { code: -32000, message: 'header not found' },
            });
          }
          if (chain.simulationRevert !== undefined) throw chain.simulationRevert;
          if (chain.simulationResult !== undefined) return chain.simulationResult;
          // The wrapper's own order: the value and buffer, Comet's withdrawal, then the burn.
          const shares = BigInt(call.args[0].toString());
          const cash = exitCashAt(state, shares);
          if (cash === 0n) throw revertWith(CALLS.getSighash('ZeroAssetsTransferred'));
          if (state.isWithdrawPaused) throw revertWith(CALLS.getSighash('Paused'));
          if (cash > state.cometCash) throw revertWith(errorString('ERC20: transfer amount exceeds balance'));
          if (shares > state.shares) {
            throw revertWith(CALLS.encodeErrorResult('ERC20InsufficientBalance', [ACCOUNT, state.shares, shares]));
          }
          return CALLS.encodeFunctionResult('unwrapAndWithdraw', [cash]);
        }
        throw new Error(`unexpected read of ${to} from ${from}`);
      }
    ),
  };
}

/** Lets a read that waits for a block try again quickly. */
const QUICK_BLOCK_WAIT = { attempts: 200, intervalMs: 5 };

/**
 * The wallet provider. Each request is mined as soon as it is sent. While the test holds receipts
 * back, a receipt lookup waits until they are released.
 */
function walletFor(chain: Chain, events: Event[]) {
  let sentCount = 0;
  const receipts = new Map<string, TransactionReceipt>();
  let receiptsReleased: Promise<void> = Promise.resolve();
  let releaseReceipts: () => void = () => undefined;
  const sendUncheckedTransaction = jest.fn(async (request: { to: string; data: string; chainId: number }) => {
    const hash = `0x${(++sentCount).toString(16).padStart(64, '0')}`;
    events.push(`send:${CALLS.parseTransaction({ data: request.data }).name}` as Event);
    const status = mine(chain, request) ? 1 : 0;
    receipts.set(hash, { transactionHash: hash, status, blockNumber: chain.block } as TransactionReceipt);
    return hash;
  });
  const wallet = {
    holdReceipts: () => {
      receiptsReleased = new Promise((resolve) => (releaseReceipts = resolve));
    },
    releaseReceipts: () => releaseReceipts(),
    send: jest.fn(async (method: string): Promise<unknown> => (method === 'eth_chainId' ? '0x1' : '0x10')),
    estimateGas: jest.fn(async () => BigNumber.from(100_000)),
    getNetwork: jest.fn(async () => ({ chainId: 1, name: 'homestead' })),
    getTransactionCount: jest.fn(async () => 5),
    getTransactionReceipt: jest.fn(async (hash: string) => {
      await receiptsReleased;
      return receipts.get(hash) ?? null;
    }),
    getTransaction: jest.fn(async () => null),
    // Called with the account that signs.
    getSigner: jest.fn<{ sendUncheckedTransaction: typeof sendUncheckedTransaction }, [string]>(() => ({
      sendUncheckedTransaction,
    })),
    sendUncheckedTransaction,
  };
  return wallet;
}
type Wallet = ReturnType<typeof walletFor>;

type DecodedRequest = { to: string; method: string; args: unknown[]; chainId: number };

/** Every request the wallet was asked to sign, decoded. */
function walletRequests(wallet: Wallet): DecodedRequest[] {
  return wallet.sendUncheckedTransaction.mock.calls.map(([request]) => {
    const call = CALLS.parseTransaction({ data: request.data });
    return {
      to: request.to.toLowerCase(),
      method: call.name,
      args: call.args.map((arg: unknown) =>
        BigNumber.isBigNumber(arg) ? arg.toBigInt() : typeof arg === 'string' ? arg.toLowerCase() : arg
      ),
      chainId: request.chainId,
    };
  });
}

const approval = (market: WrappedMarket, amount: bigint): DecodedRequest => ({
  to: market.baseTokenAddress.toLowerCase(),
  method: 'approve',
  args: [market.wrapperAddress.toLowerCase(), amount],
  chainId: 1,
});
const supplyAndWrap = (market: WrappedMarket, amount: bigint): DecodedRequest => ({
  to: market.wrapperAddress.toLowerCase(),
  method: 'supplyAndWrap',
  args: [amount],
  chainId: 1,
});

/** Only the base token's approval to the wrapper and the wrapper's supply: no Comet, Bulker or Permit2. */
function expectOnlyWrapperRequests(wallet: Wallet, market: WrappedMarket) {
  const { bulkerAddress } = getMarket(1, market.cometAddress) as MarketData;
  for (const request of walletRequests(wallet)) {
    expect([market.baseTokenAddress.toLowerCase(), market.wrapperAddress.toLowerCase()]).toContain(request.to);
    expect(['approve', 'supplyAndWrap']).toContain(request.method);
    expect([market.cometAddress, bulkerAddress, PERMIT2].map((address) => address.toLowerCase())).not.toContain(
      request.to
    );
    if (request.method === 'approve') expect(request.args[0]).toBe(market.wrapperAddress.toLowerCase());
    expect(request.chainId).toBe(1);
  }
  expect(wallet.getSigner.mock.calls.every(([account]) => account === ACCOUNT)).toBe(true);
}

type SessionSetup = Partial<LendingSession> & {
  cometAddress?: string;
  registry?: WrappedMarketRegistry;
  validation?: ValidationStatus;
};

/** The session as the app builds it, with the wrapper validated for that session. */
function sessionFor(wallet: object, setup: SessionSetup = {}): WrappedSession {
  const lending: LendingSession = {
    connector: { id: ANCHORAGE_CONNECTOR_ID, uid: 'uid-1' },
    status: 'connected',
    account: ACCOUNT,
    chainId: 1,
    isWatchOnly: false,
    isSignerReady: true,
    screeningStatus: 'allowed',
    ...setup,
  };
  const registry = setup.registry ?? OPEN;
  const cometAddress = setup.cometAddress ?? USDC_MARKET.cometAddress;
  const lookup = registry.lookup(1, cometAddress);
  const key = lookup.status === 'valid' ? wrappedRouteKey(lookup.market, lending) : '';
  const route = resolveLendingRoute({
    market: { chainId: 1, cometAddress },
    session: lending,
    conflictedRdns: new Set(),
    validation: { key, status: setup.validation ?? 'matched' },
    registry,
  });
  return {
    route,
    account: lending.account,
    chainId: lending.chainId,
    screeningStatus: lending.screeningStatus,
    provider: wallet,
  };
}

type Harness = {
  manager: TransactionManager;
  action: WrappedActionController;
  write: WriteWrappedState;
  position: ReturnType<typeof useWrappedPosition>;
};
type Result = { current: Pick<Harness, 'action' | 'write'> };

/**
 * The wrapped route as App wires it: the transaction manager, the lifecycle, the wrapped writes and
 * the position read, all through the fake wallet and the fake public provider.
 */
function renderWrapped(
  chain: Chain,
  {
    wallet: givenWallet,
    events = [],
    blockWait = QUICK_BLOCK_WAIT,
    checkRestriction,
  }: {
    wallet?: Wallet;
    events?: Event[];
    blockWait?: BlockWait;
    /** Replaces the lifecycle's read of Comet's pause, which goes through `readProvider` otherwise. */
    checkRestriction?: (identity: WrappedActionIdentity) => Promise<MarketRestriction | undefined>;
  } = {}
) {
  const wallet = givenWallet ?? walletFor(chain, events);
  const readProvider = readProviderFor(chain, events);
  // The panel's position read goes through the same provider, so it trails the same way.
  const positionRead = jest.fn(async () => {
    events.push('position-read');
    return positionOf(stateAt(chain, chain.block - chain.providerLag));
  });
  const web3 = {
    ...mockWeb3,
    write: { ...mockWeb3.write, account: ACCOUNT, chainId: 1, provider: wallet as unknown as JsonRpcProvider },
  };
  const hook = renderHook(
    ({ session }: { session: WrappedSession }) => {
      const manager = useTransactionManager(web3);
      const action = useWrappedAction({ session, manager, readProvider, checkRestriction });
      const write = useWriteWrappedState({
        action,
        route: session.route,
        readProvider,
        baseSymbol: symbolOf(chain.market),
        blockWait,
      });
      const position = useWrappedPosition({
        route: session.route,
        account: session.account,
        provider: readProvider as unknown as JsonRpcProvider,
        refreshToken: positionRefreshToken(manager.transactions, manager.settledTransactions),
        minBlock: newestReceiptBlock(action.recovered.settled),
        blockWait,
        read: positionRead,
      });
      return { manager, action, write, position };
    },
    { initialProps: { session: sessionFor(wallet, { cometAddress: chain.market.cometAddress }) } }
  );
  return { ...hook, wallet, readProvider, positionRead, events };
}

function stepsOf(state: WrappedActionState) {
  return 'steps' in state ? state.steps : [];
}
const stepStatuses = (result: Result) => stepsOf(result.current.action.state).map((step) => step.status);
const draftCalls = (result: Result) => {
  const { state } = result.current.action;
  if (!('draft' in state)) throw new Error('no draft is in review');
  return state.draft.steps.map((step) => ({ id: step.id, kind: step.kind, ...step.request }));
};

async function startSupply(result: Result, amount: bigint) {
  await waitFor(() => expect(result.current.action.blockedReason('supply')).toBeUndefined());
  let refusal: unknown = 'not called';
  act(() => {
    refusal = result.current.write.supply(amount);
  });
  expect(refusal).toBeUndefined();
  await waitFor(() => expect(['review', 'read-failed']).toContain(result.current.action.state.phase));
}

/** Confirms the step in review and waits until it settles or stops the draft. */
async function confirmStep(result: Result) {
  const { state } = result.current.action;
  if (state.phase !== 'review') throw new Error(`no step is in review: ${state.phase}`);
  const index = state.stepIndex;
  act(() => result.current.action.confirm());
  await waitFor(() =>
    expect(['confirmed', 'reverted', 'replaced', 'rejected', 'provider-failure', 'blocked']).toContain(
      stepsOf(result.current.action.state)[index]?.status
    )
  );
}

const encodeApprove = (market: WrappedMarket, amount: bigint) => ({
  to: market.baseTokenAddress,
  data: CALLS.encodeFunctionData('approve', [market.wrapperAddress, amount]),
});
const encodeSupply = (market: WrappedMarket, amount: bigint) => ({
  to: market.wrapperAddress,
  data: CALLS.encodeFunctionData('supplyAndWrap', [amount]),
});

describe('useWriteWrappedState', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  describe('wrappedSupply: approves the exact raw base-token amount to the selected wrapper', () => {
    it.each<[string, bigint]>([
      ['1234.567891', 1_234_567_891n],
      ['0.000001', 1n],
      ['1', 1_000_000n],
      ['1.5', 1_500_000n],
      ['.5', 500_000n],
      ['10.', 10_000_000n],
      ['007.000100', 7_000_100n],
      ['0', 0n],
      ['123456789012345678901234567890', 123456789012345678901234567890n * 10n ** 6n],
    ])('parses %p with 6 decimals as %p base units', (input, expected) => {
      expect(parseExactUnits(input, 6)).toBe(expected);
    });

    it.each(['', '.', '1.0000001', '-1', '+1', '1e6', '0x10', ' 1', '1 ', '1,000', '1.2.3', 'abc', '١'])(
      'refuses %p rather than rounding or guessing',
      (input) => {
        expect(parseExactUnits(input, 6)).toBeUndefined();
      }
    );

    it.each(MARKETS)('to the %s wrapper, from the typed amount', async (_name, market) => {
      const chain = chainFor(market, { balance: 5_000_000_000n, allowance: 0n });
      const amount = parseExactUnits('1234.567891', market.baseDecimals) as bigint;
      const { result, wallet } = renderWrapped(chain);

      await startSupply(result, amount);
      expect(draftCalls(result)).toEqual([
        { id: 'approve', kind: 'approve', ...encodeApprove(market, 1_234_567_891n) },
        { id: 'supply', kind: 'supply-and-wrap', ...encodeSupply(market, 1_234_567_891n) },
      ]);
      expect(result.current.action.state).toMatchObject({ draft: { amount: 1_234_567_891n } });

      await confirmStep(result);
      expect(walletRequests(wallet)).toEqual([approval(market, 1_234_567_891n)]);
      await confirmStep(result);

      expect(result.current.action.state.phase).toBe('complete');
      expect(walletRequests(wallet)).toEqual([approval(market, 1_234_567_891n), supplyAndWrap(market, 1_234_567_891n)]);
      expectOnlyWrapperRequests(wallet, market);
      // The exact approval is used up by the supply, and nothing is left approved.
      expect(chain.allowance).toBe(0n);
      expect(chain.balance).toBe(5_000_000_000n - 1_234_567_891n);
    });

    it('never asks for an unlimited approval, even for the whole wallet balance', async () => {
      const chain = chainFor(USDC_MARKET, { balance: 987_654_321n, allowance: 0n });
      const { result, wallet } = renderWrapped(chain);

      await startSupply(result, 987_654_321n);
      await confirmStep(result);
      await confirmStep(result);

      expect(walletRequests(wallet)).toEqual([
        approval(USDC_MARKET, 987_654_321n),
        supplyAndWrap(USDC_MARKET, 987_654_321n),
      ]);
      expect(walletRequests(wallet).some(({ args }) => args.includes(MAX_UINT256))).toBe(false);
    });
  });

  describe('wrappedSupply: skips approval when allowance is sufficient and approves once when allowance is zero', () => {
    const AMOUNT = 25_000_000n;

    it.each<[string, WrappedMarket, bigint]>([
      ['USDC, exactly the amount', USDC_MARKET, AMOUNT],
      ['USDC, more than the amount', USDC_MARKET, AMOUNT + 1n],
      ['USDT, exactly the amount', USDT_MARKET, AMOUNT],
      ['USDT, an unlimited allowance', USDT_MARKET, MAX_UINT256],
      ['institutional USDC, more than the amount', INSTITUTIONAL_USDC_MARKET, 10n ** 12n],
    ])('supplies without an approval when the allowance covers it: %s', async (_name, market, allowance) => {
      const chain = chainFor(market, { allowance });
      const { result, wallet } = renderWrapped(chain);

      await startSupply(result, AMOUNT);
      expect(draftCalls(result).map(({ kind }) => kind)).toEqual(['supply-and-wrap']);
      await confirmStep(result);

      expect(result.current.action.state.phase).toBe('complete');
      expect(walletRequests(wallet)).toEqual([supplyAndWrap(market, AMOUNT)]);
      expectOnlyWrapperRequests(wallet, market);
    });

    it.each(MARKETS)('approves exactly once from a zero allowance: %s', async (_name, market) => {
      const chain = chainFor(market, { allowance: 0n });
      const { result, wallet } = renderWrapped(chain);

      await startSupply(result, AMOUNT);
      expect(draftCalls(result).map(({ id }) => id)).toEqual(['approve', 'supply']);
      await confirmStep(result);
      await confirmStep(result);

      expect(result.current.action.state.phase).toBe('complete');
      expect(walletRequests(wallet)).toEqual([approval(market, AMOUNT), supplyAndWrap(market, AMOUNT)]);
      expectOnlyWrapperRequests(wallet, market);
    });
  });

  describe('wrappedSupply: confirms a nonzero insufficient USDT allowance reset before the exact approval and supply', () => {
    const AMOUNT = 5_000_000n;

    it('resets the allowance to zero, then approves the exact amount, then supplies, each after its own confirmation', async () => {
      const chain = chainFor(USDT_MARKET, { balance: 9_000_000n, allowance: 1_000_000n });
      const { result, wallet } = renderWrapped(chain);

      await startSupply(result, AMOUNT);
      expect(draftCalls(result)).toEqual([
        { id: 'reset-allowance', kind: 'approve', ...encodeApprove(USDT_MARKET, 0n) },
        { id: 'approve', kind: 'approve', ...encodeApprove(USDT_MARKET, AMOUNT) },
        { id: 'supply', kind: 'supply-and-wrap', ...encodeSupply(USDT_MARKET, AMOUNT) },
      ]);

      await confirmStep(result);
      expect(stepStatuses(result)).toEqual(['confirmed', 'waiting', 'waiting']);
      expect(chain.allowance).toBe(0n);
      // The approval waits for its own confirmation.
      await act(async () => undefined);
      expect(walletRequests(wallet)).toEqual([approval(USDT_MARKET, 0n)]);
      expect(result.current.action.state).toMatchObject({ phase: 'review', stepIndex: 1 });

      await confirmStep(result);
      expect(walletRequests(wallet)).toEqual([approval(USDT_MARKET, 0n), approval(USDT_MARKET, AMOUNT)]);
      expect(result.current.action.state).toMatchObject({ phase: 'review', stepIndex: 2 });

      await confirmStep(result);
      expect(result.current.action.state.phase).toBe('complete');
      expect(walletRequests(wallet)).toEqual([
        approval(USDT_MARKET, 0n),
        approval(USDT_MARKET, AMOUNT),
        supplyAndWrap(USDT_MARKET, AMOUNT),
      ]);
      expectOnlyWrapperRequests(wallet, USDT_MARKET);
    });

    it.each<[string, WrappedMarket]>([
      ['USDC', USDC_MARKET],
      ['institutional USDC', INSTITUTIONAL_USDC_MARKET],
    ])('approves %s over a nonzero allowance without a reset', async (_name, market) => {
      const chain = chainFor(market, { allowance: 1_000_000n });
      const { result, wallet } = renderWrapped(chain);

      await startSupply(result, AMOUNT);
      expect(draftCalls(result).map(({ id }) => id)).toEqual(['approve', 'supply']);
      await confirmStep(result);
      await confirmStep(result);

      expect(walletRequests(wallet)).toEqual([approval(market, AMOUNT), supplyAndWrap(market, AMOUNT)]);
    });

    it.each<[string, (wallet: Wallet, chain: Chain) => void, string]>([
      [
        'rejected',
        (wallet) => wallet.sendUncheckedTransaction.mockRejectedValueOnce({ code: 4001, message: 'User rejected' }),
        'rejected',
      ],
      [
        'answered with an error',
        (wallet) => wallet.sendUncheckedTransaction.mockRejectedValueOnce({ code: -32603, message: 'Internal error' }),
        'provider-failure',
      ],
      ['reverted', (_wallet, chain) => (chain.shouldRevertNext = true), 'reverted'],
    ])('stops the sequence when the reset is %s', async (_name, interrupt, status) => {
      const chain = chainFor(USDT_MARKET, { allowance: 1_000_000n });
      const events: Event[] = [];
      const wallet = walletFor(chain, events);
      interrupt(wallet, chain);
      const { result } = renderWrapped(chain, { wallet, events });

      await startSupply(result, AMOUNT);
      await confirmStep(result);
      expect(result.current.action.state).toMatchObject({ phase: 'stopped', stepIndex: 0 });
      expect(stepStatuses(result)).toEqual([status, 'waiting', 'waiting']);

      act(() => result.current.action.confirm());
      await act(async () => undefined);

      // At most the reset reached the wallet: no approval of the amount and no supply.
      expect(walletRequests(wallet).every(({ method, args }) => method === 'approve' && args[1] === 0n)).toBe(true);
      expect(chain.allowance).toBe(1_000_000n);
    });
  });

  describe('wrappedSupply: revalidates and simulates from the current sender before supply', () => {
    const AMOUNT = 3_000_000n;

    it('reads the balance and allowance again before each signature, and simulates the supply from the sender', async () => {
      const chain = chainFor(USDC_MARKET, { allowance: 0n });
      const { result, readProvider, events } = renderWrapped(chain);
      await startSupply(result, AMOUNT);
      events.length = 0;

      await confirmStep(result);
      await confirmStep(result);

      expect(result.current.action.state.phase).toBe('complete');
      // A fresh read before each request, and the simulation after it, right before the supply.
      expect(events.filter((event) => event !== 'position-read')).toEqual([
        'read',
        'send:approve',
        'read',
        'simulate',
        'send:supplyAndWrap',
      ]);
      // The supply's reads and its simulation all come from block 101, which mined the approval.
      expect(readProvider.call).toHaveBeenCalledWith(
        { to: USDC_MARKET.baseTokenAddress, data: CALLS.encodeFunctionData('balanceOf', [ACCOUNT]) },
        101
      );
      expect(readProvider.call).toHaveBeenCalledWith(
        {
          to: USDC_MARKET.baseTokenAddress,
          data: CALLS.encodeFunctionData('allowance', [ACCOUNT, USDC_MARKET.wrapperAddress]),
        },
        101
      );
      expect(readProvider.call).toHaveBeenCalledWith(
        { from: ACCOUNT, to: USDC_MARKET.wrapperAddress, data: CALLS.encodeFunctionData('supplyAndWrap', [AMOUNT]) },
        101
      );
    });

    it('sends nothing more when the simulation fails, and never falls back to Comet', async () => {
      const chain = chainFor(USDC_MARKET, { allowance: 0n });
      const { result, wallet } = renderWrapped(chain);
      await startSupply(result, AMOUNT);
      await confirmStep(result);

      chain.simulationRevert = revertWith(CALLS.getSighash('ZeroSharesMinted'));
      await confirmStep(result);

      expect(result.current.action.state).toMatchObject({
        phase: 'stopped',
        steps: [
          { status: 'confirmed' },
          { status: 'blocked', reason: 'step-check-failed', message: expect.stringMatching(/ZeroSharesMinted/) },
        ],
      });
      expect(walletRequests(wallet)).toEqual([approval(USDC_MARKET, AMOUNT)]);
      expectOnlyWrapperRequests(wallet, USDC_MARKET);
    });

    it('explains a simulation that reverts with a reason', async () => {
      const chain = chainFor(USDC_MARKET, { allowance: AMOUNT });
      const { result, wallet } = renderWrapped(chain);
      await startSupply(result, AMOUNT);

      chain.simulationRevert = revertWith(errorString('ERC20: transfer amount exceeds balance'));
      await confirmStep(result);

      expect(result.current.action.state).toMatchObject({
        steps: [
          {
            status: 'blocked',
            reason: 'step-check-failed',
            message: expect.stringMatching(/ERC20: transfer amount exceeds balance/),
          },
        ],
      });
      expect(walletRequests(wallet)).toEqual([]);
    });

    it.each<[string, string, RegExp]>([
      ["the wrapper's own error", CALLS.getSighash('ZeroSharesMinted'), /ZeroSharesMinted\(\)/],
      ['a reason string', errorString('ERC20: transfer amount exceeds allowance'), /exceeds allowance/],
      ['no shares', CALLS.encodeFunctionResult('supplyAndWrap', [0n]), /mints no shares/],
    ])(
      'refuses a simulation whose call returns %s, as ethers returns a reverted call',
      async (_name, data, message) => {
        const chain = chainFor(USDC_MARKET, { allowance: AMOUNT });
        const { result, wallet } = renderWrapped(chain);
        await startSupply(result, AMOUNT);

        chain.simulationResult = data;
        await confirmStep(result);

        expect(result.current.action.state).toMatchObject({
          phase: 'stopped',
          steps: [{ status: 'blocked', reason: 'step-check-failed', message: expect.stringMatching(message) }],
        });
        expect(walletRequests(wallet)).toEqual([]);
      }
    );

    it.each<[string, Error | undefined, string | undefined, RegExp]>([
      [
        "a call that failed without revert data, by the provider's own error",
        Object.assign(
          new Error('missing revert data in call exception; Transaction reverted without a reason string'),
          { code: 'CALL_EXCEPTION', data: '0x', error: { code: 429, message: 'Too Many Requests' } }
        ),
        undefined,
        /Too Many Requests \(429\)/,
      ],
      [
        'a panic, with its code',
        undefined,
        `0x4e487b71${utils.defaultAbiCoder.encode(['uint256'], [17]).slice(2)}`,
        /Panic\(17\)/,
      ],
      ['an error the wrapper does not declare, by its selector', undefined, '0xdeadbeef', /revert data 0xdeadbeef/],
    ])('describes %s', async (_name, thrown, returned, message) => {
      const chain = chainFor(USDC_MARKET, { allowance: AMOUNT });
      const { result, wallet } = renderWrapped(chain);
      await startSupply(result, AMOUNT);

      chain.simulationRevert = thrown;
      chain.simulationResult = returned;
      await confirmStep(result);

      const [step] = stepsOf(result.current.action.state);
      expect(step).toMatchObject({
        status: 'blocked',
        reason: 'step-check-failed',
        message: expect.stringMatching(message),
      });
      expect(step).not.toMatchObject({ message: expect.stringMatching(/without a reason string/) });
      expect(walletRequests(wallet)).toEqual([]);
    });

    it("describes a review whose first read failed by the provider's own error", async () => {
      const chain = chainFor(USDC_MARKET);
      chain.failsFundReads = true;
      const { result, wallet } = renderWrapped(chain);

      await startSupply(result, AMOUNT);

      expect(result.current.action.state).toMatchObject({
        phase: 'read-failed',
        message: expect.stringMatching(/could not be read \(rate limited\)/),
      });
      expect(walletRequests(wallet)).toEqual([]);
    });

    it("refuses a review while the market's network cannot be read", async () => {
      const chain = chainFor(USDC_MARKET);
      const events: Event[] = [];
      const wallet = walletFor(chain, events);
      const manager = {
        transactions: [],
        settledTransactions: [],
        walletFailure: undefined,
        restoredSession: { provider: wallet, account: ACCOUNT, chainId: 1 },
        dismissTransaction: jest.fn(),
        submitTransaction: jest.fn(),
      };
      const { result } = renderHook(() => {
        const session = sessionFor(wallet);
        const action = useWrappedAction({
          session,
          manager,
          readProvider: undefined,
          checkRestriction: async () => undefined,
        });
        const write = useWriteWrappedState({
          action,
          route: session.route,
          readProvider: undefined,
          baseSymbol: 'USDC',
        });
        return { action, write };
      });

      await startSupply(result, AMOUNT);

      expect(result.current.action.state).toMatchObject({
        phase: 'read-failed',
        message: expect.stringMatching(/cannot be read right now/),
      });
      expect(manager.submitTransaction).not.toHaveBeenCalled();
    });

    it.each<[string, Partial<Chain>, (chain: Chain) => void, number, string[]]>([
      ['the allowance became enough before the approval', {}, (chain) => (chain.allowance = AMOUNT), 0, []],
      ['another allowance was set before the approval', { allowance: 1n }, (chain) => (chain.allowance = 2n), 0, []],
      ['the allowance was used before the supply', {}, (chain) => (chain.allowance = 0n), 1, ['approve']],
      [
        'the wallet balance fell below the amount before the supply',
        {},
        (chain) => (chain.balance = AMOUNT - 1n),
        1,
        ['approve'],
      ],
      ['the wallet balance fell below the amount before the approval', {}, (chain) => (chain.balance = 0n), 0, []],
    ])('stops for a fresh review when %s', async (_name, initial, change, stoppedAt, sent) => {
      const chain = { ...chainFor(USDC_MARKET), ...initial };
      const { result, wallet } = renderWrapped(chain);
      await startSupply(result, AMOUNT);
      if (stoppedAt === 1) await confirmStep(result);

      change(chain);
      await confirmStep(result);

      expect(result.current.action.state).toMatchObject({ phase: 'stopped', stepIndex: stoppedAt });
      expect(stepsOf(result.current.action.state)[stoppedAt]).toMatchObject({
        status: 'blocked',
        reason: 'step-check-failed',
        message: expect.stringMatching(/review/i),
      });
      expect(walletRequests(wallet).map(({ method }) => method)).toEqual(sent);
    });

    it('stops before the USDT reset when the allowance changed after the review', async () => {
      const chain = chainFor(USDT_MARKET, { allowance: 1_000_000n });
      const { result, wallet } = renderWrapped(chain);
      await startSupply(result, AMOUNT);
      expect(draftCalls(result).map(({ id }) => id)).toEqual(['reset-allowance', 'approve', 'supply']);

      // The allowance is raised elsewhere, above the amount, before the reset is signed.
      chain.allowance = 10_000_000n;
      await confirmStep(result);

      expect(result.current.action.state).toMatchObject({
        phase: 'stopped',
        steps: [{ status: 'blocked', reason: 'step-check-failed' }, { status: 'waiting' }, { status: 'waiting' }],
      });
      expect(walletRequests(wallet)).toEqual([]);
      expect(chain.allowance).toBe(10_000_000n);
    });

    it('stops without a simulation or a request when the balance and allowance cannot be read before the supply', async () => {
      const chain = chainFor(USDC_MARKET, { allowance: 0n });
      const { result, wallet, events } = renderWrapped(chain);
      await startSupply(result, AMOUNT);
      await confirmStep(result);
      events.length = 0;

      chain.failsFundReads = true;
      await confirmStep(result);

      expect(result.current.action.state).toMatchObject({
        phase: 'stopped',
        steps: [
          { status: 'confirmed' },
          { status: 'blocked', reason: 'step-check-failed', message: expect.stringMatching(/could not be read again/) },
        ],
      });
      expect(events).not.toContain('simulate');
      expect(walletRequests(wallet)).toEqual([approval(USDC_MARKET, AMOUNT)]);
    });

    it('stops when a USDT allowance is nonzero again after its reset', async () => {
      const chain = chainFor(USDT_MARKET, { allowance: 1_000_000n });
      const { result, wallet } = renderWrapped(chain);
      await startSupply(result, AMOUNT);
      await confirmStep(result);
      expect(chain.allowance).toBe(0n);

      chain.allowance = 7n;
      await confirmStep(result);

      expect(result.current.action.state).toMatchObject({
        phase: 'stopped',
        steps: [{ status: 'confirmed' }, { status: 'blocked', reason: 'step-check-failed' }, { status: 'waiting' }],
      });
      expect(walletRequests(wallet)).toEqual([approval(USDT_MARKET, 0n)]);
    });

    it.each<[string, bigint, RegExp]>([
      ['above the refreshed wallet balance', 10_000_000_001n, /in your wallet/i],
      ['zero', 0n, /greater than/i],
      ['the unlimited sentinel', MAX_UINT256, /unlimited/i],
    ])('refuses an amount %s before any review', async (_name, amount, message) => {
      const chain = chainFor(USDC_MARKET, { balance: 10_000_000_000n });
      const { result, wallet } = renderWrapped(chain);

      await startSupply(result, amount);

      expect(result.current.action.state).toMatchObject({
        phase: 'read-failed',
        message: expect.stringMatching(message),
      });
      expect(walletRequests(wallet)).toEqual([]);
    });

    it("refuses to plan for a market that is not the reviewed identity's", async () => {
      const identity = wrappedActionIdentity('supply', sessionFor({}, { cometAddress: USDT_MARKET.cometAddress }));
      if (identity === undefined) throw new Error('the session must have an identity');
      const readFunds = jest.fn(async () => ({ blockNumber: 100, walletBalance: AMOUNT, allowance: 0n }));

      await expect(
        prepareWrappedSupply({
          identity,
          market: USDC_MARKET,
          amount: AMOUNT,
          symbol: 'USDC',
          reads: { readFunds, call: jest.fn(), retryIntervalMs: 1 },
        })
      ).rejects.toThrow(/wrapper for this market changed/);
      expect(readFunds).not.toHaveBeenCalled();
    });

    it('reads again when a node of a load-balanced provider is still a block behind', async () => {
      const chain = chainFor(USDC_MARKET, { allowance: 0n });
      const { result, wallet } = renderWrapped(chain);
      await startSupply(result, AMOUNT);

      // The next pinned read lands on a node that has not reached its block yet.
      chain.laggingNodeReads = 1;
      await confirmStep(result);

      expect(stepStatuses(result)).toEqual(['confirmed', 'waiting']);
      expect(walletRequests(wallet)).toEqual([approval(USDC_MARKET, AMOUNT)]);
    });

    it('simulates again when a node of a load-balanced provider is still a block behind', async () => {
      const chain = chainFor(USDC_MARKET, { allowance: AMOUNT });
      const { result, wallet } = renderWrapped(chain);
      await startSupply(result, AMOUNT);

      chain.laggingNodeSimulations = 1;
      await confirmStep(result);

      expect(result.current.action.state.phase).toBe('complete');
      expect(walletRequests(wallet)).toEqual([supplyAndWrap(USDC_MARKET, AMOUNT)]);
    });

    it('does not simulate a revert again', async () => {
      const chain = chainFor(USDC_MARKET, { allowance: AMOUNT });
      const { result, events } = renderWrapped(chain);
      await startSupply(result, AMOUNT);
      events.length = 0;

      chain.simulationRevert = revertWith(CALLS.getSighash('ZeroSharesMinted'));
      await confirmStep(result);

      expect(events.filter((event) => event === 'simulate')).toHaveLength(1);
      expect(stepStatuses(result)).toEqual(['blocked']);
    });

    it('says a step stopped because the provider did not catch up, in a sentence of its own', async () => {
      const chain = chainFor(USDC_MARKET, { allowance: 0n });
      const { result } = renderWrapped(chain, { blockWait: { attempts: 3, intervalMs: 5 } });
      await startSupply(result, AMOUNT);
      await confirmStep(result);

      chain.providerLag = 1;
      await confirmStep(result);

      expect(stepsOf(result.current.action.state)[1]).toMatchObject({
        status: 'blocked',
        message:
          "This market's network has not shown your last wrapped transaction yet. Review the supply again in a moment.",
      });
    });

    it('treats a revert the node reports without data as a revert: it says so and does not simulate again', async () => {
      const chain = chainFor(USDT_MARKET, { allowance: AMOUNT });
      const { result, events } = renderWrapped(chain);
      await startSupply(result, AMOUNT);
      events.length = 0;

      // USDT's require failures revert with no data. Ethers wraps the node's error twice.
      chain.simulationRevert = Object.assign(new Error('missing revert data in call exception'), {
        code: 'CALL_EXCEPTION',
        data: '0x',
        error: Object.assign(new Error('processing response error (body=..., url="https://rpc.example")'), {
          reason: 'processing response error',
          code: 'SERVER_ERROR',
          error: Object.assign(new Error('execution reverted'), { code: -32000 }),
        }),
      });
      await confirmStep(result);

      expect(events.filter((event) => event === 'simulate')).toHaveLength(1);
      const [step] = stepsOf(result.current.action.state);
      expect(step).toMatchObject({
        status: 'blocked',
        message: expect.stringMatching(/execution reverted \(-32000\)/),
      });
      expect(step).not.toMatchObject({ message: expect.stringMatching(/processing response error|rpc\.example/) });
    });

    it('describes an HTTP failure by its status, without the request it sent', async () => {
      const chain = chainFor(USDC_MARKET, { allowance: AMOUNT });
      const { result } = renderWrapped(chain);
      await startSupply(result, AMOUNT);

      const request = `requestBody="{\\"method\\":\\"eth_call\\",\\"params\\":[{\\"from\\":\\"${ACCOUNT}\\"}]}", url="https://rpc.example/ethereum-mainnet"`;
      chain.simulationRevert = Object.assign(new Error('missing revert data in call exception'), {
        code: 'CALL_EXCEPTION',
        data: '0x',
        error: Object.assign(
          new Error(`bad response (status=503, headers={}, body=null, ${request}, code=SERVER_ERROR)`),
          {
            reason: 'bad response',
            code: 'SERVER_ERROR',
            status: 503,
          }
        ),
      });
      await confirmStep(result);

      const [step] = stepsOf(result.current.action.state);
      expect(step).toMatchObject({ status: 'blocked', message: expect.stringMatching(/bad response, status 503/) });
      expect(step).not.toMatchObject({ message: expect.stringMatching(/rpc\.example|eth_call/) });
    });

    it('stops without sending when the balance and allowance cannot be read again', async () => {
      const chain = chainFor(USDC_MARKET, { allowance: 0n });
      const { result, wallet } = renderWrapped(chain);
      await startSupply(result, AMOUNT);

      chain.failsFundReads = true;
      await confirmStep(result);

      expect(result.current.action.state).toMatchObject({
        phase: 'stopped',
        steps: [
          { status: 'blocked', reason: 'step-check-failed', message: expect.stringMatching(/could not be read again/) },
          { status: 'waiting' },
        ],
      });
      expect(walletRequests(wallet)).toEqual([]);
    });

    it('judges the amount by a fresh read, not by the balance the panel showed', async () => {
      const chain = chainFor(USDC_MARKET, { balance: AMOUNT });
      const { result, wallet } = renderWrapped(chain);
      await waitFor(() => expect(result.current.position.state).toMatchObject({ status: 'loaded' }));

      // The wallet spends some of its balance after the panel's read.
      chain.balance = AMOUNT - 1n;
      await startSupply(result, AMOUNT);

      expect(result.current.action.state).toMatchObject({
        phase: 'read-failed',
        message: expect.stringMatching(/wallet/i),
      });
      expect(walletRequests(wallet)).toEqual([]);
    });

    it("waits for the market's provider to show the confirmed approval before checking the supply", async () => {
      const chain = chainFor(USDC_MARKET, { allowance: 0n });
      const { result, wallet, readProvider } = renderWrapped(chain);
      await startSupply(result, AMOUNT);
      await confirmStep(result);
      expect(chain.block).toBe(101);

      // The wallet's node has the approval's block. The market's provider is one block behind.
      chain.providerLag = 1;
      const asked = readProvider.getBlockNumber.mock.calls.length;
      act(() => result.current.action.confirm());
      await waitFor(() => expect(readProvider.getBlockNumber.mock.calls.length).toBeGreaterThan(asked + 2));
      expect(walletRequests(wallet)).toEqual([approval(USDC_MARKET, AMOUNT)]);
      expect(stepStatuses(result)).toEqual(['confirmed', 'checking']);

      chain.providerLag = 0;
      await waitFor(() => expect(result.current.action.state.phase).toBe('complete'));
      expect(walletRequests(wallet)).toEqual([approval(USDC_MARKET, AMOUNT), supplyAndWrap(USDC_MARKET, AMOUNT)]);
    });

    it("plans a fresh review from the confirmed approval while the market's provider trails, and asks for no second approval", async () => {
      const chain = chainFor(USDC_MARKET, { allowance: 0n });
      const { result, wallet } = renderWrapped(chain);
      await startSupply(result, AMOUNT);
      await confirmStep(result);
      act(() => result.current.action.discard());

      chain.providerLag = 1;
      act(() => {
        result.current.write.supply(AMOUNT);
      });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(result.current.action.state.phase).toBe('reading');

      chain.providerLag = 0;
      await waitFor(() => expect(result.current.action.state.phase).toBe('review'));
      expect(draftCalls(result).map(({ id }) => id)).toEqual(['supply']);
      expect(walletRequests(wallet)).toEqual([approval(USDC_MARKET, AMOUNT)]);
    });

    it("signs nothing when the market's provider does not catch up", async () => {
      const chain = chainFor(USDC_MARKET, { allowance: 0n });
      const { result, wallet } = renderWrapped(chain, { blockWait: { attempts: 3, intervalMs: 5 } });
      await startSupply(result, AMOUNT);
      await confirmStep(result);

      chain.providerLag = 1;
      await confirmStep(result);

      expect(result.current.action.state).toMatchObject({
        phase: 'stopped',
        steps: [
          { status: 'confirmed' },
          { status: 'blocked', reason: 'step-check-failed', message: expect.stringMatching(/has not shown/) },
        ],
      });
      expect(walletRequests(wallet)).toEqual([approval(USDC_MARKET, AMOUNT)]);
    });

    it("signs nothing when the market's provider stops answering for its newest block", async () => {
      const chain = chainFor(USDC_MARKET, { allowance: 0n });
      const { result, wallet, readProvider } = renderWrapped(chain, { blockWait: { attempts: 3, intervalMs: 5 } });
      await startSupply(result, AMOUNT);
      await confirmStep(result);

      readProvider.getBlockNumber.mockImplementation(() => new Promise<number>(() => undefined));
      await confirmStep(result);

      expect(result.current.action.state).toMatchObject({
        phase: 'stopped',
        steps: [
          { status: 'confirmed' },
          { status: 'blocked', reason: 'step-check-failed', message: expect.stringMatching(/has not shown/) },
        ],
      });
      expect(walletRequests(wallet)).toEqual([approval(USDC_MARKET, AMOUNT)]);
    });

    const CHANGES: [string, (wallet: Wallet) => WrappedSession][] = [
      ['account', (wallet) => sessionFor(wallet, { account: OTHER_ACCOUNT })],
      ['route: the wrapper check fails', (wallet) => sessionFor(wallet, { validation: 'not-canonical' })],
      ['route: the wallet leaves Ethereum', (wallet) => sessionFor(wallet, { chainId: 8453 })],
      ['screening', (wallet) => sessionFor(wallet, { screeningStatus: 'blocked' })],
      ['release control', (wallet) => sessionFor(wallet, { registry: registryWith({ deposits: false }) })],
    ];

    it.each(CHANGES)('signs nothing further after a change of %s', async (_name, changedSession) => {
      const chain = chainFor(USDC_MARKET, { allowance: 0n });
      const { result, rerender, wallet } = renderWrapped(chain);
      await startSupply(result, AMOUNT);
      await confirmStep(result);
      expect(result.current.action.state).toMatchObject({ phase: 'review', stepIndex: 1 });

      rerender({ session: changedSession(wallet) });
      act(() => result.current.action.confirm());
      await act(async () => undefined);

      expect(['discarded', 'stopped']).toContain(result.current.action.state.phase);
      expect(walletRequests(wallet)).toEqual([approval(USDC_MARKET, AMOUNT)]);
      let refusal: unknown;
      act(() => {
        refusal = result.current.write.supply(AMOUNT);
      });
      expect(refusal).toBeDefined();
    });
  });

  describe('wrappedSupply: requires new user review after reconnect or an interrupted sequence', () => {
    const AMOUNT = 4_000_000n;

    it('closes the reviewed supply on a reconnect, and the next review starts from the new allowance', async () => {
      const chain = chainFor(USDC_MARKET, { allowance: 0n });
      const { result, rerender, wallet } = renderWrapped(chain);
      await startSupply(result, AMOUNT);
      await confirmStep(result);
      const keptConfirm = result.current.action.confirm;

      rerender({ session: sessionFor(wallet, { status: 'reconnecting' }) });
      expect(result.current.action.state).toMatchObject({ phase: 'discarded', reason: 'identity-changed' });
      rerender({ session: sessionFor(wallet) });
      act(() => keptConfirm());
      act(() => result.current.action.confirm());
      await act(async () => undefined);

      expect(result.current.action.state.phase).toBe('discarded');
      expect(walletRequests(wallet)).toEqual([approval(USDC_MARKET, AMOUNT)]);

      await startSupply(result, AMOUNT);
      // The approval already went through, so the fresh review only supplies, after its own confirmation.
      expect(draftCalls(result).map(({ id }) => id)).toEqual(['supply']);
      expect(stepStatuses(result)).toEqual(['waiting']);
      expect(walletRequests(wallet)).toEqual([approval(USDC_MARKET, AMOUNT)]);
      await confirmStep(result);
      expect(walletRequests(wallet)).toEqual([approval(USDC_MARKET, AMOUNT), supplyAndWrap(USDC_MARKET, AMOUNT)]);
    });

    it('sends nothing after a reload between the approval and the supply, and the next review only supplies', async () => {
      const chain = chainFor(USDC_MARKET, { allowance: 0n });
      const events: Event[] = [];
      const wallet = walletFor(chain, events);
      const first = renderWrapped(chain, { wallet, events });
      await startSupply(first.result, AMOUNT);
      wallet.holdReceipts();
      act(() => first.result.current.action.confirm());
      await waitFor(() => expect(stepStatuses(first.result)).toEqual(['submitted', 'waiting']));

      // The page reloads while the approval is pending.
      first.unmount();
      const second = renderWrapped(chain, { wallet, events });
      await waitFor(() => expect(second.result.current.action.recovered.pending).toHaveLength(1));
      expect(second.result.current.action.blockedReason('supply')).toBe('transaction-pending');
      expect(second.result.current.write.supply(AMOUNT)).toBe('transaction-pending');

      await act(async () => wallet.releaseReceipts());
      await waitFor(() => expect(second.result.current.action.recovered.settled).toHaveLength(1));
      expect(second.result.current.action.state).toEqual({ phase: 'idle' });
      expect(walletRequests(wallet)).toEqual([approval(USDC_MARKET, AMOUNT)]);

      await startSupply(second.result, AMOUNT);
      expect(draftCalls(second.result).map(({ id }) => id)).toEqual(['supply']);
      await act(async () => undefined);
      expect(walletRequests(wallet)).toEqual([approval(USDC_MARKET, AMOUNT)]);
    });

    it('waits for a supply request the wallet left unanswered until the user stops waiting, and resends nothing', async () => {
      const chain = chainFor(USDC_MARKET, { allowance: AMOUNT });
      const events: Event[] = [];
      const wallet = walletFor(chain, events);
      wallet.sendUncheckedTransaction.mockRejectedValueOnce({ code: -32603, message: 'Internal error' });
      const { result } = renderWrapped(chain, { wallet, events });
      await startSupply(result, AMOUNT);
      await confirmStep(result);
      expect(stepStatuses(result)).toEqual(['provider-failure']);

      act(() => result.current.action.discard());
      expect(result.current.action.blockedReason('supply')).toBe('transaction-pending');
      expect(result.current.action.canDismissRecovered).toBe(true);
      expect(result.current.write.supply(AMOUNT)).toBe('transaction-pending');

      act(() => result.current.action.dismissRecovered());
      await startSupply(result, AMOUNT);
      expect(stepStatuses(result)).toEqual(['waiting']);
      expect(wallet.sendUncheckedTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('wrappedSupply: distinguishes awaiting signature, pending hash, rejection, provider failure, revert, replacement, and unresolved transaction', () => {
    const AMOUNT = 2_000_000n;

    type Manager = Pick<
      TransactionManager,
      | 'transactions'
      | 'settledTransactions'
      | 'walletFailure'
      | 'restoredSession'
      | 'submitTransaction'
      | 'dismissTransaction'
    >;

    /** A transaction manager whose sends resolve only when the test says so. */
    function fakeManager(wallet: Wallet) {
      const requests: { request: TransactionRequest; resolve: (result: SendResult) => void }[] = [];
      const manager: Manager = {
        transactions: [],
        settledTransactions: [],
        walletFailure: undefined,
        restoredSession: { provider: wallet, account: ACCOUNT, chainId: 1 },
        dismissTransaction: jest.fn(),
        submitTransaction: jest.fn(
          (request: TransactionRequest) => new Promise<SendResult>((resolve) => requests.push({ request, resolve }))
        ),
      };
      return { manager, requests };
    }

    function renderWithFakeManager(chain: Chain) {
      const events: Event[] = [];
      const wallet = walletFor(chain, events);
      const readProvider = readProviderFor(chain, events);
      const { manager, requests } = fakeManager(wallet);
      const hook = renderHook(
        ({ manager: currentManager }: { manager: Manager }) => {
          const action = useWrappedAction({ session: sessionFor(wallet), manager: currentManager, readProvider });
          const write = useWriteWrappedState({
            action,
            route: sessionFor(wallet).route,
            readProvider,
            baseSymbol: 'USDC',
            blockWait: QUICK_BLOCK_WAIT,
          });
          return { action, write };
        },
        { initialProps: { manager } }
      );
      return { ...hook, wallet, manager, requests };
    }

    const OUTCOMES: [string, string, RegExp][] = [
      ['awaiting signature', 'awaiting-signature', /confirm the request in your wallet/i],
      ['pending hash', 'submitted', /broadcast/i],
      ['rejection', 'rejected', /you rejected the request/i],
      ['provider failure', 'provider-failure', /your wallet reported an error/i],
      ['revert', 'reverted', /failed on chain/i],
      ['replacement', 'replaced', /replaced or dropped/i],
      ['unresolved transaction', 'unresolved', /can no longer follow it/i],
    ];

    it.each(OUTCOMES)('%s', async (_name, status, text) => {
      const chain = chainFor(USDC_MARKET, { allowance: AMOUNT });
      const { result, rerender, manager, requests, wallet } = renderWithFakeManager(chain);
      await waitFor(() => expect(result.current.action.session.status).toBe('usable'));
      act(() => {
        result.current.write.supply(AMOUNT);
      });
      await waitFor(() => expect(result.current.action.state.phase).toBe('review'));
      act(() => result.current.action.confirm());
      await waitFor(() => expect(requests).toHaveLength(1));

      // The manager asks the wallet to send, as the real one does, and reports the hash it returned.
      let hash = '';
      const submit = async () => {
        hash = (await requests[0].request.send()) as string;
        requests[0].resolve({ status: 'submitted', id: 'id-1', hash });
      };
      await act(async () => {
        switch (status) {
          case 'submitted':
            await submit();
            break;
          case 'rejected':
            requests[0].resolve({ status: 'rejected' });
            break;
          case 'provider-failure':
            requests[0].resolve({ status: 'provider-failure', message: 'Internal error (-32603)' });
            break;
          case 'reverted':
          case 'replaced':
            await submit();
            await Promise.resolve();
            requests[0].request.onSettled?.(
              status === 'reverted'
                ? { status: 'reverted', receipt: { transactionHash: hash, status: 0 } as TransactionReceipt }
                : { status: 'replaced' }
            );
            break;
          case 'unresolved':
            await submit();
            break;
        }
      });
      if (status === 'unresolved') {
        // The wallet breaks after it broadcast the supply, so its result can no longer be followed.
        rerender({ manager: { ...manager, walletFailure: { provider: wallet, message: 'sendMessage' } } });
        await waitFor(() => expect(result.current.action.state.phase).toBe('stopped'));
      }

      expect(stepStatuses(result)).toEqual([status]);
      // Nothing is retried or sent again.
      expect(manager.submitTransaction).toHaveBeenCalledTimes(1);

      render(
        <WrappedSupplyModal
          state={result.current.action.state}
          symbol="USDC"
          decimals={6}
          directBorrowBalance={0n}
          onConfirm={jest.fn()}
          onClose={jest.fn()}
        />
      );
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(text);
      // Each outcome reads differently from every other.
      for (const [, otherStatus, otherText] of OUTCOMES) {
        if (otherStatus !== status) expect(dialog).not.toHaveTextContent(otherText);
      }
      const links = screen
        .queryAllByRole('link', { name: /view on explorer/i })
        .map((link) => link.getAttribute('href'));
      if (['submitted', 'reverted', 'replaced', 'unresolved'].includes(status)) {
        expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(links).toEqual([`${getBlockExplorerUrl(1)}/tx/${hash}`]);
      } else {
        expect(links).toEqual([]);
      }
    });

    it("refreshes the position from a block that shows the confirmed supply, while the market's provider trails", async () => {
      const chain = chainFor(USDC_MARKET, { balance: 10_000_000n, allowance: AMOUNT });
      const { result } = renderWrapped(chain);
      await waitFor(() => expect(result.current.position.state).toMatchObject({ status: 'loaded' }));
      await startSupply(result, AMOUNT);

      // The market's provider trails the wallet's node by a block, so it does not show the supply yet.
      chain.providerLag = 1;
      await confirmStep(result);
      expect(result.current.action.state.phase).toBe('complete');
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(result.current.position.state).toMatchObject({ position: { shares: 0n } });

      chain.providerLag = 0;
      await waitFor(() =>
        expect(result.current.position.state).toMatchObject({
          position: { shares: AMOUNT * 10n ** 12n, baseWalletBalance: 10_000_000n - AMOUNT, wrapperAllowance: 0n },
        })
      );
    });

    it('refreshes shares, wallet balance and allowance after the confirmed supply, and links the transaction', async () => {
      const chain = chainFor(USDC_MARKET, { balance: 10_000_000n, allowance: 0n });
      const { result, positionRead } = renderWrapped(chain);
      await waitFor(() =>
        expect(result.current.position.state).toMatchObject({
          status: 'loaded',
          position: { shares: 0n, baseWalletBalance: 10_000_000n, wrapperAllowance: 0n },
        })
      );

      await startSupply(result, AMOUNT);
      await confirmStep(result);
      await waitFor(() =>
        expect(result.current.position.state).toMatchObject({ position: { wrapperAllowance: AMOUNT } })
      );
      const readsBeforeSupply = positionRead.mock.calls.length;
      await confirmStep(result);

      expect(result.current.action.state.phase).toBe('complete');
      await waitFor(() =>
        expect(result.current.position.state).toMatchObject({
          status: 'loaded',
          position: { shares: AMOUNT * 10n ** 12n, baseWalletBalance: 10_000_000n - AMOUNT, wrapperAllowance: 0n },
        })
      );
      expect(positionRead.mock.calls.length).toBeGreaterThan(readsBeforeSupply);

      render(
        <WrappedSupplyModal
          state={result.current.action.state}
          symbol="USDC"
          decimals={6}
          directBorrowBalance={0n}
          onConfirm={jest.fn()}
          onClose={jest.fn()}
        />
      );
      const supplyHash = (stepsOf(result.current.action.state)[1] as { hash: string }).hash;
      expect(
        screen.getAllByRole('link', { name: /view on explorer/i }).map((link) => link.getAttribute('href'))
      ).toContain(`${getBlockExplorerUrl(1)}/tx/${supplyHash}`);
    });
  });

  /** 250 of the wrapper's 1,000 whole shares: a full exit pays 250,124,997 base units. */
  const SHARES = 250n * 10n ** 18n;
  const FULL_EXIT_CASH = 250_124_997n;
  /** The fewest shares that pay 100 USDC: ceil(100,000,003 × 10^21 ÷ 1,000,500,001). */
  const SHARES_FOR_100 = 99_950_027_886_106_918_655n;

  /** A chain where the account holds `shares` of the wrapper. */
  function exitChainFor(market: WrappedMarket, ledger: Partial<Ledger> = {}): Chain {
    return { ...chainFor(market), shares: SHARES, ...ledger };
  }

  async function startWithdraw(result: Result, request: WithdrawalRequest, shownCash?: bigint) {
    await waitFor(() => expect(result.current.action.blockedReason('withdraw')).toBeUndefined());
    let refusal: unknown = 'not called';
    act(() => {
      refusal = result.current.write.withdraw(request, shownCash);
    });
    expect(refusal).toBeUndefined();
    await waitFor(() => expect(['review', 'read-failed']).toContain(result.current.action.state.phase));
  }

  const encodeExit = (market: WrappedMarket, shares: bigint) => ({
    to: market.wrapperAddress,
    data: CALLS.encodeFunctionData('unwrapAndWithdraw', [shares]),
  });
  const unwrapAndWithdraw = (market: WrappedMarket, shares: bigint): DecodedRequest => ({
    to: market.wrapperAddress.toLowerCase(),
    method: 'unwrapAndWithdraw',
    args: [shares],
    chainId: 1,
  });

  /**
   * Only the wrapper's `unwrapAndWithdraw`, signed by the account on Ethereum: never Comet's
   * `withdraw`, which can open a borrow, nor the Bulker. Every call made from the account, the
   * simulations and the gas estimates included, is the wrapper's exit too.
   */
  function expectOnlyWrapperExit(
    wallet: Wallet,
    readProvider: ReturnType<typeof readProviderFor>,
    market: WrappedMarket
  ) {
    const { bulkerAddress } = getMarket(1, market.cometAddress) as MarketData;
    const forbidden = [market.cometAddress, bulkerAddress, PERMIT2].map((address) => address.toLowerCase());
    for (const request of walletRequests(wallet)) {
      expect(request).toMatchObject({
        to: market.wrapperAddress.toLowerCase(),
        method: 'unwrapAndWithdraw',
        chainId: 1,
      });
      expect(forbidden).not.toContain(request.to);
    }
    expect(wallet.getSigner.mock.calls.every(([account]) => account === ACCOUNT)).toBe(true);
    const fromAccount = [
      ...readProvider.call.mock.calls.map(([request]) => request),
      ...(wallet.estimateGas.mock.calls as unknown as [{ from?: string; to?: string; data?: string }][]).map(
        ([request]) => request
      ),
    ].filter((request) => request.from !== undefined);
    for (const request of fromAccount) {
      expect(request.to?.toLowerCase()).toBe(market.wrapperAddress.toLowerCase());
      expect(CALLS.parseTransaction({ data: request.data ?? '0x' }).name).toBe('unwrapAndWithdraw');
    }
  }

  describe('wrappedWithdraw: full exit uses the refreshed entire share balance', () => {
    it.each(MARKETS)(
      'burns the share balance read when the review starts, not the one the panel showed: %s',
      async (_name, market) => {
        const chain = exitChainFor(market);
        const { result, wallet, readProvider } = renderWrapped(chain);
        await waitFor(() =>
          expect(result.current.position.state).toMatchObject({ status: 'loaded', position: { shares: SHARES } })
        );

        // Shares arrive after the panel's read. The page showed the full exit of the earlier balance.
        chain.shares = 260n * 10n ** 18n;
        await startWithdraw(result, { kind: 'full' }, FULL_EXIT_CASH);

        expect(draftCalls(result)).toEqual([
          { id: WRAPPED_WITHDRAW_STEP_ID, kind: 'unwrap-and-withdraw', ...encodeExit(market, 260n * 10n ** 18n) },
        ]);
        expect(result.current.action.state).toMatchObject({
          draft: {
            amount: 260n * 10n ** 18n,
            withdrawal: {
              request: { kind: 'full' },
              quote: {
                kind: 'full',
                shares: 260n * 10n ** 18n,
                grossAssets: 260_130_000n,
                redeemBuffer: 3n,
                cash: 260_129_997n,
                leavesDust: false,
              },
              shownCash: FULL_EXIT_CASH,
              blockNumber: 100,
            },
          },
        });

        await confirmStep(result);
        expect(result.current.action.state.phase).toBe('complete');
        expect(walletRequests(wallet)).toEqual([unwrapAndWithdraw(market, 260n * 10n ** 18n)]);
        expectOnlyWrapperExit(wallet, readProvider, market);
        expect(chain.shares).toBe(0n);
        expect(chain.balance).toBe(10_000_000_000n + 260_129_997n);
      }
    );

    it('reads the position again and simulates the exit from the account at that block, just before the signature', async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, readProvider, events } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'full' });
      events.length = 0;

      await confirmStep(result);

      expect(result.current.action.state.phase).toBe('complete');
      expect(events.filter((event) => event !== 'position-read')).toEqual([
        'exit-read',
        'simulate',
        'send:unwrapAndWithdraw',
      ]);
      expect(readProvider.call).toHaveBeenCalledWith(
        { to: USDC_MARKET.wrapperAddress, data: CALLS.encodeFunctionData('balanceOf', [ACCOUNT]) },
        100
      );
      expect(readProvider.call).toHaveBeenCalledWith(
        {
          from: ACCOUNT,
          to: USDC_MARKET.wrapperAddress,
          data: CALLS.encodeFunctionData('unwrapAndWithdraw', [SHARES]),
        },
        100
      );
    });

    it.each<[string, bigint]>([
      ['received', 1n],
      ['sent', -1n],
    ])(
      'stops for a fresh review when the account %s shares before the signature, and the next review burns the new balance',
      async (_name, change) => {
        const chain = exitChainFor(USDC_MARKET);
        const { result, wallet, events } = renderWrapped(chain);
        await startWithdraw(result, { kind: 'full' });
        events.length = 0;

        chain.shares += change;
        await confirmStep(result);

        expect(result.current.action.state).toMatchObject({
          phase: 'stopped',
          steps: [
            {
              status: 'blocked',
              reason: 'step-check-failed',
              message: expect.stringMatching(/wrapped balance changed.*review/i),
            },
          ],
        });
        expect(events).not.toContain('simulate');
        expect(walletRequests(wallet)).toEqual([]);

        act(() => result.current.action.discard());
        await startWithdraw(result, { kind: 'full' });
        expect(draftCalls(result)).toEqual([
          { id: WRAPPED_WITHDRAW_STEP_ID, kind: 'unwrap-and-withdraw', ...encodeExit(USDC_MARKET, SHARES + change) },
        ]);
      }
    );

    it('stops for a fresh review when the cash estimate falls before the signature', async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'full' });

      // The wrapper's assets fall, so the same shares now pay 250,024,997 base units.
      chain.totalAssets = 1_000_100_000n;
      await confirmStep(result);

      expect(stepsOf(result.current.action.state)[0]).toMatchObject({
        status: 'blocked',
        reason: 'step-check-failed',
        message: expect.stringMatching(/now pays about 250\.024997 USDC, less than the 250\.124997 USDC you reviewed/),
      });
      expect(walletRequests(wallet)).toEqual([]);
    });

    it('signs the reviewed shares when interest raises the estimate before the signature', async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'full' });

      chain.totalAssets = 1_001_000_000n;
      await confirmStep(result);

      expect(result.current.action.state.phase).toBe('complete');
      expect(walletRequests(wallet)).toEqual([unwrapAndWithdraw(USDC_MARKET, SHARES)]);
      expect(chain.balance).toBe(10_000_000_000n + 250_249_997n);
    });

    it("simulates at the block of the reads made just before the signature, not at the review's", async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet, readProvider } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'full' });

      // Another account's transaction makes a new block, and the wrapper's assets grow with interest.
      chain.history.set(chain.block, ledgerOf(chain));
      chain.block += 1;
      chain.totalAssets = 1_001_000_000n;
      await confirmStep(result);

      expect(result.current.action.state.phase).toBe('complete');
      expect(readProvider.call).toHaveBeenCalledWith(
        {
          from: ACCOUNT,
          to: USDC_MARKET.wrapperAddress,
          data: CALLS.encodeFunctionData('unwrapAndWithdraw', [SHARES]),
        },
        101
      );
      expect(walletRequests(wallet)).toEqual([unwrapAndWithdraw(USDC_MARKET, SHARES)]);
    });

    it('requires the simulation to pay what the quote of the same block pays', async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'full' });

      chain.simulationResult = CALLS.encodeFunctionResult('unwrapAndWithdraw', [FULL_EXIT_CASH - 1n]);
      await confirmStep(result);

      expect(stepsOf(result.current.action.state)[0]).toMatchObject({
        status: 'blocked',
        reason: 'step-check-failed',
        message: expect.stringMatching(/pays 250\.124996 USDC, not the 250\.124997 USDC/),
      });
      expect(walletRequests(wallet)).toEqual([]);
    });
  });

  describe('wrappedWithdraw: a partial exit burns the fewest shares that pay the amount', () => {
    it.each(MARKETS)('to the %s wrapper, from the typed amount', async (_name, market) => {
      const chain = exitChainFor(market);
      const { result, wallet, readProvider } = renderWrapped(chain);

      await startWithdraw(result, { kind: 'partial', cash: parseExactUnits('100', market.baseDecimals) as bigint });

      expect(draftCalls(result)).toEqual([
        { id: WRAPPED_WITHDRAW_STEP_ID, kind: 'unwrap-and-withdraw', ...encodeExit(market, SHARES_FOR_100) },
      ]);
      expect(result.current.action.state).toMatchObject({
        draft: {
          amount: SHARES_FOR_100,
          withdrawal: {
            request: { kind: 'partial', cash: 100_000_000n },
            quote: {
              kind: 'partial',
              shares: SHARES_FOR_100,
              grossAssets: 100_000_003n,
              redeemBuffer: 3n,
              cash: 100_000_000n,
              leavesDust: false,
            },
            shownCash: undefined,
          },
        },
      });

      await confirmStep(result);
      expect(result.current.action.state.phase).toBe('complete');
      expect(walletRequests(wallet)).toEqual([unwrapAndWithdraw(market, SHARES_FOR_100)]);
      expectOnlyWrapperExit(wallet, readProvider, market);
      expect(chain.balance).toBe(10_000_000_000n + 100_000_000n);
      expect(chain.shares).toBe(SHARES - SHARES_FOR_100);
    });

    it('burns its reviewed shares after the account receives more', async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'partial', cash: 100_000_000n });

      chain.shares += 10n ** 18n;
      await confirmStep(result);

      expect(walletRequests(wallet)).toEqual([unwrapAndWithdraw(USDC_MARKET, SHARES_FOR_100)]);
    });

    it('stops when the account no longer holds the shares it burns', async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'partial', cash: 100_000_000n });

      chain.shares = 10n ** 18n;
      await confirmStep(result);

      expect(stepsOf(result.current.action.state)[0]).toMatchObject({
        status: 'blocked',
        message: expect.stringMatching(/below the shares this withdrawal burns/),
      });
      expect(walletRequests(wallet)).toEqual([]);
    });

    it.each<[string, Partial<Ledger>, WithdrawalRequest, RegExp[]]>([
      [
        'more than the shares pay',
        {},
        { kind: 'partial', cash: FULL_EXIT_CASH + 1n },
        [/^250\.124998 USDC is more than your wrapped position pays now/, /at most 250\.124997 USDC/, /Everything/],
      ],
      [
        "more than the market's cash",
        { cometCash: 100_000_000n },
        { kind: 'partial', cash: 100_000_001n },
        [/holds only 100\.000000 USDC/, /at most 100\.000000 USDC/],
      ],
      [
        "a full exit above the market's cash",
        { cometCash: 100_000_000n },
        { kind: 'full' },
        [/holds only 100\.000000 USDC/, /at most 100\.000000 USDC/],
      ],
      ['from an account with no shares', { shares: 0n }, { kind: 'full' }, [/no wrapped USDC/]],
    ])(
      'requires a revised amount or an explicit full exit, and signs nothing, for %s',
      async (_name, ledger, request, messages) => {
        const chain = exitChainFor(USDC_MARKET, ledger);
        const { result, wallet } = renderWrapped(chain);

        await startWithdraw(result, request);

        expect(result.current.action.state.phase).toBe('read-failed');
        for (const message of messages) {
          expect(result.current.action.state).toMatchObject({ message: expect.stringMatching(message) });
        }
        expect(walletRequests(wallet)).toEqual([]);
      }
    );
  });

  describe('wrappedWithdraw: a payout that changes between the review and the signature', () => {
    /** Ends the review's block, and gives the wrapper `totalAssets` in the next one. */
    function changeAssets(chain: Chain, totalAssets: bigint) {
      chain.history.set(chain.block, ledgerOf(chain));
      chain.block += 1;
      chain.totalAssets = totalAssets;
    }

    it("stops a partial exit for a fresh review when the wrapper's assets double before the signature", async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet, events } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'partial', cash: 100_000_000n });
      events.length = 0;

      // Assets sent to the wrapper's Comet balance, such as a donation, double what each share is worth.
      changeAssets(chain, 2_001_000_000n);
      await confirmStep(result);

      expect(result.current.action.state).toMatchObject({
        phase: 'stopped',
        steps: [
          {
            status: 'blocked',
            reason: 'step-check-failed',
            message: expect.stringMatching(
              /now pays about 200\.000002 USDC, more than 0\.1% above the 100\.000000 USDC you reviewed\. Review it again/
            ),
          },
        ],
      });
      expect(events).not.toContain('simulate');
      expect(walletRequests(wallet)).toEqual([]);
      expect(chain.balance).toBe(10_000_000_000n);

      // A fresh review quotes the same amount from fewer shares.
      act(() => result.current.action.discard());
      await startWithdraw(result, { kind: 'partial', cash: 100_000_000n });
      expect(draftCalls(result)).toEqual([
        {
          id: WRAPPED_WITHDRAW_STEP_ID,
          kind: 'unwrap-and-withdraw',
          ...encodeExit(USDC_MARKET, 49_975_013_968_028_478_777n),
        },
      ]);
    });

    it.each<[string, bigint, bigint, string]>([
      ['interest raises its cash by 0.05%', 1_001_000_000n, 100_049_975n, '100.049975'],
      ['its cash rises by exactly 0.1%', 1_001_500_500n, 100_100_000n, '100.100000'],
    ])(
      'signs the reviewed shares of a partial exit when %s, and describes the cash they now pay',
      async (_name, totalAssets, cash, shownCash) => {
        const chain = exitChainFor(USDC_MARKET);
        const { result, wallet } = renderWrapped(chain);
        await startWithdraw(result, { kind: 'partial', cash: 100_000_000n });

        changeAssets(chain, totalAssets);
        await confirmStep(result);

        const description = `Withdraw about ${shownCash} USDC from the wrapper`;
        expect(result.current.action.state).toMatchObject({
          phase: 'complete',
          draft: { withdrawal: { quote: { shares: SHARES_FOR_100, cash: 100_000_000n } } },
          rechecked: { description, quote: { shares: SHARES_FOR_100, cash }, blockNumber: 101 },
        });
        expect(walletRequests(wallet)).toEqual([unwrapAndWithdraw(USDC_MARKET, SHARES_FOR_100)]);
        await waitFor(() =>
          expect(result.current.manager.settledTransactions.map((transaction) => transaction.description)).toEqual([
            description,
          ])
        );
        expect(chain.balance).toBe(10_000_000_000n + cash);
      }
    );

    it.each<[string, bigint, RegExp]>([
      [
        'rises by one unit more than 0.1%',
        1_001_500_510n,
        /now pays about 100\.100001 USDC, more than 0\.1% above the 100\.000000 USDC you reviewed\. Review it again/,
      ],
      [
        'falls by one unit',
        1_000_499_990n,
        /now pays about 99\.999999 USDC, less than the 100\.000000 USDC you reviewed/,
      ],
    ])('stops a partial exit for a fresh review when its cash %s', async (_name, totalAssets, message) => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet, events } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'partial', cash: 100_000_000n });
      events.length = 0;

      changeAssets(chain, totalAssets);
      await confirmStep(result);

      expect(stepsOf(result.current.action.state)[0]).toMatchObject({
        status: 'blocked',
        reason: 'step-check-failed',
        message: expect.stringMatching(message),
      });
      expect(events).not.toContain('simulate');
      expect(walletRequests(wallet)).toEqual([]);
    });

    it("stops a partial exit, and simulates nothing, when its check reads a block before the review's", async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet, events } = renderWrapped(chain);
      // The market's provider can serve the block before the review.
      chain.history.set(99, ledgerOf(chain));
      await startWithdraw(result, { kind: 'partial', cash: 100_000_000n });
      expect(result.current.action.state).toMatchObject({ draft: { withdrawal: { blockNumber: 100 } } });
      events.length = 0;

      // The wrapper's assets double in block 101, and the provider then answers from block 99.
      changeAssets(chain, 2_001_000_000n);
      chain.providerLag = 2;
      await confirmStep(result);

      expect(stepsOf(result.current.action.state)[0]).toMatchObject({
        status: 'blocked',
        reason: 'step-check-failed',
        message: expect.stringMatching(/answered from an older block than your review\. Review the withdrawal again/),
      });
      expect(events).not.toContain('simulate');
      expect(walletRequests(wallet)).toEqual([]);
      expect(chain.balance).toBe(10_000_000_000n);
    });

    it('stops a partial exit, and simulates nothing, when its check reads at a block number of NaN', async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet, events, readProvider } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'partial', cash: 100_000_000n });
      events.length = 0;

      readProvider.getBlockNumber.mockResolvedValue(Number.NaN);
      await confirmStep(result);

      expect(stepsOf(result.current.action.state)[0]).toMatchObject({
        status: 'blocked',
        reason: 'step-check-failed',
        message: expect.stringMatching(/answered from an older block than your review/),
      });
      expect(events).not.toContain('simulate');
      expect(walletRequests(wallet)).toEqual([]);
    });

    it('signs the whole balance of a full exit when its cash doubles, and describes the cash it now pays', async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'full' });

      changeAssets(chain, 2_001_000_000n);
      await confirmStep(result);

      const description = 'Withdraw all your wrapped USDC, about 500.249997 USDC';
      expect(result.current.action.state).toMatchObject({
        phase: 'complete',
        rechecked: { description, quote: { kind: 'full', shares: SHARES, cash: 500_249_997n } },
      });
      expect(walletRequests(wallet)).toEqual([unwrapAndWithdraw(USDC_MARKET, SHARES)]);
      await waitFor(() =>
        expect(result.current.manager.settledTransactions.map((transaction) => transaction.description)).toEqual([
          description,
        ])
      );
      expect(chain.balance).toBe(10_000_000_000n + 500_249_997n);
    });

    it('stops a full exit when the account receives shares, even when its cash also rises', async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'full' });

      changeAssets(chain, 2_001_000_000n);
      chain.shares += 10n ** 18n;
      await confirmStep(result);

      expect(stepsOf(result.current.action.state)[0]).toMatchObject({
        status: 'blocked',
        message: expect.stringMatching(/wrapped balance changed/),
      });
      expect(walletRequests(wallet)).toEqual([]);
    });

    it('shows the cash the exit now pays in its dialog while the wallet has the request', async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'partial', cash: 100_000_000n });
      // The wallet holds the request until the test has read the dialog.
      let approve: () => void = () => undefined;
      const approval = new Promise<void>((resolve) => (approve = resolve));
      const send = wallet.sendUncheckedTransaction.getMockImplementation();
      if (send === undefined) throw new Error('the wallet must send');
      wallet.sendUncheckedTransaction.mockImplementationOnce(async (request) => {
        await approval;
        return send(request);
      });

      changeAssets(chain, 1_001_000_000n);
      act(() => result.current.action.confirm());
      await waitFor(() => expect(wallet.sendUncheckedTransaction).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(stepsOf(result.current.action.state)[0]?.status).toBe('awaiting-signature'));
      render(
        <WrappedWithdrawModal
          state={result.current.action.state}
          symbol="USDC"
          decimals={6}
          onConfirm={jest.fn()}
          onClose={jest.fn()}
        />
      );

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('Withdraw about 100.049975 USDC from the wrapper to your wallet.');
      expect(within(dialog).getByTestId('wrapped-withdraw-cash')).toHaveTextContent('100.049975 USDC');
      expect(within(dialog).getByRole('listitem')).toHaveTextContent('Withdraw about 100.049975 USDC from the wrapper');
      expect(dialog).not.toHaveTextContent(/about 100\.000000 USDC/);

      approve();
      await waitFor(() => expect(result.current.action.state.phase).toBe('complete'));
    });
  });

  describe('wrappedWithdraw: refuses an amount of zero', () => {
    it('before reading anything', async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet, events } = renderWrapped(chain);
      await waitFor(() => expect(result.current.position.state).toMatchObject({ status: 'loaded' }));
      events.length = 0;

      await startWithdraw(result, { kind: 'partial', cash: 0n });

      expect(result.current.action.state).toMatchObject({
        phase: 'read-failed',
        message: expect.stringMatching(/greater than 0/),
      });
      expect(events).not.toContain('exit-read');
      expect(walletRequests(wallet)).toEqual([]);
    });
  });

  describe('wrappedWithdraw: surfaces ZeroAssetsTransferred, ExcessiveAssetsDebited, pause, liquidity, and failed-simulation errors without a direct-Comet call', () => {
    const httpFailure = Object.assign(new Error('missing revert data in call exception'), {
      code: 'CALL_EXCEPTION',
      data: '0x',
      error: Object.assign(new Error('bad response (status=503, url="https://rpc.example")'), {
        reason: 'bad response',
        code: 'SERVER_ERROR',
        status: 503,
      }),
    });
    const revertWithoutData = Object.assign(new Error('missing revert data in call exception'), {
      code: 'CALL_EXCEPTION',
      data: '0x',
      error: Object.assign(new Error('execution reverted'), { code: -32000 }),
    });

    it.each<[string, Error | undefined, string | undefined, RegExp[]]>([
      [
        'ZeroAssetsTransferred',
        revertWith(CALLS.getSighash('ZeroAssetsTransferred')),
        undefined,
        [/ZeroAssetsTransferred/, /no more than the wrapper's rounding buffer/, /larger amount/],
      ],
      [
        'ExcessiveAssetsDebited',
        revertWith(CALLS.encodeErrorResult('ExcessiveAssetsDebited', [SHARES + 1n, SHARES])),
        undefined,
        [/ExcessiveAssetsDebited/, /more from the wrapper than these shares cover/, /try again in a few minutes/i],
      ],
      ["Comet's pause", revertWith(CALLS.getSighash('Paused')), undefined, [/paused/i, /until they resume/]],
      [
        'a transfer the market cannot pay',
        revertWith(errorString('ERC20: transfer amount exceeds balance')),
        undefined,
        [/does not hold enough USDC/, /smaller amount/],
      ],
      [
        "Comet's failed payout",
        revertWith(CALLS.getSighash('TransferOutFailed')),
        undefined,
        [/TransferOutFailed/, /could not pay/],
      ],
      [
        'a revert without data, as a USDT transfer the market cannot pay gives',
        revertWithoutData,
        undefined,
        [/reverted without a reason \(execution reverted \(-32000\)\)/, /may not hold enough USDC/],
      ],
      [
        "the wrapper's share balance error",
        revertWith(CALLS.encodeErrorResult('ERC20InsufficientBalance', [ACCOUNT, 0n, SHARES])),
        undefined,
        [/ERC20InsufficientBalance/, /fewer wrapped shares/],
      ],
      [
        'a call that failed without revert data',
        httpFailure,
        undefined,
        [/could not be run \(bad response, status 503\)/],
      ],
      [
        'an error returned as the result, as ethers returns a revert',
        undefined,
        CALLS.getSighash('ZeroAssetsTransferred'),
        [/ZeroAssetsTransferred/],
      ],
      ['an undeclared error', undefined, '0xdeadbeef', [/revert data 0xdeadbeef/]],
    ])('explains %s, and signs nothing', async (_name, thrown, returned, messages) => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet, readProvider } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'full' });

      chain.simulationRevert = thrown;
      chain.simulationResult = returned;
      await confirmStep(result);

      const [step] = stepsOf(result.current.action.state);
      expect(step).toMatchObject({ status: 'blocked', reason: 'step-check-failed' });
      for (const message of messages) expect(step).toMatchObject({ message: expect.stringMatching(message) });
      expect(step).toMatchObject({ message: expect.stringMatching(/your wallet was not asked to sign it/i) });
      expect(step).not.toMatchObject({ message: expect.stringMatching(/rpc\.example/) });
      expect(walletRequests(wallet)).toEqual([]);
      expectOnlyWrapperExit(wallet, readProvider, USDC_MARKET);
    });

    it("explains a position worth no more than the wrapper's buffer before any review", async () => {
      const chain = exitChainFor(USDC_MARKET, { shares: 2_998_500_746_629n });
      const { result, wallet } = renderWrapped(chain);

      await startWithdraw(result, { kind: 'full' });

      expect(result.current.action.state).toMatchObject({
        phase: 'read-failed',
        message: expect.stringMatching(/no more than the wrapper's rounding buffer.*ZeroAssetsTransferred/),
      });
      expect(walletRequests(wallet)).toEqual([]);
    });

    it('refuses a review while Comet withdrawals are paused', async () => {
      const chain = exitChainFor(USDC_MARKET, { isWithdrawPaused: true });
      const { result, wallet } = renderWrapped(chain);

      await startWithdraw(result, { kind: 'full' });

      expect(result.current.action.state).toMatchObject({
        phase: 'read-failed',
        message: expect.stringMatching(/withdrawals from this market are paused/i),
      });
      expect(walletRequests(wallet)).toEqual([]);
    });

    it('stops before the simulation and the signature when Comet pauses withdrawals after the review', async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet, events } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'full' });
      events.length = 0;

      chain.isWithdrawPaused = true;
      await confirmStep(result);

      expect(stepsOf(result.current.action.state)[0]).toMatchObject({ status: 'blocked', reason: 'withdraw-paused' });
      expect(events).not.toContain('simulate');
      expect(walletRequests(wallet)).toEqual([]);
    });

    it("stops with its own pause check when the lifecycle's earlier read still shows withdrawals running", async () => {
      const chain = exitChainFor(USDC_MARKET);
      // The lifecycle's pause read is not pinned to a block, so it can come from a node that has not
      // seen the pause yet. The step's own reads, pinned to the newest block, have.
      const { result, wallet, events } = renderWrapped(chain, { checkRestriction: async () => undefined });
      await startWithdraw(result, { kind: 'full' });
      events.length = 0;

      chain.isWithdrawPaused = true;
      await confirmStep(result);

      expect(stepsOf(result.current.action.state)[0]).toMatchObject({
        status: 'blocked',
        reason: 'step-check-failed',
        message: expect.stringMatching(/withdrawals from this market are now paused.*until they resume/i),
      });
      expect(events).not.toContain('simulate');
      expect(walletRequests(wallet)).toEqual([]);
    });

    it('stops before the simulation when the shares are worth no more than the buffer by the signature', async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet, events } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'full' });
      events.length = 0;

      // A quarter of the wrapper's shares is now worth floor(11 ÷ 4) = 2 base units, under the buffer of 3.
      chain.totalAssets = 10n;
      await confirmStep(result);

      expect(stepsOf(result.current.action.state)[0]).toMatchObject({
        status: 'blocked',
        reason: 'step-check-failed',
        message: expect.stringMatching(/no more than the wrapper's rounding buffer.*ZeroAssetsTransferred/),
      });
      expect(events).not.toContain('simulate');
      expect(walletRequests(wallet)).toEqual([]);
    });

    it("stops before the simulation when the market's cash falls below the exit after the review", async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet, events } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'partial', cash: 100_000_000n });
      events.length = 0;

      chain.cometCash = 99_999_999n;
      await confirmStep(result);

      expect(stepsOf(result.current.action.state)[0]).toMatchObject({
        status: 'blocked',
        reason: 'step-check-failed',
        message: expect.stringMatching(/holds only 99\.999999 USDC/),
      });
      expect(events).not.toContain('simulate');
      expect(walletRequests(wallet)).toEqual([]);
    });

    it('sends nothing more, and never falls back to Comet, when the exit reverts on chain', async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet, readProvider } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'full' });

      chain.shouldRevertNext = true;
      await confirmStep(result);
      act(() => result.current.action.confirm());
      await act(async () => undefined);

      expect(result.current.action.state).toMatchObject({ phase: 'stopped', steps: [{ status: 'reverted' }] });
      expect(walletRequests(wallet)).toEqual([unwrapAndWithdraw(USDC_MARKET, SHARES)]);
      expectOnlyWrapperExit(wallet, readProvider, USDC_MARKET);
      expect(chain.shares).toBe(SHARES);
    });

    it('simulates again after a node a block behind, and never after a revert', async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet, events } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'full' });

      chain.laggingNodeSimulations = 1;
      await confirmStep(result);
      expect(result.current.action.state.phase).toBe('complete');
      expect(walletRequests(wallet)).toEqual([unwrapAndWithdraw(USDC_MARKET, SHARES)]);

      const reverting = exitChainFor(USDC_MARKET);
      const second = renderWrapped(reverting);
      await startWithdraw(second.result, { kind: 'full' });
      second.events.length = 0;
      reverting.simulationRevert = revertWith(CALLS.getSighash('ZeroAssetsTransferred'));
      await confirmStep(second.result);
      expect(second.events.filter((event) => event === 'simulate')).toHaveLength(1);
      expect(events).toContain('simulate');
    });

    it("describes a review whose first read failed by the provider's own error", async () => {
      const chain = exitChainFor(USDC_MARKET);
      chain.failsFundReads = true;
      const { result, wallet } = renderWrapped(chain);

      await startWithdraw(result, { kind: 'full' });

      expect(result.current.action.state).toMatchObject({
        phase: 'read-failed',
        message: expect.stringMatching(/position could not be read \(rate limited\)/),
      });
      expect(walletRequests(wallet)).toEqual([]);
    });
  });

  describe('wrappedWithdraw: stale identity, signer, screening, route, or exit eligibility blocks submission', () => {
    const IDENTITY_CHANGES: [string, (wallet: Wallet) => WrappedSession][] = [
      ['account', (wallet) => sessionFor(wallet, { account: OTHER_ACCOUNT })],
      ['market', (wallet) => sessionFor(wallet, { cometAddress: USDT_MARKET.cometAddress })],
      ['reconnect', (wallet) => sessionFor(wallet, { status: 'reconnecting' })],
    ];
    const INELIGIBLE: [string, (wallet: Wallet) => WrappedSession][] = [
      ['signer', (wallet) => sessionFor(wallet, { isSignerReady: false })],
      ['screening', (wallet) => sessionFor(wallet, { screeningStatus: 'blocked' })],
      ['route: the wrapper check fails', (wallet) => sessionFor(wallet, { validation: 'not-canonical' })],
      ['route: the wallet leaves Ethereum', (wallet) => sessionFor(wallet, { chainId: 8453 })],
      ['exit eligibility', (wallet) => sessionFor(wallet, { registry: registryWith({ exits: false }) })],
    ];

    it.each([...IDENTITY_CHANGES, ...INELIGIBLE])(
      'signs nothing after a change of %s, even from a confirmation kept from the review',
      async (_name, changedSession) => {
        const chain = exitChainFor(USDC_MARKET);
        const { result, rerender, wallet } = renderWrapped(chain);
        await startWithdraw(result, { kind: 'full' });
        const keptConfirm = result.current.action.confirm;

        rerender({ session: changedSession(wallet) });
        act(() => keptConfirm());
        act(() => result.current.action.confirm());
        await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

        expect(['discarded', 'stopped']).toContain(result.current.action.state.phase);
        expect(walletRequests(wallet)).toEqual([]);
      }
    );

    it.each(INELIGIBLE)('starts no fresh review after a change of %s', async (_name, changedSession) => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, rerender, wallet } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'full' });

      rerender({ session: changedSession(wallet) });
      await act(async () => undefined);
      let refusal: unknown;
      act(() => {
        refusal = result.current.write.withdraw({ kind: 'full' });
      });

      expect(refusal).toBeDefined();
      expect(walletRequests(wallet)).toEqual([]);
    });

    it('keeps the exit closed by the committed release control', async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, rerender, wallet } = renderWrapped(chain);
      rerender({ session: sessionFor(wallet, { registry: WRAPPED_MARKET_REGISTRY }) });
      await act(async () => undefined);

      expect(HARDCODED_WRAPPED_LENDING_SOURCE.markets.every((market) => market.isExitEnabled === false)).toBe(true);
      expect(result.current.action.blockedReason('withdraw')).toBe('exits-disabled');
      expect(result.current.write.withdraw({ kind: 'full' })).toBe('exits-disabled');
    });

    it('refreshes shares and wallet balances after the confirmed exit, from a block that shows it', async () => {
      const chain = exitChainFor(USDC_MARKET, { balance: 5_000_000n });
      const { result, wallet } = renderWrapped(chain);
      await waitFor(() =>
        expect(result.current.position.state).toMatchObject({
          status: 'loaded',
          position: { shares: SHARES, baseWalletBalance: 5_000_000n },
        })
      );
      await startWithdraw(result, { kind: 'partial', cash: 100_000_000n });

      // Once the exit is mined, the market's provider trails the wallet's node by a block, so it does
      // not show the exit yet. The check before the signature still reads the block of the review.
      const send = wallet.sendUncheckedTransaction.getMockImplementation();
      if (send === undefined) throw new Error('the wallet must send');
      wallet.sendUncheckedTransaction.mockImplementationOnce(async (request) => {
        const hash = await send(request);
        chain.providerLag = 1;
        return hash;
      });
      await confirmStep(result);
      expect(result.current.action.state.phase).toBe('complete');
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(result.current.position.state).toMatchObject({ position: { shares: SHARES } });

      chain.providerLag = 0;
      await waitFor(() =>
        expect(result.current.position.state).toMatchObject({
          position: { shares: SHARES - SHARES_FOR_100, baseWalletBalance: 5_000_000n + 100_000_000n },
        })
      );
    });

    it("waits for the market's provider to show the confirmed exit before quoting the next one", async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result } = renderWrapped(chain);
      await startWithdraw(result, { kind: 'partial', cash: 100_000_000n });
      await confirmStep(result);
      act(() => result.current.action.discard());

      chain.providerLag = 1;
      act(() => {
        result.current.write.withdraw({ kind: 'full' });
      });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(result.current.action.state.phase).toBe('reading');

      chain.providerLag = 0;
      await waitFor(() => expect(result.current.action.state.phase).toBe('review'));
      expect(result.current.action.state).toMatchObject({
        draft: { amount: SHARES - SHARES_FOR_100, withdrawal: { quote: { cash: 150_124_994n } } },
      });
    });

    it("quotes nothing when the market's provider does not catch up", async () => {
      const chain = exitChainFor(USDC_MARKET);
      const { result, wallet } = renderWrapped(chain, { blockWait: { attempts: 3, intervalMs: 5 } });
      await startWithdraw(result, { kind: 'partial', cash: 100_000_000n });
      await confirmStep(result);
      act(() => result.current.action.discard());

      chain.providerLag = 1;
      await startWithdraw(result, { kind: 'full' });

      expect(result.current.action.state).toMatchObject({
        phase: 'read-failed',
        message: expect.stringMatching(/has not shown your last wrapped transaction yet/),
      });
      expect(walletRequests(wallet)).toEqual([unwrapAndWithdraw(USDC_MARKET, SHARES_FOR_100)]);
    });

    it("refuses to plan for a market that is not the reviewed identity's", async () => {
      const identity = wrappedActionIdentity('withdraw', sessionFor({}, { cometAddress: USDT_MARKET.cometAddress }));
      if (identity === undefined) throw new Error('the session must have an identity');
      const readSnapshot = jest.fn();

      await expect(
        prepareWrappedWithdrawal({
          identity,
          market: USDC_MARKET,
          request: { kind: 'full' },
          shownCash: undefined,
          symbol: 'USDC',
          reads: { readSnapshot, call: jest.fn(), retryIntervalMs: 1 },
        })
      ).rejects.toThrow(/wrapper for this market changed/);
      expect(readSnapshot).not.toHaveBeenCalled();
    });
  });
});

describe('newestReceiptBlock', () => {
  const settledIn = (id: string, outcome: SettledTransaction['outcome']): SettledTransaction => ({
    id,
    key: USDC_MARKET.wrapperAddress,
    networkId: 1,
    networkName: 'homestead',
    description: id,
    nonce: 1,
    account: ACCOUNT,
    step: id,
    state: TransactionState.Pending,
    hash: `0x${'1'.repeat(64)}`,
    outcome,
  });
  const mined = (blockNumber: number, status = 1) =>
    ({ transactionHash: `0x${'1'.repeat(64)}`, status, blockNumber } as TransactionReceipt);

  it('names the newest block a settled transaction was mined in, reverted or not', () => {
    expect(
      newestReceiptBlock([
        settledIn('reset', { status: 'confirmed', receipt: mined(101) }),
        settledIn('approve', { status: 'reverted', receipt: mined(103, 0) }),
        settledIn('supply', { status: 'confirmed', receipt: mined(102) }),
        settledIn('replaced', { status: 'replaced' }),
      ])
    ).toBe(103);
  });

  it('names none before anything settled, or when nothing settled has a receipt', () => {
    expect(newestReceiptBlock([])).toBeUndefined();
    expect(newestReceiptBlock([settledIn('replaced', { status: 'replaced' })])).toBeUndefined();
  });
});

describe('positionRefreshToken', () => {
  const pending = (id: string) => ({ id } as never);
  const settled = (id: string) => ({ id } as never);

  it('changes when a transaction settles while another is added', () => {
    expect(positionRefreshToken([pending('a')], [])).not.toBe(positionRefreshToken([pending('b')], [settled('a')]));
  });

  it('changes when a transaction settles after the settled list is full', () => {
    const full = Array.from({ length: 20 }, (_, index) => settled(`s${index}`));
    const next = [...full.slice(1), settled('s20')];

    expect(positionRefreshToken([], full)).not.toBe(positionRefreshToken([], next));
  });

  it('stays the same while nothing changes', () => {
    expect(positionRefreshToken([pending('a')], [settled('b')])).toBe(
      positionRefreshToken([pending('a')], [settled('b')])
    );
  });
});
