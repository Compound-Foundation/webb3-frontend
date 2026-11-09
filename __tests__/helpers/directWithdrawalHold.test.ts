import { Interface } from '@ethersproject/abi';
import { hexZeroPad } from '@ethersproject/bytes';

import CometAbi from '@helpers/abis/Comet';
import {
  anchorBlock,
  createHoldStore,
  DIRECT_WITHDRAWAL_HOLDS_KEY,
  directWithdrawalCalldata,
  DirectWithdrawalHold,
  HoldEvidenceReader,
  holdKey,
  isHoldResolved,
  LOG_BLOCK_RANGE,
  RESERVATION_LEASE_MS,
} from '@helpers/directWithdrawalHold';
import { MAX_UINT256 } from '@helpers/numbers';

const ACCOUNT = '0x0000000000000000000000000000000000000aa1';
const OTHER = '0x0000000000000000000000000000000000000bb2';
const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const BULKER = '0xa397a8C2086C554B531c02E29f3291c9704B00c7';
const KEY = holdKey(ACCOUNT, 1, USDC_COMET);
const COMET = new Interface(CometAbi);
const CALLDATA = directWithdrawalCalldata(USDC, 200_000_000n);
const FIGURES = { calldata: CALLDATA, amount: 200_000_000n, blockNumber: 100 };

/** Storage two tabs share, with a clock both read. */
function sharedStorage() {
  const items = new Map<string, string>();
  const storage = {
    getItem: jest.fn((name: string) => items.get(name) ?? null),
    setItem: jest.fn((name: string, value: string) => void items.set(name, value)),
    removeItem: jest.fn((name: string) => void items.delete(name)),
  };
  let time = 1_000_000;
  const clock = { now: () => time, advance: (ms: number) => (time += ms) };
  const tab = (tabId: string) =>
    createHoldStore({ storage: () => storage, locks: () => undefined, tabId, now: clock.now, lockWaitMs: 200 });
  return { storage, items, clock, tab };
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('the hold store', () => {
  it('reserves a key once: another tab is held back while the reservation is live', async () => {
    const { tab } = sharedStorage();
    const first = tab('tab-1');
    const second = tab('tab-2');

    const reserved = await first.reserve(KEY);
    expect(reserved).toEqual({ status: 'reserved', id: expect.any(String) });
    // The second tab opens and reads storage: the first tab's reservation is kept.
    expect(second.read(KEY)).toEqual({
      status: 'known',
      records: [expect.objectContaining({ kind: 'reserved', tabId: 'tab-1' })],
    });
    await expect(second.reserve(KEY)).resolves.toEqual({
      status: 'held-back',
      records: [expect.objectContaining({ kind: 'reserved', tabId: 'tab-1' })],
    });
    // Another account, network or market is not held back.
    await expect(second.reserve(holdKey(OTHER, 1, USDC_COMET))).resolves.toMatchObject({ status: 'reserved' });
    await expect(second.reserve(holdKey(ACCOUNT, 8453, USDC_COMET))).resolves.toMatchObject({ status: 'reserved' });
  });

  it('drops a reservation only once its lease has expired', async () => {
    const { tab, clock } = sharedStorage();
    const first = tab('tab-1');
    const second = tab('tab-2');
    const reserved = await first.reserve(KEY);
    if (reserved.status !== 'reserved') throw new Error('the first tab must reserve');

    clock.advance(RESERVATION_LEASE_MS - 1);
    await expect(second.reserve(KEY)).resolves.toMatchObject({ status: 'held-back' });
    clock.advance(1);
    expect(second.read(KEY)).toEqual({ status: 'known', records: [] });
    await expect(second.reserve(KEY)).resolves.toMatchObject({ status: 'reserved' });
    // The first tab's reservation is gone, so it cannot become a hold: its request is never sent.
    await expect(first.hold(KEY, reserved.id, FIGURES)).resolves.toBe(false);
  });

  it('turns its own reservation into a hold with the calldata, read back from storage', async () => {
    const { tab, items } = sharedStorage();
    const store = tab('tab-1');
    const reserved = await store.reserve(KEY);
    if (reserved.status !== 'reserved') throw new Error('the tab must reserve');

    await expect(store.hold(KEY, reserved.id, FIGURES)).resolves.toBe(true);
    const held = {
      ...KEY,
      kind: 'held',
      id: reserved.id,
      calldata: CALLDATA,
      amount: '200000000',
      blockNumber: 100,
    };
    expect(JSON.parse(items.get(DIRECT_WITHDRAWAL_HOLDS_KEY) ?? '[]')).toEqual([held]);
    await expect(store.recordHash(KEY, reserved.id, `0x${'AB'.repeat(32)}`, 7)).resolves.toBe(true);
    expect(store.read(KEY)).toEqual({
      status: 'known',
      records: [{ ...held, hash: `0x${'ab'.repeat(32)}`, nonce: 7 }],
    });
    await expect(store.release(KEY, reserved.id)).resolves.toBe(true);
    expect(store.read(KEY)).toEqual({ status: 'known', records: [] });
  });

  it('keeps a hold however much time passes, and holds back every other tab', async () => {
    const { tab, clock } = sharedStorage();
    const first = tab('tab-1');
    const reserved = await first.reserve(KEY);
    if (reserved.status !== 'reserved') throw new Error('the tab must reserve');
    await first.hold(KEY, reserved.id, FIGURES);

    clock.advance(365 * 24 * 60 * 60 * 1000);
    await expect(tab('tab-2').reserve(KEY)).resolves.toMatchObject({ status: 'held-back' });
  });

  it('refuses a hold for a request whose reservation is not its own or is beside another live one', async () => {
    const { tab, items } = sharedStorage();
    const store = tab('tab-1');
    await expect(store.hold(KEY, 'never-reserved', FIGURES)).resolves.toBe(false);
    const reserved = await store.reserve(KEY);
    if (reserved.status !== 'reserved') throw new Error('the tab must reserve');
    // Another tab's live reservation was written meanwhile, as by a tab without the lock.
    const stored = JSON.parse(items.get(DIRECT_WITHDRAWAL_HOLDS_KEY) ?? '[]');
    items.set(DIRECT_WITHDRAWAL_HOLDS_KEY, JSON.stringify([...stored, { ...stored[0], id: 'other', tabId: 'tab-2' }]));
    await expect(store.hold(KEY, reserved.id, FIGURES)).resolves.toBe(false);
  });

  it.each([
    [
      'setItem throws',
      (storage: ReturnType<typeof sharedStorage>['storage']) =>
        storage.setItem.mockImplementation(() => {
          throw new Error('QuotaExceededError');
        }),
    ],
    [
      'setItem is ignored',
      (storage: ReturnType<typeof sharedStorage>['storage']) => storage.setItem.mockImplementation(() => undefined),
    ],
  ])('reserves and holds nothing when %s', async (_name, fail) => {
    const { tab, storage } = sharedStorage();
    const store = tab('tab-1');
    const reserved = await store.reserve(KEY);
    if (reserved.status !== 'reserved') throw new Error('the tab must reserve');
    fail(storage);

    await expect(store.hold(KEY, reserved.id, FIGURES)).resolves.toBe(false);
    await expect(tab('tab-2').reserve(holdKey(OTHER, 1, USDC_COMET))).resolves.toEqual({ status: 'unknown' });
  });

  it.each([
    [
      'getItem throws',
      (storage: ReturnType<typeof sharedStorage>['storage']) =>
        storage.getItem.mockImplementation(() => {
          throw new Error('SecurityError');
        }),
    ],
    [
      'the list is not JSON',
      (storage: ReturnType<typeof sharedStorage>['storage']) => storage.getItem.mockImplementation(() => '{not json'),
    ],
  ])('reads as unknown, never as empty, when %s', async (_name, fail) => {
    const { tab, storage } = sharedStorage();
    const store = tab('tab-1');
    fail(storage);
    expect(store.read(KEY)).toEqual({ status: 'unknown' });
    await expect(store.reserve(KEY)).resolves.toEqual({ status: 'unknown' });
  });

  it('keeps a hold without a hash the wallet gave in a form storage does not accept', async () => {
    const { tab } = sharedStorage();
    const store = tab('tab-1');
    const reserved = await store.reserve(KEY);
    if (reserved.status !== 'reserved') throw new Error('the tab must reserve');
    await store.hold(KEY, reserved.id, FIGURES);

    await expect(store.recordHash(KEY, reserved.id, 'ab'.repeat(32), undefined)).resolves.toBe(false);
    await expect(store.recordHash(KEY, reserved.id, `0x${'ab'.repeat(32)} `, undefined)).resolves.toBe(false);
    const read = tab('tab-2').read(KEY);
    expect(read).toEqual({
      status: 'known',
      records: [expect.objectContaining({ kind: 'held', id: reserved.id, calldata: CALLDATA })],
    });
    expect(read.status === 'known' && 'hash' in read.records[0]).toBe(false);
  });

  it('puts the stored list back when the read-back differs from what was written', async () => {
    const { tab, storage, items } = sharedStorage();
    const store = tab('tab-1');
    const reserved = await store.reserve(KEY);
    if (reserved.status !== 'reserved') throw new Error('the tab must reserve');
    const before = items.get(DIRECT_WITHDRAWAL_HOLDS_KEY);
    // Storage keeps something else once for the list, as a full or broken store can.
    let isBroken = true;
    storage.setItem.mockImplementation((name: string, value: string) => {
      const isList = name === DIRECT_WITHDRAWAL_HOLDS_KEY;
      items.set(name, isList && isBroken ? '[{"kind":"other"}]' : value);
      if (isList) isBroken = false;
    });

    await expect(store.hold(KEY, reserved.id, FIGURES)).resolves.toBe(false);
    expect(items.get(DIRECT_WITHDRAWAL_HOLDS_KEY)).toBe(before);
  });

  it('turns no expired reservation into a hold, even with no other tab reserved', async () => {
    const { tab, clock } = sharedStorage();
    const store = tab('tab-1');
    const reserved = await store.reserve(KEY);
    if (reserved.status !== 'reserved') throw new Error('the tab must reserve');
    clock.advance(RESERVATION_LEASE_MS);
    await expect(store.hold(KEY, reserved.id, FIGURES)).resolves.toBe(false);
  });

  it('gives exactly one of two tabs that reserve at once the reservation, through the storage lock', async () => {
    const { tab } = sharedStorage();
    const results = await Promise.all([tab('tab-1').reserve(KEY), tab('tab-2').reserve(KEY)]);
    expect(results.map(({ status }) => status).sort()).toEqual(['held-back', 'reserved']);
  });

  it('takes one Web Locks API lock for every key, where the browser has it', async () => {
    const { storage } = sharedStorage();
    const request = jest.fn(async (_name: string, callback: () => Promise<unknown>) => callback());
    const store = createHoldStore({ storage: () => storage, locks: () => ({ request } as never), tabId: 'tab-1' });
    await expect(store.reserve(KEY)).resolves.toMatchObject({ status: 'reserved' });
    // One lock for every key: they share the stored list.
    await expect(store.reserve(holdKey(OTHER, 1, USDC_COMET))).resolves.toMatchObject({ status: 'reserved' });
    expect(request.mock.calls.map(([name]) => name)).toEqual([
      DIRECT_WITHDRAWAL_HOLDS_KEY,
      DIRECT_WITHDRAWAL_HOLDS_KEY,
    ]);
  });

  it('ignores a malformed record that any script could write', async () => {
    const { tab, items } = sharedStorage();
    items.set(DIRECT_WITHDRAWAL_HOLDS_KEY, JSON.stringify([{ ...KEY, kind: 'held', id: 'x', calldata: 'nope' }]));
    expect(tab('tab-1').read(KEY)).toEqual({ status: 'known', records: [] });
  });
});

describe('directWithdrawalCalldata', () => {
  it("is production's Comet withdraw(baseToken, amount) encoding, in lower case", () => {
    expect(directWithdrawalCalldata(USDC, 200_000_000n)).toBe(
      COMET.encodeFunctionData('withdraw', [USDC, '200000000']).toLowerCase()
    );
    expect(directWithdrawalCalldata(USDC, MAX_UINT256)).toBe(
      COMET.encodeFunctionData('withdraw', [USDC, MAX_UINT256.toString()]).toLowerCase()
    );
  });
});

describe('anchorBlock', () => {
  const reader = (block: number) => ({ getBlockNumber: jest.fn(async () => block) });
  const FAST = { attempts: 2, intervalMs: 1 };

  it("is the configured chain's block once it has reached the wallet node's block and every floor", async () => {
    await expect(anchorBlock(reader(105), reader(103), [101, undefined], FAST)).resolves.toBe(105);
    await expect(anchorBlock(reader(105), reader(103), [105], FAST)).resolves.toBe(105);
  });

  it("throws when the wallet node's block cannot be read, or there is no wallet", async () => {
    const failing = { getBlockNumber: jest.fn(async () => Promise.reject(new Error('timeout'))) };
    await expect(anchorBlock(reader(105), failing, [], FAST)).rejects.toThrow('timeout');
    await expect(anchorBlock(reader(105), undefined, [], FAST)).rejects.toThrow("The wallet's network cannot be read.");
  });

  it("throws when the wallet node's block does not come in time", async () => {
    const silent = { getBlockNumber: jest.fn(() => new Promise<number>(() => undefined)) };
    await expect(anchorBlock(reader(105), silent, [], FAST)).rejects.toThrow('did not answer in time');
  });

  it("throws when the configured chain's provider stays behind the wallet node or a floor", async () => {
    await expect(anchorBlock(reader(101), reader(103), [], FAST)).rejects.toThrow('has not reached');
    await expect(anchorBlock(reader(103), reader(103), [104], FAST)).rejects.toThrow('has not reached');
  });
});

describe('isHoldResolved', () => {
  const HOLD: DirectWithdrawalHold = {
    ...KEY,
    kind: 'held',
    id: 'hold-1',
    calldata: CALLDATA,
    amount: '200000000',
    blockNumber: 100,
  };
  /** The canonical hash of the block at `blockNumber`. */
  const blockHashAt = (blockNumber: number) => `0x${'b'.repeat(56)}${blockNumber.toString(16).padStart(8, '0')}`;
  const withdrawLog = (blockNumber: number, transactionHash: string, src = ACCOUNT) => ({
    blockNumber,
    blockHash: blockHashAt(blockNumber),
    transactionHash,
    address: USDC_COMET,
    ...COMET.encodeEventLog(COMET.getEvent('Withdraw'), [src, src, 1n]),
  });
  type Mined = { hash: string; blockNumber: number; from: string; to: string; data: string };
  /** A node that has mined `mined`, answering Withdraw log filters by address, src and range. */
  function nodeWith(mined: Mined[]) {
    return {
      getLogs: jest.fn(
        async (filter: { address?: string; topics?: (string | null)[]; fromBlock?: number; toBlock?: number }) =>
          mined
            .filter(
              (transaction) =>
                transaction.blockNumber >= (filter.fromBlock ?? 0) &&
                transaction.blockNumber <= (filter.toBlock ?? Infinity) &&
                filter.topics?.[1] === hexZeroPad(transaction.from.toLowerCase(), 32)
            )
            .map((transaction) => withdrawLog(transaction.blockNumber, transaction.hash, transaction.from))
      ),
      getTransaction: jest.fn(async (hash: string) => {
        const transaction = mined.find((candidate) => candidate.hash === hash);
        return transaction === undefined ? null : { ...transaction, blockHash: blockHashAt(transaction.blockNumber) };
      }),
      getTransactionReceipt: jest.fn(async () => null),
      getTransactionCount: jest.fn(async () => 5),
      getBlock: jest.fn(async (blockNumber: number) => ({ number: blockNumber, hash: blockHashAt(blockNumber) })),
    };
  }
  const asReader = (node: ReturnType<typeof nodeWith>) => node as unknown as HoldEvidenceReader;
  const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

  it('ends a hashless hold once a transaction from the account to Comet with the same calldata is mined', async () => {
    const node = nodeWith([{ hash: hash(1), blockNumber: 102, from: ACCOUNT, to: USDC_COMET, data: CALLDATA }]);
    await expect(isHoldResolved(HOLD, asReader(node), 110, new Map())).resolves.toBe(true);
    expect(node.getLogs).toHaveBeenCalledWith({
      address: KEY.cometAddress,
      topics: [COMET.getEventTopic('Withdraw'), hexZeroPad(KEY.account, 32)],
      fromBlock: 101,
      toBlock: 110,
    });
  });

  it.each<[string, Mined]>([
    // Sol's case: another interface withdrew 301 USDC, enough with a supply of 100 more to meet the old rule.
    [
      'another amount',
      {
        hash: hash(1),
        blockNumber: 102,
        from: ACCOUNT,
        to: USDC_COMET,
        data: directWithdrawalCalldata(USDC, 301_000_000n),
      },
    ],
    [
      'the whole supply instead',
      {
        hash: hash(1),
        blockNumber: 102,
        from: ACCOUNT,
        to: USDC_COMET,
        data: directWithdrawalCalldata(USDC, MAX_UINT256),
      },
    ],
    [
      'the Bulker on the account’s behalf',
      { hash: hash(1), blockNumber: 102, from: ACCOUNT, to: BULKER, data: CALLDATA },
    ],
    ['before the hold’s block', { hash: hash(1), blockNumber: 99, from: ACCOUNT, to: USDC_COMET, data: CALLDATA }],
    [
      'in the hold’s own block, read before the request was made',
      { hash: hash(1), blockNumber: 100, from: ACCOUNT, to: USDC_COMET, data: CALLDATA },
    ],
  ])('keeps a hashless hold beside a withdrawal of %s', async (_name, mined) => {
    await expect(isHoldResolved(HOLD, asReader(nodeWith([mined])), 110, new Map())).resolves.toBe(false);
  });

  it('keeps a hashless hold beside any change of balance: it reads no balance at all', async () => {
    const node = { ...nodeWith([]), call: jest.fn(), getBalance: jest.fn() };
    await expect(isHoldResolved(HOLD, asReader(node), 110, new Map())).resolves.toBe(false);
    expect(node.call).not.toHaveBeenCalled();
  });

  it('looks through at most five ranges each time, and continues from the last block it looked through', async () => {
    const far = HOLD.blockNumber + 6 * LOG_BLOCK_RANGE;
    const node = nodeWith([{ hash: hash(1), blockNumber: far, from: ACCOUNT, to: USDC_COMET, data: CALLDATA }]);
    const scanned = new Map<string, number>();
    await expect(isHoldResolved(HOLD, asReader(node), far + 10, scanned)).resolves.toBe(false);
    expect(node.getLogs).toHaveBeenCalledTimes(5);
    expect(scanned.get(HOLD.id)).toBe(HOLD.blockNumber + 5 * LOG_BLOCK_RANGE);

    await expect(isHoldResolved(HOLD, asReader(node), far + 10, scanned)).resolves.toBe(true);
    // The second look starts where the first stopped, and finds the transaction in its second range.
    expect(node.getLogs.mock.calls[5][0]).toMatchObject({ fromBlock: HOLD.blockNumber + 5 * LOG_BLOCK_RANGE + 1 });
  });

  it('throws, so the hold stays, when the node cannot be read', async () => {
    const node = nodeWith([]);
    node.getLogs.mockRejectedValue(new Error('range too large'));
    await expect(isHoldResolved(HOLD, asReader(node), 110, new Map())).rejects.toThrow('range too large');
  });

  it('ends a hold with a hash on its receipt, success or revert, or once its own nonce is taken', async () => {
    const withHash = { ...HOLD, hash: hash(9) };
    const mined = nodeWith([]);
    mined.getTransactionReceipt.mockResolvedValue({ status: 0 } as never);
    await expect(isHoldResolved(withHash, asReader(mined), 110, new Map())).resolves.toBe(true);

    const replaced = nodeWith([]);
    replaced.getTransaction.mockResolvedValue({ nonce: 5 } as never);
    replaced.getTransactionCount.mockResolvedValue(6);
    await expect(isHoldResolved(withHash, asReader(replaced), 110, new Map())).resolves.toBe(true);
    expect(replaced.getTransactionCount).toHaveBeenCalledWith(KEY.account, 110);

    // The stored nonce serves when the node no longer knows the transaction.
    const dropped = nodeWith([]);
    dropped.getTransactionCount.mockResolvedValue(8);
    await expect(isHoldResolved({ ...withHash, nonce: 7 }, asReader(dropped), 110, new Map())).resolves.toBe(true);
  });

  it("reports the node's own nonce for the hash when the hold has none, and never judges by a lower bound", async () => {
    const withHash = { ...HOLD, hash: hash(9) };
    const pending = nodeWith([]);
    pending.getTransaction.mockResolvedValue({ nonce: 6 } as never);
    pending.getTransactionCount.mockResolvedValue(6);
    const onNonce = jest.fn();
    await expect(isHoldResolved(withHash, asReader(pending), 110, new Map(), onNonce)).resolves.toBe(false);
    expect(onNonce).toHaveBeenCalledWith(6);
    onNonce.mockClear();
    await isHoldResolved({ ...withHash, nonce: 6 }, asReader(pending), 110, new Map(), onNonce);
    expect(onNonce).not.toHaveBeenCalled();
  });

  it('reads a candidate again on the next look when the node could not give its transaction, and then ends the hold', async () => {
    const node = nodeWith([{ hash: hash(1), blockNumber: 102, from: ACCOUNT, to: USDC_COMET, data: CALLDATA }]);
    node.getTransaction.mockResolvedValueOnce(null);
    const scanned = new Map<string, number>();
    await expect(isHoldResolved(HOLD, asReader(node), 110, scanned)).resolves.toBe(false);
    expect(scanned.get(HOLD.id)).toBe(101);
    await expect(isHoldResolved(HOLD, asReader(node), 111, scanned)).resolves.toBe(true);
    expect(node.getLogs.mock.calls[1][0]).toMatchObject({ fromBlock: 102, toBlock: 111 });
  });

  describe('the cursor beside a candidate that did not count', () => {
    const MINED: Mined = { hash: hash(1), blockNumber: 102, from: ACCOUNT, to: USDC_COMET, data: CALLDATA };

    it('starts the next look at the lowest such block of a range', async () => {
      const node = nodeWith([MINED, { ...MINED, hash: hash(2), blockNumber: 105 }]);
      node.getTransaction.mockResolvedValue(null);
      const scanned = new Map<string, number>();
      // The later log comes last, so the lowest block is not simply the last one met.
      node.getLogs.mockImplementationOnce(async () => [withdrawLog(102, hash(1)), withdrawLog(105, hash(2))]);
      await expect(isHoldResolved(HOLD, asReader(node), 110, scanned)).resolves.toBe(false);
      expect(scanned.get(HOLD.id)).toBe(101);
    });

    it('keeps what earlier ranges of the same look read through', async () => {
      const far = HOLD.blockNumber + LOG_BLOCK_RANGE + 50;
      const node = nodeWith([{ ...MINED, blockNumber: far }]);
      node.getTransaction.mockResolvedValue(null);
      const scanned = new Map<string, number>();
      await expect(isHoldResolved(HOLD, asReader(node), far + 10, scanned)).resolves.toBe(false);
      expect(scanned.get(HOLD.id)).toBe(far - 1);
    });

    it.each([
      ['past the anchored block', { ...withdrawLog(111, hash(1)) }],
      ['with no block number', { ...withdrawLog(102, hash(1)), blockNumber: undefined }],
    ])('reads the whole range again for a log %s', async (_name, log) => {
      const node = nodeWith([MINED]);
      node.getLogs.mockImplementation(async () => [log] as never);
      node.getTransaction.mockResolvedValue({ ...MINED, blockNumber: 111, blockHash: blockHashAt(111) } as never);
      node.getBlock.mockImplementation(async (blockNumber: number) => ({
        number: blockNumber,
        hash: blockHashAt(111),
      }));
      const scanned = new Map<string, number>();
      await expect(isHoldResolved(HOLD, asReader(node), 110, scanned)).resolves.toBe(false);
      expect(scanned.get(HOLD.id)).toBe(HOLD.blockNumber);
    });
  });

  describe('after a reorg', () => {
    const MINED: Mined = { hash: hash(1), blockNumber: 102, from: ACCOUNT, to: USDC_COMET, data: CALLDATA };

    it('keeps a hashless hold whose logged candidate a reorg returned to pending, and reads its block again', async () => {
      const node = nodeWith([MINED]);
      node.getTransaction.mockResolvedValueOnce({ ...MINED, blockNumber: null, blockHash: null } as never);
      const scanned = new Map<string, number>();
      await expect(isHoldResolved(HOLD, asReader(node), 110, scanned)).resolves.toBe(false);
      // The next look starts at the candidate's block, and ends the hold once it is mined again there.
      expect(scanned.get(HOLD.id)).toBe(MINED.blockNumber - 1);
      await expect(isHoldResolved(HOLD, asReader(node), 110, scanned)).resolves.toBe(true);
      expect(node.getLogs.mock.calls[1][0]).toMatchObject({ fromBlock: MINED.blockNumber });
    });

    it("keeps a hashless hold whose candidate is mined in a block other than the log's", async () => {
      const node = nodeWith([MINED]);
      node.getTransaction.mockResolvedValue({ ...MINED, blockHash: `0x${'c'.repeat(64)}` } as never);
      const scanned = new Map<string, number>();
      await expect(isHoldResolved(HOLD, asReader(node), 110, scanned)).resolves.toBe(false);
      expect(scanned.get(HOLD.id)).toBe(MINED.blockNumber - 1);
    });

    it("keeps a hashless hold while the canonical block at the log's height has another hash", async () => {
      const node = nodeWith([MINED]);
      node.getBlock.mockResolvedValue({ number: MINED.blockNumber, hash: `0x${'c'.repeat(64)}` });
      const scanned = new Map<string, number>();
      await expect(isHoldResolved(HOLD, asReader(node), 110, scanned)).resolves.toBe(false);
      expect(node.getBlock).toHaveBeenCalledWith(MINED.blockNumber);
      expect(scanned.get(HOLD.id)).toBe(MINED.blockNumber - 1);
    });

    it('keeps a hashless hold whose candidate is mined after the anchored block', async () => {
      const node = nodeWith([MINED]);
      node.getTransaction.mockResolvedValue({ ...MINED, blockNumber: 111, blockHash: blockHashAt(111) } as never);
      await expect(isHoldResolved(HOLD, asReader(node), 110, new Map())).resolves.toBe(false);
    });
  });

  it('keeps a hold with a hash while it is pending, and never ends one by calldata alone', async () => {
    const withHash = { ...HOLD, hash: hash(9) };
    const pending = nodeWith([{ hash: hash(1), blockNumber: 102, from: ACCOUNT, to: USDC_COMET, data: CALLDATA }]);
    pending.getTransaction.mockImplementation(async (asked: string) =>
      asked === hash(9) ? ({ nonce: 5 } as never) : null
    );
    await expect(isHoldResolved(withHash, asReader(pending), 110, new Map())).resolves.toBe(false);
    expect(pending.getLogs).not.toHaveBeenCalled();
    // Without a nonce from the node or the wallet, nothing shows it can no longer execute.
    await expect(isHoldResolved(withHash, asReader(nodeWith([])), 110, new Map())).resolves.toBe(false);
  });
});
