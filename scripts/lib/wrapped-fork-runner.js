// The rules and the upstream proxy of the wrapped lending fork runner, `scripts/test-wrapped-lending-fork.js`.
// They live apart from the runner so that its own tests, `yarn test:fork-runner`, can check them without a fork:
// - the upstream endpoints, and the redaction of the private URL
// - the proxy that holds the URL, and its read-only method allowlist
// - each matrix cell held to Jest's own result for its test
// - the retry rule
import http from 'http';

/** The block docs/anchorage-wrapper-registry.md records its deployment reads at, and its hash. */
export const PINNED_BLOCK = 26244888;
export const PINNED_HASH = '0x440c51a6a6953b880568c1b60e4ad59044f3fa783e340e34d66793e466883839';
/** Public endpoints, in order of preference. Some of them serve old state, and some only recent state. */
export const PUBLIC_ENDPOINTS = [
  'https://eth.drpc.org',
  'https://mainnet.gateway.tenderly.co',
  'https://eth-mainnet.public.blastapi.io',
  'https://rpc.mevblocker.io',
  'https://ethereum-rpc.publicnode.com',
];
export const MARKET_COLUMNS = ['USDC', 'USDT', 'institutional USDC', 'factory'];
/**
 * anvil's own error when it cannot fetch the fork's state from the upstream. Its fork backend words
 * it as `failed to get account for <address>: <the upstream's error>`, and the same for storage, a
 * block hash, a full block and a transaction. A test's failure reason carries it when ethers passes
 * anvil's answer on.
 */
export const FORK_FETCH_ERROR = /failed to get (?:account for|storage for|block hash for|full block for|transaction) /;
/**
 * A refusal by the chain itself: anvil's revert error, ethers' decoded revert of an `eth_call`, or a
 * gas estimate that a revert stopped. A cell that failed on one failed in the app or the test,
 * whatever the upstream did. A fetch failure in an `eth_call` reaches ethers as `missing revert
 * data in call exception`, which this does not match, with anvil's fetch error inside.
 */
export const CHAIN_REFUSAL = /execution reverted|call revert exception|UNPREDICTABLE_GAS_LIMIT/;
/** The largest JSON-RPC body the proxy forwards: far above anything anvil sends. */
export const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;
/**
 * The JSON-RPC methods the proxy forwards: the reads anvil makes to fork mainnet state, and the gas
 * price anvil reads once at start-up. The proxy refuses every other method. Otherwise any local
 * process can send a transaction to mainnet, or a costly call, through the proxy and the key behind it.
 */
export const UPSTREAM_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_gasPrice',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
]);

/**
 * A part of the private URL that can be a key: 16 characters or more, and not only digits. A
 * shorter part, such as `v2`, `eth` or a port, also occurs in ordinary text and figures, and a
 * redaction of it corrupts them.
 */
export const isKeyLike = (part) => part.length >= 16 && !/^\d+$/.test(part);

/**
 * The upstream endpoints to try. A private URL is labelled. The runner redacts from every output
 * the whole URL, and each key-like part of it: its host, each path segment and each query value.
 */
export function upstreamEndpoints(env = process.env) {
  const privateUrl = env.WRAPPED_FORK_RPC_URL;
  if (privateUrl !== undefined && privateUrl !== '') {
    const url = new URL(privateUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('WRAPPED_FORK_RPC_URL must be an HTTP(S) URL.');
    }
    // fetch refuses a URL with credentials, and its error quotes the URL.
    if (url.username !== '' || url.password !== '') {
      throw new Error('WRAPPED_FORK_RPC_URL must not carry a user name or password. Put the key in its path or query.');
    }
    const parts = [url.host, ...url.pathname.split('/'), ...url.searchParams.values()];
    const secrets = [privateUrl, url.href, ...parts.filter(isKeyLike)];
    return [{ label: 'WRAPPED_FORK_RPC_URL (private, not printed)', url: privateUrl, secrets }];
  }
  return PUBLIC_ENDPOINTS.map((url) => ({ label: `${url} (public)`, url, secrets: [] }));
}

/**
 * The redaction of `secrets` from the runner's outputs. It redacts the longest secret first, so that
 * a part never splits a longer secret first.
 */
export function createRedactor(secrets) {
  const ordered = [...new Set(secrets)].sort((a, b) => b.length - a.length);
  const redact = (text) => ordered.reduce((result, secret) => result.split(secret).join('<redacted>'), String(text));

  /** `value` with each string in it redacted. A redaction of the JSON text instead can break its syntax. */
  function redactStrings(value) {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(redactStrings);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactStrings(entry)]));
    }
    return value;
  }

  /**
   * Writes a child's output to `write` a whole line at a time, each line redacted. A pipe can split a
   * line, and the URL in it, across two chunks, and neither half matches the URL.
   */
  function lineRedactor(write) {
    let pending = '';
    return {
      write: (chunk) => {
        pending += String(chunk);
        const end = pending.lastIndexOf('\n');
        if (end === -1) return;
        write(redact(pending.slice(0, end + 1)));
        pending = pending.slice(end + 1);
      },
      end: () => {
        if (pending !== '') write(redact(pending));
        pending = '';
      },
    };
  }

  /**
   * `text`, redacted, as one line of printable ASCII of at most 200 characters, for the summary. The
   * redaction comes first, so the cut cannot split a secret that the redaction then misses.
   */
  const printable = (text) =>
    redact(String(text))
      .replace(/[^\x20-\x7e]/g, ' ')
      .slice(0, 200);

  return { redact, redactStrings, lineRedactor, printable };
}

/** `method` if it is a JSON-RPC method name, so that a request cannot write other text into the summary. */
export const methodName = (method) =>
  typeof method === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(method) ? method : '<invalid>';

export const countIn = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);

/** The error message of each call that a JSON-RPC answer reports as failed, as `printable` gives it. */
function errorsIn(answer, printable) {
  try {
    const parsed = JSON.parse(answer.toString('utf8'));
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter((entry) => entry?.error !== undefined && entry?.error !== null)
      .map((entry) => printable(entry.error.message ?? JSON.stringify(entry.error)));
  } catch {
    return ['an answer that is not JSON'];
  }
}

/**
 * Forwards anvil's JSON-RPC requests to the upstream, so that only this process holds the upstream
 * URL. It listens on 127.0.0.1, and it refuses these requests:
 * - a request with an Origin header, which a web page sends
 * - a method other than POST
 * - a content type other than JSON, or a body that is not JSON
 * - a body over 10 MB
 * - an empty batch, or a request or batch that calls a method outside `UPSTREAM_METHODS`
 *
 * It sends anvil no text of its own errors, which can name the upstream URL. The upstream's answers
 * reach anvil unchanged, and the runner redacts every output. It counts the methods it forwards and
 * each refusal, by its method or reason. It also counts the requests that the upstream failed and
 * the calls it answered with an error. It keeps the first such error, as `printable` gives it, for
 * the summary.
 */
export function startUpstreamProxy(upstreamUrl, { printable }) {
  const stats = {
    requests: 0,
    failures: 0,
    errorAnswers: 0,
    firstError: undefined,
    methods: new Map(),
    refused: new Map(),
  };
  const server = http.createServer((request, response) => {
    const refuse = (status, reason) => {
      if (reason !== undefined) countIn(stats.refused, reason);
      response.writeHead(status, { 'content-type': 'text/plain' });
      response.end();
    };
    if (request.headers.origin !== undefined) return refuse(403, '<an Origin header>');
    if (request.method !== 'POST') return refuse(405, '<a method other than POST>');
    if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) {
      return refuse(415, '<a content type other than JSON>');
    }
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_PROXY_BODY_BYTES) chunks.push(chunk);
      else if (!request.destroyed) {
        countIn(stats.refused, '<a body over 10 MB>');
        request.destroy();
      }
    });
    request.on('end', async () => {
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return refuse(400, '<a body that is not JSON>');
      }
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      const methods = calls.map((call) => methodName(call?.method));
      if (methods.length === 0) return refuse(403, '<an empty batch>');
      const outside = methods.filter((method) => !UPSTREAM_METHODS.has(method));
      if (outside.length > 0) {
        for (const method of outside) countIn(stats.refused, method);
        return refuse(403);
      }
      // The calls the proxy checked, rebuilt from their four JSON-RPC members. A raw body can name a
      // method twice, or under a key in another case, such as `Method`. An upstream can read that name
      // instead of the one that the proxy checked.
      const checked = calls.map(({ jsonrpc, id, method, params }) => ({ jsonrpc, id, method, params }));
      for (const method of methods) countIn(stats.methods, method);
      stats.requests += 1;
      try {
        const upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Array.isArray(parsed) ? checked : checked[0]),
          signal: AbortSignal.timeout(60_000),
        });
        const answer = Buffer.from(await upstream.arrayBuffer());
        if (upstream.status >= 400) {
          stats.failures += 1;
          stats.firstError ??= `HTTP ${upstream.status}`;
        } else {
          const errors = errorsIn(answer, printable);
          stats.errorAnswers += errors.length;
          stats.firstError ??= errors[0];
        }
        response.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
        });
        response.end(answer);
      } catch {
        stats.failures += 1;
        stats.firstError ??= 'no answer within 60 s, or no connection';
        refuse(502);
      }
    });
  });
  // anvil's HTTP client keeps an idle connection open for up to 90 s. By default, Node's server
  // closes an idle connection after 5 s. A request that anvil sends as the proxy closes the
  // connection fails before the proxy reads it. So the proxy never closes an idle connection.
  server.keepAliveTimeout = 0;
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, stats, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

/** The scenario and market of a matrix cell's test title, `<scenario> (<market>)`, or undefined. */
export function cellOf(title) {
  const market = MARKET_COLUMNS.find((column) => title.endsWith(` (${column})`));
  return market === undefined ? undefined : { scenario: title.slice(0, -(market.length + 3)), market };
}

/**
 * The cells, each held to Jest's own result for its test. A scenario records its cell when its body
 * settles, which can come after Jest failed the test, for example on a timeout. Such a cell fails.
 * A test that Jest failed can also have recorded no cell. Its `beforeAll` or `beforeEach` hook
 * failed, or its scenario never settled before Jest timed it out. It gets a failed cell, with Jest's
 * failure as the reason.
 */
export function heldToJest(results, jest) {
  const failures = new Map(
    (jest?.tests ?? []).filter((test) => test.status === 'failed').map((test) => [test.title, test.failure])
  );
  const held = results.map((result) => {
    const failure = failures.get(`${result.scenario} (${result.market})`);
    if (failure === undefined || result.status === 'fail') return result;
    return {
      ...result,
      status: 'fail',
      reason: `Jest failed this test after its scenario recorded ${result.status}: ${failure}`,
    };
  });
  const recorded = new Set(results.map((result) => `${result.scenario} (${result.market})`));
  for (const [title, failure] of failures) {
    const cell = cellOf(title);
    if (cell === undefined || recorded.has(title)) continue;
    held.push({
      ...cell,
      status: 'fail',
      reason: `Jest failed this test, and its scenario recorded no cell: ${failure}`,
    });
  }
  return held;
}

/**
 * Whether `run` failed only because the upstream failed to serve the fork's state. At least one
 * cell must have failed, and every failed cell must carry anvil's fetch error and no refusal by the
 * chain. Jest must have reported its results and failed no other test. No suite must have failed
 * outside its tests, as one does when it fails to load or its `afterAll` hook throws. anvil must not
 * have exited. The proxy must have seen the upstream fail or answer with an error.
 */
export function failedOnUpstreamOnly(run) {
  const failed = run.results.filter((result) => result.status === 'fail');
  return (
    run.exitCode !== 0 &&
    !run.anvilExited &&
    failed.length > 0 &&
    run.jest !== undefined &&
    run.jest.numRuntimeErrorTestSuites === 0 &&
    failed.length === run.jest.numFailedTests &&
    run.stats.failures + run.stats.errorAnswers > 0 &&
    failed.every((result) => FORK_FETCH_ERROR.test(result.reason ?? '') && !CHAIN_REFUSAL.test(result.reason ?? ''))
  );
}

/** `endpoints` with `last` moved to the end, so that a retry tries the other endpoints first. */
export const withLast = (endpoints, last) => [...endpoints.filter((endpoint) => endpoint !== last), last];
