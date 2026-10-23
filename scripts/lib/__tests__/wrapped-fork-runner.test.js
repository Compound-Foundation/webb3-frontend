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
  isBlockHeader,
  isBlockNumber,
  isKeyLike,
  isKeyLikeSegmentOrValue,
  isRetryable,
  MATRIX_CELLS,
  notExercisedCells,
  PINNED_BLOCK,
  PINNED_HASH,
  PUBLIC_ENDPOINTS,
  retryFork,
  rpc,
  SCENARIO_ORDER,
  scenarioMatrix,
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
/** The fake numeric key of the review's error-code probe: 16 digits, so below 2^53 and exact as a JSON number. */
const NUMERIC_KEY = '1234567890123456';
/** A fake numeric key of 20 digits. As a JSON number it parses to 98765432109876540000, which keeps 16 of its digits. */
const LONG_NUMERIC_KEY = '98765432109876543210';
/** The fake key of the GPT 6 Astra review's probe: 12 digits, fewer than the 16 that make any part of a URL key-like. */
const SHORT_NUMERIC_KEY = '123456789012';
/** How the runner names a private upstream's JSON-RPC error whose code has more than five digits. */
const WITHHELD_CODE = 'a JSON-RPC error with a code of more than five digits, withheld';

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
    'with JSON escapes for /': key.replaceAll('/', '\\/'),
    'partly encoded': key.replace('+', '%2b').replace('F', '%46'),
    'in upper case': key.toUpperCase(),
    'in lower case': key.toLowerCase(),
  };
}

const post = (url, body, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const call = (method, params = []) => ({ jsonrpc: '2.0', id: 1, method, params });

/**
 * Posts `body` as JSON to `url` with `host` as the Host header, or with no Host header when `host` is
 * undefined. Resolves to the HTTP status. `fetch` sets the Host header from the URL alone.
 */
const postWithHost = (url, host, body) =>
  new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: 'POST',
        setHost: false,
        headers: { 'content-type': 'application/json', ...(host === undefined ? {} : { host }) },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      }
    );
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });

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

  test('leaves a short part, so that ordinary text and figures stay whole', () => {
    assert.equal(isKeyLike('v2'), false);
    assert.equal(isKeyLike('eth'), false);
    assert.equal(isKeyLike('123456789012345'), false);
    assert.equal(isKeyLike(FAKE_KEY), true);
    const { redact } = redactor();
    assert.equal(redact('v2 eth network 12345678901234567890'), 'v2 eth network 12345678901234567890');
  });

  test('redacts a key of 16 digits or more in the query or the path, and leaves an ordinary error code', () => {
    assert.equal(isKeyLike(NUMERIC_KEY), true);
    assert.equal(isKeyLike(LONG_NUMERIC_KEY), true);
    for (const privateUrl of [
      `https://rpc.example.test/32000/v2?network=eth&key=${NUMERIC_KEY}`,
      `https://rpc.example.test/32000/v2/${NUMERIC_KEY}`,
      `https://rpc.example.test/32000/v2/${LONG_NUMERIC_KEY}`,
    ]) {
      const key = privateUrl.endsWith(LONG_NUMERIC_KEY) ? LONG_NUMERIC_KEY : NUMERIC_KEY;
      const { redact } = createRedactor(upstreamEndpoints({ WRAPPED_FORK_RPC_URL: privateUrl })[0].secretPatterns);
      assert.equal(redact(`error code ${key}: x`), 'error code <redacted>: x', privateUrl);
      assert.equal(redact(`error code ${encodeURIComponent(key)}`), 'error code <redacted>', privateUrl);
      // The URL's short path segment 32000 is no secret, so the code -32000 stays whole.
      assert.equal(redact('error code -32000: x'), 'error code -32000: x', privateUrl);
    }
  });

  test('redacts a short key in a path segment or a query field, and leaves a short part or a word', () => {
    // The review's probe put a 12-digit key in the query. A provider can also put one in the path.
    for (const privateUrl of [
      `https://rpc.example.test/?key=${SHORT_NUMERIC_KEY}`,
      `https://rpc.example.test/ogrpc?network=ethereum&chainid=1&key=${SHORT_NUMERIC_KEY}`,
      `https://rpc.example.test/v2/${SHORT_NUMERIC_KEY}`,
      `https://rpc.example.test/?${SHORT_NUMERIC_KEY}`,
    ]) {
      const { redact } = createRedactor(upstreamEndpoints({ WRAPPED_FORK_RPC_URL: privateUrl })[0].secretPatterns);
      assert.equal(redact(`Invalid API key ${SHORT_NUMERIC_KEY}.`), 'Invalid API key <redacted>.', privateUrl);
      const ordinary = 'ogrpc network ethereum chainid 1 v2 key 12345 eth-mainnet';
      assert.equal(redact(ordinary), ordinary, privateUrl);
    }
    assert.equal(isKeyLikeSegmentOrValue(SHORT_NUMERIC_KEY), true);
    assert.equal(isKeyLikeSegmentOrValue('ab12cd'), true);
    assert.equal(isKeyLikeSegmentOrValue('12345'), false);
    assert.equal(isKeyLikeSegmentOrValue('v2'), false);
    assert.equal(isKeyLikeSegmentOrValue('ethereum'), false);
    assert.equal(isKeyLikeSegmentOrValue('eth-mainnet'), false);
    assert.equal(isKeyLikeSegmentOrValue('abcdefghijklmnop'), true);
    // Another part, such as a host label or a port, keeps the 16-character rule.
    assert.equal(isKeyLike(SHORT_NUMERIC_KEY), false);
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

  test("redacts a key whose character a pipe splits between two chunks, in the middle of the character's bytes", () => {
    const key = 'FAKE_KEY_ÄÖÜ_0123456789';
    const { lineRedactor } = createRedactor(
      upstreamEndpoints({ WRAPPED_FORK_RPC_URL: `https://rpc.example.test/v2/${encodeURIComponent(key)}` })[0]
        .secretPatterns
    );
    let output = '';
    const lines = lineRedactor((text) => (output += text));
    const bytes = Buffer.from(`anvil: ${key} failed\n`);
    const middleOfA = bytes.indexOf(Buffer.from('Ä')) + 1;
    lines.write(bytes.subarray(0, middleOfA));
    lines.write(bytes.subarray(middleOfA));
    lines.end();
    assert.equal(output, 'anvil: <redacted> failed\n');
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

  test("names a private upstream's error code only when it has at most five digits, so a numeric key never shows", async () => {
    const answer = (code) => `{"jsonrpc":"2.0","id":1,"error":{"code":${code},"message":"authentication failed"}}`;
    const codes = {
      eth_chainId: NUMERIC_KEY,
      eth_blockNumber: LONG_NUMERIC_KEY,
      eth_gasPrice: '-32000',
      eth_getCode: '429',
    };
    const numeric = await startStubUpstream(({ method }) => ({ body: answer(codes[method]) }));
    try {
      const isPrivate = true;
      await assert.rejects(rpc(numeric.url, 'eth_chainId', [], { isPrivate }), {
        message: `eth_chainId: HTTP 200, ${WITHHELD_CODE}`,
      });
      await assert.rejects(rpc(numeric.url, 'eth_blockNumber', [], { isPrivate }), {
        message: `eth_blockNumber: HTTP 200, ${WITHHELD_CODE}`,
      });
      await assert.rejects(rpc(numeric.url, 'eth_gasPrice', [], { isPrivate }), {
        message: 'eth_gasPrice: HTTP 200, a JSON-RPC error with code -32000',
      });
      await assert.rejects(rpc(numeric.url, 'eth_getCode', [], { isPrivate }), {
        message: 'eth_getCode: HTTP 200, a JSON-RPC error with code 429',
      });
    } finally {
      await numeric.close();
    }
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

  test("relays anvil's backoff hint, data.rate.backoff_seconds, and no other data", () =>
    withProxy(
      ({ id }) => ({
        body: {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32005,
            message: `project ID request rate exceeded for ${FAKE_KEY}`,
            data: { rate: { backoff_seconds: 3, key: FAKE_KEY }, see: FAKE_KEY },
          },
        },
      }),
      async (proxy) => {
        const response = await post(proxy.url, call('eth_getBalance', ['0x1', '0x1']));
        assert.deepEqual((await response.json()).error, {
          code: -32005,
          message: "rate exceeded (the rest of the private upstream's message is withheld)",
          data: { rate: { backoff_seconds: 3 } },
        });
      }
    ));

  test('relays an error code of more than five digits as -32603, and an id that is not a safe integer as null', () =>
    // An upstream can echo a numeric key as the code or the id. Above 2^53, a JSON number loses
    // digits when parsed, so the redaction of the key no longer matches what is left of it.
    withProxy(
      () => ({ body: `{"jsonrpc":"2.0","id":${LONG_NUMERIC_KEY},"error":{"code":${LONG_NUMERIC_KEY},"message":"x"}}` }),
      async (proxy) => {
        const response = await post(proxy.url, call('eth_getBalance', ['0x1', '0x1']));
        const text = await response.text();
        assert.ok(!text.includes(LONG_NUMERIC_KEY.slice(0, 10)), text);
        assert.deepEqual(JSON.parse(text), {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: "the private upstream's message is withheld" },
        });
        assert.equal(proxy.stats.firstError, WITHHELD_CODE);
      }
    ));

  test('relays a backoff hint of at most five digits, rounded up to whole seconds, and drops a longer one', () =>
    // An upstream can echo a numeric key as the hint, whole or after a decimal point.
    withProxy(
      ({ params }) => ({
        body: `{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"x","data":{"rate":{"backoff_seconds":${params[1]}}}}}`,
      }),
      async (proxy) => {
        const hintFor = async (seconds) =>
          (await (await post(proxy.url, call('eth_getBalance', ['0x1', seconds]))).json()).error.data?.rate
            ?.backoff_seconds;
        assert.equal(await hintFor('86400'), 86400);
        assert.equal(await hintFor('2.5'), 3);
        assert.equal(await hintFor(`0.${NUMERIC_KEY}`), 1);
        assert.equal(await hintFor(LONG_NUMERIC_KEY), undefined);
        assert.equal(await hintFor(NUMERIC_KEY), undefined);
      }
    ));

  test('relays a bare error payload as one, with its code and the phrases of the retry rule', () =>
    // anvil reads an answer of the shape `{ code, message }` as an error, and retries it by its code.
    withProxy(
      () => ({ body: { code: -32005, message: `rate limit exceeded for ${FAKE_KEY}` } }),
      async (proxy) => {
        const response = await post(proxy.url, call('eth_getBalance', ['0x1', '0x1']));
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          code: -32005,
          message: "rate limit (the rest of the private upstream's message is withheld)",
        });
        assert.equal(proxy.stats.errorAnswers, 1);
        assert.equal(proxy.stats.firstError, 'a JSON-RPC error with code -32005');
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

  test('relays a well-formed result of each method it forwards, in an envelope of its own', async () => {
    const hash = `0x${'ab'.repeat(32)}`;
    const address = `0x${'cd'.repeat(20)}`;
    const results = {
      eth_chainId: '0x1',
      eth_blockNumber: '0x1907ba0',
      eth_gasPrice: '0x3b9aca00',
      eth_getBalance: '0x0',
      eth_getTransactionCount: '0x2a',
      eth_getStorageAt: `0x${'0'.repeat(63)}1`,
      eth_getCode: '0x6080',
      eth_getBlockByNumber: {
        number: '0x1907ba0',
        hash,
        sha3Uncles: hash,
        transactions: [{ hash, to: null, accessList: [{ address, storageKeys: [hash] }] }],
        withdrawals: [{ index: '0x1', address, amount: '0x2' }],
      },
      eth_getBlockByHash: null,
      eth_getTransactionByHash: { hash, input: '0x', yParity: '0x0' },
      eth_getTransactionReceipt: { status: '0x1', contractAddress: null, logs: [{ topics: [hash], removed: false }] },
    };
    assert.deepEqual(Object.keys(results).sort(), [...UPSTREAM_METHODS].sort());
    for (const [method, result] of Object.entries(results)) {
      await withProxy(
        // A member outside the envelope can carry the upstream's text, so the proxy drops it.
        ({ id }) => ({ body: { jsonrpc: '2.0', id, result, note: `Invalid API key ${SHORT_NUMERIC_KEY}` } }),
        async (proxy) => {
          const response = await post(proxy.url, { ...call(method), id: 8 });
          assert.equal(response.status, 200);
          assert.equal(await response.text(), JSON.stringify({ jsonrpc: '2.0', id: 8, result }), method);
          assert.equal(proxy.stats.errorAnswers, 0);
        }
      );
    }
  });

  test('withholds a result without the shape that its method returns, and never relays its text', async () => {
    // The review's probe: the upstream answers with a success whose result is text that echoes the key.
    const text = `Invalid API key ${SHORT_NUMERIC_KEY}`;
    const hash = `0x${'ab'.repeat(32)}`;
    const block = { number: '0x1907ba0', hash, transactions: [hash] };
    const malformed = [
      ['eth_getBalance', text],
      ['eth_getBalance', `0x${'f'.repeat(65)}`],
      ['eth_getBalance', 42],
      ['eth_getStorageAt', `0x${SHORT_NUMERIC_KEY}x`],
      ['eth_getCode', '0x608'],
      ['eth_getCode', text],
      ['eth_getBlockByNumber', text],
      ['eth_getBlockByNumber', [block]],
      ['eth_getBlockByNumber', { ...block, miner: text }],
      ['eth_getBlockByNumber', { ...block, [text]: '0x1' }],
      ['eth_getBlockByNumber', { ...block, transactions: [{ hash, input: text }] }],
      ['eth_getTransactionReceipt', { status: '0x1', gasUsed: 21000 }],
    ];
    for (const [method, result] of malformed) {
      await withProxy(
        ({ id }) => ({ body: { jsonrpc: '2.0', id, result } }),
        async (proxy) => {
          const response = await post(proxy.url, { ...call(method), id: 8 });
          const answer = await response.text();
          assert.ok(!answer.includes(SHORT_NUMERIC_KEY), `${method}: ${answer}`);
          assert.deepEqual(JSON.parse(answer), {
            jsonrpc: '2.0',
            id: 8,
            error: { code: -32603, message: "the private upstream's malformed result is withheld" },
          });
          assert.equal(proxy.stats.errorAnswers, 1);
          assert.equal(proxy.stats.firstError, `a malformed ${method} result`);
        }
      );
    }
  });

  test('withholds a malformed result in a batch, and relays the other results', () =>
    withProxy(
      () => ({
        body: [
          { jsonrpc: '2.0', id: 1, result: '0x2a' },
          { jsonrpc: '2.0', id: 2, result: `Invalid API key ${SHORT_NUMERIC_KEY}` },
          { jsonrpc: '2.0', id: 3, result: '0x1' },
        ],
      }),
      async (proxy) => {
        const response = await post(proxy.url, [
          { ...call('eth_chainId'), id: 1 },
          { ...call('eth_getBalance', ['0x1', '0x1']), id: 2 },
        ]);
        const text = await response.text();
        assert.ok(!text.includes(SHORT_NUMERIC_KEY), text);
        const withheld = { code: -32603, message: "the private upstream's malformed result is withheld" };
        assert.deepEqual(JSON.parse(text), [
          { jsonrpc: '2.0', id: 1, result: '0x2a' },
          { jsonrpc: '2.0', id: 2, error: withheld },
          // No call in the batch has the id 3, so no method gives the shape of its result.
          { jsonrpc: '2.0', id: 3, error: withheld },
        ]);
        assert.equal(proxy.stats.errorAnswers, 2);
        assert.equal(proxy.stats.firstError, 'a malformed eth_getBalance result');
      }
    ));
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

  test("refuses a request whose Host header is not the proxy's own address, and forwards one that is", async () => {
    await startProxy();
    try {
      const { port } = proxy.server.address();
      const statusWith = (host) => postWithHost(proxy.url, host, call('eth_chainId'));
      // The review's probe: a JSON POST with a foreign Host header and no Origin header.
      assert.equal(await statusWith('attacker.example:1234'), 403);
      assert.equal(await statusWith(`attacker.example:${port}`), 403);
      assert.equal(await statusWith('127.0.0.1'), 403);
      assert.equal(await statusWith(`localhost:${port + 1}`), 403);
      // Node's server answers 400 to an HTTP/1.1 request without a Host header, before the proxy sees it.
      assert.equal(await statusWith(undefined), 400);
      assert.equal(stub.received.length, 0);
      assert.deepEqual([...proxy.stats.refused], [["<a Host header other than the proxy's address>", 4]]);
      assert.equal(await statusWith(`127.0.0.1:${port}`), 200);
      assert.equal(await statusWith(`localhost:${port}`), 200);
      assert.equal(await statusWith(`LOCALHOST:${port}`), 200);
      assert.equal(stub.received.length, 3);
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
      assert.ok(Date.now() - proxy.stats.lastFailureAt < 5_000);
      assert.equal(proxy.stats.pending, 0);
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

  test("counts a public endpoint's bare error payload as a call answered with an error", async () => {
    const payload = { code: -32005, message: 'rate limit exceeded' };
    await startProxy(() => ({ body: payload }));
    try {
      const response = await post(proxy.url, call('eth_getBalance', ['0x0', '0x1']));
      assert.deepEqual(await response.json(), payload);
      assert.equal(proxy.stats.errorAnswers, 1);
      assert.equal(proxy.stats.firstError, 'rate limit exceeded');
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
      const answer = post(hanging.url, call('eth_getBalance', ['0x1', '0x1']));
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(hanging.stats.pending, 1);
      const before = Date.now();
      assert.equal((await answer).status, 502);
      assert.equal(hanging.stats.pending, 0);
      assert.ok(hanging.stats.lastFailureAt >= before);
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

  test('failed on the upstream when anvil was still retrying it at the deadline', () => {
    // anvil prints its fetch error only when it gives up, and a slow upstream outlasts the deadline.
    const now = 1_000_000;
    const timedOut = (stats) => failedToStartOnUpstream({ stats, output: '', isTimedOut: true, now });
    assert.equal(timedOut({ ...upstreamFailed, pending: 1, lastFailureAt: now - 100_000 }), true);
    assert.equal(timedOut({ ...upstreamFailed, pending: 0, lastFailureAt: now - 10_000 }), true);
    // An upstream failure long before the deadline, with nothing open, leaves anvil's own failure.
    assert.equal(timedOut({ ...upstreamFailed, pending: 0, lastFailureAt: now - 115_000 }), false);
    assert.equal(timedOut({ failures: 0, errorAnswers: 0, pending: 1, lastFailureAt: undefined }), false);
  });
});

describe('the fork block an upstream reports', () => {
  test('needs a hex block number below 2^32, because the runner prints the block it chose', () => {
    assert.equal(isBlockNumber('0x1907ba0'), true);
    assert.equal(isBlockNumber('0xffffffff'), true);
    assert.equal(isBlockNumber('0x100000000'), false);
    assert.equal(isBlockNumber(`0x${Number(NUMERIC_KEY).toString(16)}`), false);
    assert.equal(isBlockNumber(Number(NUMERIC_KEY)), false);
    assert.equal(isBlockNumber(NUMERIC_KEY), false);
    assert.equal(isBlockNumber(null), false);
  });

  test('needs a 32-byte hash and a hex timestamp, because the runner prints both', () => {
    const hash = `0x${'ab'.repeat(32)}`;
    assert.equal(isBlockHeader({ hash, timestamp: '0x6717fb4f' }), true);
    assert.equal(isBlockHeader({ hash: `invalid key ${FAKE_KEY}`, timestamp: '0x1' }), false);
    assert.equal(isBlockHeader({ hash: `${hash}00`, timestamp: '0x1' }), false);
    assert.equal(isBlockHeader({ hash, timestamp: `invalid key ${FAKE_KEY}` }), false);
    // A timestamp past JavaScript's last date, 8.64e12 s, makes the header's date throw.
    assert.equal(isBlockHeader({ hash, timestamp: `0x${'f'.repeat(12)}` }), false);
    assert.equal(isBlockHeader({ hash, timestamp: `0x${(8.64e12).toString(16)}` }), true);
    assert.equal(isBlockHeader({ hash }), false);
    assert.equal(isBlockHeader(null), false);
    assert.equal(isBlockHeader(`invalid key ${FAKE_KEY}`), false);
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

  test("prints every cell in the matrix's table, a missing cell as missing, and - where the matrix has no cell", () => {
    const statusOf = { 'dust (USDC)': 'pass', 'pause (USDT)': 'fail', 'accrued-value (USDC)': 'not-exercised' };
    const results = MATRIX_CELLS.map((cell) => ({
      ...cell,
      status: statusOf[`${cell.scenario} (${cell.market})`] ?? 'missing',
    }));
    const table = scenarioMatrix(results).split('\n');
    assert.deepEqual(table.slice(0, 2), [
      '| Scenario | USDC | USDT | institutional USDC | factory |',
      '| --- | --- | --- | --- | --- |',
    ]);
    assert.deepEqual(
      table.slice(2).map((row) => row.split(' | ')[0].slice(2)),
      SCENARIO_ORDER
    );
    assert.ok(table.includes('| deployment | missing | missing | missing | - |'));
    assert.ok(table.includes('| source-build | missing | missing | missing | missing |'));
    assert.ok(table.includes('| dust | pass | missing | missing | - |'));
    assert.ok(table.includes('| pause | missing | FAIL | missing | - |'));
    assert.ok(table.includes('| accrued-value | not exercised | missing | missing | - |'));
  });
});

describe('the verdict', () => {
  const cell = (scenario, market, status, reason) => ({ scenario, market, status, ...(reason ? { reason } : {}) });
  const titleOf = ({ scenario, market }) => `${scenario} (${market})`;
  const fetchError = 'failed to get account for 0x1: HTTP error 429';
  /** Every cell of the full matrix, passed, with `changes` merged into the cells that they name by title. */
  const fullMatrix = (changes = {}) =>
    MATRIX_CELLS.map((each) => ({ ...each, status: 'pass', ...changes[titleOf(each)] }));
  /** The cell reporter's file for `results`: one test for each cell, failed if the cell failed, and passed otherwise. */
  const jestReportFor = (results) => ({
    numFailedTests: results.filter((result) => result.status === 'fail').length,
    numRuntimeErrorTestSuites: 0,
    tests: results.map((result) => ({
      title: titleOf(result),
      status: result.status === 'fail' ? 'failed' : 'passed',
      failure: '',
    })),
  });
  const suiteRun = (
    number,
    exitCode,
    results,
    stats = { failures: 0, errorAnswers: 0 },
    jest = jestReportFor(results)
  ) => ({
    number,
    exitCode,
    anvilExited: false,
    results,
    jest,
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

  test('passes only a run whose Jest passed, and which passed every cell of the matrix once', () => {
    const passed = finalVerdict([suiteRun(1, 0, fullMatrix())]);
    assert.deepEqual([passed.verdict, passed.exitCode, passed.results.length], ['PASS', 0, 64]);
    // A cell that recorded a pass after Jest failed its test fails, so Jest's exit code alone is not enough.
    const timedOut = finalVerdict([suiteRun(1, 0, [cell('dust', 'USDC', 'fail', 'Jest failed this test after ...')])]);
    assert.deepEqual([timedOut.verdict, timedOut.exitCode], ['FAIL', 1]);
    const empty = finalVerdict([suiteRun(1, 0, [])]);
    assert.deepEqual([empty.verdict, empty.exitCode, empty.results.length], ['NOT EXERCISED', 1, 64]);
    assert.ok(empty.results.every((result) => result.status === 'missing'));
  });

  test('is NOT EXERCISED when the four source-build cells were not exercised, as without --solc-output', () => {
    // The review's first case: `notExercised` records each cell, and Jest reports a todo under another title.
    const reason = 'no solc output of the pinned build input was given (--solc-output)';
    const sourceBuild = MATRIX_CELLS.filter((each) => each.scenario === 'source-build').map(titleOf);
    const results = fullMatrix(
      Object.fromEntries(sourceBuild.map((title) => [title, { status: 'not-exercised', reason }]))
    );
    const jest = jestReportFor(results);
    for (const test of jest.tests.filter((each) => sourceBuild.includes(each.title))) {
      Object.assign(test, { title: `${test.title}: not exercised: ${reason}`, status: 'todo' });
    }
    const { verdict, exitCode, results: judged } = finalVerdict([suiteRun(1, 0, results, undefined, jest)]);
    assert.deepEqual([verdict, exitCode], ['NOT EXERCISED', 1]);
    assert.deepEqual(judged.filter((result) => result.status !== 'pass').map(titleOf), sourceBuild);
  });

  test('is NOT EXERCISED when Jest skipped a matrix test, and lists its cell as missing', () => {
    // The review's second case: `test.skip` on one matrix test, whose scenario then records no cell.
    const [skipped, ...ran] = fullMatrix();
    const jest = jestReportFor(ran);
    jest.tests.unshift({ title: titleOf(skipped), status: 'pending', failure: '' });
    const { verdict, exitCode, results } = finalVerdict([suiteRun(1, 0, ran, undefined, jest)]);
    assert.deepEqual([verdict, exitCode, results.length], ['NOT EXERCISED', 1, 64]);
    assert.deepEqual(
      results.find((result) => titleOf(result) === titleOf(skipped)),
      cell(
        skipped.scenario,
        skipped.market,
        'missing',
        'Jest reported this test as pending, and its scenario recorded no cell'
      )
    );
  });

  test('is NOT EXERCISED when the cell reporter wrote no results, so Jest confirms no cell', () => {
    // The review's third case: the suite's Jest config without `cellReporter.js`.
    const { verdict, exitCode, results } = finalVerdict([{ ...suiteRun(1, 0, fullMatrix()), jest: undefined }]);
    assert.deepEqual([verdict, exitCode, results.length], ['NOT EXERCISED', 1, 64]);
    for (const result of results) {
      assert.equal(result.status, 'not-exercised');
      assert.equal(result.reason, "its scenario recorded a pass, but Jest's reporter wrote no result for its test");
    }
  });

  test('is NOT EXERCISED when the run recorded a single passing cell, and lists the 63 others as missing', () => {
    // The review's fourth case.
    const { verdict, exitCode, results } = finalVerdict([suiteRun(1, 0, [cell('dust', 'USDC', 'pass')])]);
    assert.deepEqual([verdict, exitCode, results.length], ['NOT EXERCISED', 1, 64]);
    const missing = results.filter((result) => result.status === 'missing');
    assert.equal(missing.length, 63);
    assert.ok(missing.every((result) => result.reason === 'the run has no test for this cell'));
  });

  test('is NOT EXERCISED when Jest did not pass the test of a cell that recorded a pass', () => {
    const jest = jestReportFor(fullMatrix());
    jest.tests[0].status = 'pending';
    jest.tests.pop();
    const { verdict, exitCode, results } = finalVerdict([suiteRun(1, 0, fullMatrix(), undefined, jest)]);
    assert.deepEqual([verdict, exitCode], ['NOT EXERCISED', 1]);
    assert.deepEqual(
      results.filter((result) => result.status !== 'pass').map((result) => result.reason),
      [
        'its scenario recorded a pass, but Jest reported this test as pending',
        'its scenario recorded a pass, but Jest reported no test with this title',
      ]
    );
  });

  test('fails a cell that the run recorded twice', () => {
    const { verdict, exitCode, results } = finalVerdict([
      suiteRun(1, 0, [...fullMatrix(), cell('dust', 'USDC', 'pass')]),
    ]);
    assert.deepEqual([verdict, exitCode, results.length], ['FAIL', 1, 64]);
    assert.deepEqual(
      results.filter((result) => titleOf(result) === 'dust (USDC)'),
      [cell('dust', 'USDC', 'fail', 'the run recorded this cell 2 times, and each cell needs exactly one test')]
    );
  });

  test('judges a run scoped by --test by the cells that Jest ran', () => {
    const inScope = fullMatrix().filter((result) => ['deployment', 'source-build'].includes(result.scenario));
    const passed = finalVerdict([suiteRun(1, 0, inScope)], { isScoped: true });
    assert.deepEqual([passed.verdict, passed.exitCode, passed.results.length], ['PASS', 0, 7]);
    // A test that Jest skipped inside the scope still keeps the run from passing.
    const [skipped, ...ran] = inScope;
    const jest = jestReportFor(ran);
    jest.tests.push({ title: titleOf(skipped), status: 'pending', failure: '' });
    const withSkipped = finalVerdict([suiteRun(1, 0, ran, undefined, jest)], { isScoped: true });
    assert.deepEqual([withSkipped.verdict, withSkipped.exitCode, withSkipped.results.length], ['NOT EXERCISED', 1, 7]);
    const none = finalVerdict([suiteRun(1, 0, [])], { isScoped: true });
    assert.deepEqual([none.verdict, none.exitCode, none.results.length], ['NOT EXERCISED', 1, 0]);
  });

  test("records a run's cells that failed only on the upstream as not exercised", () => {
    const run = suiteRun(1, 1, fullMatrix({ 'pause (USDT)': { status: 'fail', reason: fetchError } }), {
      failures: 2,
      errorAnswers: 0,
    });
    const { verdict, exitCode, results } = finalVerdict([run]);
    assert.deepEqual([verdict, exitCode], ['NOT EXERCISED', 1]);
    assert.deepEqual(
      results.filter((result) => result.status !== 'pass').map((result) => [titleOf(result), result.status]),
      [['pause (USDT)', 'not-exercised']]
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
    const run1 = suiteRun(1, 1, fullMatrix({ 'pause (USDT)': { status: 'fail', reason: fetchError } }), {
      failures: 1,
      errorAnswers: 0,
    });
    const { final, verdict, results } = finalVerdict([run1, startupRun(2)]);
    assert.equal(final, run1);
    assert.equal(verdict, 'NOT EXERCISED');
    assert.deepEqual(
      results.filter((result) => result.status !== 'pass').map((result) => [titleOf(result), result.status]),
      [['pause (USDT)', 'not-exercised']]
    );
  });

  test('judges a retry that started after a start-up failure by its own cells', () => {
    assert.equal(finalVerdict([startupRun(1), suiteRun(2, 0, fullMatrix())]).verdict, 'PASS');
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
 * Runs the runner at `block`, the pinned block by default, against `privateUrl`, with the fake anvil.
 * Returns the runner's exit code, its console output, and each file in its log directory by name.
 */
async function runRunner({ privateUrl, anvil, block = 'pinned' }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapped-fork-runner-test-'));
  const logDir = path.join(directory, 'logs');
  try {
    const child = spawn(process.execPath, [RUNNER, '--block', block, '--log-dir', logDir], {
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

  test('never prints a block hash in which the upstream echoes the key, at a block that is not pinned', async () => {
    // Only the pinned block's hash is known in advance. The runner prints another block's hash in its header.
    answers = ({ id, method }, requestPath) => ({
      body: {
        jsonrpc: '2.0',
        id,
        result:
          method === 'eth_chainId'
            ? '0x1'
            : method === 'eth_getBlockByNumber'
            ? { number: '0x1000', hash: `invalid key ${requestPath.split('/').pop()}`, timestamp: '0x1' }
            : '0x0',
      },
    });
    const run = await runRunner({ privateUrl: `${stub.url}/v2/${FAKE_KEY}`, anvil: 'wrong-fork', block: '4096' });
    assert.equal(run.code, 1);
    assertKeyNeverWritten(run, FAKE_KEY);
    assert.match(run.output, /4096 block: block 4096 has no valid hash or timestamp/);
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

  test('never prints a numeric key that the upstream echoes as its error code', async () => {
    // The review's third probe: the stand-in answers each call with the 16-digit query key as the error's code.
    answers = ({ id }) => ({
      body: { jsonrpc: '2.0', id, error: { code: Number(NUMERIC_KEY), message: 'authentication failed' } },
    });
    const run = await runRunner({ privateUrl: `${stub.url}/?key=${NUMERIC_KEY}`, anvil: 'genesis' });
    assert.equal(run.code, 1);
    assertKeyNeverWritten(run, NUMERIC_KEY);
    assert.match(run.output, new RegExp(`pinned block: eth_chainId: HTTP 200, ${WITHHELD_CODE}`));
  });

  test("never passes a numeric key in an error's code to anvil, so anvil's log holds none of it", async () => {
    answers = pinnedBlockUpstream(({ id }) => ({
      body: { jsonrpc: '2.0', id, error: { code: Number(NUMERIC_KEY), message: 'authentication failed' } },
    }));
    const run = await runRunner({ privateUrl: `${stub.url}/api/${NUMERIC_KEY}`, anvil: 'genesis' });
    assert.equal(run.code, 1);
    assertKeyNeverWritten(run, NUMERIC_KEY);
    assert.match(run.files['anvil.log'], /error code -32603: the private upstream's message is withheld/);
  });

  test("never passes a numeric key in an error's backoff hint to anvil, so anvil's log holds none of it", async () => {
    // alloy prints an error's data in anvil's log. Parsed, the 20-digit key keeps 16 of its digits.
    answers = pinnedBlockUpstream(({ id }) => ({
      body: `{"jsonrpc":"2.0","id":${id},"error":{"code":-32000,"message":"invalid key","data":{"rate":{"backoff_seconds":${LONG_NUMERIC_KEY}}}}}`,
    }));
    const run = await runRunner({ privateUrl: `${stub.url}/?key=${LONG_NUMERIC_KEY}`, anvil: 'genesis' });
    assert.equal(run.code, 1);
    assertKeyNeverWritten(run, LONG_NUMERIC_KEY.slice(0, 12));
    assert.match(run.files['anvil.log'], /error code -32000: the private upstream's message is withheld/);
  });

  test('never prints a numeric key that the upstream answers as the latest block number', async () => {
    // The runner prints the block it chooses, the latest less 8, which no redaction of the key matches.
    answers = ({ id, method }) => ({
      body: {
        jsonrpc: '2.0',
        id,
        result: { eth_chainId: '0x1', eth_blockNumber: Number(NUMERIC_KEY) }[method] ?? null,
      },
    });
    const run = await runRunner({ privateUrl: `${stub.url}/?key=${NUMERIC_KEY}`, anvil: 'genesis', block: 'recent' });
    assert.equal(run.code, 1);
    assertKeyNeverWritten(run, NUMERIC_KEY.slice(0, 12));
    assert.match(run.output, /recent block: eth_blockNumber: an answer that is not a block number/);
  });

  test('never writes a short numeric key that the upstream answers as a malformed result', async () => {
    // The review's probe: the upstream answers anvil's genesis read with a success whose result is
    // text that echoes the 12-digit query key. anvil prints a result that it cannot parse.
    answers = pinnedBlockUpstream(({ id }) => ({
      body: { jsonrpc: '2.0', id, result: `Invalid API key ${SHORT_NUMERIC_KEY}` },
    }));
    const run = await runRunner({ privateUrl: `${stub.url}/?key=${SHORT_NUMERIC_KEY}`, anvil: 'genesis' });
    assert.equal(run.code, 1);
    assertKeyNeverWritten(run, SHORT_NUMERIC_KEY, 'Invalid API key');
    assert.match(run.files['anvil.log'], /error code -32603: the private upstream's malformed result is withheld/);
    assert.match(run.output, /Result: NOT EXERCISED\./);
  });

  test("never passes an upstream's malformed result to anvil, so anvil's log holds none of its text", async () => {
    answers = pinnedBlockUpstream(({ id }, requestPath) => ({
      body: { jsonrpc: '2.0', id, result: `no balance for ${decodeURIComponent(requestPath.split('/').pop())}` },
    }));
    const run = await runRunner({ privateUrl: `${stub.url}/api/${encodeURIComponent(PLUS_KEY)}`, anvil: 'genesis' });
    assert.equal(run.code, 1);
    assertKeyNeverWritten(run, PLUS_KEY, 'no balance for');
    assert.match(
      run.files['anvil.log'],
      /failed to get account for .*: server returned an error response: error code -32603: the private upstream's malformed result is withheld/
    );
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
