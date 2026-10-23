// The wrapped lending fork runner's own tests: its redaction, its proxy, the rules that hold each
// matrix cell to Jest's result, and the retry rule. They need no fork and no network. Each test that
// needs an upstream runs a stand-in for it on 127.0.0.1, and the end-to-end tests run the runner
// with `fake-anvil.js` in place of anvil.
//
//   yarn test:fork-runner
//
// `yarn test` runs them too, through `__tests__/scripts/wrappedForkRunner.test.ts`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  cellOf,
  createRedactor,
  failedOnUpstreamOnly,
  failedToStartOnUpstream,
  finalVerdict,
  heldToJest,
  isKeyLike,
  isRetryable,
  MATRIX_CELLS,
  notExercisedCells,
  PINNED_BLOCK,
  PINNED_HASH,
  PUBLIC_ENDPOINTS,
  retryFork,
  rpc,
  SCENARIO_ORDER,
  startUpstreamProxy,
  upstreamEndpoints,
  UPSTREAM_METHODS,
  withheldMessage,
  withLast,
} from '../wrapped-fork-runner.js';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TESTS, '../../..');
const RUNNER = path.join(ROOT, 'scripts/test-wrapped-lending-fork.js');

/** A fake key, never a real one. It is longer than 16 characters, so the runner treats it as a key. */
const FAKE_KEY = 'FAKE_RUNNER_TEST_KEY_1234567890';
/** The fake key of the review's probe. Encoded, its `+` is `%2B`. */
const PLUS_KEY = 'FAKE_REVIEW_KEY+12345678901234567890';
/** A fake key with the characters that separate a URL's parts when they are not encoded. */
const SEPARATOR_KEY = 'Fake+Key/For=Runner&Tests~0123456789';

const listening = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

function closed(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

/**
 * A stand-in for the upstream RPC on 127.0.0.1. `answer` gives the status and body for each request,
 * from its parsed body and its path. The stand-in records the raw text of each request it receives.
 */
async function startStubUpstream(answer = () => ({ body: { jsonrpc: '2.0', id: 1, result: '0x1' } })) {
  const received = [];
  const server = http.createServer((request, response) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      received.push(text);
      const { status = 200, body = '', contentType = 'application/json' } = answer(JSON.parse(text), request.url) ?? {};
      response.writeHead(status, { 'content-type': contentType });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });
  await listening(server);
  return { received, url: `http://127.0.0.1:${server.address().port}`, close: () => closed(server) };
}

/** The forms in which an upstream can echo a key from its URL. */
function echoForms(key) {
  const lowerCaseHex = (text) => text.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
  return {
    decoded: key,
    'percent-encoded': encodeURIComponent(key),
    'percent-encoded in lower case': lowerCaseHex(encodeURIComponent(key)),
    'form-decoded, with a space for +': key.replaceAll('+', ' '),
    'form-encoded': new URLSearchParams({ key }).toString().slice('key='.length),
    'encoded twice': encodeURIComponent(encodeURIComponent(key)),
    'JSON-escaped': [...key].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
    'partly encoded': key.replace('+', '%2b').replace('F', '%46'),
  };
}

const post = (url, body, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const call = (method, params = []) => ({ jsonrpc: '2.0', id: 1, method, params });

describe('upstream endpoints', () => {
  test('without WRAPPED_FORK_RPC_URL, the public endpoints, in order, with nothing to redact', () => {
    for (const env of [{}, { WRAPPED_FORK_RPC_URL: '' }]) {
      const endpoints = upstreamEndpoints(env);
      assert.deepEqual(
        endpoints.map((endpoint) => endpoint.url),
        PUBLIC_ENDPOINTS
      );
      assert.deepEqual(
        endpoints.map((endpoint) => endpoint.label),
        PUBLIC_ENDPOINTS.map((url) => `${url} (public)`)
      );
      assert.ok(endpoints.every((endpoint) => !endpoint.isPrivate && endpoint.secretPatterns.length === 0));
    }
  });

  test('a private URL is labelled without the URL', () => {
    const privateUrl = `https://rpc.example.test/v2/${FAKE_KEY}`;
    const [endpoint, ...others] = upstreamEndpoints({ WRAPPED_FORK_RPC_URL: privateUrl });
    assert.equal(others.length, 0);
    assert.equal(endpoint.url, privateUrl);
    assert.equal(endpoint.isPrivate, true);
    assert.equal(endpoint.label, 'WRAPPED_FORK_RPC_URL (private, not printed)');
    assert.ok(!endpoint.label.includes(FAKE_KEY));
  });

  test('refuses a private URL with a user name or a password, or that is not HTTP(S)', () => {
    for (const privateUrl of [
      `https://user:${FAKE_KEY}@rpc.example.test/`,
      `https://${FAKE_KEY}@rpc.example.test/`,
      `wss://rpc.example.test/${FAKE_KEY}`,
    ]) {
      assert.throws(
        () => upstreamEndpoints({ WRAPPED_FORK_RPC_URL: privateUrl }),
        (error) => {
          assert.ok(!error.message.includes(FAKE_KEY));
          return true;
        }
      );
    }
  });
});

describe('redaction', () => {
  const privateUrl = `https://rpc.example.test/v2/${FAKE_KEY}?network=eth&token=${FAKE_KEY}x`;
  const redactor = () => createRedactor(upstreamEndpoints({ WRAPPED_FORK_RPC_URL: privateUrl })[0].secretPatterns);

  test('redacts the whole URL, its key-like path segments and its key-like query values', () => {
    const { redact } = redactor();
    assert.equal(redact(`failed: ${privateUrl}`), 'failed: <redacted>');
    assert.equal(redact(`key ${FAKE_KEY} and token ${FAKE_KEY}x`), 'key <redacted> and token <redacted>');
  });

  test('leaves a short or all-digit part, so that ordinary text and figures stay whole', () => {
    assert.equal(isKeyLike('v2'), false);
    assert.equal(isKeyLike('eth'), false);
    assert.equal(isKeyLike('12345678901234567890'), false);
    assert.equal(isKeyLike(FAKE_KEY), true);
    const { redact } = redactor();
    assert.equal(redact('v2 eth network 12345678901234567890'), 'v2 eth network 12345678901234567890');
  });

  test('redacts each string in a parsed JSON value and keeps the rest of the value', () => {
    const { redactStrings } = redactor();
    assert.deepEqual(
      redactStrings({
        reason: `failed to get account for 0x1: ${FAKE_KEY}`,
        measurements: { paidCash: '1000', isExact: true, count: 3 },
        list: [`token ${FAKE_KEY}x`, null],
      }),
      {
        reason: 'failed to get account for 0x1: <redacted>',
        measurements: { paidCash: '1000', isExact: true, count: 3 },
        list: ['token <redacted>', null],
      }
    );
  });

  test('redacts a key that a pipe splits across two chunks, a whole line at a time', () => {
    const { lineRedactor } = redactor();
    let output = '';
    const lines = lineRedactor((text) => (output += text));
    lines.write(Buffer.from(`anvil: ${FAKE_KEY.slice(0, 10)}`));
    lines.write(Buffer.from(`${FAKE_KEY.slice(10)} failed\nnext ${FAKE_KEY.slice(0, 5)}`));
    lines.write(Buffer.from(FAKE_KEY.slice(5)));
    lines.end();
    assert.equal(output, 'anvil: <redacted> failed\nnext <redacted>');
  });

  test('redacts before it cuts a line to 200 printable characters, so no prefix of a key stays', () => {
    const { printable } = redactor();
    const line = printable(`${'x'.repeat(190)}${FAKE_KEY} and more`);
    assert.ok(!line.includes(FAKE_KEY.slice(0, 10)));
    assert.equal(line, `${'x'.repeat(190)}<redacted>`);
    assert.equal(printable('a\nb\u0000c'), 'a b c');
  });
});

describe('redaction of each form of a private key', () => {
  const lowerCaseHex = (text) => text.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
  const placements = {
    'an encoded query value': (key) => `https://rpc.example.test/?network=eth&key=${encodeURIComponent(key)}`,
    'a query value with a raw +': () => `https://rpc.example.test/?key=${PLUS_KEY}`,
    'a query field without a value': (key) => `https://rpc.example.test/?${encodeURIComponent(key)}`,
    'an encoded path segment': (key) => `https://rpc.example.test/v2/${encodeURIComponent(key)}`,
    'a path segment encoded in lower case': (key) =>
      `https://rpc.example.test/v2/${lowerCaseHex(encodeURIComponent(key))}`,
  };
  for (const [placement, urlFor] of Object.entries(placements)) {
    for (const key of placement === 'a query value with a raw +' ? [PLUS_KEY] : [PLUS_KEY, SEPARATOR_KEY]) {
      test(`redacts every form of ${key} in ${placement}`, () => {
        const { redact } = createRedactor(upstreamEndpoints({ WRAPPED_FORK_RPC_URL: urlFor(key) })[0].secretPatterns);
        for (const [name, form] of Object.entries(echoForms(key))) {
          assert.equal(redact(`Invalid API key ${form}.`), 'Invalid API key <redacted>.', `${name}: ${form}`);
        }
      });
    }
  }

  test('redacts both of two keys that overlap in the text', () => {
    const first = 'AAAAAAAAAAAAAAAAbbbbbbbb';
    const second = 'bbbbbbbbCCCCCCCCCCCCCCCC';
    const privateUrl = `https://rpc.example.test/${first}/${second}`;
    const { redact } = createRedactor(upstreamEndpoints({ WRAPPED_FORK_RPC_URL: privateUrl })[0].secretPatterns);
    assert.equal(redact(`echo AAAAAAAAAAAAAAAAbbbbbbbbCCCCCCCCCCCCCCCC end`), 'echo <redacted> end');
  });
});

describe('a JSON-RPC call to an upstream', () => {
  let stub;
  before(async () => {
    stub = await startStubUpstream(({ id, method }) => {
      if (method === 'eth_chainId') {
        return { body: { jsonrpc: '2.0', id, error: { code: -32000, message: `Invalid API key ${FAKE_KEY}` } } };
      }
      if (method === 'eth_blockNumber')
        return { body: `<html>Invalid API key ${FAKE_KEY}</html>`, contentType: 'text/html' };
      if (method === 'eth_gasPrice') return { status: 401, body: `Invalid API key ${FAKE_KEY}` };
      return { body: { jsonrpc: '2.0', id, result: '0x2a' } };
    });
  });
  after(() => stub.close());

  test("reports a private endpoint's failure by a reason and the HTTP status, never by the upstream's text", async () => {
    const isPrivate = true;
    await assert.rejects(rpc(stub.url, 'eth_chainId', [], { isPrivate }), {
      message: 'eth_chainId: HTTP 200, a JSON-RPC error with code -32000',
    });
    await assert.rejects(rpc(stub.url, 'eth_blockNumber', [], { isPrivate }), {
      message: 'eth_blockNumber: HTTP 200, an answer that is not JSON',
    });
    await assert.rejects(rpc(stub.url, 'eth_gasPrice', [], { isPrivate }), { message: 'eth_gasPrice: HTTP 401' });
    const down = http.createServer();
    await listening(down);
    const downUrl = `http://127.0.0.1:${down.address().port}`;
    await closed(down);
    await assert.rejects(rpc(downUrl, 'eth_chainId', [], { isPrivate }), {
      message: 'eth_chainId: no connection (ECONNREFUSED)',
    });
  });

  test("keeps a public endpoint's error message, and returns a result", async () => {
    await assert.rejects(rpc(stub.url, 'eth_chainId'), { message: `eth_chainId: Invalid API key ${FAKE_KEY}` });
    assert.equal(await rpc(stub.url, 'eth_getBalance', ['0x0', 'latest'], { isPrivate: true }), '0x2a');
  });
});

describe("a private upstream's error message", () => {
  test('keeps only the phrases that make anvil retry, so anvil retries as it would have', () => {
    const withheld = "the private upstream's message is withheld";
    assert.equal(withheldMessage(`Invalid API key ${FAKE_KEY}`), withheld);
    assert.equal(withheldMessage(undefined), withheld);
    assert.equal(withheldMessage({ text: FAKE_KEY }), withheld);
    assert.equal(withheldMessage('header not found'), 'header not found');
    assert.equal(withheldMessage(`header not found for ${FAKE_KEY}`), withheld);
    assert.equal(
      withheldMessage('daily request count exceeded, request rate limited'),
      'daily request count exceeded, request rate limited'
    );
    assert.equal(
      withheldMessage(`You reached Public endpoint rate limit, please upgrade ${FAKE_KEY}`),
      "rate limit (the rest of the private upstream's message is withheld)"
    );
    assert.equal(
      withheldMessage(`credits limited to 6000/s for ${FAKE_KEY}`),
      "credits limited; credits (the rest of the private upstream's message is withheld)"
    );
    assert.equal(
      withheldMessage('100/second request limit reached - reduce calls per second'),
      "request limit (the rest of the private upstream's message is withheld)"
    );
    for (const phrase of ['rate exceeded', 'too many requests']) {
      assert.equal(
        withheldMessage(`x ${phrase} ${FAKE_KEY}`),
        `${phrase} (the rest of the private upstream's message is withheld)`
      );
    }
  });
});

describe('the upstream proxy for a private endpoint', () => {
  let stub;
  let answers;
  before(async () => {
    stub = await startStubUpstream((parsed) => answers(parsed));
  });
  after(() => stub.close());

  async function withProxy(answer, check) {
    answers = answer;
    const proxy = await startUpstreamProxy(
      { url: stub.url, isPrivate: true },
      { printable: createRedactor([]).printable }
    );
    try {
      await check(proxy);
    } finally {
      await closed(proxy.server);
    }
  }

  test("relays an HTTP error's status without its body", () =>
    withProxy(
      () => ({ status: 429, body: `{"error":{"message":"rate limit for key ${FAKE_KEY}"}}` }),
      async (proxy) => {
        const response = await post(proxy.url, call('eth_getBalance', ['0x1', '0x1']));
        assert.equal(response.status, 429);
        assert.equal(await response.text(), '');
        assert.equal(proxy.stats.failures, 1);
        assert.equal(proxy.stats.firstError, 'HTTP 429');
      }
    ));

  test("relays a JSON-RPC error with its code and anvil's retry phrases only, and drops its data", () =>
    withProxy(
      ({ id }) => ({
        body: {
          jsonrpc: '2.0',
          id,
          error: { code: 15, message: `You reached Public endpoint rate limit, key ${FAKE_KEY}`, data: FAKE_KEY },
        },
      }),
      async (proxy) => {
        const response = await post(proxy.url, { ...call('eth_getBalance', ['0x1', '0x1']), id: 8 });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          jsonrpc: '2.0',
          id: 8,
          error: { code: 15, message: "rate limit (the rest of the private upstream's message is withheld)" },
        });
        assert.equal(proxy.stats.errorAnswers, 1);
        assert.equal(proxy.stats.firstError, 'a JSON-RPC error with code 15');
      }
    ));

  test('relays the results of a batch unchanged, and withholds the text of its errors', () =>
    withProxy(
      () => ({
        body: [
          { jsonrpc: '2.0', id: 1, result: '0x2a' },
          { jsonrpc: '2.0', id: 2, error: { code: -32000, message: `Invalid API key ${FAKE_KEY}` } },
          { jsonrpc: '2.0', id: 3, error: `Invalid API key ${FAKE_KEY}` },
        ],
      }),
      async (proxy) => {
        const response = await post(proxy.url, [call('eth_chainId'), call('eth_blockNumber'), call('eth_gasPrice')]);
        const text = await response.text();
        assert.ok(!text.includes(FAKE_KEY));
        assert.deepEqual(JSON.parse(text), [
          { jsonrpc: '2.0', id: 1, result: '0x2a' },
          { jsonrpc: '2.0', id: 2, error: { code: -32000, message: "the private upstream's message is withheld" } },
          { jsonrpc: '2.0', id: 3, error: { code: -32603, message: "the private upstream's message is withheld" } },
        ]);
        assert.equal(proxy.stats.errorAnswers, 2);
        assert.equal(proxy.stats.firstError, 'a JSON-RPC error with code -32000');
      }
    ));

  test('answers 502, with no body, for an answer that is not JSON or not a JSON-RPC response', async () => {
    for (const [body, firstError] of [
      [`<html>Invalid API key ${FAKE_KEY}</html>`, 'an answer that is not JSON'],
      [{ message: `Invalid API key ${FAKE_KEY}` }, 'an answer that is not a JSON-RPC response'],
    ]) {
      await withProxy(
        () => ({ body }),
        async (proxy) => {
          const response = await post(proxy.url, call('eth_chainId'));
          assert.equal(response.status, 502);
          assert.equal(await response.text(), '');
          assert.equal(proxy.stats.errorAnswers, 1);
          assert.equal(proxy.stats.firstError, firstError);
        }
      );
    }
  });

  test('relays a successful answer byte for byte', () => {
    const body = '{"jsonrpc":"2.0","id":1,"result":"0x2a"}\n';
    return withProxy(
      () => ({ body }),
      async (proxy) => {
        const response = await post(proxy.url, call('eth_chainId'));
        assert.equal(response.status, 200);
        assert.equal(await response.text(), body);
        assert.equal(proxy.stats.errorAnswers, 0);
      }
    );
  });
});

describe('the upstream proxy', () => {
  let stub;
  let proxy;
  let answers;

  before(async () => {
    stub = await startStubUpstream((parsed) => answers(parsed));
  });
  after(() => stub.close());

  async function startProxy(answer = () => ({ body: { jsonrpc: '2.0', id: 1, result: '0x1' } })) {
    stub.received.length = 0;
    answers = answer;
    proxy = await startUpstreamProxy({ url: stub.url, isPrivate: false }, { printable: createRedactor([]).printable });
    return proxy;
  }

  const stopProxy = () => closed(proxy.server);

  test('listens on 127.0.0.1 only, keeps idle connections open, and stops listening when closed', async () => {
    await startProxy();
    try {
      assert.equal(proxy.server.address().address, '127.0.0.1');
      assert.equal(proxy.server.keepAliveTimeout, 0);
      assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
      assert.equal((await post(proxy.url, call('eth_chainId'))).status, 200);
    } finally {
      await stopProxy();
    }
    await assert.rejects(post(proxy.url, call('eth_chainId')));
  });

  test('forwards exactly the reads anvil makes to fork mainnet state', () => {
    assert.deepEqual([...UPSTREAM_METHODS].sort(), [
      'eth_blockNumber',
      'eth_chainId',
      'eth_gasPrice',
      'eth_getBalance',
      'eth_getBlockByHash',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_getStorageAt',
      'eth_getTransactionByHash',
      'eth_getTransactionCount',
      'eth_getTransactionReceipt',
    ]);
  });

  test('forwards a read, and relays the upstream answer unchanged', async () => {
    const result = { jsonrpc: '2.0', id: 7, result: '0x2a' };
    await startProxy(() => ({ body: result }));
    try {
      const response = await post(proxy.url, call('eth_getBalance', ['0x0', 'latest']));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), result);
      assert.deepEqual(
        stub.received.map((text) => JSON.parse(text)),
        [call('eth_getBalance', ['0x0', 'latest'])]
      );
      assert.deepEqual([...proxy.stats.methods], [['eth_getBalance', 1]]);
      assert.equal(proxy.stats.requests, 1);
    } finally {
      await stopProxy();
    }
  });

  test('refuses a write or any other method outside the allowlist, alone or in a batch, and sends nothing upstream', async () => {
    await startProxy();
    try {
      const refusedMethods = [
        'eth_sendRawTransaction',
        'eth_sendTransaction',
        'eth_sign',
        'eth_signTypedData_v4',
        'personal_sign',
        'eth_call',
        'eth_estimateGas',
        'eth_getLogs',
        'debug_traceTransaction',
        'anvil_setBalance',
        'hardhat_impersonateAccount',
        'wallet_sendCalls',
      ];
      for (const method of refusedMethods) {
        assert.equal((await post(proxy.url, call(method, ['0x00']))).status, 403, method);
      }
      const batch = [call('eth_chainId'), call('eth_sendRawTransaction', ['0x00']), call('eth_blockNumber')];
      assert.equal((await post(proxy.url, batch)).status, 403);
      assert.equal((await post(proxy.url, { method: 42 })).status, 403);
      assert.equal(stub.received.length, 0);
      assert.equal(proxy.stats.requests, 0);
      assert.equal(proxy.stats.refused.get('eth_sendRawTransaction'), 2);
      assert.equal(proxy.stats.refused.get('<invalid>'), 1);
    } finally {
      await stopProxy();
    }
  });

  test('forwards only the method it checked, rebuilt from the four JSON-RPC members', async () => {
    await startProxy();
    try {
      // JSON.parse keeps the last of two `method` keys. The upstream must never see the first one.
      const twice = '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","method":"eth_chainId","params":[]}';
      assert.equal((await post(proxy.url, twice)).status, 200);
      // A key in another case, which some upstreams read as the method, is dropped.
      const cased = { jsonrpc: '2.0', id: 2, method: 'eth_getBalance', Method: 'eth_sendRawTransaction', params: [] };
      assert.equal((await post(proxy.url, cased)).status, 200);
      // A member outside the four is dropped too.
      const extra = { ...call('eth_blockNumber'), sendTransaction: { to: '0x0' } };
      assert.equal((await post(proxy.url, [extra])).status, 200);
      assert.deepEqual(stub.received, [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_getBalance', params: [] }),
        JSON.stringify([call('eth_blockNumber')]),
      ]);
      assert.ok(stub.received.every((text) => !/sendRawTransaction|sendTransaction|Method/.test(text)));
    } finally {
      await stopProxy();
    }
  });

  test('refuses what a web page or a malformed client sends', async () => {
    await startProxy();
    try {
      assert.equal((await post(proxy.url, call('eth_chainId'), { origin: 'https://example.test' })).status, 403);
      assert.equal((await fetch(proxy.url)).status, 405);
      assert.equal((await post(proxy.url, call('eth_chainId'), { 'content-type': 'text/plain' })).status, 415);
      assert.equal((await post(proxy.url, 'not JSON')).status, 400);
      assert.equal((await post(proxy.url, [])).status, 403);
      assert.equal(stub.received.length, 0);
      assert.deepEqual(
        new Map(proxy.stats.refused),
        new Map([
          ['<an Origin header>', 1],
          ['<a method other than POST>', 1],
          ['<a content type other than JSON>', 1],
          ['<a body that is not JSON>', 1],
          ['<an empty batch>', 1],
        ])
      );
    } finally {
      await stopProxy();
    }
  });

  test('refuses a body over 10 MB without forwarding it', async () => {
    await startProxy();
    try {
      const body = JSON.stringify({ ...call('eth_chainId'), padding: 'x'.repeat(10 * 1024 * 1024) });
      await post(proxy.url, body).then(
        () => undefined,
        () => undefined
      );
      assert.equal(proxy.stats.refused.get('<a body over 10 MB>'), 1);
      assert.equal(stub.received.length, 0);
    } finally {
      await stopProxy();
    }
  });

  test('counts a request the upstream failed, and a call it answered with an error', async () => {
    let status = 429;
    await startProxy(() =>
      status === 429
        ? { status, body: 'slow down' }
        : { body: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'missing trie node' } } }
    );
    try {
      const failed = await post(proxy.url, call('eth_getBalance', ['0x0', '0x1']));
      assert.equal(failed.status, 429);
      status = 200;
      const answered = await post(proxy.url, call('eth_getBalance', ['0x0', '0x1']));
      assert.equal(answered.status, 200);
      assert.equal(proxy.stats.failures, 1);
      assert.equal(proxy.stats.errorAnswers, 1);
      assert.equal(proxy.stats.firstError, 'HTTP 429');
    } finally {
      await stopProxy();
    }
  });

  test("relays a public endpoint's error unchanged, and keeps its message for the summary", async () => {
    const error = { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'missing trie node abc' } };
    await startProxy(() => ({ body: error }));
    try {
      const response = await post(proxy.url, call('eth_getBalance', ['0x0', '0x1']));
      assert.deepEqual(await response.json(), error);
      assert.equal(proxy.stats.firstError, 'missing trie node abc');
    } finally {
      await stopProxy();
    }
  });

  test('answers 502 when the upstream gives no answer, and counts the failure', async () => {
    const down = http.createServer();
    await listening(down);
    const downUrl = `http://127.0.0.1:${down.address().port}`;
    await closed(down);
    const unreachable = await startUpstreamProxy(
      { url: downUrl, isPrivate: false },
      { printable: createRedactor([]).printable }
    );
    try {
      assert.equal((await post(unreachable.url, call('eth_chainId'))).status, 502);
      assert.equal(unreachable.stats.failures, 1);
      assert.equal(unreachable.stats.firstError, 'no answer within 40 s, or no connection');
    } finally {
      await closed(unreachable.server);
    }
  });

  test('gives up on an upstream that never answers, and counts the failure, before anvil gives up', async () => {
    const silent = http.createServer(() => undefined);
    await listening(silent);
    const hanging = await startUpstreamProxy(
      { url: `http://127.0.0.1:${silent.address().port}`, isPrivate: true },
      { printable: createRedactor([]).printable, timeoutMs: 300 }
    );
    try {
      assert.equal((await post(hanging.url, call('eth_getBalance', ['0x1', '0x1']))).status, 502);
      assert.equal(hanging.stats.failures, 1);
      assert.equal(hanging.stats.firstError, 'no answer within 0.3 s, or no connection');
    } finally {
      await closed(hanging.server);
      await closed(silent);
    }
  });
});

describe('cells held to Jest', () => {
  const cell = (scenario, market, status, reason) => ({ scenario, market, status, ...(reason ? { reason } : {}) });
  const jestReport = (tests) => ({
    numFailedTests: tests.filter((entry) => entry.status === 'failed').length,
    numRuntimeErrorTestSuites: 0,
    tests,
  });

  test('reads the scenario and the market from a matrix test title, and nothing from another title', () => {
    assert.deepEqual(cellOf('partial-exit (institutional USDC)'), {
      scenario: 'partial-exit',
      market: 'institutional USDC',
    });
    assert.deepEqual(cellOf('source-build (factory)'), { scenario: 'source-build', market: 'factory' });
    assert.equal(cellOf('refuses connections to other hosts'), undefined);
  });

  test('fails a cell that recorded a pass after Jest failed its test on a timeout', () => {
    const held = heldToJest(
      [cell('partial-exit', 'USDC', 'pass'), cell('full-exit', 'USDC', 'pass')],
      jestReport([
        {
          title: 'partial-exit (USDC)',
          status: 'failed',
          failure: 'thrown: Exceeded timeout of 600000 ms for a test.',
        },
        { title: 'full-exit (USDC)', status: 'passed', failure: '' },
      ])
    );
    assert.deepEqual(held, [
      cell(
        'partial-exit',
        'USDC',
        'fail',
        'Jest failed this test after its scenario recorded pass: thrown: Exceeded timeout of 600000 ms for a test.'
      ),
      cell('full-exit', 'USDC', 'pass'),
    ]);
  });

  test('fails a cell that recorded not exercised after Jest failed its test', () => {
    const [held] = heldToJest(
      [cell('accrued-value', 'USDT', 'not-exercised', 'supply rate 0')],
      jestReport([{ title: 'accrued-value (USDT)', status: 'failed', failure: 'Error: boom' }])
    );
    assert.equal(held.status, 'fail');
  });

  test('gives a failed cell to a matrix test that Jest failed before it recorded one, and none to another test', () => {
    const held = heldToJest(
      [],
      jestReport([
        { title: 'pause (USDT)', status: 'failed', failure: 'failed to get account for 0x1: pruned' },
        { title: 'refuses connections to other hosts', status: 'failed', failure: 'Error: reached' },
      ])
    );
    assert.deepEqual(held, [
      cell(
        'pause',
        'USDT',
        'fail',
        'Jest failed this test, and its scenario recorded no cell: failed to get account for 0x1: pruned'
      ),
    ]);
  });

  test('keeps a failed cell, and every cell when Jest reported nothing', () => {
    const results = [cell('dust', 'USDC', 'fail', 'Error: dust'), cell('dust', 'USDT', 'pass')];
    assert.deepEqual(heldToJest(results, undefined), results);
    assert.deepEqual(
      heldToJest(results, jestReport([{ title: 'dust (USDC)', status: 'failed', failure: 'Error: dust' }])),
      results
    );
  });
});

describe('the retry rule', () => {
  const fetchError = 'failed to get storage for 0xdAC17F958D2ee523a2206206994597C13D831ec7 at 1: HTTP error 429';
  const upstreamOnly = () => ({
    exitCode: 1,
    anvilExited: false,
    results: [
      { scenario: 'pause', market: 'USDT', status: 'fail', reason: fetchError },
      { scenario: 'dust', market: 'USDT', status: 'pass' },
    ],
    jest: { numFailedTests: 1, numRuntimeErrorTestSuites: 0, tests: [] },
    stats: { failures: 3, errorAnswers: 0 },
  });

  test('retries a run whose every failed cell carries anvil fetch error, when the upstream failed', () => {
    assert.equal(failedOnUpstreamOnly(upstreamOnly()), true);
    assert.equal(failedOnUpstreamOnly({ ...upstreamOnly(), stats: { failures: 0, errorAnswers: 2 } }), true);
  });

  test('never retries a failure of the app or a test', () => {
    const run = upstreamOnly();
    const withFailedCell = (reason) => ({
      ...run,
      results: [...run.results, { scenario: 'excessive-debit', market: 'USDC', status: 'fail', reason }],
      jest: { ...run.jest, numFailedTests: 2 },
    });
    const cases = {
      'a cell without anvil fetch error': withFailedCell('expect(received).toBe(expected)'),
      'a revert beside the fetch error': withFailedCell(`${fetchError}; execution reverted`),
      "ethers' decoded revert of a call": withFailedCell(`call revert exception; ${fetchError}`),
      'a gas estimate a revert stopped': withFailedCell(`UNPREDICTABLE_GAS_LIMIT ${fetchError}`),
      'the digits 429 inside an address, without a fetch error': withFailedCell(
        'expected 0x4290000000000000000000000000000000000000 to equal 0x1'
      ),
      'a test outside the matrix failed too': { ...run, jest: { ...run.jest, numFailedTests: 2 } },
      'a suite failed outside its tests': { ...run, jest: { ...run.jest, numRuntimeErrorTestSuites: 1 } },
      'Jest reported nothing': { ...run, jest: undefined },
      'anvil exited': { ...run, anvilExited: true },
      'the upstream never failed': { ...run, stats: { failures: 0, errorAnswers: 0 } },
      'no cell failed': { ...run, results: run.results.filter((result) => result.status !== 'fail') },
      'the run passed': { ...run, exitCode: 0 },
    };
    for (const [name, failedRun] of Object.entries(cases)) {
      assert.equal(failedOnUpstreamOnly(failedRun), false, name);
    }
  });

  test('a retry tries the other endpoints first and the failed one last', () => {
    const [first, second, third] = [{ label: 'a' }, { label: 'b' }, { label: 'c' }];
    assert.deepEqual(withLast([first, second, third], first), [second, third, first]);
    assert.deepEqual(withLast([first], first), [first]);
  });

  test('retries a run that could not start the fork on the upstream, or that failed only on it', () => {
    assert.equal(isRetryable({ startupFailure: 'the upstream failed', results: [], stats: {} }), true);
    assert.equal(isRetryable(upstreamOnly()), true);
    assert.equal(isRetryable({ ...upstreamOnly(), anvilExited: true }), false);
  });

  test('retries the pinned block, or a given one, at the same block, and a recent block at a fresh one', () => {
    const endpoints = [{ label: 'a' }, { label: 'b' }, { label: 'c' }];
    const failedRun = (mode, number) => ({ endpoint: endpoints[0], target: { mode, number } });
    const sameBlock = { block: String(PINNED_BLOCK), endpoints: [endpoints[1], endpoints[2], endpoints[0]] };
    assert.deepEqual(retryFork('pinned', failedRun('pinned', PINNED_BLOCK), endpoints), sameBlock);
    assert.deepEqual(retryFork('auto', failedRun('pinned', PINNED_BLOCK), endpoints), sameBlock);
    assert.deepEqual(retryFork('123', failedRun('recent', 123), endpoints), { ...sameBlock, block: '123' });
    assert.deepEqual(retryFork('recent', failedRun('recent', 456), endpoints), { block: 'recent', endpoints });
    assert.deepEqual(retryFork('auto', failedRun('recent', 456), endpoints), { block: 'recent', endpoints });
  });
});

describe('a fork that could not start', () => {
  // anvil's own output when the upstream answered its genesis read with HTTP 429, in a recorded run.
  const genesisFailure = [
    'Error: failed to create genesis',
    '',
    'Context:',
    '- failed to get account for 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC: Max retries exceeded HTTP error 429 with empty body',
  ].join('\n');
  const upstreamFailed = { failures: 6, errorAnswers: 0 };

  test('failed on the upstream when the proxy saw it fail and anvil names a failed fetch', () => {
    assert.equal(failedToStartOnUpstream({ stats: upstreamFailed, output: genesisFailure }), true);
    for (const output of [
      'Error: failed to fetch network chain ID',
      'Error: failed to get fork block number',
      'Error: Failed to get block for block number: 26244888',
    ]) {
      assert.equal(failedToStartOnUpstream({ stats: { failures: 0, errorAnswers: 1 }, output }), true, output);
    }
  });

  test('did not fail on the upstream when the proxy saw no upstream failure, or anvil names no fetch', () => {
    // A refusal by the proxy, such as a method outside the allowlist, counts as no upstream failure.
    assert.equal(failedToStartOnUpstream({ stats: { failures: 0, errorAnswers: 0 }, output: genesisFailure }), false);
    assert.equal(
      failedToStartOnUpstream({ stats: upstreamFailed, output: 'Error: Address already in use (os error 48)' }),
      false
    );
    assert.equal(failedToStartOnUpstream({ stats: upstreamFailed, output: '' }), false);
  });
});

describe('the matrix', () => {
  test('lists every scenario that the fork suites declare, on each wrapped market, and the factory build', () => {
    const suites = path.join(ROOT, '__tests__/integration/wrappedLendingFork');
    const declared = new Set();
    const onFactory = new Set();
    for (const file of fs.readdirSync(suites).filter((name) => /\.fork\.test\.tsx?$/.test(name))) {
      const source = fs.readFileSync(path.join(suites, file), 'utf8');
      for (const [, name, market] of source.matchAll(/\b(?:scenario|notExercised)\(\s*'([a-z-]+)',\s*('factory')?/g)) {
        declared.add(name);
        if (market !== undefined) onFactory.add(name);
      }
    }
    assert.deepEqual([...declared].sort(), [...SCENARIO_ORDER].sort());
    assert.deepEqual([...onFactory], ['source-build']);
    assert.equal(MATRIX_CELLS.length, SCENARIO_ORDER.length * 3 + 1);
    assert.deepEqual(
      MATRIX_CELLS.filter((cell) => cell.scenario === 'source-build').map((cell) => cell.market),
      ['USDC', 'USDT', 'institutional USDC', 'factory']
    );
  });

  test('records every cell as not exercised, with the reason', () => {
    const cells = notExercisedCells('the upstream failed');
    assert.equal(cells.length, 64);
    assert.ok(cells.every((cell) => cell.status === 'not-exercised' && cell.reason === 'the upstream failed'));
  });
});

describe('the verdict', () => {
  const cell = (scenario, market, status, reason) => ({ scenario, market, status, ...(reason ? { reason } : {}) });
  const fetchError = 'failed to get account for 0x1: HTTP error 429';
  const suiteRun = (number, exitCode, results, stats = { failures: 0, errorAnswers: 0 }) => ({
    number,
    exitCode,
    anvilExited: false,
    results,
    jest: { numFailedTests: results.filter((result) => result.status === 'fail').length, numRuntimeErrorTestSuites: 0 },
    stats,
  });
  const startupRun = (number) => ({
    number,
    startupFailure: 'anvil could not start the fork',
    exitCode: 1,
    anvilExited: false,
    results: notExercisedCells('anvil could not start the fork'),
    stats: { failures: 1, errorAnswers: 0 },
  });

  test('passes only a run whose Jest passed, which recorded cells, and none of which failed', () => {
    assert.equal(finalVerdict([suiteRun(1, 0, [cell('dust', 'USDC', 'pass')])]).verdict, 'PASS');
    // A cell that recorded a pass after Jest failed its test fails, so Jest's exit code alone is not enough.
    const timedOut = finalVerdict([suiteRun(1, 0, [cell('dust', 'USDC', 'fail', 'Jest failed this test after ...')])]);
    assert.deepEqual([timedOut.verdict, timedOut.exitCode], ['FAIL', 1]);
    const empty = finalVerdict([suiteRun(1, 0, [])]);
    assert.deepEqual([empty.verdict, empty.exitCode], ['FAIL', 1]);
  });

  test("records a run's cells that failed only on the upstream as not exercised", () => {
    const run = suiteRun(1, 1, [cell('dust', 'USDC', 'pass'), cell('pause', 'USDT', 'fail', fetchError)], {
      failures: 2,
      errorAnswers: 0,
    });
    const { verdict, exitCode, results } = finalVerdict([run]);
    assert.deepEqual([verdict, exitCode], ['NOT EXERCISED', 1]);
    assert.deepEqual(
      results.map((result) => result.status),
      ['pass', 'not-exercised']
    );
  });

  test('records every cell as not exercised when no run started the fork', () => {
    for (const runs of [[startupRun(1)], [startupRun(1), startupRun(2)]]) {
      const { final, verdict, exitCode, results } = finalVerdict(runs);
      assert.equal(final, runs[runs.length - 1]);
      assert.deepEqual([verdict, exitCode, results.length], ['NOT EXERCISED', 1, 64]);
      assert.ok(results.every((result) => result.status === 'not-exercised'));
    }
  });

  test('keeps the last run that ran the suite when the retry could not start the fork', () => {
    const run1 = suiteRun(1, 1, [cell('dust', 'USDC', 'pass'), cell('pause', 'USDT', 'fail', fetchError)], {
      failures: 1,
      errorAnswers: 0,
    });
    const { final, verdict, results } = finalVerdict([run1, startupRun(2)]);
    assert.equal(final, run1);
    assert.equal(verdict, 'NOT EXERCISED');
    assert.deepEqual(
      results.map((result) => result.status),
      ['pass', 'not-exercised']
    );
  });

  test('judges a retry that started after a start-up failure by its own cells', () => {
    assert.equal(finalVerdict([startupRun(1), suiteRun(2, 0, [cell('dust', 'USDC', 'pass')])]).verdict, 'PASS');
    const failed = finalVerdict([startupRun(1), suiteRun(2, 1, [cell('dust', 'USDC', 'fail', 'execution reverted')])]);
    assert.deepEqual([failed.verdict, failed.exitCode], ['FAIL', 1]);
  });
});

/** A shell script that starts `fake-anvil.js` with `behaviour`, to give the runner as ANVIL. */
function fakeAnvil(directory, behaviour) {
  const script = path.join(directory, `anvil-${behaviour}`);
  const fake = path.join(TESTS, 'fake-anvil.js');
  fs.writeFileSync(script, `#!/bin/sh\nexec '${process.execPath}' '${fake}' '${behaviour}' "$@"\n`, { mode: 0o755 });
  return script;
}

/**
 * Runs the runner at the pinned block against `privateUrl`, with the fake anvil. Returns the runner's
 * exit code, its console output, and each file in its log directory by name.
 */
async function runRunner({ privateUrl, anvil }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapped-fork-runner-test-'));
  const logDir = path.join(directory, 'logs');
  try {
    const child = spawn(process.execPath, [RUNNER, '--block', 'pinned', '--log-dir', logDir], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ANVIL: fakeAnvil(directory, anvil),
        WRAPPED_FORK_RPC_URL: privateUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const code = await new Promise((resolve) => child.on('close', resolve));
    const files = Object.fromEntries(
      fs.readdirSync(logDir).map((name) => [name, fs.readFileSync(path.join(logDir, name), 'utf8')])
    );
    return { code, output, files };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** The stand-in's answers that let the runner choose the pinned block. `otherwise` answers the rest. */
const pinnedBlockUpstream =
  (otherwise) =>
  ({ id, method, params }, requestPath) => {
    if (method === 'eth_chainId') return { body: { jsonrpc: '2.0', id, result: '0x1' } };
    if (method === 'eth_getBlockByNumber') {
      const header = { number: `0x${PINNED_BLOCK.toString(16)}`, hash: PINNED_HASH, timestamp: '0x67170000' };
      return { body: { jsonrpc: '2.0', id, result: header } };
    }
    if (method === 'eth_getBalance' && /^0x0{40}$/.test(params[0]))
      return { body: { jsonrpc: '2.0', id, result: '0x0' } };
    return otherwise({ id, method, params }, requestPath);
  };

/** Fails unless `key`, in each form an upstream can echo, is missing from the run's output and files. */
function assertKeyNeverWritten(run, key, upstreamText) {
  for (const [name, text] of [['console', run.output], ...Object.entries(run.files)]) {
    for (const [form, echo] of Object.entries(echoForms(key))) {
      assert.ok(!text.includes(echo), `${name} holds the key, ${form}`);
    }
    if (upstreamText !== undefined) assert.ok(!text.includes(upstreamText), `${name} holds the upstream's text`);
  }
}

describe('the runner, end to end, with a private upstream that echoes its key', { timeout: 120_000 }, () => {
  let stub;
  let answers;
  before(async () => {
    stub = await startStubUpstream((parsed, requestPath) => answers(parsed, requestPath));
  });
  after(() => stub.close());

  test('never prints a key that the upstream echoes percent-encoded from the query', async () => {
    // The review's first probe: the stand-in echoes the query value as the URL carries it.
    answers = ({ id }, requestPath) => ({
      body: { jsonrpc: '2.0', id, error: { code: -32000, message: `Invalid API key ${requestPath.split('=')[1]}` } },
    });
    const run = await runRunner({ privateUrl: `${stub.url}/?key=${encodeURIComponent(PLUS_KEY)}`, anvil: 'genesis' });
    assert.equal(run.code, 1);
    assertKeyNeverWritten(run, PLUS_KEY, 'Invalid API key');
    assert.match(run.output, /pinned block: eth_chainId: HTTP 200, a JSON-RPC error with code -32000/);
  });

  test('never prints a key that the upstream echoes decoded from the path', async () => {
    // The review's second probe: the stand-in echoes the last path segment, decoded.
    answers = ({ id }, requestPath) => ({
      body: {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: `Invalid API key ${decodeURIComponent(requestPath.split('/').pop())}` },
      },
    });
    const run = await runRunner({ privateUrl: `${stub.url}/api/${encodeURIComponent(PLUS_KEY)}`, anvil: 'genesis' });
    assert.equal(run.code, 1);
    assertKeyNeverWritten(run, PLUS_KEY, 'Invalid API key');
    assert.match(run.output, /pinned block: eth_chainId: HTTP 200, a JSON-RPC error with code -32000/);
  });

  test("never passes a private upstream's error text to anvil, so anvil's log holds none of it", async () => {
    answers = pinnedBlockUpstream(({ id }, requestPath) => ({
      status: 429,
      body: {
        jsonrpc: '2.0',
        id,
        error: {
          code: 15,
          message: `Public endpoint rate limit for ${decodeURIComponent(requestPath.split('/').pop())}`,
        },
      },
    }));
    const run = await runRunner({
      privateUrl: `${stub.url}/api/${encodeURIComponent(SEPARATOR_KEY)}`,
      anvil: 'genesis',
    });
    assert.equal(run.code, 1);
    assertKeyNeverWritten(run, SEPARATOR_KEY, 'Public endpoint rate limit');
    assert.match(
      run.files['anvil.log'],
      /failed to get account for 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC: .*HTTP error 429/
    );
  });

  test("redacts a key that an upstream's answer echoes into anvil's log", async () => {
    // An answer that is not an error reaches anvil unchanged, and anvil prints it when it cannot parse it.
    answers = pinnedBlockUpstream(({ id }, requestPath) => ({
      body: { jsonrpc: '2.0', id, result: `no balance for ${decodeURIComponent(requestPath.split('/').pop())}` },
    }));
    const run = await runRunner({ privateUrl: `${stub.url}/api/${encodeURIComponent(PLUS_KEY)}`, anvil: 'genesis' });
    assert.equal(run.code, 1);
    assertKeyNeverWritten(run, PLUS_KEY);
    assert.match(run.files['anvil.log'], /deserialization error: invalid value, text: .*no balance for <redacted>/);
  });
});

describe('the runner, end to end, when anvil cannot start the fork', { timeout: 120_000 }, () => {
  let stub;
  let answers;
  before(async () => {
    stub = await startStubUpstream((parsed, requestPath) => answers(parsed, requestPath));
  });
  after(() => stub.close());

  test("retries once at the pinned block, then records every cell as not exercised, and keeps run 1's log", async () => {
    // The review's recorded failure: the upstream answers anvil's genesis read with HTTP 429.
    answers = pinnedBlockUpstream(({ id }) => ({
      status: 429,
      body: { jsonrpc: '2.0', id, error: { code: 15, message: 'You reached Public endpoint rate limit' } },
    }));
    const run = await runRunner({ privateUrl: `${stub.url}/api/${FAKE_KEY}`, anvil: 'genesis' });
    assert.equal(run.code, 1);
    assert.match(run.output, /Running once more/);
    assert.deepEqual(Object.keys(run.files).sort(), [
      'anvil-2.log',
      'anvil.log',
      'results-2.json',
      'results.json',
      'summary.md',
    ]);
    for (const log of ['anvil.log', 'anvil-2.log']) {
      assert.match(run.files[log], /failed to create genesis[\s\S]*failed to get account for .*HTTP error 429/);
    }
    for (const results of ['results.json', 'results-2.json']) {
      const cells = JSON.parse(run.files[results]);
      assert.equal(cells.length, 64);
      assert.ok(cells.every((cell) => cell.status === 'not-exercised' && /could not start the fork/.test(cell.reason)));
    }
    const summary = run.files['summary.md'];
    assert.match(summary, new RegExp(`fork block: +${PINNED_BLOCK} \\(the registry's pinned block\\)`));
    assert.match(summary, /local fork: +not started/);
    assert.match(summary, /upstream use: +1 request forwarded, 1 failed upstream/);
    assert.match(summary, /first error: +HTTP 429/);
    assert.match(summary, /## Run 1, which could not start the fork because the upstream failed/);
    assert.match(summary, /\| deployment \| not exercised \| not exercised \| not exercised \| - \|/);
    assert.match(summary, /\| source-build \| not exercised \| not exercised \| not exercised \| not exercised \|/);
    assert.match(summary, /## Failed \(0\)/);
    assert.match(summary, /## Not exercised \(64\)/);
    assert.match(summary, /Result: NOT EXERCISED\./);
    assert.ok(run.output.includes(summary.trim()));
  });

  test('neither retries nor records a matrix when anvil fails for its own reason', async () => {
    answers = pinnedBlockUpstream(({ id }) => ({ body: { jsonrpc: '2.0', id, result: '0x0' } }));
    const run = await runRunner({ privateUrl: `${stub.url}/api/${FAKE_KEY}`, anvil: 'address-in-use' });
    assert.equal(run.code, 1);
    assert.match(run.output, /anvil exited before it was ready\. See anvil\.log\./);
    assert.doesNotMatch(run.output, /Running once more/);
    assert.ok(!('summary.md' in run.files) && !('anvil-2.log' in run.files) && !('results.json' in run.files));
  });

  test('neither retries nor records a matrix when the fork reports other metadata', async () => {
    answers = pinnedBlockUpstream(({ id }) => ({ body: { jsonrpc: '2.0', id, result: '0x0' } }));
    const run = await runRunner({ privateUrl: `${stub.url}/api/${FAKE_KEY}`, anvil: 'wrong-fork' });
    assert.equal(run.code, 1);
    assert.match(run.output, /The local node is not the expected fork: another fork block hash/);
    assert.doesNotMatch(run.output, /Running once more/);
    assert.ok(!('summary.md' in run.files) && !('anvil-2.log' in run.files) && !('results.json' in run.files));
  });
});
