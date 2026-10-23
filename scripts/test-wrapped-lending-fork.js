// Runs the wrapped lending fork suite (COM-289) against a local Ethereum mainnet fork.
//
//   node scripts/test-wrapped-lending-fork.js [options]
//
//   --block auto|pinned|recent|<number>  The fork block. `auto`, the default, forks the pinned block
//                                        26244888 when the upstream serves its state, and otherwise
//                                        a recent block: the latest less 8.
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
// Without it, the runner uses public endpoints. Only this process holds the URL. anvil reaches the
// upstream through a proxy this process runs on 127.0.0.1, so anvil's arguments, logs, errors and
// JSON-RPC methods carry only the proxy's address. The runner also redacts the URL from every
// output it writes, and never passes it to the tests.
//
// The fork listens on 127.0.0.1 only, sends no CORS headers, and is stopped on exit, on Ctrl-C and
// on any error. The tests sign with impersonated accounts on the fork. Nothing is signed with a real
// key, and nothing is sent to mainnet.
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
 * The EVM rules the fork runs. anvil 1.2.3 knows no later mainnet hardfork, and its default for a
 * fork is Cancun. The wrappers and Comet behave the same under both. Gas prices calldata differently.
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
 * A failed test's reason that an upstream failure gives: the fork failed to fetch state or to answer.
 * A failure of any other kind is a test's own, and the runner never retries it.
 */
const UPSTREAM_REASON =
  /missing response|SERVER_ERROR|TIMEOUT|timeout exceeded|socket hang up|ECONNRESET|ECONNREFUSED|failed to get|error sending request|header not found/i;
/** The largest JSON-RPC body the proxy forwards: far above anything anvil sends. */
const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;

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
 * The upstream endpoints to try. A private URL is labelled, and every part of it that can carry a
 * key is redacted from every output: the whole URL, its host, its path and each path segment, its
 * query and each query value, and its user name and password.
 */
function upstreamEndpoints() {
  const privateUrl = process.env.WRAPPED_FORK_RPC_URL;
  if (privateUrl !== undefined && privateUrl !== '') {
    const url = new URL(privateUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('WRAPPED_FORK_RPC_URL must be an HTTP(S) URL.');
    }
    const secrets = [
      privateUrl,
      url.href,
      url.host,
      url.pathname,
      ...url.pathname.split('/'),
      url.search,
      ...[...url.searchParams.values()],
      url.username,
      url.password,
    ];
    return [{ label: 'WRAPPED_FORK_RPC_URL (private, not printed)', url: privateUrl, secrets }];
  }
  return PUBLIC_ENDPOINTS.map((url) => ({ label: `${url} (public)`, url, secrets: [] }));
}

let secretsToRedact = [];
const redact = (text) =>
  secretsToRedact
    .filter((secret) => secret.length >= 4)
    // The longest first, so a part never splits a longer secret before that secret is replaced.
    .sort((a, b) => b.length - a.length)
    .reduce((result, secret) => result.split(secret).join('<redacted>'), String(text));

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
 * block must have the hash the registry records, and its state must be readable: a balance read at
 * that block fails on a node that keeps only recent state.
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

/** The first endpoint and block the option allows, trying the pinned block first under `auto`. */
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

/**
 * Forwards anvil's JSON-RPC requests to the upstream, so that only this process holds the upstream
 * URL. It listens on 127.0.0.1 and refuses what a web page can send: a request with an Origin
 * header, a method other than POST, and a body that is not JSON. It never forwards an error's text,
 * which can name the upstream URL. It counts the requests the upstream failed.
 */
function startUpstreamProxy(upstreamUrl) {
  const stats = { requests: 0, failures: 0 };
  const server = http.createServer((request, response) => {
    const refuse = (status) => {
      response.writeHead(status, { 'content-type': 'text/plain' });
      response.end();
    };
    if (request.headers.origin !== undefined) return refuse(403);
    if (request.method !== 'POST') return refuse(405);
    if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) return refuse(415);
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_PROXY_BODY_BYTES) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', async () => {
      stats.requests += 1;
      try {
        const upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: Buffer.concat(chunks),
          signal: AbortSignal.timeout(60_000),
        });
        const body = Buffer.from(await upstream.arrayBuffer());
        if (upstream.status >= 400) stats.failures += 1;
        response.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
        });
        response.end(body);
      } catch {
        stats.failures += 1;
        refuse(502);
      }
    });
  });
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

/** Waits for `child` to exit, killing it if it outlives `timeoutMs`. */
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
 * anvil binds a free port itself and the runner reads it from anvil's own output, so no other
 * process can take the port between its choice and the bind.
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
 * Runs the fork suite. If anvil exits while the suite runs, the suite is stopped and the run
 * fails, because whatever answers on the port afterwards is not the fork the runner verified.
 */
function runJest(options, fork, target, resultsPath, log) {
  const env = {
    ...process.env,
    TZ: 'UTC',
    WRAPPED_FORK_LOCAL_RPC_URL: fork.localUrl,
    WRAPPED_FORK_BLOCK: String(target.number),
    WRAPPED_FORK_BLOCK_HASH: target.hash,
    WRAPPED_FORK_MODE: target.mode,
    WRAPPED_FORK_RESULTS: resultsPath,
    WRAPPED_FORK_SOLC_OUTPUT: options.solcOutput ?? '',
  };
  // The tests talk to the local fork only.
  delete env.WRAPPED_FORK_RPC_URL;
  delete env.ETH_RPC_URL;
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
      resolve(anvilExited ? 1 : code ?? (signal ? 1 : 0));
    })
  );
}

function readResults(resultsPath) {
  if (!fs.existsSync(resultsPath)) return [];
  // The tests write failure messages, which an upstream error can fill, into the results file.
  const text = redact(fs.readFileSync(resultsPath, 'utf8'));
  fs.writeFileSync(resultsPath, text);
  return JSON.parse(text);
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
 * Each signed exit against its receipt, in raw base units and shares. An exit is held to the quote
 * of the check before its signature when the suite recorded one (`cashMinusRecheck`), and to its
 * review's quote otherwise. An exit mined later than the quote's block has an upper bound.
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
    "| Market | Scenario | Quoted shares | Burned shares | Reviewed cash | Check's cash | Paid cash | Held to | Paid less that quote | Tolerance |",
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const logDir = options.logDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wrapped-lending-fork-logs-'));
  fs.mkdirSync(logDir, { recursive: true });
  const endpoints = upstreamEndpoints();
  secretsToRedact = endpoints.flatMap((endpoint) => endpoint.secrets);

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

  let runs = 0;
  let exitCode = 1;
  let summary;
  const earlierFailures = [];
  for (;;) {
    runs += 1;
    // A retry chooses again: the same endpoint and pinned block if it serves them, or a fresh recent block.
    const { endpoint, target } = await chooseFork(endpoints, options.block);
    const proxy = await startUpstreamProxy(endpoint.url);
    servers.add(proxy.server);
    const anvilLog = fs.createWriteStream(path.join(logDir, runs === 1 ? 'anvil.log' : `anvil-${runs}.log`));
    const jestLog = fs.createWriteStream(path.join(logDir, runs === 1 ? 'jest.log' : `jest-${runs}.log`));
    const resultsPath = path.join(logDir, runs === 1 ? 'results.json' : `results-${runs}.json`);
    fs.rmSync(resultsPath, { force: true });

    let fork;
    let header;
    try {
      fork = await startFork(anvil.command, proxy.url, target, options.port, anvilLog);
      header = [
        `Wrapped lending fork run ${runs}`,
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
        '  signers:       fresh addresses impersonated with anvil_impersonateAccount, 100 ETH from',
        '                 anvil_setBalance, base tokens from anvil_setStorageAt on the balance slot.',
        '                 No private key is used and nothing is sent to mainnet.',
        `  logs:          ${logDir}`,
      ].join('\n');
      console.log(header);
      const { clientVersion } = await verifyFork(fork, target);
      console.log(
        `  verified:      ${clientVersion} on 127.0.0.1, chain ID 1, fork block and hash match the upstream\n`
      );
      exitCode = await runJest(options, fork, target, resultsPath, jestLog);
    } finally {
      if (fork !== undefined) await stopped(fork.child);
      await Promise.all([anvilLog, jestLog].map((log) => new Promise((resolve) => log.end(resolve))));
      proxy.server.close();
      servers.delete(proxy.server);
    }

    const results = readResults(resultsPath);
    const failed = results.filter((result) => result.status === 'fail');
    const upstream = `${proxy.stats.requests} upstream requests through the proxy, ${proxy.stats.failures} failed`;
    console.log(`\n${upstream}.`);
    summary = { header: `${header}\n  upstream use:  ${upstream}`, target, endpoint: endpoint.label, results, runs };
    // Retry once, and only when the upstream failed requests and every failed test failed for that.
    const isUpstreamFailure =
      exitCode !== 0 &&
      proxy.stats.failures > 0 &&
      failed.length > 0 &&
      failed.every((result) => UPSTREAM_REASON.test(String(result.reason)));
    if (isUpstreamFailure && runs < 2) {
      earlierFailures.push(
        ...failed.map((result) => `- run ${runs}: ${result.market}, ${result.scenario}: ${result.reason}`)
      );
      console.log('\nEvery failure in this run came from the upstream. Retrying once from a fresh fork.\n');
      continue;
    }
    if (exitCode === 0 && (results.length === 0 || failed.length > 0)) exitCode = 1;
    break;
  }

  const { results } = summary;
  const notExercised = results.filter((result) => result.status === 'not-exercised');
  const failed = results.filter((result) => result.status === 'fail');
  const report = [
    summary.header,
    '',
    '## Scenario matrix',
    matrix(results),
    '',
    '## Signed exits against their quotes (raw base units, shares in share units)',
    deltas(results),
    '',
    `## Failed (${failed.length})`,
    ...failed.map((result) => `- ${result.market}, ${result.scenario}: ${result.reason}`),
    '',
    `## Not exercised (${notExercised.length})`,
    ...notExercised.map((result) => `- ${result.market}, ${result.scenario}: ${result.reason}`),
    '',
    ...(summary.runs > 1
      ? [
          `This report is from run ${summary.runs}. Run 1 failed only on upstream errors, listed below. Its logs are anvil.log, jest.log and results.json.`,
          ...earlierFailures,
          '',
        ]
      : []),
    `Result: ${exitCode === 0 ? 'PASS' : 'FAIL'}. The fork was stopped and its temporary directory removed.`,
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
