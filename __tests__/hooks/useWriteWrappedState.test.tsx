import { Interface } from '@ethersproject/abi';
import { JsonRpcProvider, TransactionReceipt } from '@ethersproject/providers';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { BigNumber, utils } from 'ethers';

import {
  ANCHORAGE_CONNECTOR_ID,
  buildWrappedMarketRegistry,
  HARDCODED_WRAPPED_LENDING_SOURCE,
  WrappedMarket,
  WrappedMarketRegistry,
} from '@constants/wrappedMarkets';
import { LendingSession, resolveLendingRoute, ValidationStatus, wrappedRouteKey } from '@helpers/lendingRoute';
import { getMarket } from '@helpers/markets';
import { MAX_UINT256 } from '@helpers/numbers';
import { getBlockExplorerUrl } from '@helpers/urls';
import { WrappedSession, wrappedActionIdentity } from '@helpers/wrappedActions';
import { BlockWait, WrappedPosition } from '@helpers/wrappedPositions';
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
  parseWrappedSupplyAmount,
  prepareWrappedSupply,
  useWriteWrappedState,
  WriteWrappedState,
} from '@hooks/useWriteWrappedState';
import WrappedSupplyModal from '@pages/home/components/ActionModal/WrappedSupplyModal';
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
function registryWith({ deposits = true } = {}): WrappedMarketRegistry {
  return buildWrappedMarketRegistry({
    markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({ ...market, isDepositEnabled: deposits })),
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
]);

/** What the chain holds for the account in one market. */
type Chain = {
  market: WrappedMarket;
  balance: bigint;
  allowance: bigint;
  shares: bigint;
  /** The newest block. Each mined transaction makes a new one. */
  block: number;
  /** The balance, allowance and shares at the end of each earlier block. */
  history: Map<number, { balance: bigint; allowance: bigint; shares: bigint }>;
  /** How many blocks the configured chain's provider trails the wallet's node by. */
  providerLag: number;
  /** The provider fails the balance and allowance reads. */
  failsFundReads: boolean;
  /** The next mined call reverts. */
  shouldRevertNext: boolean;
  /** The supply simulation reverts with this error. */
  simulationRevert: Error | undefined;
  /** The supply simulation returns this instead, as ethers returns a reverted call's data. */
  simulationResult: string | undefined;
};

function chainFor(market: WrappedMarket, { balance = 10_000_000_000n, allowance = 0n } = {}): Chain {
  return {
    market,
    balance,
    allowance,
    shares: 0n,
    block: 100,
    history: new Map(),
    providerLag: 0,
    failsFundReads: false,
    shouldRevertNext: false,
    simulationRevert: undefined,
    simulationResult: undefined,
  };
}

/** The balance, allowance and shares at the end of `block`. */
function stateAt(chain: Chain, block: number) {
  const latest = { balance: chain.balance, allowance: chain.allowance, shares: chain.shares };
  return block >= chain.block ? latest : chain.history.get(block) ?? latest;
}

/** Mines a call in a new block, as the base token and the wrapper do. Returns whether it succeeded. */
function mine(chain: Chain, request: { to: string; data: string }): boolean {
  chain.history.set(chain.block, { balance: chain.balance, allowance: chain.allowance, shares: chain.shares });
  chain.block += 1;
  return applyCall(chain, request);
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
  return false;
}

function positionOf({ shares, balance, allowance }: { shares: bigint; balance: bigint; allowance: bigint }) {
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
 * The order in which the fakes were used: the supply's own reads, the panel's position reads,
 * simulations and wallet requests.
 */
type Event = 'read' | 'position-read' | 'simulate' | 'send:approve' | 'send:supplyAndWrap';

/**
 * The configured chain's public provider: Comet's pause read, the supply's balance and allowance
 * reads, and its simulation. It trails the wallet's node by `providerLag` blocks.
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
          if (chain.simulationRevert !== undefined) throw chain.simulationRevert;
          if (chain.simulationResult !== undefined) return chain.simulationResult;
          const amount = BigInt(call.args[0].toString());
          if (amount > state.allowance) throw revertWith(errorString('ERC20: transfer amount exceeds allowance'));
          return CALLS.encodeFunctionResult('supplyAndWrap', [amount * 10n ** 12n]);
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
 * The wrapped supply as App wires it: the transaction manager, the lifecycle, the supply and the
 * position read, all through the fake wallet and the fake public provider.
 */
function renderSupply(
  chain: Chain,
  {
    wallet: givenWallet,
    events = [],
    blockWait = QUICK_BLOCK_WAIT,
  }: { wallet?: Wallet; events?: Event[]; blockWait?: BlockWait } = {}
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
      const action = useWrappedAction({ session, manager, readProvider });
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
      expect(parseWrappedSupplyAmount(input, 6)).toBe(expected);
    });

    it.each(['', '.', '1.0000001', '-1', '+1', '1e6', '0x10', ' 1', '1 ', '1,000', '1.2.3', 'abc', '١'])(
      'refuses %p rather than rounding or guessing',
      (input) => {
        expect(parseWrappedSupplyAmount(input, 6)).toBeUndefined();
      }
    );

    it.each(MARKETS)('to the %s wrapper, from the typed amount', async (_name, market) => {
      const chain = chainFor(market, { balance: 5_000_000_000n, allowance: 0n });
      const amount = parseWrappedSupplyAmount('1234.567891', market.baseDecimals) as bigint;
      const { result, wallet } = renderSupply(chain);

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
      const { result, wallet } = renderSupply(chain);

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
      const { result, wallet } = renderSupply(chain);

      await startSupply(result, AMOUNT);
      expect(draftCalls(result).map(({ kind }) => kind)).toEqual(['supply-and-wrap']);
      await confirmStep(result);

      expect(result.current.action.state.phase).toBe('complete');
      expect(walletRequests(wallet)).toEqual([supplyAndWrap(market, AMOUNT)]);
      expectOnlyWrapperRequests(wallet, market);
    });

    it.each(MARKETS)('approves exactly once from a zero allowance: %s', async (_name, market) => {
      const chain = chainFor(market, { allowance: 0n });
      const { result, wallet } = renderSupply(chain);

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
      const { result, wallet } = renderSupply(chain);

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
      const { result, wallet } = renderSupply(chain);

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
      const { result } = renderSupply(chain, { wallet, events });

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
      const { result, readProvider, events } = renderSupply(chain);
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
      // Simulated at the block its last read came from, after the approval was mined.
      expect(readProvider.call).toHaveBeenCalledWith(
        { from: ACCOUNT, to: USDC_MARKET.wrapperAddress, data: CALLS.encodeFunctionData('supplyAndWrap', [AMOUNT]) },
        101
      );
    });

    it('sends nothing more when the simulation fails, and never falls back to Comet', async () => {
      const chain = chainFor(USDC_MARKET, { allowance: 0n });
      const { result, wallet } = renderSupply(chain);
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
      const { result, wallet } = renderSupply(chain);
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
        const { result, wallet } = renderSupply(chain);
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
      const { result, wallet } = renderSupply(chain);
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
      const { result, wallet } = renderSupply(chain);

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
      const { result, wallet } = renderSupply(chain);
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
      const { result, wallet } = renderSupply(chain);
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
      const { result, wallet, events } = renderSupply(chain);
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
      const { result, wallet } = renderSupply(chain);
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
      const { result, wallet } = renderSupply(chain);

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
          reads: { readFunds, call: jest.fn() },
        })
      ).rejects.toThrow(/wrapper for this market changed/);
      expect(readFunds).not.toHaveBeenCalled();
    });

    it('stops without sending when the balance and allowance cannot be read again', async () => {
      const chain = chainFor(USDC_MARKET, { allowance: 0n });
      const { result, wallet } = renderSupply(chain);
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
      const { result, wallet } = renderSupply(chain);
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
      const { result, wallet, readProvider } = renderSupply(chain);
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
      const { result, wallet } = renderSupply(chain);
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
      const { result, wallet } = renderSupply(chain, { blockWait: { attempts: 3, intervalMs: 5 } });
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

    const CHANGES: [string, (wallet: Wallet) => WrappedSession][] = [
      ['account', (wallet) => sessionFor(wallet, { account: OTHER_ACCOUNT })],
      ['route: the wrapper check fails', (wallet) => sessionFor(wallet, { validation: 'not-canonical' })],
      ['route: the wallet leaves Ethereum', (wallet) => sessionFor(wallet, { chainId: 8453 })],
      ['screening', (wallet) => sessionFor(wallet, { screeningStatus: 'blocked' })],
      ['release control', (wallet) => sessionFor(wallet, { registry: registryWith({ deposits: false }) })],
    ];

    it.each(CHANGES)('signs nothing further after a change of %s', async (_name, changedSession) => {
      const chain = chainFor(USDC_MARKET, { allowance: 0n });
      const { result, rerender, wallet } = renderSupply(chain);
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
      const { result, rerender, wallet } = renderSupply(chain);
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
      const first = renderSupply(chain, { wallet, events });
      await startSupply(first.result, AMOUNT);
      wallet.holdReceipts();
      act(() => first.result.current.action.confirm());
      await waitFor(() => expect(stepStatuses(first.result)).toEqual(['submitted', 'waiting']));

      // The page reloads while the approval is pending.
      first.unmount();
      const second = renderSupply(chain, { wallet, events });
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
      const { result } = renderSupply(chain, { wallet, events });
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
      const { result } = renderSupply(chain);
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
      const { result, positionRead } = renderSupply(chain);
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
