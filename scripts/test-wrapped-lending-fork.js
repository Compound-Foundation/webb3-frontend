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
//   --port <number>                      The fork's local port. Default: a free port.
//   --test <pattern>                     Runs only the fork suites whose path matches.
//
// The upstream RPC comes from WRAPPED_FORK_RPC_URL, a private variable for an archive-capable
// mainnet RPC. It is never printed, logged or passed to the tests, and it stays out of the process
// list: anvil reads it through an alias in a temporary foundry.toml. Never use a VITE_ variable for
// it, because Vite embeds those in the public bundle. Without it, the runner uses public endpoints.
//
// The fork listens on 127.0.0.1 only and is stopped on exit, on Ctrl-C and on any error. The tests
// sign with impersonated accounts on the fork. Nothing is signed with a real key, and nothing is
// sent to mainnet.
import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JEST_CONFIG = path.join(ROOT, '__tests__/integration/wrappedLendingFork/jest.config.js');
/** The block docs/anchorage-wrapper-registry.md records its deployment reads at, and its hash. */
const PINNED_BLOCK = 26244888;
const PINNED_HASH = '0x440c51a6a6953b880568c1b60e4ad59044f3fa783e340e34d66793e466883839';
/** A recent fork stays this many blocks behind the latest, so it is final on any endpoint. */
const RECENT_BLOCK_LAG = 8;
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
 * Upstream failures in anvil's log that justify one more run from a fresh fork. Whole phrases only:
 * the log is full of hashes and addresses, so a bare number such as 429 matches them.
 */
const UPSTREAM_FAILURE =
  /error sending request|failed to get (account|storage|code|block|balance|nonce)|missing trie node|header not found|too many requests|rate limited|status code 429|HTTP error 429|request timed out|operation timed out/i;

function parseArgs(argv) {
  const options = { block: 'auto', solcOutput: undefined, logDir: undefined, port: undefined, test: undefined };
  for (let index = 0; index < argv.length; index++) {
    const [flag, inline] = argv[index].split('=', 2);
    const value = () => inline ?? argv[++index];
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
  if (options.port !== undefined && !(Number.isInteger(options.port) && options.port > 0 && options.port < 65536)) {
    throw new Error('--port takes a port number.');
  }
  if (options.solcOutput !== undefined && !fs.existsSync(options.solcOutput)) {
    throw new Error('--solc-output names no file.');
  }
  return options;
}

/** The upstream endpoints to try. A private URL is labelled, and its text is redacted from every output. */
function upstreamEndpoints() {
  const privateUrl = process.env.WRAPPED_FORK_RPC_URL;
  if (privateUrl !== undefined && privateUrl !== '') {
    const url = new URL(privateUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error('WRAPPED_FORK_RPC_URL must be an HTTP(S) URL.');
    const secrets = [
      privateUrl,
      url.host,
      url.pathname.length > 1 ? url.pathname : '',
      url.search,
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
    .reduce((result, secret) => result.split(secret).join('<redacted>'), String(text));

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
    if (block === 'pinned' && header.hash !== PINNED_HASH) throw new Error(`block ${number} has another hash`);
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
async function chooseFork(endpoints, option, skip = new Set()) {
  const attempts = option === 'auto' ? ['pinned', 'recent'] : [option];
  const problems = [];
  for (const attempt of attempts) {
    for (const endpoint of endpoints) {
      if (skip.has(`${endpoint.url}|${attempt}`)) continue;
      try {
        const target = await forkTarget(endpoint, attempt);
        if (target !== undefined) return { endpoint, target, attempt };
        problems.push(`${endpoint.label}: no block for ${attempt}`);
      } catch (error) {
        problems.push(`${endpoint.label}, ${attempt} block: ${redact(error.message)}`);
      }
    }
  }
  throw new Error(`No upstream endpoint can serve the fork:\n  ${problems.join('\n  ')}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
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
const temporaryDirectories = new Set();

function stopChildren(signal = 'SIGTERM') {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

function cleanUp() {
  stopChildren('SIGKILL');
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
}

/** Waits for `child` to exit, killing it if it outlives `timeoutMs`. */
function stopped(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
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
 * Starts anvil on 127.0.0.1, forked from `target` on `endpoint`. The upstream URL reaches anvil only
 * through its environment and an alias in a temporary foundry.toml, never through its arguments, and
 * anvil's own output, which prints the endpoint, is redacted before it is logged.
 */
async function startFork(anvilCommand, endpoint, target, port, log) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapped-lending-fork-'));
  temporaryDirectories.add(directory);
  fs.writeFileSync(
    path.join(directory, 'foundry.toml'),
    '[rpc_endpoints]\nwrapped_fork = "${WRAPPED_FORK_UPSTREAM}"\n'
  );
  const args = [
    '--fork-url',
    'wrapped_fork',
    '--fork-block-number',
    String(target.number),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--chain-id',
    '1',
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
  const child = spawn(anvilCommand, args, {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, WRAPPED_FORK_UPSTREAM: endpoint.url },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.stdout.on('data', (chunk) => log.write(redact(chunk)));
  child.stderr.on('data', (chunk) => log.write(redact(chunk)));
  const localUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('anvil exited before it was ready. See anvil.log.');
    try {
      await rpc(localUrl, 'eth_chainId', [], 2_000);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('anvil was not ready within 60 s. See anvil.log.');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return { child, localUrl };
}

/** Refuses to run unless the local node is the anvil fork of `target`, on chain 1, bound to loopback. */
async function verifyFork(localUrl, target) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(localUrl)) throw new Error('The fork must listen on 127.0.0.1.');
  const [chainId, clientVersion, metadata, block] = await Promise.all([
    rpc(localUrl, 'eth_chainId'),
    rpc(localUrl, 'web3_clientVersion'),
    rpc(localUrl, 'anvil_metadata'),
    rpc(localUrl, 'eth_getBlockByNumber', [hex(target.number), false]),
  ]);
  const forked = metadata.forkedNetwork;
  const problems = [
    chainId !== '0x1' && `chain ID ${chainId}`,
    !String(clientVersion).startsWith('anvil/') && `client ${clientVersion}`,
    (forked === null || Number(forked.forkBlockNumber) !== target.number) && 'another fork block',
    (forked === null || forked.forkBlockHash !== target.hash) && 'another fork block hash',
    block?.hash !== target.hash && 'the fork block hash differs from the upstream',
  ].filter(Boolean);
  if (problems.length > 0) throw new Error(`The local node is not the expected fork: ${problems.join(', ')}.`);
  return { clientVersion };
}

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
  delete env.WRAPPED_FORK_UPSTREAM;
  delete env.ETH_RPC_URL;
  const args = [path.join(ROOT, 'node_modules/jest/bin/jest.js'), '--config', JEST_CONFIG, '--runInBand'];
  if (options.test !== undefined) args.push(options.test);
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const relay = (stream) => (chunk) => {
    const text = redact(chunk);
    stream.write(text);
    log.write(text);
  };
  child.stdout.on('data', relay(process.stdout));
  child.stderr.on('data', relay(process.stderr));
  return new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))));
}

function readResults(resultsPath) {
  return fs.existsSync(resultsPath) ? JSON.parse(fs.readFileSync(resultsPath, 'utf8')) : [];
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

  const tried = new Set();
  let runs = 0;
  let exitCode = 1;
  let summary;
  for (;;) {
    runs += 1;
    const { endpoint, target, attempt } = await chooseFork(endpoints, options.block, tried);
    tried.add(`${endpoint.url}|${attempt}`);
    const port = options.port ?? (await freePort());
    const anvilLog = fs.createWriteStream(path.join(logDir, runs === 1 ? 'anvil.log' : `anvil-${runs}.log`));
    const jestLog = fs.createWriteStream(path.join(logDir, runs === 1 ? 'jest.log' : `jest-${runs}.log`));
    const resultsPath = path.join(logDir, runs === 1 ? 'results.json' : `results-${runs}.json`);
    fs.rmSync(resultsPath, { force: true });

    const header = [
      `Wrapped lending fork run ${runs}`,
      `  upstream:      ${endpoint.label}`,
      `  fork block:    ${target.number} (${
        target.mode === 'pinned' ? "the registry's pinned block" : 'a recent block, not the pinned one'
      })`,
      `  block hash:    ${target.hash}`,
      `  block time:    ${new Date(target.timestamp * 1000).toISOString()}`,
      `  local fork:    http://127.0.0.1:${port}, chain ID 1`,
      `  tools:         node ${environment.node}, ${environment.anvil}, jest ${environment.jest}`,
      `  commit:        ${environment.commit}`,
      `  solc output:   ${options.solcOutput === undefined ? 'not given' : `sha256 ${environment.solcOutputSha256}`}`,
      '  signers:       fresh addresses impersonated with anvil_impersonateAccount, 100 ETH from',
      '                 anvil_setBalance, base tokens from anvil_setStorageAt on the balance slot.',
      '                 No private key is used and nothing is sent to mainnet.',
      `  logs:          ${logDir}`,
    ].join('\n');
    console.log(header);

    let fork;
    try {
      fork = await startFork(anvil.command, endpoint, target, port, anvilLog);
      const { clientVersion } = await verifyFork(fork.localUrl, target);
      console.log(
        `  verified:      ${clientVersion} on 127.0.0.1, chain ID 1, fork block and hash match the upstream\n`
      );
      exitCode = await runJest(options, fork, target, resultsPath, jestLog);
    } finally {
      if (fork !== undefined) await stopped(fork.child);
      await Promise.all([anvilLog, jestLog].map((log) => new Promise((resolve) => log.end(resolve))));
    }

    const results = readResults(resultsPath);
    const anvilOutput = fs.readFileSync(anvilLog.path, 'utf8');
    const failed = results.filter((result) => result.status === 'fail');
    const isUpstreamFailure = exitCode !== 0 && UPSTREAM_FAILURE.test(anvilOutput);
    summary = { header, target, endpoint: endpoint.label, results, exitCode, runs };
    if (isUpstreamFailure && runs < 2) {
      console.log('\nThe upstream failed during the run. Retrying once from a fresh fork.\n');
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
    '## Quoted exits against receipts (raw base units, shares in share units)',
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
          `This report is from run ${summary.runs}. Run 1 stopped on an upstream error. Its logs are anvil.log and jest.log.`,
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
