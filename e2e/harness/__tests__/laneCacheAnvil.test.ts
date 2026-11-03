/**
 * @jest-environment node
 */
// The union of lane caches with the real anvil 1.9.0, against a local stand-in for the upstream: two lanes
// read different state and change the fork, the promotion keeps only what they read, and a third anvil loads
// the union and answers both lanes' reads without asking the upstream again. It is skipped where anvil 1.9.0
// is not installed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { server as mswServer } from '../../../handlers/server';
import {
  anvilCacheFile,
  createRedactor,
  findAnvil,
  isCacheAnvil,
  loadForkCache,
  promoteLaneCaches,
  recordLoggedMethods,
  rpc,
  sharedCacheFile,
  startFork,
  stopChild,
  zstd,
  type Fork,
  type LaneCache,
} from '../fork';
import { FORK_BLOCK, FORK_HASH, startFakeNode, type FakeNode } from '../testing/testServers';

const anvil = (() => {
  try {
    return findAnvil();
  } catch {
    return undefined;
  }
})();
const describeWithAnvil = anvil !== undefined && isCacheAnvil(anvil.version) ? describe : describe.skip;

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const HOLDER = '0x1111111111111111111111111111111111111111';
const ZERO = `0x${'00'.repeat(32)}`;
const word = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;

/** The upstream's full header of the fork block, with the pinned hash. */
const BLOCK = {
  number: `0x${FORK_BLOCK.toString(16)}`,
  hash: FORK_HASH,
  parentHash: `0x${'11'.repeat(32)}`,
  nonce: '0x0000000000000000',
  sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
  logsBloom: `0x${'00'.repeat(256)}`,
  transactionsRoot: ZERO,
  stateRoot: ZERO,
  receiptsRoot: ZERO,
  miner: `0x${'00'.repeat(20)}`,
  difficulty: '0x0',
  totalDifficulty: '0x0',
  extraData: '0x',
  size: '0x100',
  gasLimit: '0x3938700',
  gasUsed: '0x0',
  timestamp: '0x6ad967bf',
  transactions: [],
  uncles: [],
  baseFeePerGas: '0x7',
  mixHash: ZERO,
  withdrawals: [],
  withdrawalsRoot: ZERO,
  blobGasUsed: '0x0',
  excessBlobGas: '0x0',
  parentBeaconBlockRoot: ZERO,
  requestsHash: ZERO,
};

let scratch: string;
let upstream: FakeNode;
beforeAll(() => mswServer.close());
beforeEach(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-lane-cache-anvil-'));
  fs.mkdirSync(path.join(scratch, 'cache'), { mode: 0o700 });
  // Each storage slot of the stand-in holds its own number, and every account holds 100 wei.
  upstream = await startFakeNode({
    eth_chainId: () => '0x1',
    eth_getBlockByNumber: () => BLOCK,
    eth_getBlockByHash: () => BLOCK,
    eth_gasPrice: () => '0x1',
    eth_getBalance: () => '0x64',
    eth_getTransactionCount: () => '0x0',
    eth_getCode: () => '0x',
    eth_getStorageAt: (params) => word(Number(params[1])),
  });
});
afterEach(async () => {
  await upstream.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Starts anvil with `home` as its cache home, and returns it with the methods its log shows. */
async function lane(home: string) {
  const methods = new Set<string>();
  let directory = '';
  const fork: Fork = await startFork({
    anvil: (anvil as { command: string }).command,
    upstreamUrl: `${upstream.url}/`,
    target: { number: FORK_BLOCK, hash: FORK_HASH, timestamp: 0, mode: 'pinned' },
    log: (text) => recordLoggedMethods(text, methods),
    redactor: createRedactor([]),
    cacheHome: home,
    onChild: (_, cwd) => (directory = cwd),
  });
  const call = <T>(method: string, params: unknown[] = []) => rpc<T>(fork.localUrl, method, params);
  // What verifyFork sends, which the gate expects to see in the log.
  await call('eth_chainId');
  await call('anvil_metadata');
  return {
    call,
    methods,
    stop: async (): Promise<Omit<LaneCache, 'lane'>> => {
      await stopChild(fork.child);
      fs.rmSync(directory, { recursive: true, force: true });
      return {
        runHome: home,
        methods,
        hasExitedCleanly: fork.child.exitCode === 0,
        anvilVersion: (anvil as { version: string }).version,
        isProxyListening: true,
      };
    },
  };
}

const storageReads = () =>
  upstream.calls.filter((call) => call.method === 'eth_getStorageAt').map((call) => call.params[1]);

describeWithAnvil('lane caches with anvil 1.9.0', () => {
  jest.setTimeout(90_000);

  test('the union keeps every lane’s reads and none of its changes, and a new anvil answers them from the cache', async () => {
    const root = path.join(scratch, 'cache');
    const shared = sharedCacheFile(root, 'public', FORK_BLOCK);
    const forkUrl = `${upstream.url}/`;

    const first = await lane(path.join(scratch, 'home-0'));
    expect(await first.call('eth_getStorageAt', [USDC, '0x7', 'latest'])).toBe(word(7));
    // Changes on the fork: a slot, and a balance of an account anvil first reads from the upstream.
    await first.call('anvil_setStorageAt', [USDC, '0x5', word(0x42)]);
    await first.call('anvil_setBalance', [HOLDER, '0x1000']);
    expect(await first.call('eth_getStorageAt', [USDC, '0x5', 'latest'])).toBe(word(0x42));
    const second = await lane(path.join(scratch, 'home-1'));
    expect(await second.call('eth_getStorageAt', [USDC, '0x9', 'latest'])).toBe(word(9));
    const lanes = [
      { lane: 0, ...(await first.stop()) },
      { lane: 1, ...(await second.stop()) },
    ];

    const promotion = promoteLaneCaches({
      cacheRoot: root,
      sharedFile: shared,
      blockNumber: FORK_BLOCK,
      forkHash: FORK_HASH,
      forkUrl,
      lanes,
    });
    expect(promotion).toMatchObject({ isPromoted: true, reason: 'promoted the union of 2 lanes' });
    const union = JSON.parse(zstd.zstdDecompressSync(fs.readFileSync(shared)).toString('utf8'));
    expect(union.storage[USDC]).toEqual({ '0x7': '0x7', '0x9': '0x9' });
    // The account anvil read before the harness set its balance holds the upstream's balance, not the change.
    expect(union.accounts[HOLDER].balance).toBe('0x64');

    // A new run's anvil loads the union, and reads both lanes' slots without the upstream. The changed slot,
    // never cached, is read from the upstream again and holds the upstream's value.
    const before = storageReads().length;
    const thirdHome = path.join(scratch, 'home-2');
    expect(loadForkCache({ sharedFile: shared, runHome: thirdHome, blockNumber: FORK_BLOCK, forkUrl })).toBe('warm');
    expect(fs.existsSync(anvilCacheFile(thirdHome, FORK_BLOCK, forkUrl))).toBe(true);
    const third = await lane(thirdHome);
    expect(await third.call('eth_getStorageAt', [USDC, '0x7', 'latest'])).toBe(word(7));
    expect(await third.call('eth_getStorageAt', [USDC, '0x9', 'latest'])).toBe(word(9));
    expect(await third.call('eth_getBalance', [HOLDER, 'latest'])).toBe('0x64');
    expect(storageReads().slice(before)).toEqual([]);
    expect(await third.call('eth_getStorageAt', [USDC, '0x5', 'latest'])).toBe(word(5));
    expect(storageReads().slice(before)).toEqual(['0x5']);
    await third.stop();
  });
});
