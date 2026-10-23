// Runs the wrapped lending fork suite (COM-289) against a local Ethereum mainnet fork.
//
//   node scripts/test-wrapped-lending-fork.js [options]
//
//   --block auto|pinned|recent|<number>  The fork block. The default, `auto`, forks the pinned block
//                                        26244888 when the upstream serves its state. Otherwise it
//                                        forks a recent block, the latest less 8.
//   --solc-output <path>                 solc's standard-JSON output for the wrappers' build input,
//                                        for the deployed bytecode comparison. Without it, that check
//                                        is recorded as not exercised.
//   --log-dir <path>                     Where the logs, results and summary go. Default: a new
//                                        directory under the system's temporary directory.
//   --port <number>                      The fork's local port. Default: a port anvil chooses.
//   --test <pattern>                     Runs only the fork suites whose path matches.
//
// The upstream RPC comes from WRAPPED_FORK_RPC_URL, a private variable for an archive-capable
// mainnet RPC. Never use a VITE_ variable for it, because Vite embeds those in the public bundle.
// Put the key in the URL's path or query. The runner refuses a URL with a user name or password.
// Without the variable, the runner uses public endpoints. Only this process holds the URL. anvil
// reaches the upstream through a proxy that this process runs on 127.0.0.1. So anvil's arguments,
// logs, errors and JSON-RPC methods carry only the proxy's address. The proxy forwards only the reads
// anvil makes to fork mainnet state. The runner redacts the URL, and each key-like part of it, from
// every output it writes. The tests get none of the runner's environment except the variables
// they need, so they never see the URL.
//
// The fork listens on 127.0.0.1 only, sends no CORS headers, and is stopped on exit, on Ctrl-C and
// on any error. The tests sign with impersonated accounts on the fork. Nothing is signed with a real
// key, and nothing is sent to mainnet.
//
// The runner retries a run once, and only when the upstream failed to serve the fork's state. Every
// failed cell must then carry anvil's own fetch error and no revert. Jest must have failed no other
// test, and the proxy must have seen the upstream fail. A recent-block run retries from a fresh
// recent block. A run at the pinned block, or at a given block, retries at the same block, on the
// other endpoints first. If the last run fails only that way too, its failed cells are recorded as
// not exercised, and the run fails.
//
// Three risks remain. In none of them do the fork or the proxy give out the URL, and no real funds
// are at stake:
// - Any local process can call the fork and the proxy on 127.0.0.1 during a run. It can change the
//   fork's state, and so a run's results, and it can make the reads that the proxy forwards.
// - anvil checks no Host header, so a web page open during a run can reach the fork through DNS
//   rebinding. Such a page can change the fork's state and so a run's results, but anvil holds no
//   key and the proxy forwards only reads. Run the suite with no untrusted page open.
// - If the runner is killed with SIGKILL, it cannot stop anvil. The orphaned anvil holds no key, and
//   its upstream is gone. Stop it with `pkill -f 'anvil --fork-url http://127.0.0.1'`.
import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JEST_CONFIG = path.join(ROOT, '__tests__/integration/wrappedLendingFork/jest.config.js');
/** The block docs/anchorage-wrapper-registry.md records its deployment reads at, and its hash. */
const PINNED_BLOCK = 26244888;
const PINNED_HASH = '0x440c51a6a6953b880568c1b60e4ad59044f3fa783e340e34d66793e466883839';
/** A recent fork stays this many blocks behind the endpoint's latest, so that every node behind it has the block. */
const RECENT_BLOCK_LAG = 8;
/**
 * The EVM rules the fork runs: Prague, the latest that anvil 1.2.3 knows. Its default for a fork is
 * Cancun. Mainnet runs at least Osaka's rules at these blocks, so the fork trails mainnet. Osaka adds
 * the CLZ opcode and a P-256 precompile, reprices MODEXP and caps a transaction's gas at 2^24. The
 * wrappers and Comet use none of the three, and each suite transaction stays far below the cap. So
 * only the gas figures can differ from mainnet's.
 */
const HARDFORK = 'prague';
/** Public endpoints, in order of preference. Some of them serve old state, and some only recent state. */
const PUBLIC_ENDPOINTS = [
  'https://eth.drpc.org',
  'https://mainnet.gateway.tenderly.co',
  'https://eth-mainnet.public.blastapi.io',
  'https://rpc.mevblocker.io',
  'https://ethereum-rpc.publicnode.com',
];
const MARKET_COLUMNS = ['USDC', 'USDT', 'institutional USDC', 'factory'];
/**
 * anvil's own error when it cannot fetch the fork's state from the upstream. Its fork backend words
 * it as `failed to get account for <address>: <the upstream's error>`, and the same for storage, a
 * block hash, a full block and a transaction. A test's failure reason carries it when ethers passes
 * anvil's answer on.
 */
const FORK_FETCH_ERROR = /failed to get (?:account for|storage for|block hash for|full block for|transaction) /;
/**
 * A refusal by the chain itself: a revert, or a gas estimate that a revert stopped. A cell that
 * failed on one failed in the app or the test, whatever the upstream did.
 */
const CHAIN_REFUSAL = /execution reverted|UNPREDICTABLE_GAS_LIMIT/;
/** The largest JSON-RPC body the proxy forwards: far above anything anvil sends. */
const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;
/**
 * The JSON-RPC methods the proxy forwards: the reads anvil makes to fork mainnet state, and the gas
 * price anvil reads once at start-up. The proxy refuses every other method. Otherwise any local
 * process can send a transaction to mainnet, or a costly call, through the proxy and the key behind it.
 */
const UPSTREAM_METHODS = new Set([
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

function parseArgs(argv) {
  const options = { block: 'auto', solcOutput: undefined, logDir: undefined, port: 0, test: undefined };
  for (let index = 0; index < argv.length; index++) {
    const equals = argv[index].indexOf('=');
    const flag = equals === -1 ? argv[index] : argv[index].slice(0, equals);
    const inline = equals === -1 ? undefined : argv[index].slice(equals + 1);
    const value = () => {
      const next = inline ?? argv[++index];
      if (next === undefined || next === '') throw new Error(`${flag} takes a value.`);
      return next;
    };
    switch (flag) {
      case '--block':
        options.block = value();
        break;
      case '--solc-output':
        options.solcOutput = path.resolve(value());
        break;
      case '--log-dir':
        options.logDir = path.resolve(value());
        break;
      case '--port':
        options.port = Number(value());
        break;
      case '--test':
        options.test = value();
        break;
      default:
        throw new Error(`Unknown option ${argv[index]}. See the comment at the top of this script.`);
    }
  }
  if (!['auto', 'pinned', 'recent'].includes(options.block) && !/^\d+$/.test(options.block)) {
    throw new Error('--block takes auto, pinned, recent or a block number.');
  }
  if (!(Number.isInteger(options.port) && options.port >= 0 && options.port < 65536)) {
    throw new Error('--port takes a port number.');
  }
  if (options.solcOutput !== undefined && !fs.existsSync(options.solcOutput)) {
    throw new Error('--solc-output names no file.');
  }
  // Jest reads an argument that starts with a dash as one of its own options.
  if (options.test !== undefined && (options.test === '' || options.test.startsWith('-'))) {
    throw new Error('--test takes a path pattern, not a Jest option.');
  }
  return options;
}

/**
 * A part of the private URL that can be a key: 16 characters or more, and not only digits. A
 * shorter part, such as `v2`, `eth` or a port, also occurs in ordinary text and figures, and a
 * redaction of it corrupts them.
 */
const isKeyLike = (part) => part.length >= 16 && !/^\d+$/.test(part);

/**
 * The upstream endpoints to try. A private URL is labelled. The runner redacts from every output
 * the whole URL, and each key-like part of it: its host, each path segment and each query value.
 */
function upstreamEndpoints() {
  const privateUrl = process.env.WRAPPED_FORK_RPC_URL;
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

/** The secrets to redact, the longest first, so that a part never splits a longer secret first. */
let secretsToRedact = [];
const redact = (text) =>
  secretsToRedact.reduce((result, secret) => result.split(secret).join('<redacted>'), String(text));

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

async function rpc(url, method, params = [], timeoutMs = 20_000) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

const hex = (value) => `0x${Number(value).toString(16)}`;

/**
 * The block and hash to fork from on `endpoint`, or undefined when it cannot serve them. The pinned
 * block must have the hash that the registry records. Its state must also be readable. A balance
 * read at that block fails on a node that keeps only recent state.
 */
async function forkTarget(endpoint, block) {
  if ((await rpc(endpoint.url, 'eth_chainId')) !== '0x1') throw new Error('the endpoint is not Ethereum mainnet');
  if (block === 'pinned' || /^\d+$/.test(block)) {
    const number = block === 'pinned' ? PINNED_BLOCK : Number(block);
    const header = await rpc(endpoint.url, 'eth_getBlockByNumber', [hex(number), false]);
    if (header === null) return undefined;
    if (number === PINNED_BLOCK && header.hash !== PINNED_HASH) throw new Error(`block ${number} has another hash`);
    await rpc(endpoint.url, 'eth_getBalance', ['0x0000000000000000000000000000000000000000', hex(number)]);
    return {
      number,
      hash: header.hash,
      timestamp: Number(header.timestamp),
      mode: number === PINNED_BLOCK ? 'pinned' : 'recent',
    };
  }
  const latest = Number(await rpc(endpoint.url, 'eth_blockNumber'));
  const header = await rpc(endpoint.url, 'eth_getBlockByNumber', [hex(latest - RECENT_BLOCK_LAG), false]);
  return { number: latest - RECENT_BLOCK_LAG, hash: header.hash, timestamp: Number(header.timestamp), mode: 'recent' };
}

/** The first endpoint and block that the option allows. Under `auto`, the pinned block comes first. */
async function chooseFork(endpoints, option) {
  const attempts = option === 'auto' ? ['pinned', 'recent'] : [option];
  const problems = [];
  for (const attempt of attempts) {
    for (const endpoint of endpoints) {
      try {
        const target = await forkTarget(endpoint, attempt);
        if (target !== undefined) return { endpoint, target };
        problems.push(`${endpoint.label}: no block for ${attempt}`);
      } catch (error) {
        problems.push(`${endpoint.label}, ${attempt} block: ${redact(error.message)}`);
      }
    }
  }
  throw new Error(`No upstream endpoint can serve the fork:\n  ${problems.join('\n  ')}`);
}

/** `method` if it is a JSON-RPC method name, so that a request cannot write other text into the summary. */
const methodName = (method) =>
  typeof method === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(method) ? method : '<invalid>';

const countIn = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);

/** `text` as one line of printable ASCII, at most 200 characters, for the summary. */
const printable = (text) =>
  String(text)
    .replace(/[^\x20-\x7e]/g, ' ')
    .slice(0, 200);

/** The error message of each call that a JSON-RPC answer reports as failed. */
function errorsIn(answer) {
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
 * the calls it answered with an error. It keeps the first such error for the summary.
 */
function startUpstreamProxy(upstreamUrl) {
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
          const errors = errorsIn(answer);
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

function toolVersion(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split('\n')[0].trim() : undefined;
}

function findAnvil() {
  const candidates = [process.env.ANVIL, 'anvil', path.join(os.homedir(), '.foundry/bin/anvil')].filter(Boolean);
  for (const candidate of candidates) {
    const version = toolVersion(candidate, ['--version']);
    if (version !== undefined) return { command: candidate, version };
  }
  throw new Error('anvil was not found. Install Foundry (https://getfoundry.sh) or set ANVIL to its path.');
}

const children = new Set();
const servers = new Set();
const temporaryDirectories = new Set();

function cleanUp() {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const server of servers) server.close();
  servers.clear();
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
}

const hasExited = (child) => child.exitCode !== null || child.signalCode !== null;

/** Stops `child` with SIGTERM and waits for it to exit. If it outlives `timeoutMs`, kills it with SIGKILL. */
function stopped(child, timeoutMs = 5_000) {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/**
 * Starts anvil on 127.0.0.1, forked from `target` through the proxy at `upstreamUrl`. With port 0,
 * anvil binds a free port itself, and the runner reads the port from anvil's own output. So no
 * other process can take the port between its choice and the bind.
 */
async function startFork(anvilCommand, upstreamUrl, target, port, log) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapped-lending-fork-'));
  temporaryDirectories.add(directory);
  const args = [
    '--fork-url',
    upstreamUrl,
    '--fork-block-number',
    String(target.number),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--chain-id',
    '1',
    '--hardfork',
    HARDFORK,
    '--no-cors',
    '--retries',
    '5',
    '--timeout',
    '45000',
    '--fork-retry-backoff',
    '1000',
    '--compute-units-per-second',
    '330',
    '--no-storage-caching',
  ];
  // An empty working directory, so no foundry.toml changes anvil's settings.
  const child = spawn(anvilCommand, args, {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let boundPort;
  const stdout = lineRedactor((text) => {
    log.write(text);
    const listening = /Listening on 127\.0\.0\.1:(\d+)/.exec(text);
    if (listening !== null) boundPort = Number(listening[1]);
  });
  const stderr = lineRedactor((text) => log.write(text));
  child.stdout.on('data', stdout.write);
  child.stdout.on('end', stdout.end);
  child.stderr.on('data', stderr.write);
  child.stderr.on('end', stderr.end);
  const deadline = Date.now() + 120_000;
  while (boundPort === undefined) {
    if (hasExited(child)) throw new Error('anvil exited before it was ready. See anvil.log.');
    if (Date.now() > deadline) throw new Error('anvil was not ready within 120 s. See anvil.log.');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { child, localUrl: `http://127.0.0.1:${boundPort}`, port: boundPort };
}

/** Refuses to run unless the local node is the anvil fork of `target`, on chain 1, bound to loopback. */
async function verifyFork(fork, target) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(fork.localUrl)) throw new Error('The fork must listen on 127.0.0.1.');
  const [chainId, clientVersion, metadata, block] = await Promise.all([
    rpc(fork.localUrl, 'eth_chainId'),
    rpc(fork.localUrl, 'web3_clientVersion'),
    rpc(fork.localUrl, 'anvil_metadata'),
    rpc(fork.localUrl, 'eth_getBlockByNumber', [hex(target.number), false]),
  ]);
  const forked = metadata.forkedNetwork;
  const problems = [
    hasExited(fork.child) && 'the runner started an anvil that has exited',
    chainId !== '0x1' && `chain ID ${chainId}`,
    !String(clientVersion).startsWith('anvil/') && `client ${clientVersion}`,
    (forked === null || Number(forked.forkBlockNumber) !== target.number) && 'another fork block',
    (forked === null || forked.forkBlockHash !== target.hash) && 'another fork block hash',
    block?.hash !== target.hash && 'the fork block hash differs from the upstream',
  ].filter(Boolean);
  if (problems.length > 0) throw new Error(`The local node is not the expected fork: ${problems.join(', ')}.`);
  return { clientVersion };
}

/**
 * The variables the suite inherits from the runner's environment. The suite gets no other variable,
 * so no key in the runner's environment reaches the tests.
 */
const INHERITED_VARIABLES = ['PATH', 'HOME', 'TMPDIR', 'CI', 'NODE_OPTIONS'];

/**
 * Runs the fork suite. If anvil exits while the suite runs, the runner stops the suite and the run
 * fails. Whatever answers on the port afterwards is not the fork that the runner verified.
 */
function runJest(options, fork, target, files, log) {
  const env = {
    ...Object.fromEntries(
      INHERITED_VARIABLES.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])
    ),
    TZ: 'UTC',
    WRAPPED_FORK_LOCAL_RPC_URL: fork.localUrl,
    WRAPPED_FORK_BLOCK: String(target.number),
    WRAPPED_FORK_BLOCK_HASH: target.hash,
    WRAPPED_FORK_MODE: target.mode,
    WRAPPED_FORK_RESULTS: files.results,
    WRAPPED_FORK_JEST_RESULTS: files.jestReport,
    WRAPPED_FORK_SOLC_OUTPUT: options.solcOutput ?? '',
  };
  const args = [path.join(ROOT, 'node_modules/jest/bin/jest.js'), '--config', JEST_CONFIG, '--runInBand'];
  if (options.test !== undefined) args.push(options.test);
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const relay = (stream) =>
    lineRedactor((text) => {
      stream.write(text);
      log.write(text);
    });
  const stdout = relay(process.stdout);
  const stderr = relay(process.stderr);
  child.stdout.on('data', stdout.write);
  child.stdout.on('end', stdout.end);
  child.stderr.on('data', stderr.write);
  child.stderr.on('end', stderr.end);
  let anvilExited = false;
  const onAnvilExit = () => {
    anvilExited = true;
    if (!hasExited(child)) child.kill('SIGTERM');
  };
  fork.child.once('exit', onAnvilExit);
  // 'close', not 'exit': it comes after the child's output streams have ended.
  return new Promise((resolve) =>
    child.on('close', (code, signal) => {
      fork.child.off('exit', onAnvilExit);
      if (anvilExited) console.error('\nanvil exited while the suite ran, so the run fails.');
      resolve({ exitCode: anvilExited ? 1 : code ?? (signal ? 1 : 0), anvilExited });
    })
  );
}

/**
 * The JSON file at `file`, with each string in it redacted, or `missing` when there is no file.
 * The tests write failure messages into their files, and an upstream error can fill a message.
 */
function readRedacted(file, missing) {
  if (!fs.existsSync(file)) return missing;
  try {
    return redactStrings(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    throw new Error('The suite wrote a results file that is not valid JSON, so the run has no results.');
  }
}

/**
 * The cells, each held to Jest's own result for its test. A scenario records its cell when its body
 * settles, which can come after Jest failed the test, for example on a timeout. Such a cell fails.
 */
function heldToJest(results, jest) {
  const failures = new Map(
    (jest?.tests ?? []).filter((test) => test.status === 'failed').map((test) => [test.title, test.failure])
  );
  return results.map((result) => {
    const failure = failures.get(`${result.scenario} (${result.market})`);
    if (failure === undefined || result.status === 'fail') return result;
    return {
      ...result,
      status: 'fail',
      reason: `Jest failed this test after its scenario recorded ${result.status}: ${failure}`,
    };
  });
}

/**
 * Whether `run` failed only because the upstream failed to serve the fork's state. Every failed
 * cell must carry anvil's fetch error and no refusal by the chain. Jest must have failed no other
 * test, and the proxy must have seen the upstream fail or answer with an error.
 */
function failedOnUpstreamOnly(run) {
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

/** The matrix's rows, in the order a reader follows them. A scenario not listed here comes last. */
const SCENARIO_ORDER = [
  'deployment',
  'source-build',
  'supply-zero-allowance',
  'supply-sufficient-allowance',
  'supply-insufficient-allowance',
  'accrued-value',
  'partial-exit',
  'partial-exit-delayed',
  'partial-exit-held-open',
  'partial-exit-held-too-long',
  'full-exit',
  'dust',
  'pause',
  'insufficient-liquidity',
  'excessive-debit',
  'estimate-rose',
  'stale-state',
  'session-races',
  'other-connectors-and-watch-only',
  'direct-alongside',
  'standard-route-lending',
];

/** The scenario matrix as a Markdown table: one row per scenario, one column per market. */
function matrix(results) {
  const rank = (scenario) =>
    SCENARIO_ORDER.includes(scenario) ? SCENARIO_ORDER.indexOf(scenario) : SCENARIO_ORDER.length;
  const scenarios = [...new Set(results.map((result) => result.scenario))].sort((a, b) => rank(a) - rank(b));
  const columns = MARKET_COLUMNS.filter((market) => results.some((result) => result.market === market));
  const cell = (scenario, market) => {
    const found = results.filter((result) => result.scenario === scenario && result.market === market);
    if (found.length === 0) return '-';
    if (found.some((result) => result.status === 'fail')) return 'FAIL';
    if (found.every((result) => result.status === 'pass')) return 'pass';
    return 'not exercised';
  };
  return [
    `| Scenario | ${columns.join(' | ')} |`,
    `| --- | ${columns.map(() => '---').join(' | ')} |`,
    ...scenarios.map((scenario) => `| ${scenario} | ${columns.map((market) => cell(scenario, market)).join(' | ')} |`),
  ].join('\n');
}

/**
 * The exits of each market's supply-and-exit sequence against their receipts, in raw base units and
 * shares: the partial, one-slot, held-open and full exits. Each other signed exit records no
 * figures here, and its own scenario holds it to its quote. An exit is held to the quote of the
 * check before its signature when the suite recorded one (`cashMinusRecheck`), and to its review's
 * quote otherwise. An exit mined later than the quote's block has an upper bound.
 */
function deltas(results) {
  const rows = results
    .filter((result) => result.measurements?.paidCash !== undefined && result.measurements?.quotedCash !== undefined)
    .map(({ scenario, market, measurements: m }) => {
      const difference = m.cashMinusRecheck ?? m.cashMinusQuote ?? '-';
      const heldTo = m.cashMinusRecheck !== undefined ? 'the check' : 'the review';
      const tolerance = m.upperBound !== undefined ? `0 to ${m.upperBound}` : '0';
      return `| ${market} | ${scenario} | ${m.quotedShares ?? '-'} | ${m.burnedShares ?? '-'} | ${m.quotedCash} | ${
        m.recheckedCash ?? '-'
      } | ${m.paidCash} | ${heldTo} | ${difference} | ${tolerance} |`;
    });
  return [
    "| Market | Scenario | Quoted shares | Burned shares | Reviewed cash | Check's cash | Paid cash | Held to | Paid minus that quote | Tolerance |",
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** `endpoints` with `last` moved to the end, so that a retry tries the other endpoints first. */
const withLast = (endpoints, last) => [...endpoints.filter((endpoint) => endpoint !== last), last];

/** `count` and `noun`, with the noun's plural for any count but 1. */
const counted = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

const listed = (counts) =>
  [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([method, count]) => `${method} ${count}`)
    .join(', ');

/** The summary's lines on the proxy's use of the upstream during one run. */
function upstreamUse(stats) {
  const refused = [...stats.refused.values()].reduce((total, count) => total + count, 0);
  return [
    `  upstream use:  ${counted(stats.requests, 'request')} forwarded, ${stats.failures} failed upstream, ${counted(
      stats.errorAnswers,
      'call'
    )} answered with an error, ${refused} refused`,
    `  forwarded:     ${listed(stats.methods) || 'none'}`,
    ...(refused > 0 ? [`  refused:       ${listed(stats.refused)}`] : []),
    ...(stats.firstError !== undefined ? [`  first error:   ${stats.firstError}`] : []),
  ];
}

/** The summary's section on run 1, when the upstream's failure made the runner run once more. */
function firstRunSection(run) {
  const failed = run.results.filter((result) => result.status === 'fail');
  return [
    "## Run 1, which failed only because the upstream failed to serve the fork's state",
    `- fork block ${run.target.number}, hash ${run.target.hash}, from ${run.endpoint.label}`,
    ...upstreamUse(run.stats).map((line) => `- ${line.trim()}`),
    `- logs: ${run.files.anvil}, ${run.files.jest} and ${run.files.results}`,
    ...failed.map((result) => `- failed: ${result.market}, ${result.scenario}: ${result.reason}`),
    '',
  ];
}

/**
 * Runs the suite once, on a fork of `choice`, and returns what the summary needs. Run 2's logs and
 * results carry `-2` in their file names.
 */
async function runSuite({ choice, options, anvil, environment, logDir, number }) {
  const { endpoint, target } = choice;
  const suffix = number === 1 ? '' : `-${number}`;
  const files = { anvil: `anvil${suffix}.log`, jest: `jest${suffix}.log`, results: `results${suffix}.json` };
  fs.rmSync(path.join(logDir, files.results), { force: true });
  // The tests write their results into a directory that only this user can read. The runner writes
  // them to the log directory, redacted, when Jest ends. So no unredacted file stays there, even
  // after Ctrl-C.
  const privateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapped-lending-fork-results-'));
  temporaryDirectories.add(privateDirectory);
  const written = {
    results: path.join(privateDirectory, 'results.json'),
    jestReport: path.join(privateDirectory, 'jest-results.json'),
  };
  const proxy = await startUpstreamProxy(endpoint.url);
  servers.add(proxy.server);
  const anvilLog = fs.createWriteStream(path.join(logDir, files.anvil));
  const jestLog = fs.createWriteStream(path.join(logDir, files.jest));

  let exitCode = 1;
  let anvilExited = false;
  let fork;
  let header;
  try {
    fork = await startFork(anvil.command, proxy.url, target, options.port, anvilLog);
    header = [
      number === 1
        ? 'Wrapped lending fork run'
        : `Wrapped lending fork run ${number}, after run 1 failed on the upstream`,
      `  upstream:      ${endpoint.label}, through a proxy on 127.0.0.1`,
      `  fork block:    ${target.number} (${
        target.mode === 'pinned' ? "the registry's pinned block" : 'a recent block, not the pinned one'
      })`,
      `  block hash:    ${target.hash}`,
      `  block time:    ${new Date(target.timestamp * 1000).toISOString()}`,
      `  local fork:    ${fork.localUrl}, chain ID 1, ${HARDFORK} rules, no CORS`,
      `  tools:         node ${environment.node}, ${environment.anvil}, jest ${environment.jest}`,
      `  commit:        ${environment.commit}`,
      `  solc output:   ${options.solcOutput === undefined ? 'not given' : `sha256 ${environment.solcOutputSha256}`}`,
      "  signers:       accounts impersonated with anvil_impersonateAccount: Comet's pause guardian,",
      '                 and fresh addresses funded with anvil_setBalance and, for base tokens,',
      '                 anvil_setStorageAt on the balance slot. No private key is used, and nothing',
      '                 is sent to mainnet.',
      `  logs:          ${logDir}`,
    ].join('\n');
    console.log(header);
    const { clientVersion } = await verifyFork(fork, target);
    console.log(`  verified:      ${clientVersion} on 127.0.0.1, chain ID 1, fork block and hash match the upstream\n`);
    ({ exitCode, anvilExited } = await runJest(options, fork, target, written, jestLog));
  } finally {
    if (fork !== undefined) await stopped(fork.child);
    await Promise.all([anvilLog, jestLog].map((log) => new Promise((resolve) => log.end(resolve))));
    proxy.server.close();
    servers.delete(proxy.server);
  }
  const jest = readRedacted(written.jestReport, undefined);
  const results = heldToJest(readRedacted(written.results, []), jest);
  fs.writeFileSync(path.join(logDir, files.results), JSON.stringify(results, null, 2));
  return { endpoint, target, header, exitCode, anvilExited, files, jest, results, stats: proxy.stats };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const logDir = options.logDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wrapped-lending-fork-logs-'));
  fs.mkdirSync(logDir, { recursive: true });
  const endpoints = upstreamEndpoints();
  secretsToRedact = [...new Set(endpoints.flatMap((endpoint) => endpoint.secrets))].sort((a, b) => b.length - a.length);

  const anvil = findAnvil();
  const environment = {
    node: process.version,
    anvil: anvil.version,
    jest: JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/jest/package.json'), 'utf8')).version,
    commit: `${toolVersion('git', ['-C', ROOT, 'rev-parse', 'HEAD']) ?? 'unknown'}${
      spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim() === ''
        ? ''
        : ', with uncommitted changes'
    }`,
    solcOutputSha256:
      options.solcOutput === undefined
        ? 'not given'
        : createHash('sha256').update(fs.readFileSync(options.solcOutput)).digest('hex'),
  };

  const runs = [];
  let retryProblem;
  let choice = await chooseFork(endpoints, options.block);
  for (;;) {
    try {
      runs.push(await runSuite({ choice, options, anvil, environment, logDir, number: runs.length + 1 }));
    } catch (error) {
      if (runs.length === 0) throw error;
      retryProblem = redact(error?.message ?? error);
      break;
    }
    if (runs.length === 2 || !failedOnUpstreamOnly(runs[0])) break;
    // A recent block can leave the endpoint's window of recent state during a run, so the retry
    // forks a fresh one. The pinned block, or a given one, stays, so the retry tests the same state.
    const failedRun = runs[0];
    const freshBlock = options.block === 'recent' || (options.block === 'auto' && failedRun.target.mode === 'recent');
    console.log("\nRun 1 failed only because the upstream failed to serve the fork's state. Running once more.\n");
    try {
      choice = freshBlock
        ? await chooseFork(endpoints, 'recent')
        : await chooseFork(withLast(endpoints, failedRun.endpoint), String(failedRun.target.number));
    } catch (error) {
      retryProblem = redact(error?.message ?? error);
      break;
    }
  }

  const final = runs[runs.length - 1];
  const upstreamOnly = failedOnUpstreamOnly(final);
  // A cell that failed only because the upstream failed to serve the fork's state was not exercised.
  const results = upstreamOnly
    ? final.results.map((result) =>
        result.status === 'fail'
          ? {
              ...result,
              status: 'not-exercised',
              reason: `the upstream failed to serve the fork's state: ${result.reason}`,
            }
          : result
      )
    : final.results;
  const notExercised = results.filter((result) => result.status === 'not-exercised');
  const failed = results.filter((result) => result.status === 'fail');
  let exitCode = final.exitCode;
  if (exitCode === 0 && (results.length === 0 || failed.length > 0)) exitCode = 1;
  const verdict = exitCode === 0 ? 'PASS' : upstreamOnly ? 'NOT EXERCISED' : 'FAIL';
  const { stats } = final;
  const report = [
    final.header,
    ...upstreamUse(stats),
    '',
    ...(runs.length > 1 ? firstRunSection(runs[0]) : []),
    ...(retryProblem !== undefined ? [`The runner could not start a second run: ${retryProblem}`, ''] : []),
    '## Scenario matrix',
    matrix(results),
    '',
    "## The supply-and-exit sequence's exits against their quotes (raw base units, shares in share units)",
    deltas(results),
    '',
    `## Failed (${failed.length})`,
    ...failed.map((result) => `- ${result.market}, ${result.scenario}: ${result.reason}`),
    '',
    `## Not exercised (${notExercised.length})`,
    ...notExercised.map((result) => `- ${result.market}, ${result.scenario}: ${result.reason}`),
    '',
    ...(final.anvilExited
      ? [
          'anvil exited while the suite ran, so the run fails. Whatever answered on its port afterwards was not the fork that the runner verified. See the anvil log.',
          '',
        ]
      : []),
    ...(verdict === 'FAIL' && results.length === 0 && !final.anvilExited
      ? ['The run recorded no matrix cell. Check the --test pattern, and see the Jest log.', '']
      : []),
    ...(verdict === 'FAIL' && failed.length === 0 && results.length > 0 && !final.anvilExited
      ? [
          'No matrix cell failed, but the run did. A test outside the matrix failed, such as the network guard, or an error came after a cell passed. See the Jest log.',
          '',
        ]
      : []),
    ...(verdict === 'FAIL' && stats.failures + stats.errorAnswers > 0
      ? [
          `The upstream failed ${counted(stats.failures, 'request')} and answered ${counted(
            stats.errorAnswers,
            'call'
          )} with an error, so a failure above can come from the upstream, not the app. Run the suite again to tell them apart.`,
          '',
        ]
      : []),
    ...(verdict === 'NOT EXERCISED'
      ? [
          "The upstream failed to serve the fork's state, so the cells that needed it were not exercised. Use an archive RPC in WRAPPED_FORK_RPC_URL, or run the suite again.",
          '',
        ]
      : []),
    `Result: ${verdict}. The fork was stopped, and the runner's temporary directories were removed.`,
  ].join('\n');
  fs.writeFileSync(path.join(logDir, 'summary.md'), `${redact(report)}\n`);
  console.log(`\n${redact(report)}`);
  return exitCode;
}

process.on('SIGINT', () => {
  cleanUp();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanUp();
  process.exit(143);
});
process.on('exit', cleanUp);

main().then(
  (code) => {
    cleanUp();
    process.exit(code);
  },
  (error) => {
    console.error(`\n${redact(error?.message ?? error)}`);
    cleanUp();
    process.exit(1);
  }
);
