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
// The runner retries a run once, and only when the upstream failed to serve the fork's state:
// - At least one cell failed, and every failed cell carries anvil's own fetch error and no revert.
// - Jest reported its results and failed no other test. No suite failed outside its tests, as one
//   does when it fails to load or its afterAll hook throws. anvil did not exit.
// - The proxy saw the upstream fail a request or answer a call with an error.
// A recent-block run retries from a fresh recent block. A run at the pinned block, or at a given
// block, retries at the same block. It tries the other endpoints first and the failed one last. If
// the last run fails only that way too, its failed cells are recorded as not exercised, and the run
// fails.
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
//
// The redaction, the proxy, the cell rules and the retry rule are in `scripts/lib/wrapped-fork-runner.js`.
// `yarn test:fork-runner` tests them.
import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  createRedactor,
  failedOnUpstreamOnly,
  heldToJest,
  MARKET_COLUMNS,
  PINNED_BLOCK,
  PINNED_HASH,
  startUpstreamProxy,
  upstreamEndpoints,
  withLast,
} from './lib/wrapped-fork-runner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JEST_CONFIG = path.join(ROOT, '__tests__/integration/wrappedLendingFork/jest.config.js');
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

/** The redaction of the private URL from every output. `main` sets it once it knows the endpoints. */
let redaction = createRedactor([]);

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
        problems.push(`${endpoint.label}, ${attempt} block: ${redaction.redact(error.message)}`);
      }
    }
  }
  throw new Error(`No upstream endpoint can serve the fork:\n  ${problems.join('\n  ')}`);
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
  const stdout = redaction.lineRedactor((text) => {
    log.write(text);
    const listening = /Listening on 127\.0\.0\.1:(\d+)/.exec(text);
    if (listening !== null) boundPort = Number(listening[1]);
  });
  const stderr = redaction.lineRedactor((text) => log.write(text));
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
function runJest(options, fork, target, privateFiles, log) {
  const env = {
    ...Object.fromEntries(
      INHERITED_VARIABLES.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])
    ),
    TZ: 'UTC',
    WRAPPED_FORK_LOCAL_RPC_URL: fork.localUrl,
    WRAPPED_FORK_BLOCK: String(target.number),
    WRAPPED_FORK_BLOCK_HASH: target.hash,
    WRAPPED_FORK_MODE: target.mode,
    WRAPPED_FORK_RESULTS: privateFiles.results,
    WRAPPED_FORK_JEST_RESULTS: privateFiles.jestReport,
    WRAPPED_FORK_SOLC_OUTPUT: options.solcOutput ?? '',
  };
  const args = [path.join(ROOT, 'node_modules/jest/bin/jest.js'), '--config', JEST_CONFIG, '--runInBand'];
  if (options.test !== undefined) args.push(options.test);
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const relay = (stream) =>
    redaction.lineRedactor((text) => {
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
    return redaction.redactStrings(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    throw new Error('The suite wrote a results file that is not valid JSON, so the run has no results.');
  }
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
    `- logs: ${run.logFiles.anvil}, ${run.logFiles.jest} and ${run.logFiles.results}`,
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
  const logFiles = { anvil: `anvil${suffix}.log`, jest: `jest${suffix}.log`, results: `results${suffix}.json` };
  // The tests write their results into a directory that only this user can read. The runner writes
  // them to the log directory, redacted, when Jest ends. So no unredacted file stays there, even
  // after Ctrl-C.
  const privateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapped-lending-fork-results-'));
  temporaryDirectories.add(privateDirectory);
  const privateFiles = {
    results: path.join(privateDirectory, 'results.json'),
    jestReport: path.join(privateDirectory, 'jest-results.json'),
  };
  const proxy = await startUpstreamProxy(endpoint.url, { printable: redaction.printable });
  servers.add(proxy.server);
  const anvilLog = fs.createWriteStream(path.join(logDir, logFiles.anvil));
  const jestLog = fs.createWriteStream(path.join(logDir, logFiles.jest));

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
    ({ exitCode, anvilExited } = await runJest(options, fork, target, privateFiles, jestLog));
  } finally {
    if (fork !== undefined) await stopped(fork.child);
    await Promise.all([anvilLog, jestLog].map((log) => new Promise((resolve) => log.end(resolve))));
    proxy.server.close();
    servers.delete(proxy.server);
  }
  const jest = readRedacted(privateFiles.jestReport, undefined);
  const results = heldToJest(readRedacted(privateFiles.results, []), jest);
  fs.writeFileSync(path.join(logDir, logFiles.results), JSON.stringify(results, null, 2));
  return { endpoint, target, header, exitCode, anvilExited, logFiles, jest, results, stats: proxy.stats };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const logDir = options.logDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wrapped-lending-fork-logs-'));
  fs.mkdirSync(logDir, { recursive: true });
  // A reused log directory keeps no file from an earlier invocation, even if this one stops before
  // its first run starts.
  const runFiles = ['anvil.log', 'jest.log', 'results.json', 'anvil-2.log', 'jest-2.log', 'results-2.json'];
  for (const file of [...runFiles, 'summary.md']) fs.rmSync(path.join(logDir, file), { force: true });
  const endpoints = upstreamEndpoints();
  redaction = createRedactor(endpoints.flatMap((endpoint) => endpoint.secrets));

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
      retryProblem = redaction.redact(error?.message ?? error);
      break;
    }
    if (runs.length === 2 || !failedOnUpstreamOnly(runs[0])) break;
    // A recent block can leave the endpoint's window of recent state during a run, so the retry
    // forks a fresh one. The pinned block, or a given one, stays, so the retry tests the same state.
    const failedRun = runs[0];
    const isRecentBlockRun =
      options.block === 'recent' || (options.block === 'auto' && failedRun.target.mode === 'recent');
    console.log("\nRun 1 failed only because the upstream failed to serve the fork's state. Running once more.\n");
    try {
      choice = isRecentBlockRun
        ? await chooseFork(endpoints, 'recent')
        : await chooseFork(withLast(endpoints, failedRun.endpoint), String(failedRun.target.number));
    } catch (error) {
      retryProblem = redaction.redact(error?.message ?? error);
      break;
    }
  }

  const final = runs[runs.length - 1];
  const isUpstreamOnly = failedOnUpstreamOnly(final);
  // A cell that failed only because the upstream failed to serve the fork's state was not exercised.
  const results = isUpstreamOnly
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
  const verdict = exitCode === 0 ? 'PASS' : isUpstreamOnly ? 'NOT EXERCISED' : 'FAIL';
  // The last run's results file says what the summary says.
  fs.writeFileSync(path.join(logDir, final.logFiles.results), JSON.stringify(results, null, 2));
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
  fs.writeFileSync(path.join(logDir, 'summary.md'), `${redaction.redact(report)}\n`);
  console.log(`\n${redaction.redact(report)}`);
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
    console.error(`\n${redaction.redact(error?.message ?? error)}`);
    cleanUp();
    process.exit(1);
  }
);
