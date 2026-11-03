/**
 * @jest-environment node
 */
// The parts of COM-289's fork runner that the harness copies (see fork.ts), with the cases that apply here,
// and the `eth_getLogs` addition with its check of a private upstream's answer.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { server as mswServer } from '../../../handlers/server';
import {
  ALWAYS_LOGGED_METHODS,
  isCacheAnvil,
  promoteSafely,
  startCacheableProxy,
  anvilCacheFile,
  checkCacheRoot,
  createRedactor,
  failedToStartOnUpstream,
  forkCacheRoot,
  forkCacheState,
  isBlockHeader,
  isLogArray,
  loadForkCache,
  MAX_RELAYED_LOGS,
  methodsBlockingPromotion,
  promoteForkCache,
  PUBLIC_ENDPOINTS,
  recordLoggedMethods,
  relayed,
  rpc,
  sharedCacheFile,
  startFork,
  startUpstreamProxy,
  stopChild,
  UPSTREAM_METHODS,
  upstreamEndpoints,
  withheldMessage,
  zstd,
} from '../fork';
import { startFakeNode, type FakeNode } from '../testing/testServers';

beforeAll(() => mswServer.close());

const CANARY = 'sk3yC4n4ryValue0123456789';
const LOG = {
  address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
  data: '0x00',
  blockNumber: '0x1',
  transactionHash: `0x${'aa'.repeat(32)}`,
  transactionIndex: '0x0',
  blockHash: `0x${'bb'.repeat(32)}`,
  logIndex: '0x0',
  removed: false,
};

describe('upstream endpoints', () => {
  test('without BROWSER_FORK_RPC_URL, the public endpoints in order, with nothing to redact', () => {
    expect(upstreamEndpoints({}).map((endpoint) => endpoint.url)).toEqual(PUBLIC_ENDPOINTS);
    expect(upstreamEndpoints({}).every((endpoint) => !endpoint.isPrivate && endpoint.secretPatterns.length === 0)).toBe(
      true
    );
  });

  test('a private URL is labelled without the URL, and its key-like parts are redacted in every form', () => {
    const url = `https://rpc.example.com/v2/${CANARY}?apikey=${CANARY}`;
    const [endpoint] = upstreamEndpoints({ BROWSER_FORK_RPC_URL: url });
    expect(endpoint.label).toBe('BROWSER_FORK_RPC_URL (private, not printed)');
    expect(endpoint.label).not.toContain(CANARY);
    const { redact, printable } = createRedactor(endpoint.secretPatterns);
    for (const echo of [CANARY, encodeURIComponent(CANARY), CANARY.toUpperCase(), JSON.stringify(url), url]) {
      expect(redact(`error: ${echo}`)).not.toContain(CANARY);
      expect(redact(`error: ${echo}`).toLowerCase()).not.toContain(CANARY.toLowerCase());
    }
    expect(printable(`ordinary text v2 eth ${CANARY}`)).toBe('ordinary text v2 eth <redacted>');
  });

  test('refuses a private URL with a user name, a password, or a scheme other than HTTP(S)', () => {
    expect(() => upstreamEndpoints({ BROWSER_FORK_RPC_URL: `https://user:${CANARY}@rpc.example.com` })).toThrow(
      'user name or password'
    );
    expect(() => upstreamEndpoints({ BROWSER_FORK_RPC_URL: 'wss://rpc.example.com' })).toThrow('HTTP(S)');
    expect(() => upstreamEndpoints({ BROWSER_FORK_RPC_URL: 'not a url' })).toThrow('not a URL');
  });

  test('a line redactor redacts a key that a pipe splits across two chunks', () => {
    const [endpoint] = upstreamEndpoints({ BROWSER_FORK_RPC_URL: `https://rpc.example.com/${CANARY}` });
    const lines: string[] = [];
    const redactor = createRedactor(endpoint.secretPatterns).lineRedactor((text) => lines.push(text));
    redactor.write(`first ${CANARY.slice(0, 10)}`);
    redactor.write(`${CANARY.slice(10)} last\n`);
    redactor.end();
    expect(lines.join('')).toBe('first <redacted> last\n');
  });

  test('literal secrets, such as the control token, are redacted as written', () => {
    expect(createRedactor([], ['f'.repeat(64)]).redact(`token ${'f'.repeat(64)}.`)).toBe('token <redacted>.');
  });
});

describe('a JSON-RPC call', () => {
  let node: FakeNode;
  beforeAll(async () => {
    node = await startFakeNode({
      eth_chainId: () => '0x1',
      eth_fails: () => {
        throw new Error(`upstream said ${CANARY}`);
      },
    });
  });
  afterAll(() => node.close());

  test("names a private endpoint's error by its code alone, never by its text", async () => {
    await expect(rpc(node.url, 'eth_fails', [], { isPrivate: true })).rejects.toThrow(
      'eth_fails: HTTP 200, a JSON-RPC error with code -32000'
    );
    await expect(rpc(node.url, 'eth_fails', [], { isPrivate: true })).rejects.not.toThrow(CANARY);
    await expect(rpc(node.url, 'eth_fails')).rejects.toThrow(CANARY);
    expect(await rpc(node.url, 'eth_chainId')).toBe('0x1');
  });

  test('refuses to follow a redirect', async () => {
    const redirecting = http.createServer((_, response) => {
      response.writeHead(307, { location: 'http://192.0.2.1/' });
      response.end();
    });
    await new Promise<void>((resolve) => redirecting.listen(0, '127.0.0.1', () => resolve()));
    const port = (redirecting.address() as { port: number }).port;
    await expect(rpc(`http://127.0.0.1:${port}`, 'eth_chainId')).rejects.toThrow();
    redirecting.close();
  });
});

describe("the check of a private upstream's answers", () => {
  const printable = (text: unknown) => String(text);
  const methodOf = (method: string) => () => method;
  const relay = (method: string, body: unknown, isPrivate = true) =>
    relayed(200, 'application/json', Buffer.from(JSON.stringify(body)), {
      isPrivate,
      printable,
      methodOf: methodOf(method),
    });

  test('relays an eth_getLogs result of no logs, and of logs, unchanged', () => {
    expect(JSON.parse(relay('eth_getLogs', { jsonrpc: '2.0', id: 1, result: [] }).body.toString())).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: [],
    });
    expect(
      JSON.parse(relay('eth_getLogs', { jsonrpc: '2.0', id: 1, result: [LOG, LOG] }).body.toString()).result
    ).toEqual([LOG, LOG]);
  });

  test('withholds a malformed eth_getLogs result, and never relays its text', () => {
    for (const result of [`key ${CANARY}`, [{ ...LOG, data: `text ${CANARY}` }], [LOG, 7], { logs: [] }]) {
      const answer = relay('eth_getLogs', { jsonrpc: '2.0', id: 1, result });
      expect(answer.body.toString()).not.toContain(CANARY);
      expect(JSON.parse(answer.body.toString()).error.code).toBe(-32603);
      expect(answer.errors).toEqual(['a malformed eth_getLogs result']);
    }
  });

  test('bounds the logs it relays', () => {
    expect(isLogArray(Array(MAX_RELAYED_LOGS).fill(LOG))).toBe(true);
    expect(isLogArray(Array(MAX_RELAYED_LOGS + 1).fill(LOG))).toBe(false);
  });

  test("relays a private upstream's error with its code and anvil's retry phrases only", () => {
    const answer = relay('eth_getLogs', {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32005, message: `rate limit ${CANARY}`, data: CANARY },
    });
    expect(answer.body.toString()).not.toContain(CANARY);
    expect(JSON.parse(answer.body.toString()).error).toEqual({ code: -32005, message: withheldMessage('rate limit') });
  });

  test("relays an HTTP error's status without its body, and a public endpoint's answer unchanged", () => {
    const failed = relayed(500, 'text/plain', Buffer.from(CANARY), {
      isPrivate: true,
      printable,
      methodOf: methodOf('eth_getLogs'),
    });
    expect(failed.body.length).toBe(0);
    const body = { jsonrpc: '2.0', id: 1, result: `anything ${CANARY}` };
    expect(relay('eth_getLogs', body, false).body.toString()).toBe(JSON.stringify(body));
  });
});

describe('the upstream proxy', () => {
  let upstream: FakeNode;
  let proxy: Awaited<ReturnType<typeof startUpstreamProxy>>;
  beforeEach(async () => {
    upstream = await startFakeNode({ eth_chainId: () => '0x1', eth_getLogs: () => [LOG] });
    proxy = await startUpstreamProxy(
      { label: 'test', url: upstream.url, isPrivate: false, secretPatterns: [] },
      { printable: String }
    );
  });
  afterEach(async () => {
    proxy.server.closeAllConnections();
    await new Promise((resolve) => proxy.server.close(resolve));
    await upstream.close();
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(proxy.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  test('forwards reads, eth_getLogs included, and refuses every write, alone or in a batch, sending nothing upstream', async () => {
    expect(UPSTREAM_METHODS.has('eth_getLogs')).toBe(true);
    const bounded = { address: LOG.address, fromBlock: '0x1907a00', toBlock: '0x1907a18' };
    const logs = await (await post({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [bounded] })).json();
    expect(logs.result).toEqual([LOG]);
    for (const method of [
      'eth_sendRawTransaction',
      'eth_sendTransaction',
      'eth_sign',
      'personal_sign',
      'anvil_setBalance',
      'eth_call',
    ]) {
      expect((await post({ jsonrpc: '2.0', id: 1, method, params: [] })).status).toBe(403);
      expect(
        (
          await post([
            { jsonrpc: '2.0', id: 1, method: 'eth_chainId' },
            { jsonrpc: '2.0', id: 2, method },
          ])
        ).status
      ).toBe(403);
    }
    expect(upstream.calls.map((call) => call.method)).toEqual(['eth_getLogs']);
  });

  test('forwards eth_getLogs only by block hash, or for named addresses over a bounded range of block numbers', async () => {
    const refused = [
      [{}],
      [{ fromBlock: '0x0', toBlock: '0x1907a17' }],
      [{ address: LOG.address, fromBlock: '0x0', toBlock: '0x1907a17' }],
      [{ address: LOG.address, fromBlock: 'earliest', toBlock: 'latest' }],
      [{ address: LOG.address, fromBlock: '0x10', toBlock: '0x1' }],
    ];
    for (const params of refused) {
      expect((await post({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params })).status).toBe(403);
    }
    expect(
      (await post({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ blockHash: LOG.blockHash }] })).status
    ).toBe(200);
    expect(upstream.calls.map((call) => call.method)).toEqual(['eth_getLogs']);
    expect(proxy.stats.refused.get('<an unbounded eth_getLogs>')).toBe(refused.length);
  });

  test('forwards only the method it checked, rebuilt from the four JSON-RPC members', async () => {
    await fetch(proxy.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","Method":"eth_sendRawTransaction","params":[]}',
    });
    expect(upstream.calls.map((call) => call.method)).toEqual(['eth_chainId']);
  });

  test('refuses an Origin header, another Host and a body that is not JSON', async () => {
    expect(
      (await post({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, { origin: 'http://127.0.0.1:1' })).status
    ).toBe(403);
    expect(
      (await fetch(proxy.url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status
    ).toBe(415);
    expect((await fetch(proxy.url, { method: 'GET' })).status).toBe(405);
    expect(upstream.calls).toEqual([]);
  });
});

describe('start-up', () => {
  test('a fork that could not start failed on the upstream only when the proxy saw it fail and anvil names a fetch', () => {
    const stats = { failures: 1, errorAnswers: 0, pending: 0, lastFailureAt: Date.now() };
    expect(failedToStartOnUpstream({ stats, output: 'failed to create genesis\nfailed to get account for 0x00' })).toBe(
      true
    );
    expect(
      failedToStartOnUpstream({ stats: { ...stats, failures: 0 }, output: 'failed to get account for 0x00' })
    ).toBe(false);
    expect(failedToStartOnUpstream({ stats, output: 'Address already in use' })).toBe(false);
  });

  test('a block header needs a 32-byte hash and a hex timestamp', () => {
    expect(isBlockHeader({ hash: `0x${'ab'.repeat(32)}`, timestamp: '0x6a000000' })).toBe(true);
    expect(isBlockHeader({ hash: `0x${CANARY}`, timestamp: '0x1' })).toBe(false);
  });
});

describe('the fork cache root', () => {
  const HOME_DIRECTORY = '/home/tester';

  test('is ~/.cache/cf-browser-fork by default, and under XDG_CACHE_HOME when that is absolute', () => {
    expect(forkCacheRoot({}, 'pinned', HOME_DIRECTORY)).toBe('/home/tester/.cache/cf-browser-fork');
    expect(forkCacheRoot({ BROWSER_FORK_CACHE: 'on' }, 'pinned', HOME_DIRECTORY)).toBe(
      '/home/tester/.cache/cf-browser-fork'
    );
    expect(forkCacheRoot({ XDG_CACHE_HOME: '/var/cache/tester' }, 'pinned', HOME_DIRECTORY)).toBe(
      '/var/cache/tester/cf-browser-fork'
    );
    // The XDG specification has a relative path ignored.
    expect(forkCacheRoot({ XDG_CACHE_HOME: 'relative' }, 'pinned', HOME_DIRECTORY)).toBe(
      '/home/tester/.cache/cf-browser-fork'
    );
  });

  test('is BROWSER_FORK_CACHE_DIR when set, which must be absolute', () => {
    expect(
      forkCacheRoot(
        { BROWSER_FORK_CACHE_DIR: '/data/fork-cache', XDG_CACHE_HOME: '/var/cache/tester' },
        'pinned',
        HOME_DIRECTORY
      )
    ).toBe('/data/fork-cache');
    expect(() => forkCacheRoot({ BROWSER_FORK_CACHE_DIR: 'fork-cache' }, 'pinned', HOME_DIRECTORY)).toThrow(
      'BROWSER_FORK_CACHE_DIR must be an absolute path.'
    );
  });

  test('is off for a fork of the latest block and with BROWSER_FORK_CACHE=off', () => {
    expect(forkCacheRoot({}, 'latest', HOME_DIRECTORY)).toBeUndefined();
    expect(forkCacheRoot({ BROWSER_FORK_CACHE: 'off' }, 'pinned', HOME_DIRECTORY)).toBeUndefined();
    expect(
      forkCacheRoot({ BROWSER_FORK_CACHE: 'off', BROWSER_FORK_CACHE_DIR: '/data/fork-cache' }, 'pinned', HOME_DIRECTORY)
    ).toBeUndefined();
  });

  test('refuses any other BROWSER_FORK_CACHE value, and a relative override, whatever the block', () => {
    for (const block of ['pinned', 'latest'] as const) {
      expect(() => forkCacheRoot({ BROWSER_FORK_CACHE: 'yes' }, block, HOME_DIRECTORY)).toThrow(
        "BROWSER_FORK_CACHE must be 'on' (the default) or 'off'."
      );
      expect(() => forkCacheRoot({ BROWSER_FORK_CACHE_DIR: './cache' }, block, HOME_DIRECTORY)).toThrow(
        'BROWSER_FORK_CACHE_DIR must be an absolute path.'
      );
    }
  });

  test("keeps each trust class's cache apart, and names anvil's cache file for the block and the fork URL", () => {
    expect(sharedCacheFile('/data/fork-cache', 'public', 26244888)).toBe(
      '/data/fork-cache/public/mainnet-26244888.json'
    );
    expect(sharedCacheFile('/data/fork-cache', 'private', 26244888)).toBe(
      '/data/fork-cache/private/mainnet-26244888.json'
    );
    // anvil 1.9.0 names the file storage-<keccak256 of the fork URL>.json; this one was read off a run.
    expect(anvilCacheFile('/run/anvil-home', 26244888, 'http://127.0.0.1:18695/')).toBe(
      '/run/anvil-home/.foundry/cache/rpc/mainnet/26244888/storage-300d54cc98c2d6920f9dc89420847558b65203d0c30a3c149b2bb59ab6c25985.json'
    );
  });
});

describe('the shared fork cache', () => {
  const BLOCK = 26244888;
  const FORK_URL = 'http://127.0.0.1:18546/';
  /** A cache file as anvil 1.9.0 writes one, zstd-compressed JSON, for `block`, holding `balance` for one account. */
  const cacheJson = (block: number, balance = '0x1') =>
    zstd.zstdCompressSync(
      JSON.stringify({
        meta: { block_env: { number: `0x${block.toString(16)}` }, hosts: ['127.0.0.1'], source_id: '0x00' },
        accounts: { '0x1111111111111111111111111111111111111111': { balance, nonce: 0 } },
        storage: {},
        block_hashes: {},
      })
    );
  let scratch: string;
  let root: string;
  let shared: string;
  let runHome: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-fork-cache-test-'));
    root = path.join(scratch, 'cache', 'cf-browser-fork');
    shared = sharedCacheFile(root, 'public', BLOCK);
    runHome = path.join(scratch, 'private', 'anvil-home');
  });

  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

  const writeShared = (content: string | Buffer) => {
    fs.mkdirSync(path.dirname(shared), { recursive: true, mode: 0o700 });
    fs.writeFileSync(shared, content);
  };
  const writeRunCache = (content: Buffer) => {
    fs.mkdirSync(path.dirname(anvilCacheFile(runHome, BLOCK, FORK_URL)), { recursive: true });
    fs.writeFileSync(anvilCacheFile(runHome, BLOCK, FORK_URL), content);
  };

  describe('the root check', () => {
    test('creates a missing root, and its parents, with mode 0700', () => {
      checkCacheRoot(root);
      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.dirname(root)).mode & 0o777).toBe(0o700);
    });

    test('accepts an existing root of mode 0700', () => {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      expect(() => checkCacheRoot(root)).not.toThrow();
    });

    test('refuses a root that others can read or write, and does not change its mode', () => {
      fs.mkdirSync(root, { recursive: true });
      fs.chmodSync(root, 0o755);
      expect(() => checkCacheRoot(root)).toThrow(/must be a directory you own, with mode 0700/);
      expect(fs.statSync(root).mode & 0o777).toBe(0o755);
    });

    test('refuses a symbolic link and a file', () => {
      const target = path.join(scratch, 'elsewhere');
      fs.mkdirSync(target, { mode: 0o700 });
      fs.mkdirSync(path.dirname(root), { recursive: true });
      fs.symlinkSync(target, root);
      expect(() => checkCacheRoot(root)).toThrow(/must be a directory you own, with mode 0700/);
      const file = path.join(scratch, 'file');
      fs.writeFileSync(file, '');
      expect(() => checkCacheRoot(file)).toThrow(/must be a directory you own, with mode 0700/);
    });
  });

  describe('the root check of parent directories', () => {
    test('refuses a root inside a directory that others can write without the sticky bit', () => {
      const open = path.join(scratch, 'open');
      fs.mkdirSync(open, { mode: 0o700 });
      fs.chmodSync(open, 0o777);
      expect(() => checkCacheRoot(path.join(open, 'cf-browser-fork'))).toThrow(
        /is inside .*open, which another user can change/
      );
    });

    test('accepts a root inside a directory that others can write when it has the sticky bit', () => {
      const shared = path.join(scratch, 'shared');
      fs.mkdirSync(shared, { mode: 0o700 });
      fs.chmodSync(shared, 0o1777);
      expect(() => checkCacheRoot(path.join(shared, 'cf-browser-fork'))).not.toThrow();
    });
  });

  describe('the cache state', () => {
    test('is cold without a file, with a file anvil cannot use, and with a symbolic link', () => {
      expect(forkCacheState(shared, BLOCK)).toBe('cold');
      writeShared('{"meta":{trunc');
      expect(forkCacheState(shared, BLOCK)).toBe('cold');
      // Uncompressed JSON, as anvil 1.2.3 wrote it.
      writeShared(JSON.stringify({ meta: { block_env: { number: '0x1907718' } } }));
      expect(forkCacheState(shared, BLOCK)).toBe('cold');
      writeShared(cacheJson(BLOCK + 1));
      expect(forkCacheState(shared, BLOCK)).toBe('cold');
      const target = path.join(scratch, 'target.json');
      fs.writeFileSync(target, cacheJson(BLOCK));
      fs.rmSync(shared);
      fs.symlinkSync(target, shared);
      expect(forkCacheState(shared, BLOCK)).toBe('cold');
    });

    test('is warm with a file of the block', () => {
      writeShared(cacheJson(BLOCK));
      expect(forkCacheState(shared, BLOCK)).toBe('warm');
    });
  });

  describe('loading into the run', () => {
    test("a warm cache is copied to anvil's cache file in the run's home, which is otherwise emptied", () => {
      writeShared(cacheJson(BLOCK));
      fs.mkdirSync(runHome, { recursive: true });
      fs.writeFileSync(path.join(runHome, 'left-over'), '');
      expect(loadForkCache({ sharedFile: shared, runHome, blockNumber: BLOCK, forkUrl: FORK_URL })).toBe('warm');
      expect(fs.readFileSync(anvilCacheFile(runHome, BLOCK, FORK_URL))).toEqual(cacheJson(BLOCK));
      expect(fs.existsSync(path.join(runHome, 'left-over'))).toBe(false);
      expect(fs.statSync(runHome).mode & 0o777).toBe(0o700);
    });

    test("a cold cache leaves the run's home empty", () => {
      writeShared('not json');
      expect(loadForkCache({ sharedFile: shared, runHome, blockNumber: BLOCK, forkUrl: FORK_URL })).toBe('cold');
      expect(fs.readdirSync(runHome)).toEqual([]);
    });
  });

  describe('promotion after the run', () => {
    const CLEAN_RUN = {
      methods: ['eth_call', ...ALWAYS_LOGGED_METHODS],
      hasExitedCleanly: true,
      anvilVersion: 'anvil Version: 1.9.0-stable (6056c5845d 2026-11-02T20:16:54.701302000Z)',
      forkUrl: FORK_URL,
    };

    test('methods that cannot change where the fork reads, and the harness methods, allow it', () => {
      expect(
        methodsBlockingPromotion([
          'eth_call',
          'eth_getStorageAt',
          'eth_networkId',
          'web3_clientVersion',
          'anvil_metadata',
          'anvil_reset',
          'anvil_dropTransaction',
          'anvil_setBalance',
          'anvil_setStorageAt',
          'anvil_impersonateAccount',
          'anvil_stopImpersonatingAccount',
          'evm_setNextBlockTimestamp',
        ])
      ).toEqual([]);
    });

    test('any other method blocks it, such as a new upstream URL, turning logging off, or loading state', () => {
      // anvil logs no call after anvil_setLoggingEnabled(false), so that call alone must block promotion.
      expect(
        methodsBlockingPromotion([
          'eth_call',
          'anvil_setRpcUrl',
          'anvil_setLoggingEnabled',
          'anvil_loadState',
          'evm_revert',
          'debug_traceCall',
        ])
      ).toEqual(['anvil_setRpcUrl', 'anvil_setLoggingEnabled', 'anvil_loadState', 'evm_revert', 'debug_traceCall']);
    });

    test("a clean stop with no blocking method replaces the shared file with the run's", () => {
      writeShared(cacheJson(BLOCK, '0x1'));
      writeRunCache(cacheJson(BLOCK, '0x2'));
      const result = promoteForkCache({
        runHome,
        sharedFile: shared,
        blockNumber: BLOCK,
        ...CLEAN_RUN,
      });
      expect(result).toEqual({ isPromoted: true, reason: 'promoted' });
      expect(fs.readFileSync(shared)).toEqual(cacheJson(BLOCK, '0x2'));
      expect(fs.readdirSync(path.dirname(shared))).toEqual([path.basename(shared)]);
    });

    test('after a new upstream URL, an unclean stop, an unread log, another anvil, or a file of another block, the shared file stays as it was', () => {
      writeShared(cacheJson(BLOCK, '0x1'));
      writeRunCache(cacheJson(BLOCK, '0x999'));
      const promote = (overrides: object) =>
        promoteForkCache({
          runHome,
          sharedFile: shared,
          blockNumber: BLOCK,
          ...CLEAN_RUN,
          ...overrides,
        });
      expect(promote({ methods: [...CLEAN_RUN.methods, 'anvil_reset', 'anvil_setRpcUrl'] })).toEqual({
        isPromoted: false,
        reason: 'the fork was sent anvil_setRpcUrl',
      });
      const many = ['anvil_setRpcUrl', 'anvil_a', 'anvil_b', 'anvil_c', 'anvil_d', 'anvil_e', 'anvil_f'];
      expect(promote({ methods: [...CLEAN_RUN.methods, ...many] })).toEqual({
        isPromoted: false,
        reason: 'the fork was sent anvil_setRpcUrl, anvil_a, anvil_b, anvil_c, anvil_d and 2 more',
      });
      // A log that shows none of the harness's own calls was not read as expected, as with another log format.
      expect(promote({ methods: [] })).toEqual({
        isPromoted: false,
        reason: "anvil's log does not show the calls the harness makes",
      });
      for (const anvilVersion of ['anvil Version: 1.2.3-stable', 'anvil Version: 1.9.1-stable']) {
        expect(promote({ anvilVersion })).toEqual({
          isPromoted: false,
          reason: 'the cache is promoted only from anvil 1.9.0',
        });
      }
      expect(promote({ hasExitedCleanly: false })).toEqual({
        isPromoted: false,
        reason: 'anvil did not exit cleanly',
      });
      writeRunCache(cacheJson(BLOCK + 1, '0x999'));
      expect(promote({})).toEqual({ isPromoted: false, reason: 'anvil wrote no cache of the block' });
      expect(fs.readFileSync(shared)).toEqual(cacheJson(BLOCK, '0x1'));
    });

    test('removes its new file and throws when the rename fails', () => {
      // A directory with an entry at the shared path cannot be replaced by a file.
      fs.mkdirSync(path.join(shared, 'entry'), { recursive: true });
      writeRunCache(cacheJson(BLOCK));
      expect(() => promoteForkCache({ runHome, sharedFile: shared, blockNumber: BLOCK, ...CLEAN_RUN })).toThrow();
      expect(fs.readdirSync(path.dirname(shared))).toEqual([path.basename(shared)]);
    });

    test('replaces a symbolic link at the shared path, and never writes through it', () => {
      const target = path.join(scratch, 'target.txt');
      fs.writeFileSync(target, 'unchanged');
      fs.mkdirSync(path.dirname(shared), { recursive: true, mode: 0o700 });
      fs.symlinkSync(target, shared);
      writeRunCache(cacheJson(BLOCK));
      expect(promoteForkCache({ runHome, sharedFile: shared, blockNumber: BLOCK, ...CLEAN_RUN }).isPromoted).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe('unchanged');
      expect(fs.lstatSync(shared).isSymbolicLink()).toBe(false);
    });
  });
});

describe("anvil's start-up arguments and home", () => {
  const TARGET = { number: 26244888, hash: `0x${'ab'.repeat(32)}`, timestamp: 1, mode: 'pinned' } as const;
  let scratch: string;
  let fakeAnvil: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-fork-cache-test-'));
    // Prints its arguments and HOME as JSON, then the line the harness reads the port from, and waits.
    fakeAnvil = path.join(scratch, 'anvil');
    fs.writeFileSync(
      fakeAnvil,
      [
        '#!/usr/bin/env node',
        'console.log(JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME }));',
        "console.log('Listening on 127.0.0.1:1');",
        'setInterval(() => undefined, 1000);',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
  });

  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

  async function startedWith(cacheHome: string | undefined) {
    let output = '';
    const fork = await startFork({
      anvil: fakeAnvil,
      upstreamUrl: 'http://127.0.0.1:9/',
      target: TARGET,
      log: (text) => (output += text),
      redactor: createRedactor([]),
      onChild: () => undefined,
      cacheHome,
    });
    await stopChild(fork.child);
    const started = JSON.parse(output.split('\n').find((line) => line.startsWith('{')) ?? '{}');
    return started as { args: string[]; home: string };
  }

  test('with a cache home, anvil caches storage, with HOME set to the cache home', async () => {
    const cacheHome = path.join(scratch, 'private', 'anvil-home');
    const { args, home } = await startedWith(cacheHome);
    expect(args).not.toContain('--no-storage-caching');
    expect(args).toEqual(expect.arrayContaining(['--fork-block-number', '26244888', '--accounts', '0']));
    expect(home).toBe(cacheHome);
  });

  test("without a cache home, anvil caches nothing, and HOME stays the runner's", async () => {
    const { args, home } = await startedWith(undefined);
    expect(args).toContain('--no-storage-caching');
    expect(home).toBe(process.env.HOME);
  });
});

describe('the methods anvil logs', () => {
  test('are the lines that are a method name alone', () => {
    const methods = new Set<string>();
    recordLoggedMethods('eth_call\nanvil_reset\n    Transaction: 0xabc\nListening on 127.0.0.1:1\n', methods);
    recordLoggedMethods('web3_clientVersion\n', methods);
    expect([...methods]).toEqual(['eth_call', 'anvil_reset', 'web3_clientVersion']);
  });
});

describe('the fixed proxy port', () => {
  test('the upstream proxy listens on the port it is given, and a second proxy there fails with EADDRINUSE', async () => {
    const endpoint = { label: 'test', url: 'http://127.0.0.1:9/', isPrivate: false, secretPatterns: [] };
    const first = await startUpstreamProxy(endpoint, { printable: String });
    const { port } = first.server.address() as { port: number };
    first.server.close();
    await new Promise((resolve) => first.server.once('close', resolve));
    const fixed = await startUpstreamProxy(endpoint, { printable: String, port });
    expect(fixed.url).toBe(`http://127.0.0.1:${port}/`);
    await expect(startUpstreamProxy(endpoint, { printable: String, port })).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    fixed.server.close();
  });
});

describe("anvil 1.9.0's retry rule", () => {
  test("a private upstream's error keeps the phrase alloy 2.5.0 retries on for concurrent requests", () => {
    expect(withheldMessage('maximum number of concurrent requests reached for key sk-123')).toBe(
      "maximum number of concurrent requests (the rest of the private upstream's message is withheld)"
    );
  });
});

describe('the cacheable proxy', () => {
  const endpoint = { label: 'test', url: 'http://127.0.0.1:9/', isPrivate: false, secretPatterns: [] };
  const freePort = async () => {
    const probe = await startUpstreamProxy(endpoint, { printable: String });
    const { port } = probe.server.address() as { port: number };
    await new Promise((resolve) => probe.server.close(resolve));
    return port;
  };

  test('without a cache port, listens on a free port and says nothing', async () => {
    const { proxy, offReason } = await startCacheableProxy(endpoint, { printable: String });
    expect(offReason).toBeUndefined();
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    proxy.server.close();
  });

  test('with a cache port, listens there; when it is taken, listens on a free port and says why', async () => {
    const cachePort = await freePort();
    const first = await startCacheableProxy(endpoint, { printable: String, cachePort });
    expect(first.offReason).toBeUndefined();
    expect(first.proxy.url).toBe(`http://127.0.0.1:${cachePort}/`);
    const second = await startCacheableProxy(endpoint, { printable: String, cachePort });
    expect(second.offReason).toBe(`port ${cachePort} is in use`);
    expect(second.proxy.url).not.toBe(`http://127.0.0.1:${cachePort}/`);
    first.proxy.server.close();
    second.proxy.server.close();
  });
});

describe('the anvil that can read the cache', () => {
  test('is 1.9.0, by its --version line', () => {
    expect(isCacheAnvil('anvil Version: 1.9.0-stable (6056c5845d 2026-11-02T20:16:54.701302000Z)')).toBe(true);
    expect(isCacheAnvil('anvil Version: 1.9.0')).toBe(true);
    for (const version of [
      'anvil Version: 1.2.3-stable',
      'anvil Version: 1.9.01',
      'anvil Version: 1.10.0',
      'forge 1.9.0',
    ]) {
      expect(isCacheAnvil(version)).toBe(false);
    }
  });
});

describe('promotion at teardown', () => {
  const BLOCK = 26244888;
  const FORK_URL = 'http://127.0.0.1:18546/';
  let scratch: string;
  let root: string;
  let runHome: string;
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-fork-cache-test-'));
    root = path.join(scratch, 'root');
    runHome = path.join(scratch, 'private', 'anvil-home');
    const runFile = anvilCacheFile(runHome, BLOCK, FORK_URL);
    fs.mkdirSync(path.dirname(runFile), { recursive: true });
    fs.writeFileSync(
      runFile,
      zstd.zstdCompressSync(JSON.stringify({ meta: { block_env: { number: `0x${BLOCK.toString(16)}` } } }))
    );
  });
  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

  const promote = () =>
    promoteSafely({
      cacheRoot: root,
      runHome,
      sharedFile: sharedCacheFile(root, 'public', BLOCK),
      blockNumber: BLOCK,
      forkUrl: FORK_URL,
      methods: ALWAYS_LOGGED_METHODS,
      hasExitedCleanly: true,
      anvilVersion: 'anvil Version: 1.9.0-stable',
    });

  test('checks the root again, and names only that it failed', () => {
    fs.mkdirSync(root, { recursive: true });
    fs.chmodSync(root, 0o755);
    expect(promote()).toEqual({ isPromoted: false, reason: 'the cache root failed its check' });
  });

  test("names a file system error by its code alone, not by its message's paths", () => {
    fs.mkdirSync(path.join(sharedCacheFile(root, 'public', BLOCK), 'entry'), { recursive: true });
    fs.chmodSync(root, 0o700);
    const result = promote();
    expect(result.isPromoted).toBe(false);
    expect(result.reason).toMatch(/^the promotion failed \(E[A-Z]+\)$/);
  });

  test('promotes when the root passes', () => {
    expect(promote()).toEqual({ isPromoted: true, reason: 'promoted' });
  });
});
