/**
 * @jest-environment node
 */
// The parts of COM-289's fork runner that the harness copies (see fork.ts), with the cases that apply here,
// and the `eth_getLogs` addition with its check of a private upstream's answer.
import http from 'node:http';

import { server as mswServer } from '../../../handlers/server';
import {
  createRedactor,
  failedToStartOnUpstream,
  isBlockHeader,
  isLogArray,
  MAX_RELAYED_LOGS,
  PUBLIC_ENDPOINTS,
  relayed,
  rpc,
  startUpstreamProxy,
  UPSTREAM_METHODS,
  upstreamEndpoints,
  withheldMessage,
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
