import { Interface } from '@ethersproject/abi';
import { hexZeroPad } from '@ethersproject/bytes';
import type { JsonRpcProvider } from '@ethersproject/providers';

import CometAbi from '@helpers/abis/Comet';
import { BlockWait, DEFAULT_BLOCK_WAIT, waitForBlock } from '@helpers/wrappedPositions';

// The hold on a Comet base withdrawal that a withdrawal on the wrapped route sends for the account's
// direct supply. While one such request can still execute, a second one can take more than the
// direct supply together with it, and Comet then lends the account the rest. So the Comet base
// withdrawals that Home sends for the account on the market wait until the first one can no longer
// execute.
//
// A hold starts as a reservation before the wallet is asked, and becomes a hold with the request's
// calldata just before the wallet is asked. Only evidence about the request itself ends it: its
// receipt or its own nonce taken when the wallet gave its hash, or else a transaction from the
// account to Comet with the same calldata, mined after the hold's block. Nothing else does: no
// balance, time, Clear, reload or change of market.
//
// Holds are stored apart from the transaction manager's records, under their own key, and every
// change to them is made under one lock that other tabs of the app respect.

/** Where the holds are stored. */
export const DIRECT_WITHDRAWAL_HOLDS_KEY = 'webb3-direct-withdrawal-holds';

/**
 * How long a reservation keeps other tabs from reserving, in milliseconds. It covers the gas
 * estimate and the fresh read before the wallet is asked, which waits at most half a minute for a
 * block. A reservation is dropped only once it has expired.
 */
export const RESERVATION_LEASE_MS = 120_000;

/** The most blocks one `getLogs` request covers when a hashless hold is looked for. */
export const LOG_BLOCK_RANGE = 2_000;

/** The most `getLogs` requests one look at a hashless hold makes. The next look continues from there. */
const LOG_REQUESTS_PER_LOOK = 5;

/** The account, network and Comet market a hold belongs to, all in lower case. */
export type HoldKey = { account: string; chainId: number; cometAddress: string };

/** A request that has not reached the wallet yet. `tabId` made it, and it expires at `expiresAt`. */
export type DirectWithdrawalReservation = HoldKey & {
  kind: 'reserved';
  id: string;
  tabId: string;
  expiresAt: number;
};

/** A request the wallet was asked to sign. */
export type DirectWithdrawalHold = HoldKey & {
  kind: 'held';
  id: string;
  /** The request's calldata, `withdraw(baseToken, amount)`, in lower case. */
  calldata: string;
  /** `withdraw`'s amount in base units, as a decimal string: `MAX_UINT256` for the whole supply. */
  amount: string;
  /** The block of the fresh read made just before the wallet was asked. */
  blockNumber: number;
  /** The transaction's hash, once the wallet gave it. */
  hash?: string;
  /** The transaction's own nonce, when the wallet's answer named it. */
  nonce?: number;
};

export type HoldRecord = DirectWithdrawalReservation | DirectWithdrawalHold;

/** The live records for one key, or `unknown` when storage cannot be read. */
export type HoldsRead = { status: 'known'; records: HoldRecord[] } | { status: 'unknown' };

export type ReserveResult =
  | { status: 'reserved'; id: string }
  /** Another request of the key is reserved or held. */
  | { status: 'held-back'; records: HoldRecord[] }
  /** Storage was not read or written, so nothing is reserved. */
  | { status: 'unknown' };

/** What a hold stores when the wallet is asked. */
export type HoldFigures = { calldata: string; amount: bigint; blockNumber: number };

type HoldStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type LockRequester = { request: <T>(name: string, callback: () => Promise<T>) => Promise<T> };

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const CALLDATA = /^0x([0-9a-f]{2})+$/;
const DECIMAL = /^[0-9]{1,78}$/;

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Whether a stored value is a well-formed record. Any script on the page can write storage. */
function isHoldRecord(value: unknown): value is HoldRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const isKeyed =
    typeof record.id === 'string' &&
    typeof record.account === 'string' &&
    ADDRESS.test(record.account) &&
    typeof record.cometAddress === 'string' &&
    ADDRESS.test(record.cometAddress) &&
    isCount(record.chainId);
  if (!isKeyed) return false;
  if (record.kind === 'reserved') return typeof record.tabId === 'string' && isCount(record.expiresAt);
  return (
    record.kind === 'held' &&
    typeof record.calldata === 'string' &&
    CALLDATA.test(record.calldata) &&
    typeof record.amount === 'string' &&
    DECIMAL.test(record.amount) &&
    isCount(record.blockNumber) &&
    (record.hash === undefined || (typeof record.hash === 'string' && HASH.test(record.hash))) &&
    (record.nonce === undefined || isCount(record.nonce))
  );
}

/** The key in lower case, as records store it. */
export function holdKey(account: string, chainId: number, cometAddress: string): HoldKey {
  return { account: account.toLowerCase(), chainId, cometAddress: cometAddress.toLowerCase() };
}

const isForKey = (record: HoldRecord, key: HoldKey) =>
  record.account === key.account && record.chainId === key.chainId && record.cometAddress === key.cometAddress;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A random id for a record, a tab or a lock's owner. */
function randomId(): string {
  const { crypto } = globalThis;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** How long the storage lock is held at most, and how long a tab waits for it. */
const STORAGE_LOCK_LEASE_MS = 10_000;
const STORAGE_LOCK_WAIT_MS = 10_000;
const STORAGE_LOCK_POLL_MS = 25;

export type HoldStoreOptions = {
  storage?: () => HoldStorage;
  /** The Web Locks API, or undefined where the browser lacks it. */
  locks?: () => LockRequester | undefined;
  tabId?: string;
  /** The clock of reservations' leases. */
  now?: () => number;
  /** How long a change waits for the storage lock before it fails, in milliseconds. */
  lockWaitMs?: number;
};

export type HoldStore = ReturnType<typeof createHoldStore>;

/**
 * The stored holds, as one tab of the app sees them. Reads are synchronous. Every change runs under
 * a lock per key that every tab respects, writes the whole list and reads it back, and reports
 * failure rather than throwing: a change that did not reach storage did not happen.
 */
export function createHoldStore({
  storage = () => window.localStorage,
  locks = () => (typeof navigator === 'undefined' ? undefined : (navigator as { locks?: LockRequester }).locks),
  tabId,
  now = Date.now,
  lockWaitMs = STORAGE_LOCK_WAIT_MS,
}: HoldStoreOptions = {}) {
  // Made when first needed, so that loading the module makes no id.
  let ownTabId = tabId;
  const currentTabId = () => (ownTabId ??= randomId());
  /** Every well-formed stored record, or undefined when storage cannot be read. */
  const readAll = (): HoldRecord[] | undefined => {
    try {
      const raw = storage().getItem(DIRECT_WITHDRAWAL_HOLDS_KEY);
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isHoldRecord) : undefined;
    } catch {
      return undefined;
    }
  };

  const isLive = (record: HoldRecord) => record.kind === 'held' || record.expiresAt > now();

  /**
   * Writes `records`, less expired reservations, and reads them back. Whether storage now holds them.
   * A record that fails `isHoldRecord`, which a read drops, is never written. When the read-back
   * differs, the list stored before is put back.
   */
  const writeAll = (records: HoldRecord[]): boolean => {
    const kept = records.filter(isLive);
    if (!kept.every(isHoldRecord)) return false;
    let before: string | null;
    try {
      before = storage().getItem(DIRECT_WITHDRAWAL_HOLDS_KEY);
      storage().setItem(DIRECT_WITHDRAWAL_HOLDS_KEY, JSON.stringify(kept));
    } catch {
      return false;
    }
    const readBack = readAll();
    if (readBack !== undefined && JSON.stringify(readBack) === JSON.stringify(kept)) return true;
    try {
      if (before === null) storage().removeItem(DIRECT_WITHDRAWAL_HOLDS_KEY);
      else storage().setItem(DIRECT_WITHDRAWAL_HOLDS_KEY, before);
    } catch {
      // Storage refuses writes, so it still holds what a read finds.
    }
    return false;
  };

  /**
   * A lock through storage, for a browser without the Web Locks API. Throws if it cannot be taken.
   * It is not a strict mutex: two tabs whose writes reach each other later than the 25 ms it waits
   * can both take it.
   */
  const withStorageLock = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const lockKey = `${DIRECT_WITHDRAWAL_HOLDS_KEY}:lock:${name}`;
    const owner = randomId();
    const ownerOf = () => {
      const raw = storage().getItem(lockKey);
      if (raw === null) return undefined;
      const lease = JSON.parse(raw) as { owner?: unknown; expiresAt?: unknown };
      return typeof lease.expiresAt === 'number' && lease.expiresAt > Date.now() ? lease.owner : undefined;
    };
    const deadline = Date.now() + lockWaitMs;
    for (;;) {
      if (ownerOf() === undefined) {
        storage().setItem(lockKey, JSON.stringify({ owner, expiresAt: Date.now() + STORAGE_LOCK_LEASE_MS }));
        // Another tab that wrote at the same moment overwrites this lease or is overwritten by it.
        await delay(STORAGE_LOCK_POLL_MS);
        if (ownerOf() === owner) break;
      }
      if (Date.now() > deadline) throw new Error('Another tab of the app holds the withdrawal lock.');
      await delay(STORAGE_LOCK_POLL_MS);
    }
    try {
      return await run();
    } finally {
      try {
        if (ownerOf() === owner) storage().removeItem(lockKey);
      } catch {
        // The lease expires on its own.
      }
    }
  };

  /**
   * Runs `change` under the store's lock. Every key shares the stored list, so every change takes the
   * same lock. A failure to take the lock, or to read storage, is `onFailure`.
   */
  const withLock = async <T>(onFailure: T, change: (records: HoldRecord[]) => T): Promise<T> => {
    const name = DIRECT_WITHDRAWAL_HOLDS_KEY;
    const run = async () => {
      const records = readAll();
      return records === undefined ? onFailure : change(records);
    };
    try {
      const manager = locks();
      return await (manager === undefined ? withStorageLock(name, run) : manager.request(name, run));
    } catch (error) {
      console.warn('Could not change the stored withdrawal holds:', error);
      return onFailure;
    }
  };

  return {
    /** The key's records, held ones and live reservations, or `unknown` when storage cannot be read. */
    read(key: HoldKey): HoldsRead {
      const records = readAll();
      if (records === undefined) return { status: 'unknown' };
      return { status: 'known', records: records.filter((record) => isForKey(record, key) && isLive(record)) };
    },

    /** Reserves the key for a new request, unless another one is reserved or held. */
    reserve(key: HoldKey): Promise<ReserveResult> {
      return withLock<ReserveResult>({ status: 'unknown' }, (records) => {
        const others = records.filter((record) => isForKey(record, key) && isLive(record));
        if (others.length > 0) return { status: 'held-back', records: others };
        const reservation: DirectWithdrawalReservation = {
          ...key,
          kind: 'reserved',
          id: randomId(),
          tabId: currentTabId(),
          expiresAt: now() + RESERVATION_LEASE_MS,
        };
        return writeAll([...records, reservation]) ? { status: 'reserved', id: reservation.id } : { status: 'unknown' };
      });
    },

    /**
     * Turns the reservation `id` into a hold with `figures`, just before the wallet is asked. Whether
     * storage now holds it: false when the reservation is gone or expired, another request of the key is live,
     * or storage failed. The wallet is asked only on true.
     */
    hold(key: HoldKey, id: string, figures: HoldFigures): Promise<boolean> {
      return withLock(false, (records) => {
        const own = records.find((record) => record.id === id && isForKey(record, key));
        const others = records.filter((record) => record.id !== id && isForKey(record, key) && isLive(record));
        if (own?.kind !== 'reserved' || !isLive(own) || others.length > 0) return false;
        const held: DirectWithdrawalHold = {
          ...key,
          kind: 'held',
          id,
          calldata: figures.calldata.toLowerCase(),
          amount: figures.amount.toString(),
          blockNumber: figures.blockNumber,
        };
        return writeAll(records.map((record) => (record.id === id ? held : record)));
      });
    },

    /** Adds the transaction's hash, and its nonce when known, to the hold `id`. */
    recordHash(key: HoldKey, id: string, hash: string, nonce: number | undefined): Promise<boolean> {
      return withLock(false, (records) => {
        const own = records.find((record) => record.id === id && isForKey(record, key));
        const lowerHash = hash.toLowerCase();
        // A hash that fails the format a read accepts leaves the hold as it is, without it.
        if (own?.kind !== 'held' || !HASH.test(lowerHash)) return false;
        const withHash: DirectWithdrawalHold = {
          ...own,
          hash: lowerHash,
          ...(isCount(nonce) ? { nonce } : {}),
        };
        return writeAll(records.map((record) => (record.id === id ? withHash : record)));
      });
    },

    /** Removes the record `id`: its request never reached the wallet, or can no longer execute. */
    release(key: HoldKey, id: string): Promise<boolean> {
      return withLock(false, (records) =>
        writeAll(records.filter((record) => !(record.id === id && isForKey(record, key))))
      );
    },
  };
}

/** This tab's view of the stored holds. */
export const directWithdrawalHolds = createHoldStore();

const cometInterface = new Interface(CometAbi);

/** The calldata of Comet's `withdraw(baseToken, amount)`, as production's Comet base withdrawal sends it. */
export function directWithdrawalCalldata(baseToken: string, amount: bigint | string): string {
  return cometInterface.encodeFunctionData('withdraw', [baseToken, amount.toString()]).toLowerCase();
}

/**
 * The block a read about the hold must be of: no older than the wallet node's newest block and
 * every one of `floors`, read from the configured chain's provider once it has reached it. Throws
 * when the wallet's node cannot be read or answers late, or the provider does not reach the block
 * in time, and then
 * nothing that depends on the read happens: no hold ends, no row unlocks and nothing is sent.
 */
export async function anchorBlock(
  readProvider: Pick<JsonRpcProvider, 'getBlockNumber'>,
  walletProvider: Pick<JsonRpcProvider, 'getBlockNumber'> | undefined,
  floors: readonly (number | undefined)[],
  wait: BlockWait = DEFAULT_BLOCK_WAIT
): Promise<number> {
  if (walletProvider === undefined) throw new Error("The wallet's network cannot be read.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("The wallet's network did not answer in time.")),
      wait.attempts * wait.intervalMs
    );
  });
  const walletBlock = await Promise.race([walletProvider.getBlockNumber(), late]).finally(() => clearTimeout(timer));
  if (!isCount(walletBlock)) throw new Error("The wallet's network gave no block.");
  const required = floors.reduce<number>(
    (newest, floor) => (floor !== undefined && floor > newest ? floor : newest),
    walletBlock
  );
  const block = await waitForBlock(readProvider, required, wait);
  if (block === undefined || block < required)
    throw new Error("This market's network has not reached the wallet's block.");
  return block;
}

/** The reads that look for evidence about a held request. */
export type HoldEvidenceReader = Pick<
  JsonRpcProvider,
  'getLogs' | 'getTransaction' | 'getTransactionReceipt' | 'getTransactionCount' | 'getBlock'
>;

/**
 * Whether the held request can no longer execute, by evidence about the request itself up to
 * `throughBlock`, a block from `anchorBlock`:
 * - With a hash: the transaction has a receipt, success or revert, or its own nonce is taken, by
 *   itself or by another transaction that replaced it. The own nonce is the one the node reports
 *   for the hash, or the one the hold stores. `onNonce` gets the node's when the hold has none, so
 *   that it can be stored. The lower bound the transaction manager reads before sending is never used.
 * - Without one: a transaction from the account to Comet with the hold's calldata, byte for byte,
 *   was mined after the hold's block, the block of the fresh read before the wallet was asked.
 *   Comet's `Withdraw` logs for the account find the candidates. A candidate counts only when it is
 *   mined in the log's own block, and that block is the canonical one at its height
 *   (`isMinedAsLogged`). `scanned` keeps the last block looked through for each hold, so the next look
 *   continues from there, at most `LOG_BLOCK_RANGE × 5` blocks each time. It stops before the block of
 *   a log whose transaction was not read, or whose transaction has the held calldata and did not
 *   count, so the next look reads that block again.
 *
 * A failed read throws, and the hold stays. An identical withdrawal of the same amount sent from
 * another interface also ends a hashless hold.
 */
export async function isHoldResolved(
  hold: DirectWithdrawalHold,
  reader: HoldEvidenceReader,
  throughBlock: number,
  scanned: Map<string, number>,
  onNonce?: (nonce: number) => void
): Promise<boolean> {
  if (hold.hash !== undefined) {
    if (await reader.getTransactionReceipt(hold.hash)) return true;
    const reported = (await reader.getTransaction(hold.hash))?.nonce;
    if (isCount(reported) && hold.nonce === undefined) onNonce?.(reported);
    const nonce = isCount(reported) ? reported : hold.nonce;
    if (nonce === undefined) return false;
    return (await reader.getTransactionCount(hold.account, throughBlock)) > nonce;
  }

  const withdrawTopic = cometInterface.getEventTopic('Withdraw');
  // The hold's block was read before the wallet was asked, so the request is mined after it.
  let fromBlock = Math.max(hold.blockNumber + 1, (scanned.get(hold.id) ?? hold.blockNumber) + 1);
  for (let request = 0; request < LOG_REQUESTS_PER_LOOK && fromBlock <= throughBlock; request++) {
    const toBlock = Math.min(throughBlock, fromBlock + LOG_BLOCK_RANGE - 1);
    const logs = await reader.getLogs({
      address: hold.cometAddress,
      topics: [withdrawTopic, hexZeroPad(hold.account, 32)],
      fromBlock,
      toBlock,
    });
    // The lowest block of a log whose transaction was not read, or whose transaction has the held
    // calldata but was not shown mined where its log says. The next look starts there.
    let unsettledFrom: number | undefined;
    const keepUnsettled = (log: { blockNumber?: number }) => {
      const logBlock =
        isCount(log.blockNumber) && log.blockNumber >= fromBlock && log.blockNumber <= toBlock
          ? log.blockNumber
          : fromBlock;
      unsettledFrom = Math.min(unsettledFrom ?? logBlock, logBlock);
    };
    for (const log of logs) {
      const transaction = await reader.getTransaction(log.transactionHash);
      // A node answers null for a transaction it has not indexed yet. That is no evidence either way.
      if (transaction === null || transaction === undefined) {
        keepUnsettled(log);
      } else if (
        transaction.from?.toLowerCase() === hold.account &&
        transaction.to?.toLowerCase() === hold.cometAddress &&
        transaction.data?.toLowerCase() === hold.calldata
      ) {
        if (await isMinedAsLogged(transaction, log, reader, throughBlock)) return true;
        keepUnsettled(log);
      }
    }
    if (unsettledFrom !== undefined) {
      scanned.set(hold.id, unsettledFrom - 1);
      return false;
    }
    scanned.set(hold.id, toBlock);
    fromBlock = toBlock + 1;
  }
  return false;
}

/**
 * Whether `transaction` is mined in the block `log` names, and that block is canonical at the
 * anchored block: the transaction's block number and hash are the log's, the node's block at that
 * height has the same hash, and it is no newer than `throughBlock`. A transaction a reorg returned to
 * pending has no block, and a log or block from another branch has another hash.
 */
async function isMinedAsLogged(
  transaction: { blockNumber?: number | null; blockHash?: string | null },
  log: { blockNumber?: number; blockHash?: string },
  reader: Pick<HoldEvidenceReader, 'getBlock'>,
  throughBlock: number
): Promise<boolean> {
  const { blockNumber, blockHash } = transaction;
  const logHash = typeof log.blockHash === 'string' ? log.blockHash.toLowerCase() : undefined;
  if (!isCount(blockNumber) || typeof blockHash !== 'string' || logHash === undefined) return false;
  if (blockNumber !== log.blockNumber || blockHash.toLowerCase() !== logHash || blockNumber > throughBlock) {
    return false;
  }
  const block = await reader.getBlock(blockNumber);
  return typeof block?.hash === 'string' && block.hash.toLowerCase() === logHash;
}
