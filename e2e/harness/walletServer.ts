// The harness wallet: the accounts, the queue of wallet requests, message signing, and transaction sending
// through the local anvil fork. It runs in the Playwright runner and listens on 127.0.0.1.
//
// The page never talks to this server. The injected provider calls a Playwright binding, and the binding's
// handler, in the test worker, calls `/v1/rpc` and `/v1/events` here with the per-run bearer token. Tests and
// agents use the other `/v1` endpoints to inspect, approve, reject and delay requests, and to change
// accounts, chains and screening. Every request must carry the token, come with this server's own Host, and
// carry no Origin header, so no browser page can use the API.
//
// Transactions are never signed. An approved `eth_sendTransaction` goes to anvil's own
// `eth_sendTransaction` from an impersonated sender, after the server checks again that the node is the
// expected local fork. So no signed chain-1 transaction exists that could be replayed on mainnet. Messages
// and typed data are signed with a key made for the run, held only in this process.
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isHex,
  parseEther,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { BLOCK_SECONDS } from './blockTime';
import { ERC20_ABI, USDC, usdcBalanceKey } from './contracts';
import { hex, rpc, verifyFork } from './fork';
import { SCREENING_BEHAVIOURS, isAddress, type ScreeningBehaviour, type ScreeningStub } from './screeningStub';

/** The provider methods that queue for a decision. */
export const QUEUED_METHODS = [
  'eth_requestAccounts',
  'wallet_requestPermissions',
  'eth_sendTransaction',
  'personal_sign',
  'eth_signTypedData_v4',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
] as const;
type QueuedMethod = (typeof QUEUED_METHODS)[number];

/** The reads the wallet forwards to the fork while its chain is 1. */
export const WALLET_READ_METHODS: ReadonlySet<string> = new Set([
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_getBalance',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getCode',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getLogs',
]);

/** How long one `/v1/rpc`, outcome or events call waits before it answers "still pending". */
export const LONG_POLL_MS = 20_000;
export const MAX_CONTROL_BODY_BYTES = 1024 * 1024;

export type RpcErrorBody = { code: number; message: string; data?: unknown };
export type Outcome = { result: unknown } | { error: RpcErrorBody };
export type Policy = 'manual' | 'approve' | { reject: number };

export type WalletRequest = {
  id: string;
  generation: number;
  method: QueuedMethod;
  params: unknown;
  origin: string;
  chainIdAtRequest: number;
  selectedAccount: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'failed';
  scheduled?: { decision: 'approve' | 'reject'; at: string };
  result?: unknown;
  error?: RpcErrorBody;
  receivedAt: string;
  respondedAt?: string;
};

/** A call the wallet answered at once, such as `wallet_revokePermissions`, recorded for tests. */
export type WalletCall = { method: string; origin: string; receivedAt: string; generation: number };

export type WalletEvent = {
  cursor: number;
  type: 'accountsChanged' | 'chainChanged' | 'connect' | 'disconnect';
  data: unknown;
};

type Account = { address: Address; key?: Hex };

export type WalletServerOptions = {
  fork: { localUrl: string; child?: ChildProcess };
  target: { number: number; hash: string };
  token: string;
  screening: ScreeningStub;
  stats?: () => Record<string, unknown>;
  log?: (line: string) => void;
  /** Gets every key the server makes, for the run's secret scan. */
  onSecret?: (secret: string) => void;
  /** The most provider calls one generation records. Past it the record reports an overflow. */
  providerCallLimit?: number;
  /** Checks the fork before each send. Tests replace it to see the server refuse. */
  verify?: typeof verifyFork;
};

export type WalletServer = {
  url: string;
  port: number;
  close: () => Promise<void>;
  /** The number of resets so far. */
  generation: () => number;
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

class WalletError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

const DEFAULT_MESSAGES: Record<number, string> = {
  4001: 'User rejected the request.',
  4100: 'The requested account and/or method has not been authorized by the user.',
  4200: 'The requested method is not supported by this wallet.',
  4900: 'The wallet is disconnected.',
  4902: 'Unrecognized chain ID.',
  [-32002]: 'Request already pending.',
  [-32603]: 'Internal error.',
};

const isQuantity = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value);
const isData = (value: unknown): value is string => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
const now = () => new Date().toISOString();
const sha256 = (text: string) => createHash('sha256').update(text).digest();

/** Whether `given` equals `expected`, in time that does not depend on where they differ or on their lengths. */
export function tokenMatches(expected: string, given: string): boolean {
  return timingSafeEqual(sha256(expected), sha256(given));
}

/** The chain ID in a `wallet_switchEthereumChain` or `wallet_addEthereumChain` parameter. */
function chainIdParam(params: unknown): number {
  const [first] = Array.isArray(params) ? params : [];
  const chainId = (first as { chainId?: unknown } | undefined)?.chainId;
  if (!isQuantity(chainId)) throw new WalletError(-32602, 'harness: chainId must be a hex quantity');
  return Number(chainId);
}

export async function startWalletServer(options: WalletServerOptions): Promise<WalletServer> {
  const { fork, target, token, screening } = options;
  const log = options.log ?? (() => undefined);
  const verify = options.verify ?? verifyFork;
  const call = <T>(method: string, params: unknown[] = []) =>
    rpc<T>(fork.localUrl, method, params, { timeoutMs: 60_000 });

  let generation = 0;
  let baseline = await call<string>('evm_snapshot');
  const accounts = new Map<string, Account>();
  const impersonated = new Set<string>();
  let selected: Address[] = [];
  let permittedOrigin: string | null = null;
  let chainId = 1;
  let knownChains = new Set([1]);
  let policies = new Map<string, Policy>();
  const requests = new Map<string, WalletRequest>();
  const calls: WalletCall[] = [];
  /** Every provider call from the page, those answered at once included. */
  const providerCalls: WalletCall[] = [];
  const providerCallLimit = options.providerCallLimit ?? 100_000;
  /** Whether this generation made more provider calls than the record holds. */
  let hasProviderCallOverflow = false;
  /** When the permission was granted, as its `date`. */
  let permittedAt = 0;
  const controlSends: { hash: string; from: string; to: string; generation: number }[] = [];
  const outcomes = new Map<string, { outcome?: Outcome; waiters: Set<() => void>; timer?: NodeJS.Timeout }>();
  const events: WalletEvent[] = [];
  let cursor = 0;
  const eventWaiters = new Set<() => void>();
  let hasSessionEnded = false;

  // Fork writes run one at a time, so a reset never interleaves with a send or a funding.
  let forkQueue: Promise<unknown> = Promise.resolve();
  const serially = <T>(run: () => Promise<T>): Promise<T> => {
    const next = forkQueue.then(run, run);
    forkQueue = next.catch(() => undefined);
    return next;
  };

  const emit = (type: WalletEvent['type'], data: unknown) => {
    cursor += 1;
    events.push({ cursor, type, data });
    if (events.length > 1000) events.shift();
    for (const wake of [...eventWaiters]) wake();
  };

  const exposedAccounts = () => (permittedOrigin === null ? [] : selected.map((address) => address.toLowerCase()));

  /** Settles `request`: approved with a result, rejected by a decision, or failed when approval could not run. */
  const settle = (request: WalletRequest, outcome: Outcome, status?: 'rejected') => {
    if (request.status !== 'pending') return;
    if ('result' in outcome) {
      request.status = 'approved';
      request.result = outcome.result;
    } else {
      request.status = status ?? 'failed';
      request.error = outcome.error;
    }
    request.respondedAt = now();
    delete request.scheduled;
    const slot = outcomes.get(request.id);
    if (slot === undefined) return;
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.outcome = outcome;
    for (const wake of [...slot.waiters]) wake();
    log(`request ${request.id} ${request.method} ${request.status}`);
  };

  const failWith = (error: unknown): Outcome => ({
    error:
      error instanceof WalletError
        ? { code: error.code, message: error.message }
        : { code: -32603, message: `harness: ${String((error as Error)?.message ?? error).slice(0, 300)}` },
  });

  /** Checks a request against the wallet's state, on arrival and again when it is approved. */
  const checkRequest = (method: QueuedMethod, params: unknown, origin: string) => {
    const list = Array.isArray(params) ? params : [];
    const requireAccount = (address: unknown) => {
      if (permittedOrigin !== origin) throw new WalletError(4100, DEFAULT_MESSAGES[4100]);
      if (!isAddress(address) || selected[0]?.toLowerCase() !== address.toLowerCase()) {
        throw new WalletError(4100, 'harness: the account is not the selected account');
      }
      return accounts.get(address.toLowerCase()) as Account;
    };
    switch (method) {
      case 'eth_sendTransaction': {
        const transaction = list[0] as Record<string, unknown> | undefined;
        if (transaction === undefined || typeof transaction !== 'object')
          throw new WalletError(-32602, 'harness: no transaction');
        requireAccount(transaction.from);
        if (chainId !== 1)
          throw new WalletError(-32000, 'harness: the wallet is not on chain 1, the only chain it sends on');
        if (transaction.chainId !== undefined && Number(transaction.chainId) !== chainId) {
          throw new WalletError(
            -32602,
            `harness: transaction chainId ${String(transaction.chainId)} is not the wallet's chain`
          );
        }
        if (!isAddress(transaction.to)) throw new WalletError(-32602, 'harness: a transaction needs a `to` address');
        return;
      }
      case 'personal_sign': {
        const account = requireAccount(list[1]);
        if (!isData(list[0]) && typeof list[0] !== 'string') throw new WalletError(-32602, 'harness: no message');
        if (account.key === undefined) throw new WalletError(4200, 'harness: impersonated account cannot sign');
        return;
      }
      case 'eth_signTypedData_v4': {
        const account = requireAccount(list[0]);
        const typed = parseTypedData(list[1]);
        const domainChainId = typed.domain?.chainId;
        if (domainChainId !== undefined && Number(domainChainId) !== chainId) {
          throw new WalletError(
            -32602,
            `harness: typed data domain chainId ${String(domainChainId)} is not the wallet's chain`
          );
        }
        if (account.key === undefined) throw new WalletError(4200, 'harness: impersonated account cannot sign');
        return;
      }
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain':
        chainIdParam(params);
        return;
      default:
        return;
    }
  };

  const verifiedFork = async () => {
    await verify({ localUrl: fork.localUrl, child: fork.child }, target);
  };

  /** Mines the next block 12 s after the latest, so that accrual between the harness's blocks is fixed. */
  const setNextTimestamp = async () => {
    const latest = await call<{ timestamp: string }>('eth_getBlockByNumber', ['latest', false]);
    await call('evm_setNextBlockTimestamp', [hex(Number(latest.timestamp) + BLOCK_SECONDS)]);
  };

  /** Sends a transaction from an impersonated harness account on the verified fork. */
  const sendOnFork = (transaction: Record<string, unknown>) =>
    serially(async () => {
      await verifiedFork();
      const from = transaction.from as string;
      if (!impersonated.has(from.toLowerCase()))
        throw new WalletError(4100, 'harness: the sender is not a harness account');
      const sent: Record<string, string> = { from, to: transaction.to as string };
      const data = transaction.data ?? transaction.input;
      if (data !== undefined) {
        if (!isData(data)) throw new WalletError(-32602, 'harness: data must be hex');
        sent.data = data;
      }
      for (const field of ['value', 'gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas']) {
        const value = transaction[field];
        if (value === undefined) continue;
        if (!isQuantity(value)) throw new WalletError(-32602, `harness: ${field} must be a hex quantity`);
        sent[field] = value;
      }
      await setNextTimestamp();
      return call<string>('eth_sendTransaction', [sent]);
    });

  const execute = async (request: WalletRequest): Promise<unknown> => {
    if (request.generation !== generation) throw new WalletError(4900, 'harness: the wallet was reset');
    checkRequest(request.method, request.params, request.origin);
    const isSwitch = request.method === 'wallet_switchEthereumChain' || request.method === 'wallet_addEthereumChain';
    if (!isSwitch && request.chainIdAtRequest !== chainId) {
      throw new WalletError(4901, `harness: the wallet moved from chain ${request.chainIdAtRequest} to ${chainId}`);
    }
    const list = Array.isArray(request.params) ? request.params : [];
    switch (request.method) {
      case 'eth_requestAccounts':
      case 'wallet_requestPermissions': {
        if (selected.length === 0) throw new WalletError(-32603, 'harness: no account is selected');
        permittedOrigin = request.origin;
        permittedAt = Date.now();
        emit('accountsChanged', exposedAccounts());
        return request.method === 'eth_requestAccounts' ? exposedAccounts() : [permission(request.origin)];
      }
      case 'eth_sendTransaction':
        return sendOnFork(list[0] as Record<string, unknown>);
      case 'personal_sign': {
        const account = accounts.get(String(list[1]).toLowerCase()) as Account;
        const signer = privateKeyToAccount(account.key as Hex);
        const message = list[0] as string;
        return signer.signMessage({ message: isHex(message) ? { raw: message } : message });
      }
      case 'eth_signTypedData_v4': {
        const account = accounts.get(String(list[0]).toLowerCase()) as Account;
        const signer = privateKeyToAccount(account.key as Hex);
        const typed = parseTypedData(list[1]);
        const types = { ...(typed.types as Record<string, unknown>) };
        delete types.EIP712Domain;
        return signer.signTypedData({
          domain: typed.domain,
          types,
          primaryType: typed.primaryType,
          message: typed.message,
        } as Parameters<typeof signer.signTypedData>[0]);
      }
      case 'wallet_switchEthereumChain': {
        const target = chainIdParam(request.params);
        if (!knownChains.has(target)) throw new WalletError(4902, DEFAULT_MESSAGES[4902]);
        setChain(target);
        return null;
      }
      case 'wallet_addEthereumChain': {
        // The RPC URLs in the request are metadata. The wallet never calls them.
        const target = chainIdParam(request.params);
        knownChains.add(target);
        setChain(target);
        return null;
      }
    }
  };

  /** Requests whose decision is running, so that a second decision cannot run beside the first. */
  const deciding = new Set<string>();

  const decide = async (request: WalletRequest, decision: 'approve' | { reject: number; message?: string }) => {
    if (request.status !== 'pending' || deciding.has(request.id)) return;
    deciding.add(request.id);
    try {
      await decideOnce(request, decision);
    } finally {
      deciding.delete(request.id);
    }
  };

  const decideOnce = async (request: WalletRequest, decision: 'approve' | { reject: number; message?: string }) => {
    if (decision === 'approve') {
      try {
        settle(request, { result: await execute(request) });
      } catch (error) {
        settle(request, failWith(error));
      }
    } else {
      settle(
        request,
        {
          error: {
            code: decision.reject,
            message: decision.message ?? DEFAULT_MESSAGES[decision.reject] ?? 'harness: rejected',
          },
        },
        'rejected'
      );
    }
  };

  const setChain = (next: number) => {
    knownChains.add(next);
    if (chainId === next) return;
    chainId = next;
    emit('chainChanged', toHex(next));
  };

  const permission = (origin: string) => ({
    id: 'harness-eth-accounts',
    parentCapability: 'eth_accounts',
    invoker: origin,
    caveats: [{ type: 'restrictReturnedAccounts', value: exposedAccounts() }],
    date: permittedAt,
  });

  const waitForOutcome = (id: string, waitMs: number): Promise<Outcome | { pending: string }> => {
    const slot = outcomes.get(id);
    if (slot === undefined) return Promise.resolve({ error: { code: 4900, message: 'harness: the wallet was reset' } });
    if (slot.outcome !== undefined) return Promise.resolve(slot.outcome);
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        slot.waiters.delete(wake);
        resolve(
          slot.outcome ??
            (outcomes.has(id) ? { pending: id } : { error: { code: 4900, message: 'harness: the wallet was reset' } })
        );
      };
      const timer = setTimeout(wake, waitMs);
      slot.waiters.add(wake);
    });
  };

  /** The wallet's answer to one provider call from the page. */
  const walletRpc = async (origin: string, method: string, params: unknown): Promise<Outcome | { pending: string }> => {
    if (typeof method !== 'string') return { error: { code: -32600, message: 'harness: no method' } };
    // The record is complete or reports that it is not: a test that asserts a method was never called must
    // not pass on a record that dropped the call.
    if (providerCalls.length < providerCallLimit) providerCalls.push({ method, origin, receivedAt: now(), generation });
    else hasProviderCallOverflow = true;
    try {
      if ((QUEUED_METHODS as readonly string[]).includes(method)) {
        const queued = method as QueuedMethod;
        if (queued === 'eth_requestAccounts' && permittedOrigin === origin && selected.length > 0) {
          return { result: exposedAccounts() };
        }
        checkRequest(queued, params, origin);
        const request: WalletRequest = {
          id: randomUUID(),
          generation,
          method: queued,
          params,
          origin,
          chainIdAtRequest: chainId,
          selectedAccount: selected[0] ?? null,
          status: 'pending',
          receivedAt: now(),
        };
        requests.set(request.id, request);
        outcomes.set(request.id, { waiters: new Set() });
        log(`request ${request.id} ${method} received`);
        const policy = policies.get(method) ?? 'manual';
        if (policy === 'approve') void decide(request, 'approve');
        else if (policy !== 'manual') void decide(request, { reject: policy.reject });
        return waitForOutcome(request.id, LONG_POLL_MS);
      }
      switch (method) {
        case 'eth_chainId':
          return { result: toHex(chainId) };
        case 'net_version':
          return { result: String(chainId) };
        case 'eth_accounts':
          return { result: permittedOrigin === origin ? exposedAccounts() : [] };
        case 'wallet_getPermissions':
          return { result: permittedOrigin === origin ? [permission(origin)] : [] };
        case 'wallet_revokePermissions':
          calls.push({ method, origin, receivedAt: now(), generation });
          if (permittedOrigin === origin) {
            permittedOrigin = null;
            emit('accountsChanged', []);
          }
          return { result: null };
      }
      if (WALLET_READ_METHODS.has(method)) {
        if (chainId !== 1) return { error: { code: -32000, message: 'harness: chain not served by the harness' } };
        return { result: await call(method, Array.isArray(params) ? params : []) };
      }
      return { error: { code: 4200, message: DEFAULT_MESSAGES[4200] } };
    } catch (error) {
      const outcome = failWith(error);
      // A read the fork refused keeps the fork's own code, message and data (such as revert data), as a
      // wallet relays a node's error.
      const nodeError = error as { code?: unknown; nodeMessage?: string; data?: unknown; message?: string };
      if (!(error instanceof WalletError) && typeof nodeError.code === 'number') {
        return {
          error: {
            code: nodeError.code,
            message: nodeError.nodeMessage ?? String(nodeError.message),
            ...(nodeError.data === undefined ? {} : { data: nodeError.data }),
          },
        };
      }
      return outcome;
    }
  };

  const createAccount = async (
    { eth = '10', usdc = '0', screening: behaviour = 'allowed', hasKey }: AccountOptions & { hasKey: boolean },
    given?: Address
  ) =>
    serially(async () => {
      if (!SCREENING_BEHAVIOURS.includes(behaviour)) throw new HttpError(400, 'unknown screening behaviour');
      let account: Account;
      if (hasKey) {
        const key = generatePrivateKey();
        options.onSecret?.(key);
        account = { address: privateKeyToAccount(key).address, key };
      } else {
        account = { address: getAddress(given as string) };
      }
      const address = account.address;
      await call('anvil_impersonateAccount', [address]);
      impersonated.add(address.toLowerCase());
      await call('anvil_setBalance', [address, toHex(parseEther(eth))]);
      const usdcUnits = BigInt(Math.round(Number(usdc) * 1e6));
      if (usdcUnits > 0n) await fundUsdc(address, usdcUnits);
      accounts.set(address.toLowerCase(), account);
      screening.setBehaviour(address, behaviour);
      log(`account ${address} ${hasKey ? 'keyed' : 'impersonated'}`);
      return { address, kind: hasKey ? 'keyed' : 'impersonated' };
    });

  /**
   * Gives `address` `amount` raw USDC by writing its entry in USDC's balance mapping. It refuses unless the
   * entry and `balanceOf` both start at 0 and `balanceOf` reads back exactly `amount`, so an unexpected
   * token implementation stops the run rather than leaving a balance the test did not mean.
   */
  const fundUsdc = async (address: Address, amount: bigint) => {
    const key = usdcBalanceKey(address);
    const balance = async () =>
      decodeFunctionResult({
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        data: await call<Hex>('eth_call', [
          { to: USDC, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }) },
          'latest',
        ]),
      });
    const stored = BigInt(await call<string>('eth_getStorageAt', [USDC, key, 'latest']));
    if (stored !== 0n || (await balance()) !== 0n) throw new Error('USDC funding needs an account with no USDC');
    await call('anvil_setStorageAt', [USDC, key, toHex(amount, { size: 32 })]);
    const after = await balance();
    if (after !== amount)
      throw new Error(`USDC funding read back ${after}, not ${amount}: unexpected USDC storage layout`);
  };

  const reset = () =>
    serially(async () => {
      // Everything in memory is cleared before the first await, so no call in between sees the previous
      // test's accounts, permission or policies.
      generation += 1;
      const stale = [...impersonated];
      impersonated.clear();
      accounts.clear();
      selected = [];
      permittedOrigin = null;
      chainId = 1;
      knownChains = new Set([1]);
      policies = new Map();
      for (const request of requests.values()) {
        if (request.status === 'pending')
          settle(request, { error: { code: 4900, message: 'harness: the wallet was reset' } });
      }
      for (const slot of outcomes.values()) {
        if (slot.timer !== undefined) clearTimeout(slot.timer);
        for (const wake of [...slot.waiters]) wake();
      }
      outcomes.clear();
      requests.clear();
      calls.length = 0;
      providerCalls.length = 0;
      hasProviderCallOverflow = false;
      controlSends.length = 0;
      events.length = 0;
      for (const wake of [...eventWaiters]) wake();
      screening.reset();
      for (const address of stale) await call('anvil_stopImpersonatingAccount', [address]);
      if ((await call<boolean>('evm_revert', [baseline])) !== true) throw new Error('evm_revert failed');
      baseline = await call<string>('evm_snapshot');
      await verifiedFork();
      log(`reset to generation ${generation}`);
      return { generation };
    });

  const requestList = (query: URLSearchParams) =>
    [...requests.values()].filter(
      (request) =>
        (!query.has('status') || request.status === query.get('status')) &&
        (!query.has('method') || request.method === query.get('method'))
    );

  const route = async (method: string, path: string, query: URLSearchParams, body: Record<string, unknown>) => {
    const requestMatch = /^\/v1\/requests\/([0-9a-f-]{36})(?:\/(approve|reject|outcome))?$/.exec(path);
    if (requestMatch !== null) {
      const request = requests.get(requestMatch[1]);
      const action = requestMatch[2];
      if (method === 'GET' && action === 'outcome')
        return waitForOutcome(requestMatch[1], Math.min(Number(query.get('waitMs') ?? LONG_POLL_MS), LONG_POLL_MS));
      if (request === undefined) throw new HttpError(404, 'no such request in this generation');
      if (method === 'GET' && action === undefined) return request;
      if (method === 'POST' && (action === 'approve' || action === 'reject')) {
        if (request.status !== 'pending') throw new HttpError(409, `the request is already ${request.status}`);
        // One decision per request: a second one, now or delayed, while the first is scheduled or running
        // could otherwise send a transaction twice, or reject a request whose transaction was sent.
        if (deciding.has(request.id) || request.scheduled !== undefined) {
          throw new HttpError(409, 'the request already has a decision');
        }
        const delayMs = Number(body.delayMs ?? 0);
        if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 600_000)
          throw new HttpError(400, 'delayMs must be 0 to 600000');
        const code = Number(body.code ?? 4001);
        if (action === 'reject' && !Number.isInteger(code)) throw new HttpError(400, 'code must be an integer');
        const decision =
          action === 'approve'
            ? 'approve'
            : { reject: code, message: typeof body.message === 'string' ? body.message : undefined };
        if (delayMs > 0) {
          const slot = outcomes.get(request.id);
          if (slot === undefined) throw new HttpError(409, 'the request has no outcome slot');
          request.scheduled = { decision: action, at: new Date(Date.now() + delayMs).toISOString() };
          slot.timer = setTimeout(() => void decide(request, decision), delayMs);
          return { id: request.id, scheduled: request.scheduled };
        }
        await decide(request, decision);
        return request;
      }
    }
    switch (`${method} ${path}`) {
      case 'POST /v1/rpc':
        return walletRpc(String(body.origin ?? ''), body.method as string, body.params);
      case 'GET /v1/events': {
        if (!query.has('cursor')) return { cursor, events: [] };
        const after = Number(query.get('cursor'));
        const pending = () => events.filter((event) => event.cursor > after);
        if (pending().length > 0) return { cursor, events: pending() };
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            eventWaiters.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, LONG_POLL_MS);
          eventWaiters.add(wake);
        });
        return { cursor, events: pending() };
      }
      case 'GET /v1/health':
        return { ok: true, generation };
      case 'GET /v1/state':
        return {
          generation,
          chainId,
          knownChains: [...knownChains],
          permittedOrigin,
          selected,
          accounts: [...accounts.values()].map(({ address, key }) => ({
            address,
            kind: key === undefined ? 'impersonated' : 'keyed',
          })),
          policies: Object.fromEntries(policies),
        };
      case 'GET /v1/requests':
        return requestList(query);
      case 'GET /v1/provider-calls':
        return { calls: providerCalls, hasOverflowed: hasProviderCallOverflow };
      case 'GET /v1/calls':
        return calls;
      case 'GET /v1/control-sends':
        return controlSends;
      case 'POST /v1/policy': {
        const target = String(body.method);
        if (!(QUEUED_METHODS as readonly string[]).includes(target) && target !== '*')
          throw new HttpError(400, 'unknown method');
        const policy = body.policy as Policy;
        const valid =
          policy === 'manual' ||
          policy === 'approve' ||
          (typeof policy === 'object' && policy !== null && Number.isInteger(policy.reject));
        if (!valid) throw new HttpError(400, "policy must be 'manual', 'approve' or { reject: code }");
        for (const each of target === '*' ? QUEUED_METHODS : [target]) policies.set(each, policy);
        return Object.fromEntries(policies);
      }
      case 'POST /v1/accounts/new':
        return createAccount({ ...(body as AccountOptions), hasKey: true });
      case 'POST /v1/accounts/impersonate': {
        if (!isAddress(body.address)) throw new HttpError(400, 'address must be an address');
        if (accounts.has(body.address.toLowerCase())) throw new HttpError(409, 'the account already exists');
        return createAccount({ ...(body as AccountOptions), hasKey: false }, body.address as Address);
      }
      case 'POST /v1/accounts/select': {
        const addresses = body.addresses;
        if (
          !Array.isArray(addresses) ||
          !addresses.every((address) => isAddress(address) && accounts.has(address.toLowerCase()))
        ) {
          throw new HttpError(400, 'addresses must be harness accounts');
        }
        selected = addresses.map((address) => getAddress(address as string));
        if (permittedOrigin !== null) emit('accountsChanged', exposedAccounts());
        return { selected };
      }
      case 'POST /v1/chain': {
        const next = Number(body.chainId);
        if (!Number.isSafeInteger(next) || next <= 0) throw new HttpError(400, 'chainId must be a positive integer');
        setChain(next);
        return { chainId };
      }
      case 'POST /v1/chains/known': {
        const ids = body.chainIds;
        if (!Array.isArray(ids) || !ids.every((id) => Number.isSafeInteger(id) && id > 0))
          throw new HttpError(400, 'chainIds must be positive integers');
        knownChains = new Set(ids as number[]);
        return { knownChains: [...knownChains] };
      }
      case 'POST /v1/disconnect':
        permittedOrigin = null;
        emit('disconnect', { code: 4900, message: 'harness: disconnected' });
        emit('accountsChanged', []);
        return { disconnected: true };
      case 'POST /v1/fork/send': {
        // Fixture set-up, such as an existing position: a transaction from a harness account, without the app.
        if (!isAddress(body.from) || !accounts.has(body.from.toLowerCase()))
          throw new HttpError(400, 'from must be a harness account');
        if (!isAddress(body.to)) throw new HttpError(400, 'to must be an address');
        const hash = await sendOnFork({
          from: getAddress(body.from),
          to: body.to,
          data: body.data,
          value: body.value,
          gas: body.gas,
        });
        controlSends.push({ hash, from: body.from.toLowerCase(), to: body.to.toLowerCase(), generation });
        return { hash };
      }
      case 'POST /v1/screening': {
        if (!isAddress(body.address)) throw new HttpError(400, 'address must be an address');
        if (!SCREENING_BEHAVIOURS.includes(body.behaviour as ScreeningBehaviour))
          throw new HttpError(400, 'unknown behaviour');
        screening.setBehaviour(body.address, body.behaviour as ScreeningBehaviour);
        return { address: body.address.toLowerCase(), behaviour: body.behaviour };
      }
      case 'POST /v1/screening/release': {
        if (!isAddress(body.address)) throw new HttpError(400, 'address must be an address');
        if (body.outcome !== 'allowed' && body.outcome !== 'blocked')
          throw new HttpError(400, "outcome must be 'allowed' or 'blocked'");
        return { released: screening.release(body.address, body.outcome) };
      }
      case 'GET /v1/screening/log':
        return screening.log();
      case 'GET /v1/stats':
        return options.stats?.() ?? {};
      case 'POST /v1/reset':
        return reset();
      case 'POST /v1/session/end':
        hasSessionEnded = true;
        return { hasEnded: true };
      case 'GET /v1/session':
        return { hasEnded: hasSessionEnded };
    }
    throw new HttpError(404, 'no such endpoint');
  };

  const server = http.createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body, (_, value) => (typeof value === 'bigint' ? value.toString() : value)));
    };
    const { port } = server.address() as { port: number };
    // 1. Host: this server's own address only, which DNS rebinding cannot give.
    if (request.headers.host !== `127.0.0.1:${port}`) return send(403, { error: 'host' });
    // 2. Origin: any, including `null`, means a browser sent it. No CORS header is ever sent.
    if (request.headers.origin !== undefined) return send(403, { error: 'origin' });
    // 3. The per-run bearer token.
    const authorization = request.headers.authorization ?? '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    if (!tokenMatches(token, bearer)) return send(401, { error: 'unauthorized' });
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    const chunks: Buffer[] = [];
    let size = 0;
    let isTooLarge = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_CONTROL_BODY_BYTES) chunks.push(chunk);
      else isTooLarge = true;
    });
    request.on('end', async () => {
      if (isTooLarge) return send(413, { error: 'body over 1 MB' });
      let body: Record<string, unknown> = {};
      if (request.method === 'POST') {
        if (!String(request.headers['content-type'] ?? '').startsWith('application/json'))
          return send(415, { error: 'JSON only' });
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          body = text === '' ? {} : JSON.parse(text);
        } catch {
          return send(400, { error: 'body is not JSON' });
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body))
          return send(400, { error: 'body must be an object' });
      } else if (request.method !== 'GET') {
        return send(405, { error: 'GET or POST only' });
      }
      try {
        send(200, await route(request.method ?? 'GET', url.pathname, url.searchParams, body));
      } catch (error) {
        if (error instanceof HttpError) return send(error.status, { error: error.message });
        log(`control error on ${url.pathname}: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
        send(500, { error: String((error as Error)?.message ?? error).slice(0, 300) });
      }
    });
  });
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    generation: () => generation,
    close: () =>
      new Promise((resolve) => {
        for (const slot of outcomes.values()) if (slot.timer !== undefined) clearTimeout(slot.timer);
        for (const request of requests.values()) {
          if (request.status === 'pending')
            settle(request, { error: { code: 4900, message: 'harness: the wallet stopped' } });
        }
        for (const wake of [...eventWaiters]) wake();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type AccountOptions = { eth?: string; usdc?: string; screening?: ScreeningBehaviour };

type TypedData = {
  types?: unknown;
  domain?: { chainId?: unknown } & Record<string, unknown>;
  primaryType?: string;
  message?: Record<string, unknown>;
};

function parseTypedData(value: unknown): TypedData {
  let typed: unknown = value;
  if (typeof value === 'string') {
    try {
      typed = JSON.parse(value);
    } catch {
      throw new WalletError(-32602, 'harness: typed data is not JSON');
    }
  }
  if (typed === null || typeof typed !== 'object' || typeof (typed as TypedData).primaryType !== 'string') {
    throw new WalletError(-32602, 'harness: typed data needs types, a domain, a primaryType and a message');
  }
  return typed as TypedData;
}
