/**
 * @jest-environment node
 */
// The promotion of several lanes' fork caches at the end of a run: each lane passes the gates on its own, and
// the shared file becomes the union of what it held and what every eligible lane read from the upstream.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { server as mswServer } from '../../../handlers/server';
import {
  ALWAYS_LOGGED_METHODS,
  anvilCacheFile,
  laneCacheGate,
  promoteLaneCaches,
  sharedCacheFile,
  zstd,
  type LaneCache,
} from '../fork';

beforeAll(() => mswServer.close());

const BLOCK = 26244888;
const FORK_URL = 'http://127.0.0.1:18546/';
const META = {
  block_env: { number: `0x${BLOCK.toString(16)}` },
  hosts: ['127.0.0.1'],
  fork_hash: `0x${'44'.repeat(32)}`,
  source_id: `0x${'88'.repeat(32)}`,
};
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

type Content = {
  meta: typeof META;
  accounts: Record<string, unknown>;
  storage: Record<string, Record<string, string>>;
  block_hashes: Record<string, string>;
  block_hash_cache_version: number;
};
const content = (parts: Partial<Content> = {}): Content => ({
  meta: META,
  accounts: {},
  storage: {},
  block_hashes: { '0x1907718': META.fork_hash },
  block_hash_cache_version: 1,
  ...parts,
});
const account = (balance: string) => ({ balance, nonce: 0, code_hash: `0x${'c5'.repeat(32)}`, code: null });
const encode = (value: unknown) => zstd.zstdCompressSync(JSON.stringify(value));
const decode = (file: string) => JSON.parse(zstd.zstdDecompressSync(fs.readFileSync(file)).toString('utf8'));

let scratch: string;
let root: string;
let shared: string;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-fork-merge-test-'));
  root = path.join(scratch, 'cache');
  fs.mkdirSync(root, { mode: 0o700 });
  shared = sharedCacheFile(root, 'public', BLOCK);
});
afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

const writeShared = (value: unknown) => {
  fs.mkdirSync(path.dirname(shared), { recursive: true, mode: 0o700 });
  fs.writeFileSync(shared, encode(value));
};

/** A lane that stopped cleanly after the harness's own calls, with `value` as its anvil's cache file. */
const lane = (index: number, value: unknown, overrides: Partial<LaneCache> = {}): LaneCache => {
  const runHome = path.join(scratch, 'private', `anvil-home-${index}`);
  const file = anvilCacheFile(runHome, BLOCK, FORK_URL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (value !== undefined) fs.writeFileSync(file, encode(value));
  return {
    lane: index,
    runHome,
    methods: ['eth_call', 'anvil_reset', ...ALWAYS_LOGGED_METHODS],
    hasExitedCleanly: true,
    anvilVersion: 'anvil Version: 1.9.0-stable (6056c5845d 2026-11-02T20:16:54.701302000Z)',
    isProxyListening: true,
    ...overrides,
  };
};

const promote = (lanes: LaneCache[]) =>
  promoteLaneCaches({
    cacheRoot: root,
    sharedFile: shared,
    blockNumber: BLOCK,
    forkHash: META.fork_hash,
    forkUrl: FORK_URL,
    lanes,
  });

test('the shared file becomes the union of its entries and every lane’s, down to single storage slots', () => {
  writeShared(content({ accounts: { [A]: account('0x1') }, storage: { [USDC]: { '0x0': '0x1' } } }));
  const result = promote([
    lane(
      0,
      content({
        accounts: { [A]: account('0x1'), [B]: account('0x2') },
        storage: { [USDC]: { '0x0': '0x1', '0x5': '0x9' } },
      })
    ),
    lane(
      1,
      content({
        accounts: { [A]: account('0x1'), [C]: account('0x3') },
        storage: { [USDC]: { '0x0': '0x1', '0x7': '0x8' } },
      })
    ),
  ]);
  expect(result).toEqual({
    isPromoted: true,
    reason: 'promoted the union of 2 lanes',
    lanes: [
      { lane: 0, isMerged: true, reason: 'merged 2 new entries' },
      { lane: 1, isMerged: true, reason: 'merged 2 new entries' },
    ],
  });
  const merged = decode(shared);
  expect(Object.keys(merged.accounts).sort()).toEqual([A, B, C]);
  expect(merged.storage[USDC]).toEqual({ '0x0': '0x1', '0x5': '0x9', '0x7': '0x8' });
  expect(merged.meta).toEqual(META);
  expect(merged.block_hash_cache_version).toBe(1);
  // Nothing but the shared file is left beside it.
  expect(fs.readdirSync(path.dirname(shared))).toEqual([path.basename(shared)]);
});

test('with no shared file yet, the union of the lanes is promoted', () => {
  const result = promote([
    lane(0, content({ accounts: { [A]: account('0x1') } })),
    lane(1, content({ accounts: { [B]: account('0x2') } })),
  ]);
  expect(result.isPromoted).toBe(true);
  expect(Object.keys(decode(shared).accounts).sort()).toEqual([A, B]);
});

test('a lane that fails a gate is left out whole, and the other lanes are still promoted', () => {
  writeShared(content({ accounts: { [A]: account('0x1') } }));
  const result = promote([
    lane(0, content({ accounts: { [A]: account('0x1'), [B]: account('0x2') } }), { hasExitedCleanly: false }),
    lane(1, content({ accounts: { [A]: account('0x1'), [C]: account('0x3') } }), {
      methods: [...ALWAYS_LOGGED_METHODS, 'anvil_setRpcUrl'],
    }),
    lane(2, content({ accounts: { [A]: account('0x1'), [C]: account('0x3') } }), { isProxyListening: false }),
    lane(3, content({ accounts: { [A]: account('0x1'), [C]: account('0x3') } }), {
      anvilVersion: 'anvil Version: 1.2.3',
    }),
    lane(4, content({ storage: { [USDC]: { '0x3': '0x4' } } })),
  ]);
  expect(result.lanes).toEqual([
    { lane: 0, isMerged: false, reason: 'anvil did not exit cleanly' },
    { lane: 1, isMerged: false, reason: 'the fork was sent anvil_setRpcUrl' },
    { lane: 2, isMerged: false, reason: 'the upstream proxy stopped before anvil' },
    { lane: 3, isMerged: false, reason: 'the cache is promoted only from anvil 1.9.0' },
    { lane: 4, isMerged: true, reason: 'merged 1 new entry' },
  ]);
  const merged = decode(shared);
  expect(Object.keys(merged.accounts)).toEqual([A]);
  expect(merged.storage).toEqual({ [USDC]: { '0x3': '0x4' } });
});

test('a lane with a value that differs from one already held is left out whole: the block state never changes', () => {
  writeShared(content({ accounts: { [A]: account('0x1') } }));
  const result = promote([
    // A changed balance, as a local mutation would be, beside a new account that must not be promoted either.
    lane(0, content({ accounts: { [A]: account('0x999'), [B]: account('0x2') } })),
    lane(1, content({ accounts: { [C]: account('0x3') }, storage: { [USDC]: { '0x0': '0x1' } } })),
    lane(2, content({ storage: { [USDC]: { '0x0': '0x2' } } })),
  ]);
  expect(result.lanes).toEqual([
    { lane: 0, isMerged: false, reason: `its accounts entry ${A} differs from the one already held` },
    { lane: 1, isMerged: true, reason: 'merged 2 new entries' },
    { lane: 2, isMerged: false, reason: `its storage entry ${USDC} 0x0 differs from the one already held` },
  ]);
  const merged = decode(shared);
  expect(merged.accounts[A]).toEqual(account('0x1'));
  expect(Object.keys(merged.accounts).sort()).toEqual([A, C]);
  expect(merged.storage).toEqual({ [USDC]: { '0x0': '0x1' } });
});

test('a lane of another fork, block or format is left out, and a shared file of another fork is replaced', () => {
  writeShared(content({ meta: { ...META, source_id: `0x${'99'.repeat(32)}` }, accounts: { [C]: account('0x3') } }));
  const result = promote([
    lane(0, content({ meta: { ...META, fork_hash: `0x${'45'.repeat(32)}` }, accounts: { [B]: account('0x2') } })),
    lane(1, content({ block_hash_cache_version: 2, accounts: { [B]: account('0x2') } })),
    lane(2, { meta: { block_env: { number: '0x1' } }, accounts: {} }),
    lane(3, undefined),
    lane(4, content({ accounts: { [A]: account('0x1') } })),
    // The first merged lane sets the fork every other file must match in full.
    lane(5, content({ meta: { ...META, source_id: `0x${'77'.repeat(32)}` }, accounts: { [B]: account('0x2') } })),
  ]);
  expect(result.lanes).toEqual([
    { lane: 0, isMerged: false, reason: 'its cache is of another fork' },
    { lane: 1, isMerged: false, reason: 'its cache is in a format the harness does not merge' },
    { lane: 2, isMerged: false, reason: 'anvil wrote no cache of the block' },
    { lane: 3, isMerged: false, reason: 'anvil wrote no cache of the block' },
    // Its account and the block hash: the shared file of another fork contributed nothing.
    { lane: 4, isMerged: true, reason: 'merged 2 new entries' },
    { lane: 5, isMerged: false, reason: 'its cache is of another fork' },
  ]);
  expect(result.reason).toBe('promoted the union of 1 lane; the shared file was of another fork and was replaced');
  expect(Object.keys(decode(shared).accounts)).toEqual([A]);
});

test('nothing is written when no lane is eligible, or when the lanes read nothing new', () => {
  writeShared(content({ accounts: { [A]: account('0x1') } }));
  const before = fs.readFileSync(shared);
  expect(promote([lane(0, content({ accounts: { [B]: account('0x2') } }), { hasExitedCleanly: false })])).toEqual({
    isPromoted: false,
    reason: 'no lane passed the gates',
    lanes: [{ lane: 0, isMerged: false, reason: 'anvil did not exit cleanly' }],
  });
  expect(promote([lane(0, content({ accounts: { [A]: account('0x1') } }))])).toEqual({
    isPromoted: false,
    reason: 'the shared file already held everything the lanes read',
    lanes: [{ lane: 0, isMerged: true, reason: 'merged 0 new entries' }],
  });
  expect(promote([])).toEqual({ isPromoted: false, reason: 'no lane passed the gates', lanes: [] });
  expect(fs.readFileSync(shared)).toEqual(before);
});

test('a shared file another run promoted during this one is merged in, not overwritten', () => {
  const laneZero = lane(0, content({ accounts: { [A]: account('0x1') } }));
  // Another run's promotion lands after this run copied the shared file, and before it promotes.
  writeShared(content({ accounts: { [C]: account('0x3') } }));
  expect(promote([laneZero]).isPromoted).toBe(true);
  expect(Object.keys(decode(shared).accounts).sort()).toEqual([A, C]);
});

test('the root is checked again first, and a symbolic link at the shared path is replaced, not written through', () => {
  const target = path.join(scratch, 'target.txt');
  fs.writeFileSync(target, 'unchanged');
  fs.mkdirSync(path.dirname(shared), { recursive: true, mode: 0o700 });
  fs.symlinkSync(target, shared);
  expect(promote([lane(0, content({ accounts: { [A]: account('0x1') } }))]).isPromoted).toBe(true);
  expect(fs.readFileSync(target, 'utf8')).toBe('unchanged');
  expect(fs.lstatSync(shared).isSymbolicLink()).toBe(false);

  fs.chmodSync(root, 0o755);
  expect(promote([lane(1, content({ accounts: { [B]: account('0x2') } }))])).toEqual({
    isPromoted: false,
    reason: 'the cache root failed its check',
    lanes: [],
  });
});

test('names a file system error by its code alone, and leaves no temporary file', () => {
  fs.mkdirSync(path.join(shared, 'entry'), { recursive: true });
  const result = promote([lane(0, content({ accounts: { [A]: account('0x1') } }))]);
  expect(result.isPromoted).toBe(false);
  expect(result.reason).toMatch(/^the promotion failed \(E[A-Z]+\)$/);
  expect(fs.readdirSync(path.dirname(shared))).toEqual([path.basename(shared)]);
});

describe('the gate of one lane', () => {
  test('passes a clean lane, and names the first gate a lane fails', () => {
    const clean = lane(0, content());
    expect(laneCacheGate({ ...clean, blockNumber: BLOCK, forkUrl: FORK_URL })).toEqual({
      isEligible: true,
      file: anvilCacheFile(clean.runHome, BLOCK, FORK_URL),
    });
    expect(laneCacheGate({ ...clean, methods: [], blockNumber: BLOCK, forkUrl: FORK_URL })).toEqual({
      isEligible: false,
      reason: "anvil's log does not show the calls the harness makes",
    });
  });
});
