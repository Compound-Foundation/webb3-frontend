/**
 * @jest-environment node
 */
// The wallet server against a fake anvil: its access checks, its queue, its checks of each request, its
// refusal to send to a node that is not the expected fork, its signatures, and its reset.
import http from 'node:http';

import { utils } from 'ethers';

import { server as mswServer } from '../../../handlers/server';
import { ControlClient } from '../controlClient';
import { verifyFork } from '../fork';
import type { ScreeningStub } from '../screeningStub';
import { anvilHandlers, FORK_BLOCK, FORK_HASH, startFakeNode, type FakeNode } from '../testing/testServers';
import { startWalletServer, tokenMatches, type WalletRequest, type WalletServer } from '../walletServer';

const TOKEN = 'a'.repeat(64);
const ORIGIN = 'http://127.0.0.1:5999';

const fakeScreening = (): ScreeningStub & { behaviours: Map<string, string>; resets: number } => {
  const behaviours = new Map<string, string>();
  const stub = {
    behaviours,
    resets: 0,
    origin: 'http://127.0.0.1:1',
    endpoint: 'http://127.0.0.1:1/screen',
    extensionUrl: 'http://127.0.0.1:1/extension/',
    setBehaviour: (address: string, behaviour: string) => void behaviours.set(address.toLowerCase(), behaviour),
    behaviourOf: () => 'blocked' as const,
    release: () => 0,
    log: () => [],
    reset: () => {
      behaviours.clear();
      stub.resets += 1;
    },
    close: async () => undefined,
  };
  return stub as unknown as ScreeningStub & { behaviours: Map<string, string>; resets: number };
};

let node: FakeNode;
let wallet: WalletServer;
let client: ControlClient;
let keys: string[];
let screening: ReturnType<typeof fakeScreening>;
let verifyCalls: number;
let verifyFails: boolean;

beforeAll(() => mswServer.close());

beforeEach(async () => {
  node = await startFakeNode(anvilHandlers());
  keys = [];
  screening = fakeScreening();
  verifyCalls = 0;
  verifyFails = false;
  wallet = await startWalletServer({
    fork: { localUrl: node.url },
    target: { number: FORK_BLOCK, hash: FORK_HASH },
    token: TOKEN,
    screening,
    onSecret: (secret) => keys.push(secret),
    verify: async (fork, target) => {
      verifyCalls += 1;
      if (verifyFails) throw new Error('The local node is not the expected fork: a client that is not anvil.');
      return verifyFork(fork, target);
    },
  });
  client = new ControlClient(wallet.url, TOKEN);
});

afterEach(async () => {
  await wallet.close();
  await node.close();
});

function raw(
  path: string,
  headers: Record<string, string>,
  method = 'GET',
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: wallet.port, path, method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      );
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function connectedAccount() {
  const { address } = await client.newAccount({ usdc: '0' });
  await client.select(address);
  const pending = client.walletRpc(ORIGIN, 'wallet_requestPermissions', [{ eth_accounts: {} }]);
  const request = await client.waitForRequest({ method: 'wallet_requestPermissions' });
  await client.approve(request.id);
  await pending;
  return address;
}

describe('access to the control API', () => {
  const host = () => `127.0.0.1:${wallet.port}`;

  test('needs the bearer token, compared whatever its length', async () => {
    expect((await raw('/v1/health', { host: host() })).status).toBe(401);
    expect((await raw('/v1/health', { host: host(), authorization: `Bearer ${'b'.repeat(64)}` })).status).toBe(401);
    expect((await raw('/v1/health', { host: host(), authorization: 'Bearer short' })).status).toBe(401);
    expect((await raw('/v1/health', { host: host(), authorization: `Bearer ${TOKEN}${TOKEN}` })).status).toBe(401);
    expect((await raw('/v1/health', { host: host(), authorization: TOKEN })).status).toBe(401);
    expect((await raw('/v1/health', { host: host(), authorization: `Bearer ${TOKEN.slice(0, 63)}` })).status).toBe(401);
    expect((await raw('/v1/health', { host: host(), authorization: 'Bearer ' })).status).toBe(401);
    expect((await raw('/v1/health', { host: host(), authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN, '')).toBe(false);
  });

  test('refuses any Origin, including null, and sends no CORS header', async () => {
    for (const origin of ['http://127.0.0.1:5999', 'null', 'https://attacker.example']) {
      const answer = await raw('/v1/health', { host: host(), origin, authorization: `Bearer ${TOKEN}` });
      expect(answer.status).toBe(403);
    }
    const preflight = await raw('/v1/health', { host: host(), origin: ORIGIN }, 'OPTIONS');
    expect(preflight.status).toBe(403);
  });

  test('refuses a Host other than its own address, as DNS rebinding sends', async () => {
    for (const other of [`localhost:${wallet.port}`, 'attacker.example', `127.0.0.1:${wallet.port + 1}`]) {
      expect((await raw('/v1/health', { host: other, authorization: `Bearer ${TOKEN}` })).status).toBe(403);
    }
  });

  test('refuses a body over 1 MB and a body that is not JSON', async () => {
    const headers = { host: host(), authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    expect((await raw('/v1/policy', headers, 'POST', `{"a":"${'x'.repeat(1024 * 1024 + 1)}"}`)).status).toBe(413);
    expect((await raw('/v1/policy', headers, 'POST', 'not json')).status).toBe(400);
    expect((await raw('/v1/policy', { ...headers, 'content-type': 'text/plain' }, 'POST', '{}')).status).toBe(415);
  });
});

describe('the request queue', () => {
  test('answers state methods at once, and queues the permission request until it is decided', async () => {
    const address = await connectedAccount();
    expect(await client.walletRpc(ORIGIN, 'eth_chainId', [])).toEqual({ result: '0x1' });
    expect(await client.walletRpc(ORIGIN, 'eth_accounts', [])).toEqual({ result: [address.toLowerCase()] });
    expect(await client.walletRpc('http://other.example', 'eth_accounts', [])).toEqual({ result: [] });
    expect(await client.walletRpc(ORIGIN, 'eth_sign', [])).toEqual({ error: expect.objectContaining({ code: 4200 }) });
    expect(await client.walletRpc(ORIGIN, 'eth_sendRawTransaction', ['0x00'])).toEqual({
      error: expect.objectContaining({ code: 4200 }),
    });
  });

  test('rejects with the code given, and refuses a second decision', async () => {
    await connectedAccount();
    const pending = client.walletRpc(ORIGIN, 'wallet_switchEthereumChain', [{ chainId: '0x2105' }]);
    const request = await client.waitForRequest({ method: 'wallet_switchEthereumChain' });
    await client.reject(request.id, { code: -32002 });
    expect(await pending).toEqual({ error: { code: -32002, message: 'Request already pending.' } });
    expect((await client.getRequest(request.id)).status).toBe('rejected');
    await expect(client.approve(request.id)).rejects.toThrow('409');
  });

  test('a switch to an unknown chain fails with 4902, and adding the chain switches to it', async () => {
    await connectedAccount();
    const switching = client.walletRpc(ORIGIN, 'wallet_switchEthereumChain', [{ chainId: '0x2105' }]);
    await client.approve((await client.waitForRequest({ method: 'wallet_switchEthereumChain' })).id);
    expect(await switching).toEqual({ error: { code: 4902, message: 'Unrecognized chain ID.' } });
    const adding = client.walletRpc(ORIGIN, 'wallet_addEthereumChain', [
      { chainId: '0x2105', rpcUrls: ['https://never.example'] },
    ]);
    await client.approve((await client.waitForRequest({ method: 'wallet_addEthereumChain' })).id);
    expect(await adding).toEqual({ result: null });
    expect((await client.state()).chainId).toBe(8453);
    // The add-chain RPC URL is metadata: the wallet called no node but the fork.
    expect(node.calls.every((call) => call.headers.host === new URL(node.url).host)).toBe(true);
    const events = await client.events(0);
    expect(events.events.map((event) => [event.type, event.data])).toEqual(
      expect.arrayContaining([['chainChanged', '0x2105']])
    );
    // Off chain 1, the wallet forwards no read and sends nothing.
    expect(await client.walletRpc(ORIGIN, 'eth_blockNumber', [])).toEqual({
      error: { code: -32000, message: 'harness: chain not served by the harness' },
    });
  });

  test('a delayed approval waits, and a reset cancels it so nothing is sent', async () => {
    const address = await connectedAccount();
    const sending = client.walletRpc(ORIGIN, 'eth_sendTransaction', [{ from: address, to: address, data: '0x' }]);
    const request = await client.waitForRequest({ method: 'eth_sendTransaction' });
    await client.approve(request.id, { delayMs: 300 });
    expect((await client.getRequest(request.id)).scheduled?.decision).toBe('approve');
    await client.reset();
    expect(await sending).toEqual({ error: { code: 4900, message: 'harness: the wallet was reset' } });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(node.calls.filter((call) => call.method === 'eth_sendTransaction')).toEqual([]);
    expect(await client.requests()).toEqual([]);
  });
});

describe('one decision per request', () => {
  const slowVerify = () => {
    // The fork check takes 300 ms, so a second decision arrives while the first is still running.
    node.handlers.set('web3_clientVersion', () => {
      const until = Date.now() + 300;
      while (Date.now() < until);
      return 'anvil/v1.2.3';
    });
  };
  const sends = () => node.calls.filter((call) => call.method === 'eth_sendTransaction').length;

  test('a second approval while the first runs is refused, and the transaction is sent once', async () => {
    const address = await connectedAccount();
    const sending = client.walletRpc(ORIGIN, 'eth_sendTransaction', [{ from: address, to: address }]);
    const request = await client.waitForRequest({ method: 'eth_sendTransaction' });
    slowVerify();
    const [first, second] = await Promise.allSettled([client.approve(request.id), client.approve(request.id)]);
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
    await sending;
    expect(sends()).toBe(1);
  });

  test('a rejection while an approval runs is refused, so the record matches the fork', async () => {
    const address = await connectedAccount();
    const sending = client.walletRpc(ORIGIN, 'eth_sendTransaction', [{ from: address, to: address }]);
    const request = await client.waitForRequest({ method: 'eth_sendTransaction' });
    slowVerify();
    const approving = client.approve(request.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(client.reject(request.id)).rejects.toThrow('409');
    await approving;
    expect(await sending).toEqual({ result: `0x${'ab'.repeat(32)}` });
    expect((await client.getRequest(request.id)).status).toBe('approved');
    expect(sends()).toBe(1);
  });

  test('a second delayed decision is refused, and an automatic policy decision cannot be repeated by hand', async () => {
    const address = await connectedAccount();
    const sending = client.walletRpc(ORIGIN, 'eth_sendTransaction', [{ from: address, to: address }]);
    const request = await client.waitForRequest({ method: 'eth_sendTransaction' });
    await client.approve(request.id, { delayMs: 100 });
    await expect(client.approve(request.id, { delayMs: 150 })).rejects.toThrow('409');
    await expect(client.approve(request.id)).rejects.toThrow('409');
    await sending;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sends()).toBe(1);
    slowVerify();
    await client.setPolicy('eth_sendTransaction', 'approve');
    const automatic = client.walletRpc(ORIGIN, 'eth_sendTransaction', [{ from: address, to: address }]);
    const autoRequest = await client
      .waitForRequest({ method: 'eth_sendTransaction' }, { after: new Set([request.id]) })
      .catch(() => undefined);
    if (autoRequest !== undefined) await expect(client.approve(autoRequest.id)).rejects.toThrow('409');
    await automatic;
    expect(sends()).toBe(2);
  });
});

describe('checks on each request', () => {
  test('a transaction must come from the selected, permitted account, on chain 1, with a matching chainId and a `to`', async () => {
    const address = await connectedAccount();
    const { address: other } = await client.newAccount({ usdc: '0' });
    const error = async (transaction: Record<string, unknown>) =>
      ((await client.walletRpc(ORIGIN, 'eth_sendTransaction', [transaction])) as { error: { code: number } }).error
        .code;
    expect(await error({ from: other, to: address })).toBe(4100);
    expect(await error({ from: address, to: address, chainId: '0x2105' })).toBe(-32602);
    expect(await error({ from: address })).toBe(-32602);
    await client.setChain(8453);
    expect(await error({ from: address, to: address })).toBe(-32000);
    expect(await client.requests({ method: 'eth_sendTransaction' })).toEqual([]);
  });

  test('checks a request again when it is approved: a later account or chain change fails it, and nothing is signed or sent', async () => {
    const address = await connectedAccount();
    const { address: other } = await client.newAccount({ usdc: '0' });
    const signing = client.walletRpc(ORIGIN, 'personal_sign', ['0x00', address]);
    const signRequest = await client.waitForRequest({ method: 'personal_sign' });
    await client.select(other);
    await client.approve(signRequest.id);
    expect(await signing).toEqual({ error: expect.objectContaining({ code: 4100 }) });
    expect((await client.getRequest(signRequest.id)).status).toBe('failed');
    await client.select(address);
    const sending = client.walletRpc(ORIGIN, 'eth_sendTransaction', [{ from: address, to: address }]);
    const sendRequest = await client.waitForRequest({ method: 'eth_sendTransaction' });
    await client.setChain(8453);
    await client.approve(sendRequest.id);
    expect(await sending).toEqual({ error: expect.objectContaining({ code: -32000 }) });
    expect(node.calls.filter((call) => call.method === 'eth_sendTransaction')).toEqual([]);
  });

  test('a signature approved after the wallet changed chain fails with 4901, and nothing is signed', async () => {
    const address = await connectedAccount();
    const signing = client.walletRpc(ORIGIN, 'personal_sign', ['0x00', address]);
    const request = await client.waitForRequest({ method: 'personal_sign' });
    await client.setChain(8453);
    await client.approve(request.id);
    expect(await signing).toEqual({ error: expect.objectContaining({ code: 4901 }) });
    expect((await client.getRequest(request.id)).status).toBe('failed');
  });

  test('a send goes to anvil only after the fork is verified again, with only the transaction fields it knows', async () => {
    const address = await connectedAccount();
    const sending = client.walletRpc(ORIGIN, 'eth_sendTransaction', [
      {
        from: address,
        to: address,
        data: '0x1234',
        value: '0x0',
        gas: '0x5208',
        nonce: '0x7',
        chainId: '0x1',
        maxFeePerGas: '0x3b9aca00',
      },
    ]);
    const request = await client.waitForRequest({ method: 'eth_sendTransaction' });
    const before = verifyCalls;
    await client.approve(request.id);
    expect(await sending).toEqual({ result: `0x${'ab'.repeat(32)}` });
    expect(verifyCalls).toBe(before + 1);
    const sent = node.calls.filter((call) => call.method === 'eth_sendTransaction');
    expect(sent.map((call) => call.params[0])).toEqual([
      { from: address, to: address, data: '0x1234', value: '0x0', gas: '0x5208', maxFeePerGas: '0x3b9aca00' },
    ]);
    // The next block's time is set first, 12 s after the latest block.
    const methods = node.calls.map((call) => call.method);
    expect(methods.lastIndexOf('evm_setNextBlockTimestamp')).toBe(methods.lastIndexOf('eth_sendTransaction') - 1);
    expect(node.calls.find((call) => call.method === 'evm_setNextBlockTimestamp')?.params).toEqual([
      `0x${(0x6a000000 + 12).toString(16)}`,
    ]);
  });

  test('refuses to send when the node is not the expected fork, and sends nothing', async () => {
    const address = await connectedAccount();
    verifyFails = true;
    const sending = client.walletRpc(ORIGIN, 'eth_sendTransaction', [{ from: address, to: address }]);
    await client.approve((await client.waitForRequest({ method: 'eth_sendTransaction' })).id);
    const answer = (await sending) as { error: { code: number; message: string } };
    expect(answer.error.code).toBe(-32603);
    expect(answer.error.message).toContain('not the expected fork');
    expect(node.calls.filter((call) => call.method === 'eth_sendTransaction')).toEqual([]);
  });

  test.each([
    ['a client that is not anvil', { web3_clientVersion: () => 'Geth/v1.14' }],
    [
      'another fork block hash',
      {
        anvil_metadata: () => ({
          forkedNetwork: { forkBlockNumber: FORK_BLOCK, forkBlockHash: `0x${'00'.repeat(32)}` },
        }),
      },
    ],
    ['another chain', { eth_chainId: () => '0x2105' }],
    ['a block hash that differs', { eth_getBlockByNumber: () => ({ hash: `0x${'11'.repeat(32)}`, timestamp: '0x1' }) }],
  ])('the real fork check refuses a node with %s', async (_, overrides) => {
    const other = await startFakeNode(anvilHandlers(overrides));
    await expect(verifyFork({ localUrl: other.url }, { number: FORK_BLOCK, hash: FORK_HASH })).rejects.toThrow(
      'not the expected fork'
    );
    await other.close();
  });

  test('the real fork check refuses a node that is not on 127.0.0.1', async () => {
    await expect(
      verifyFork({ localUrl: 'http://192.0.2.1:8545' }, { number: FORK_BLOCK, hash: FORK_HASH })
    ).rejects.toThrow('127.0.0.1');
    await expect(
      verifyFork({ localUrl: 'https://eth.example' }, { number: FORK_BLOCK, hash: FORK_HASH })
    ).rejects.toThrow('127.0.0.1');
  });
});

describe('signing', () => {
  test('signs personal_sign and typed data with the account key, and both recover to the account', async () => {
    const address = await connectedAccount();
    await client.setPolicy('personal_sign', 'approve');
    await client.setPolicy('eth_signTypedData_v4', 'approve');
    const message = await client.walletRpc(ORIGIN, 'personal_sign', [
      utils.hexlify(utils.toUtf8Bytes('hello')),
      address,
    ]);
    expect(utils.verifyMessage('hello', (message as { result: string }).result)).toBe(address);
    const typed = {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'chainId', type: 'uint256' },
        ],
        Check: [{ name: 'value', type: 'uint256' }],
      },
      primaryType: 'Check',
      domain: { name: 'unit test', chainId: 1 },
      message: { value: 7 },
    };
    const signature = await client.walletRpc(ORIGIN, 'eth_signTypedData_v4', [address, JSON.stringify(typed)]);
    expect(
      utils.verifyTypedData(
        typed.domain,
        { Check: typed.types.Check },
        typed.message,
        (signature as { result: string }).result
      )
    ).toBe(address);
    const wrongChain = await client.walletRpc(ORIGIN, 'eth_signTypedData_v4', [
      address,
      JSON.stringify({ ...typed, domain: { ...typed.domain, chainId: 5 } }),
    ]);
    expect(wrongChain).toEqual({ error: expect.objectContaining({ code: -32602 }) });
  });

  test('an impersonated account has no key and cannot sign', async () => {
    const address = '0x000000000000000000000000000000000000c304';
    await client.impersonate(address, { eth: '1' });
    await client.select(address);
    const pending = client.walletRpc(ORIGIN, 'wallet_requestPermissions', [{}]);
    await client.approve((await client.waitForRequest({ method: 'wallet_requestPermissions' })).id);
    await pending;
    expect(await client.walletRpc(ORIGIN, 'personal_sign', ['0x00', address])).toEqual({
      error: { code: 4200, message: 'harness: impersonated account cannot sign' },
    });
  });

  test('no control answer ever holds a key the wallet made', async () => {
    await connectedAccount();
    await client.newAccount({ usdc: '0' });
    expect(keys).toHaveLength(2);
    const answers = JSON.stringify([
      await client.state(),
      await client.requests(),
      await client.calls(),
      await client.events(0),
    ]);
    for (const key of keys) {
      expect(answers.toLowerCase()).not.toContain(key.toLowerCase());
      expect(answers.toLowerCase()).not.toContain(key.slice(2).toLowerCase());
    }
  });
});

describe('reset', () => {
  test('starts a new generation: reverts the fork, stops every impersonation, and clears accounts, requests and screening', async () => {
    const address = await connectedAccount();
    const pending = client.walletRpc(ORIGIN, 'personal_sign', ['0x00', address]);
    const request = await client.waitForRequest({ method: 'personal_sign' });
    const { generation } = await client.reset();
    expect(generation).toBe(1);
    expect(await pending).toEqual({ error: { code: 4900, message: 'harness: the wallet was reset' } });
    await expect(client.approve(request.id)).rejects.toThrow('404');
    expect(
      node.calls.filter((call) => call.method === 'anvil_stopImpersonatingAccount').map((call) => call.params)
    ).toEqual([[address.toLowerCase()]]);
    expect(node.calls.filter((call) => call.method === 'evm_revert').map((call) => call.params)).toEqual([['0x1']]);
    expect(screening.resets).toBe(1);
    const state = await client.state();
    expect(state).toEqual(
      expect.objectContaining({
        generation: 1,
        chainId: 1,
        knownChains: [1],
        permittedOrigin: null,
        selected: [],
        accounts: [],
      })
    );
    // The old account is no longer a harness account, so nothing can be sent from it.
    await expect(client.forkSend({ from: address, to: address })).rejects.toThrow('400');
  });

  test('a long poll for events or an outcome ends at a reset', async () => {
    const address = await connectedAccount();
    const { cursor } = await client.events();
    const waiting = client.events(cursor);
    const signing = client.walletRpc(ORIGIN, 'personal_sign', ['0x00', address]);
    await client.waitForRequest({ method: 'personal_sign' });
    const started = Date.now();
    await client.reset();
    await waiting;
    expect(await signing).toEqual({ error: expect.objectContaining({ code: 4900 }) });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

test('a request record holds what tests assert', async () => {
  const address = await connectedAccount();
  void client.walletRpc(ORIGIN, 'eth_sendTransaction', [{ from: address, to: address }]);
  const request: WalletRequest = await client.waitForRequest({ method: 'eth_sendTransaction' });
  expect(request).toEqual(
    expect.objectContaining({
      method: 'eth_sendTransaction',
      origin: ORIGIN,
      chainIdAtRequest: 1,
      selectedAccount: address,
      status: 'pending',
      generation: 0,
    })
  );
  expect(screening.behaviours.get(address.toLowerCase())).toBe('allowed');
  await client.reject(request.id);
});
