/**
 * @jest-environment node
 */
// The app's HTTPS RPC proxy: reads to the fork on `/ethereum-mainnet` only, every write and administrative
// method refused on every route, and its Host, Origin, method, type and size checks.
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import { server as mswServer } from '../../../handlers/server';
import { LANE_HEADER } from '../laneHeader';
import { APP_READ_METHODS, startRpcProxy, type RpcProxy } from '../rpcProxy';
import { startFakeNode, type FakeNode } from '../testing/testServers';
import { makeCertificate, type Certificate } from '../tls';

const APP = 'http://127.0.0.1:5999';
const WRITES = [
  'eth_sendRawTransaction',
  'eth_sendTransaction',
  'eth_sign',
  'eth_signTypedData_v4',
  'personal_sign',
  'wallet_addEthereumChain',
  'anvil_setBalance',
  'anvil_impersonateAccount',
  'evm_snapshot',
  'evm_revert',
  'anvil_reset',
  'anvil_setRpcUrl',
  'hardhat_setBalance',
  'debug_traceTransaction',
  'txpool_content',
  'admin_peers',
  'eth_accounts',
];

let directory: string;
let certificate: Certificate;
let node: FakeNode;
/** The fork of lane 1, which the proxy has not started at first. */
let otherNode: FakeNode;
let lanes: (string | undefined)[];
let proxy: RpcProxy;
const origins = new Set([APP]);

beforeAll(async () => {
  mswServer.close();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-test-'));
  certificate = makeCertificate(directory);
});
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

beforeEach(async () => {
  node = await startFakeNode({ eth_chainId: () => '0x1', eth_call: () => '0x01' });
  otherNode = await startFakeNode({ eth_chainId: () => '0x1', eth_call: () => '0x02' });
  lanes = [node.url, undefined, undefined];
  proxy = await startRpcProxy({
    tls: certificate,
    forkUrl: (lane) => lanes[lane],
    laneCount: 3,
    allowedOrigins: origins,
  });
});
afterEach(async () => {
  await proxy.close();
  await node.close();
  await otherNode.close();
});

/** A request to the proxy that trusts only the harness certificate, with the headers given. */
function send(
  route: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = 'POST'
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: '127.0.0.1',
        // An empty name sends no Server Name Indication (SNI), and stops Node from taking the name
        // from the Host header. Node then checks the certificate against 127.0.0.1, whatever Host
        // a test sends. Node 26 refuses an IP address as the name.
        servername: '',
        port: proxy.port,
        path: route,
        method,
        ca: certificate.cert,
        // Lane 0 unless the test names another; a value of '' leaves the header out.
        headers: Object.fromEntries(
          Object.entries({
            'content-type': 'application/json',
            host: proxy.host,
            [LANE_HEADER]: '0',
            ...headers,
          }).filter(([, value]) => value !== '')
        ),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          })
        );
      }
    );
    request.on('error', reject);
    request.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

test('the certificate names 127.0.0.1 and is trusted only as itself', () => {
  expect(certificate.spkiHash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  expect(fs.statSync(path.join(directory, 'tls-key.pem')).mode & 0o777).toBe(0o600);
});

test('forwards the app reads on /ethereum-mainnet to the fork, and counts them', async () => {
  const answer = await send(
    '/ethereum-mainnet',
    { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{}, 'latest'] },
    { origin: APP }
  );
  expect(JSON.parse(answer.body)).toEqual({ jsonrpc: '2.0', id: 1, result: '0x01' });
  expect(answer.headers['access-control-allow-origin']).toBe(APP);
  expect(proxy.stats.forwarded.get('eth_call')).toBe(1);
});

test.each(['/ethereum-mainnet', '/base-mainnet', '/arbitrum-mainnet'])(
  'refuses every write and administrative method on %s, and forwards none',
  async (route) => {
    for (const method of WRITES) {
      expect(APP_READ_METHODS.has(method)).toBe(false);
      const answer = JSON.parse((await send(route, { jsonrpc: '2.0', id: 7, method, params: [] })).body);
      expect(answer).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'harness: method refused' } });
    }
    expect(node.calls).toEqual([]);
  }
);

test('refuses a whole batch that holds a refused method, and rebuilds each forwarded call', async () => {
  const batch = JSON.parse(
    (
      await send('/ethereum-mainnet', [
        { jsonrpc: '2.0', id: 1, method: 'eth_chainId' },
        { jsonrpc: '2.0', id: 2, method: 'anvil_mine' },
      ])
    ).body
  );
  expect(batch.map((entry: { error: { code: number } }) => entry.error.code)).toEqual([-32603, -32601]);
  await send('/ethereum-mainnet', '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","Method":"anvil_mine","params":[]}');
  expect(node.calls.map((call) => call.method)).toEqual(['eth_chainId']);
});

test('answers other networks with an error, and serves no other path', async () => {
  const answer = JSON.parse((await send('/base-mainnet', { jsonrpc: '2.0', id: 1, method: 'eth_chainId' })).body);
  expect(answer.error).toEqual({ code: -32000, message: 'harness: chain not served by the harness' });
  expect((await send('/../etc/passwd', {})).status).toBe(404);
  expect((await send('/', {})).status).toBe(404);
  expect(node.calls).toEqual([]);
});

test('refuses another Host, an Origin outside the app, a method other than POST, another content type and a large body', async () => {
  expect((await send('/ethereum-mainnet', { method: 'eth_chainId' }, { host: `localhost:${proxy.port}` })).status).toBe(
    403
  );
  expect(
    (await send('/ethereum-mainnet', { method: 'eth_chainId' }, { origin: 'https://attacker.example' })).status
  ).toBe(403);
  expect((await send('/ethereum-mainnet', '', {}, 'GET')).status).toBe(405);
  expect((await send('/ethereum-mainnet', '{}', { 'content-type': 'text/plain' })).status).toBe(415);
  await expect(send('/ethereum-mainnet', `{"a":"${'x'.repeat(10 * 1024 * 1024 + 1)}"}`)).rejects.toThrow();
  const preflight = await send('/ethereum-mainnet', '', { origin: APP }, 'OPTIONS');
  expect(preflight.status).toBe(204);
  expect(preflight.headers['access-control-allow-origin']).toBe(APP);
  expect(node.calls).toEqual([]);
});

describe('fork lanes', () => {
  const call = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{}, 'latest'] };

  test('forwards each read to the fork of the lane its header names, and counts the reads by lane', async () => {
    lanes[1] = otherNode.url;
    expect(JSON.parse((await send('/ethereum-mainnet', call, { [LANE_HEADER]: '0' })).body).result).toBe('0x01');
    expect(JSON.parse((await send('/ethereum-mainnet', call, { [LANE_HEADER]: '1' })).body).result).toBe('0x02');
    expect(JSON.parse((await send('/ethereum-mainnet', call, { [LANE_HEADER]: '1' })).body).result).toBe('0x02');
    expect(node.calls).toHaveLength(1);
    expect(otherNode.calls).toHaveLength(2);
    expect(Object.fromEntries(proxy.stats.lanes)).toEqual({ '0': 1, '1': 2 });
  });

  test('refuses a read with no lane, a lane out of range or malformed, or a lane whose fork has not started', async () => {
    for (const lane of ['', '3', '-1', '01', '1.0', '0,1', 'x', '1']) {
      const answer = JSON.parse((await send('/ethereum-mainnet', call, { [LANE_HEADER]: lane })).body);
      expect(answer).toEqual({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32603, message: 'harness: the request names no started fork lane' },
      });
    }
    expect(node.calls).toEqual([]);
    expect(otherNode.calls).toEqual([]);
    expect(proxy.stats.refused.get('<no started fork lane>')).toBe(8);
  });
});
