// A typed client for the wallet server's control API, for tests, fixtures and agents. It reads the per-run
// token from the 0600 token file and never prints it.
import fs from 'node:fs';

import type { ScreeningBehaviour, ScreeningLogEntry } from './screeningStub';
import type { AccountOptions, Outcome, Policy, WalletCall, WalletEvent, WalletRequest } from './walletServer';

export class ControlError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type WalletState = {
  generation: number;
  chainId: number;
  knownChains: number[];
  permittedOrigin: string | null;
  selected: string[];
  accounts: { address: string; kind: 'keyed' | 'impersonated' }[];
  policies: Record<string, Policy>;
};

export class ControlClient {
  readonly #token: string;

  constructor(readonly url: string, token: string) {
    this.#token = token;
  }

  /** A client for the run, from BROWSER_WALLET_CONTROL_URL and the token file at BROWSER_WALLET_TOKEN_FILE. */
  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): ControlClient {
    const url = env.BROWSER_WALLET_CONTROL_URL;
    const tokenFile = env.BROWSER_WALLET_TOKEN_FILE;
    if (url === undefined || tokenFile === undefined) {
      throw new Error('BROWSER_WALLET_CONTROL_URL and BROWSER_WALLET_TOKEN_FILE are not set: start the harness first.');
    }
    return new ControlClient(url, fs.readFileSync(tokenFile, 'utf8').trim());
  }

  /** Keeps the token out of `console.log` and of Playwright's attachments of this object. */
  toJSON() {
    return { url: this.url };
  }

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
    });
    const text = await response.text();
    const parsed = text === '' ? undefined : JSON.parse(text);
    if (!response.ok)
      throw new ControlError(response.status, `${method} ${path}: ${response.status} ${parsed?.error ?? ''}`);
    return parsed as T;
  }

  /** One provider call from the page's origin. Waits through the server's long polls until it is decided. */
  async walletRpc(origin: string, method: string, params: unknown): Promise<Outcome> {
    let answer = await this.request<Outcome | { pending: string }>('POST', '/v1/rpc', { origin, method, params });
    while ('pending' in answer) {
      answer = await this.request<Outcome | { pending: string }>('GET', `/v1/requests/${answer.pending}/outcome`);
    }
    return answer;
  }

  events(cursor?: number) {
    return this.request<{ cursor: number; events: WalletEvent[] }>(
      'GET',
      cursor === undefined ? '/v1/events' : `/v1/events?cursor=${cursor}`
    );
  }

  state = () => this.request<WalletState>('GET', '/v1/state');
  reset = () => this.request<{ generation: number }>('POST', '/v1/reset', {});
  health = () => this.request<{ ok: boolean; generation: number }>('GET', '/v1/health');

  newAccount = (options: AccountOptions = {}) =>
    this.request<{ address: `0x${string}`; kind: 'keyed' }>('POST', '/v1/accounts/new', options);
  impersonate = (address: string, options: AccountOptions = {}) =>
    this.request<{ address: `0x${string}`; kind: 'impersonated' }>('POST', '/v1/accounts/impersonate', {
      address,
      ...options,
    });
  select = (...addresses: string[]) =>
    this.request<{ selected: string[] }>('POST', '/v1/accounts/select', { addresses });

  setChain = (chainId: number) => this.request<{ chainId: number }>('POST', '/v1/chain', { chainId });
  setKnownChains = (chainIds: number[]) => this.request('POST', '/v1/chains/known', { chainIds });
  disconnect = () => this.request('POST', '/v1/disconnect', {});
  setPolicy = (method: string, policy: Policy) => this.request('POST', '/v1/policy', { method, policy });

  requests = (filter: { status?: WalletRequest['status']; method?: string } = {}) =>
    this.request<WalletRequest[]>('GET', `/v1/requests?${new URLSearchParams(filter as Record<string, string>)}`);
  getRequest = (id: string) => this.request<WalletRequest>('GET', `/v1/requests/${id}`);
  approve = (id: string, options: { delayMs?: number } = {}) =>
    this.request<WalletRequest | { id: string; scheduled: unknown }>('POST', `/v1/requests/${id}/approve`, options);
  reject = (id: string, options: { code?: number; message?: string; delayMs?: number } = {}) =>
    this.request<WalletRequest | { id: string; scheduled: unknown }>('POST', `/v1/requests/${id}/reject`, options);
  calls = () => this.request<WalletCall[]>('GET', '/v1/calls');
  /** Every provider call from the page in this generation, those the wallet answered at once included. */
  providerCalls = () => this.request<WalletCall[]>('GET', '/v1/provider-calls');

  forkSend = (transaction: { from: string; to: string; data?: string; value?: string; gas?: string }) =>
    this.request<{ hash: `0x${string}` }>('POST', '/v1/fork/send', transaction);

  setScreening = (address: string, behaviour: ScreeningBehaviour) =>
    this.request('POST', '/v1/screening', { address, behaviour });
  releaseScreening = (address: string, outcome: 'allowed' | 'blocked') =>
    this.request<{ released: number }>('POST', '/v1/screening/release', { address, outcome });
  screeningLog = () => this.request<ScreeningLogEntry[]>('GET', '/v1/screening/log');

  stats = () => this.request<Record<string, unknown>>('GET', '/v1/stats');
  endSession = () => this.request('POST', '/v1/session/end', {});
  session = () => this.request<{ ended: boolean }>('GET', '/v1/session');

  /** Waits until a request matching `filter` is in the queue, and returns the first one. */
  async waitForRequest(
    filter: { method: string; status?: WalletRequest['status'] },
    { timeoutMs = 60_000, after = new Set<string>() }: { timeoutMs?: number; after?: ReadonlySet<string> } = {}
  ): Promise<WalletRequest> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = (await this.requests({ status: filter.status ?? 'pending', method: filter.method })).find(
        (request) => !after.has(request.id)
      );
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`no ${filter.method} request within ${timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
