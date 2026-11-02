import { JsonRpcProvider, TransactionReceipt, TransactionResponse } from '@ethersproject/providers';
import { BigNumber } from 'ethers';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';

import { Web3 } from '@contexts/Web3Context';
import { TRANSACTION_LOCALSTORAGE_KEY } from '@helpers/constants';
import { filterMap } from '@helpers/functions';
import { TRX_REFRESH_INTERVAL } from '@helpers/numbers';
import {
  classifyWalletError,
  describeWalletError,
  describeWalletRefusal,
  NotSentError,
  SendWithdrawnError,
} from '@helpers/walletErrors';
import { isWrapperAddress } from '@helpers/wrappedActions';
import {
  AwaitingConfirmationTransaction,
  BaseTransaction,
  PendingTransaction,
  SettledTransaction,
  Transaction,
  TransactionOutcome,
  TransactionState,
} from '@types';

/*
useTransactionManager is a hook that keeps track of pending transactions,
polling periodically to see if the transaction has resolved.

Transactions are written to localStorage, so pending transactions will be
reloaded on page refresh. A reload restores only the connected account's
transactions on the connected chain. Each one is tracked as soon as the chain is
known, before it is looked up, and `restoredSession` then names that session.
The poll looks each one up: a settled transaction is reported in
`settledTransactions` with its outcome, and only a receipt that shows success
counts as one. A restored transaction has no callback, so nothing that was to
follow it is sent.

For example:

function Component() {
  const { web3 } = useWeb3();
  const { transactions, addTransaction } = useTransactionManager(web3.read.provider);

  function approve() {
    const tokenErc20 = new Contract(...);
    const tx = await tokenErc20.approve("0x01", MAX_UINT256.toString());
    addTransaction(
      tokenErc20.address,
      tx.hash,
      `Approve Transaction - ${Date.now()}`
    );
  }

  return (
    <>
      <button onClick={() => approve()}>Approve</button>

      {transactions.map((tx: Transaction)=> (
        <div key={tx.hash}>
          <ul>
            <li>{tx.networkName}</li>
            <li>{tx.assetAddress}</li>
            <li>{tx.hash}</li>
            <li>{tx.name}</li>
          </ul>
        </div>
      ))}
    <>
  );
}
*/

enum ActionType {
  Add = 'add',
  Update = 'update',
  Remove = 'remove',
  Clear = 'clear',
}

type AddAction = [ActionType.Add, Transaction];
type UpdateAction = [ActionType.Update, Transaction];
type RemoveAction = [ActionType.Remove, string];
type ClearAction = [ActionType.Clear];

type Action = AddAction | UpdateAction | RemoveAction | ClearAction;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;

/** Whether a stored value is a well-formed transaction record. Any script on the page can write storage. */
function isStoredTransaction(value: unknown): value is Transaction {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const isCount = (field: unknown, minimum: number) =>
    typeof field === 'number' && Number.isSafeInteger(field) && field >= minimum;
  return (
    typeof record.id === 'string' &&
    typeof record.key === 'string' &&
    isCount(record.networkId, 1) &&
    typeof record.networkName === 'string' &&
    typeof record.description === 'string' &&
    isCount(record.nonce, 0) &&
    (record.nonceSource === undefined ||
      record.nonceSource === 'transaction' ||
      record.nonceSource === 'lower-bound') &&
    (record.account === undefined || (typeof record.account === 'string' && ADDRESS.test(record.account))) &&
    (record.step === undefined || typeof record.step === 'string') &&
    (record.state === TransactionState.AwaitingConfirmation ||
      (record.state === TransactionState.Pending &&
        typeof record.hash === 'string' &&
        TRANSACTION_HASH.test(record.hash)))
  );
}

/** The well-formed stored records. Anything else is dropped at the next write. */
function readStoredTransactions(): Transaction[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(TRANSACTION_LOCALSTORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isStoredTransaction) : [];
  } catch {
    return [];
  }
}

/** Applies `change` to the stored records. Storage that is full or unavailable never throws here. */
function updateStoredTransactions(change: (stored: Transaction[]) => Transaction[]) {
  try {
    window.localStorage.setItem(TRANSACTION_LOCALSTORAGE_KEY, JSON.stringify(change(readStoredTransactions())));
  } catch (error) {
    console.error('Could not store transactions:', error);
  }
}

/**
 * Whether the record is a step of a wrapper action. While such a step can still be live, the next
 * review of its action waits, so a reload does not drop it. Only records keyed to a configured
 * wrapper qualify, so a record written to storage by anyone else cannot hold any other contract's
 * buttons.
 */
function isWrapperStep(transaction: Transaction): boolean {
  return transaction.step !== undefined && isWrapperAddress(transaction.key);
}

/**
 * Whether the record delays Comet data refreshes until it settles. Every record does, except an
 * interrupted wrapper step with no hash. The manager has no hash to look up for it, so it never
 * settles the record, which leaves the list only when the user clears the list. A record that
 * delays refreshes and never settles stops every Comet data update, so this one does not delay
 * them. It stays tracked so that the next review of its action still waits for it.
 */
export function delaysCometRefresh(transaction: Transaction): boolean {
  // Storage validation accepts a wallet request record that carries a hash, and the type does not
  // declare one, so the field is read at runtime. Any hash value keeps the record delaying refreshes.
  const isInterruptedWrapperStep =
    isWrapperStep(transaction) &&
    transaction.state === TransactionState.AwaitingConfirmation &&
    transaction.isInterrupted === true &&
    !('hash' in transaction && transaction.hash !== undefined);
  return !isInterruptedWrapperStep;
}

/**
 * Whether clearing the list keeps the record: a wrapper step whose result can still be followed,
 * because it has a hash or its wallet request is open in this session. A wrapper step interrupted
 * by a reload or an ambiguous answer has neither, so nothing can follow it. Clearing the list is
 * how the user stops waiting for it, after checking the wallet, as for any other transaction.
 */
function isKeptByClear(transaction: Transaction): boolean {
  const isInterrupted =
    transaction.state === TransactionState.AwaitingConfirmation && transaction.isInterrupted === true;
  return isWrapperStep(transaction) && !isInterrupted;
}

function txReducer(currentTransactions: Transaction[], action: Action): Transaction[] {
  const [type] = action;
  let updatedTransactions: Transaction[];
  let storedChange: (stored: Transaction[]) => Transaction[];
  // Storage also holds other accounts' and other chains' transactions, so each change is applied
  // to it record by record instead of replacing it with this list.
  switch (type) {
    case ActionType.Add: {
      const added = action[1];
      if (currentTransactions.some((tx) => tx.id === added.id)) return currentTransactions;
      updatedTransactions = [...currentTransactions, added];
      storedChange = (stored) => [...stored.filter((tx) => tx.id !== added.id), added];
      break;
    }
    case ActionType.Update: {
      const updated = action[1];
      // An update for a transaction no longer tracked, such as a late lookup of one just settled,
      // changes nothing. Otherwise it writes the record back to storage, and a later restore can
      // track it again.
      if (!currentTransactions.some((tx) => tx.id === updated.id)) return currentTransactions;
      updatedTransactions = currentTransactions.map((tx) => (tx.id === updated.id ? updated : tx));
      storedChange = (stored) => [...stored.filter((tx) => tx.id !== updated.id), updated];
      break;
    }
    case ActionType.Remove: {
      const removedId = action[1];
      updatedTransactions = currentTransactions.filter((tx) => tx.id !== removedId);
      storedChange = (stored) => stored.filter((tx) => tx.id !== removedId);
      break;
    }
    case ActionType.Clear: {
      updatedTransactions = currentTransactions.filter(isKeptByClear);
      const clearedIds = new Set(currentTransactions.filter((tx) => !isKeptByClear(tx)).map((tx) => tx.id));
      storedChange = (stored) => stored.filter((tx) => !clearedIds.has(tx.id));
      break;
    }
    default:
      throw new Error();
  }
  updateStoredTransactions(storedChange);
  return updatedTransactions;
}

/** The provider calls that look up what became of a transaction. */
type TransactionReader = Pick<JsonRpcProvider, 'getTransactionReceipt' | 'getTransaction' | 'getTransactionCount'>;

function outcomeOf(receipt: TransactionReceipt): TransactionOutcome {
  return receipt.status === 1 ? { status: 'confirmed', receipt } : { status: 'reverted', receipt };
}

type Resolution =
  | { status: 'settled'; outcome: TransactionOutcome }
  /** `ownNonce` is the transaction's own nonce, when the node reported one. */
  | { status: 'pending'; ownNonce?: number };

/**
 * What became of a broadcast transaction, or `pending` while that is unknown. A receipt shows it
 * was mined, successfully or not. Without one, it was replaced only once its sender's confirmed
 * nonce has passed the transaction's nonce and a second lookup still finds no receipt.
 *
 * The nonce read before sending is only a lower bound: a wallet that queues the transaction behind
 * another sends it with a higher one. The node's record of the transaction gives its own nonce. A
 * wrapper step is judged replaced only by its own nonce, since reporting it replaced lets a fresh
 * review of the action start, and a lower bound can report a transaction that is still pending.
 *
 * The record's nonce is the transaction's own, or that lower bound, so the transaction's own nonce
 * is never below it. A smaller reported nonce is not the transaction's and is ignored. A Safe, for
 * example, reports nonce 0 until its owners execute the transaction. Otherwise every queued Safe
 * transaction is reported replaced on its first lookup.
 */
async function resolveTransaction(provider: TransactionReader, transaction: PendingTransaction): Promise<Resolution> {
  const receipt = await provider.getTransactionReceipt(transaction.hash);
  if (receipt) return { status: 'settled', outcome: outcomeOf(receipt) };
  if (transaction.account === undefined) return { status: 'pending' };

  const sentTransaction = await provider.getTransaction(transaction.hash);
  const reportedNonce =
    typeof sentTransaction?.nonce === 'number' && sentTransaction.nonce >= transaction.nonce
      ? sentTransaction.nonce
      : undefined;
  const ownNonce = reportedNonce ?? (transaction.nonceSource === 'transaction' ? transaction.nonce : undefined);
  const nonce = ownNonce ?? (isWrapperStep(transaction) ? undefined : transaction.nonce);
  const pending: Resolution = { status: 'pending', ownNonce: reportedNonce };
  if (nonce === undefined) return pending;
  const confirmedNonce = await provider.getTransactionCount(transaction.account);
  if (confirmedNonce <= nonce) return pending;

  const lateReceipt = await provider.getTransactionReceipt(transaction.hash);
  return { status: 'settled', outcome: lateReceipt ? outcomeOf(lateReceipt) : { status: 'replaced' } };
}

/** The record with the transaction's own nonce, once the node has reported it. */
function withOwnNonce(transaction: PendingTransaction, resolution: Resolution): PendingTransaction {
  if (resolution.status !== 'pending' || resolution.ownNonce === undefined) return transaction;
  if (transaction.nonceSource === 'transaction' && transaction.nonce === resolution.ownNonce) return transaction;
  return { ...transaction, nonce: resolution.ownNonce, nonceSource: 'transaction' };
}

/** How many settled transactions `settledTransactions` keeps, newest last. */
const MAX_SETTLED_TRANSACTIONS = 20;

/**
 * How long the restore waits before its first new attempt to read the chain, in milliseconds. The
 * wait doubles after each failure, up to the poll interval.
 */
const FIRST_RESTORE_RETRY_MS = 1_000;

export type AddTransaction = (
  key: string,
  description: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trxFn: (...args: any[]) => Promise<TransactionResponse>,
  estimatedGas: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trxEstimateGasFn: (...args: any[]) => Promise<BigNumber>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fnArgs: any[],
  value?: bigint,
  callback?: (outcome: TransactionOutcome) => void
) => Promise<TransactionResponse | undefined>;

/**
 * What became of asking the wallet to send a transaction.
 * - `submitted`: the wallet returned a hash, so the transaction was broadcast. Until then it shows
 *   as awaiting the wallet, which can take minutes when it is approved on a mobile device.
 * - `rejected`: the user declined, by an explicit rejection only.
 * - `refused`: the wallet refused the request before it handled it, with EIP-1193 code 4100, 4200,
 *   4900 or 4901, as the Anchorage extension does after the user logs into it again. Nothing was
 *   sent. `message` names the refusal's code.
 * - `provider-failure`: the wallet reported another error. Whether anything reached the chain is
 *   unknown, so this is never shown as a rejection and never retried automatically.
 * - `pending-in-wallet`: the wallet answered that it still holds the request, as the Anchorage
 *   extension does after a request waits for approval on a phone for about 4 minutes 47 seconds,
 *   and, with code 4900, when it stops waiting because the tab's wallet was disconnected. Whether
 *   anything reaches the chain is unknown, and it is handled as a `provider-failure`.
 * - `session-broken`: the provider itself is broken, as after an extension update.
 * - `session-changed`: the session is gone, or is not the account or chain the caller checked, or
 *   the caller withdrew the request. Nothing was sent.
 * - `not-sent`: the request failed before the wallet was asked to sign, for example while
 *   reading the nonce or estimating gas. Nothing was sent.
 *
 * After `provider-failure`, `pending-in-wallet` or `session-broken`, a wrapper step's record stays,
 * marked interrupted, since the wallet can still send it. Other records are removed.
 */
export type SendResult =
  | { status: 'submitted'; id: string; hash: string; response?: TransactionResponse }
  | { status: 'rejected' }
  | { status: 'refused'; message: string }
  | { status: 'provider-failure'; message: string }
  | { status: 'pending-in-wallet'; message: string }
  | { status: 'session-broken'; message: string }
  | { status: 'session-changed' }
  | { status: 'not-sent'; message: string };

export type TransactionRequest = {
  /** What the UI groups the transaction under, such as the contract it calls. */
  key: string;
  description: string;
  /**
   * Asks the wallet to send the transaction. Resolves with its hash or response once broadcast.
   * Throwing `SendWithdrawnError` withdraws the request before the wallet is asked.
   */
  send: () => Promise<TransactionResponse | string>;
  /** For one transaction of a multi-step action, the step it is. */
  step?: string;
  /** The sender the caller checked. Nothing is sent if the session's account differs. */
  account?: string;
  /** The chain the caller checked. Nothing is sent if the wallet reports another. */
  chainId?: number;
  onSettled?: (outcome: TransactionOutcome) => void;
};

export type SubmitTransaction = (request: TransactionRequest) => Promise<SendResult>;

/** A wallet provider that threw as a broken provider does, as after an extension update. */
export type WalletFailure = { provider: object; message: string };

/** A wallet session whose stored transactions are restored: its provider, its sender in lower case and its chain. */
export type RestoredSession = { provider: object; account: string; chainId: number };

export type TransactionManager = {
  /** Transactions awaiting a wallet's confirmation or a receipt. */
  transactions: Transaction[];
  /** Transactions this session saw settle, including restored ones, with what became of them. */
  settledTransactions: SettledTransaction[];
  /**
   * The last wallet provider found broken while that provider was in use, if any. The manager
   * ignores a failure from a provider that is not in use, so that failure cannot replace this
   * record. An example is a request through an earlier provider that fails after Web3Context
   * rebuilt the wallet provider.
   */
  walletFailure: WalletFailure | undefined;
  /**
   * The last wallet session whose stored transactions were restored into `transactions`. Until it
   * is the live session, `transactions` can lack a transaction the live session sent before a
   * reload, so a caller that must wait for earlier transactions waits for this too.
   */
  restoredSession: RestoredSession | undefined;
  addTransaction: AddTransaction;
  submitTransaction: SubmitTransaction;
  /** Clears the list, except wrapper steps that can still be followed, which stay until they settle. */
  clearTransactions: () => void;
};

export function useTransactionManager(web3: Web3): TransactionManager {
  const [transactions, updateTransactions] = useReducer(txReducer, []);
  const [settledTransactions, setSettledTransactions] = useState<SettledTransaction[]>([]);
  const [walletFailure, setWalletFailure] = useState<WalletFailure | undefined>(undefined);
  const [restoredSession, setRestoredSession] = useState<RestoredSession | undefined>(undefined);
  const settledIds = useRef(new Set<string>());
  // Callbacks by transaction id. Records are stored, and a stored record cannot hold a function,
  // so no record carries its callback. `settle` runs once for each id, so each callback runs once.
  const callbacks = useRef(new Map<string, (outcome: TransactionOutcome) => void>());
  // The transactions as of the last render. The reducer writes storage only when it runs, in the
  // next render, so storage can still hold a transaction that this session has since settled or
  // cleared.
  const trackedTransactions = useRef(transactions);
  trackedTransactions.current = transactions;
  const { provider, account } = web3.write;
  // The wallet provider in use: the one in the last render. A request through an earlier provider
  // can fail after Web3Context has rebuilt the wallet provider.
  const liveProvider = useRef(provider);
  liveProvider.current = provider;

  // Records a provider as broken only while that provider is in use. Otherwise a failure that an
  // earlier provider reports late replaces the record of the provider in use. `useWrappedAction`
  // can then show the broken session as usable, with no new check.
  const noteWalletError = useCallback((failedProvider: object, error: unknown) => {
    if (failedProvider !== liveProvider.current) return;
    if (classifyWalletError(error) === 'session-broken') {
      setWalletFailure({ provider: failedProvider, message: describeWalletError(error) });
    }
  }, []);

  const settle = useCallback((transaction: PendingTransaction, outcome: TransactionOutcome) => {
    if (settledIds.current.has(transaction.id)) return;
    settledIds.current.add(transaction.id);
    updateTransactions([ActionType.Remove, transaction.id]);
    const callback = callbacks.current.get(transaction.id);
    callbacks.current.delete(transaction.id);
    setSettledTransactions((settled) => [...settled, { ...transaction, outcome }].slice(-MAX_SETTLED_TRANSACTIONS));
    callback?.(outcome);
  }, []);

  // Restore the connected account's transactions on the connected chain. Each one is tracked as
  // soon as the chain is known, before anything looks it up, so no render names the session
  // restored without them. The poll then looks each one up. Other accounts' and chains' records
  // stay stored until they connect.
  useEffect(() => {
    if (provider === undefined || account === undefined) return;
    let isCurrent = true;
    let retryId: ReturnType<typeof setTimeout> | undefined;
    let failedReadCount = 0;
    const sender = account.toLowerCase();

    const restore = () =>
      provider.getNetwork().then(
        ({ chainId }) => {
          if (!isCurrent) return;
          const storedTransactions = readStoredTransactions();
          const isOwn = (tx: Transaction) => tx.networkId === chainId && tx.account?.toLowerCase() === sender;
          // A record with no sender cannot be tied to an account, and a wallet request with no hash
          // cannot be looked up. A wrapper step stays, though: its wallet request can still be open,
          // so the next review of its action waits until the user clears it from the list.
          const isRestorable = (tx: Transaction) => tx.state === TransactionState.Pending || isWrapperStep(tx);
          // A transaction this session settled is dropped, even when storage holds it again, as after
          // another tab writes it back. `settle` ignores an id it has settled, so a copy tracked
          // again stays pending until a reload.
          const isSettled = (tx: Transaction) => settledIds.current.has(tx.id);
          updateStoredTransactions((stored) =>
            stored.filter((tx) => tx.account !== undefined && !isSettled(tx) && (!isOwn(tx) || isRestorable(tx)))
          );
          // A transaction the last render tracked is skipped as well, because its stored record can be
          // stale until the next render. Otherwise a wallet request cleared or forgotten since that
          // render comes back as interrupted, and holds back the next wrapper review.
          const isTracked = (tx: Transaction) => trackedTransactions.current.some((tracked) => tracked.id === tx.id);
          storedTransactions
            .filter((tx) => isOwn(tx) && isRestorable(tx) && !isTracked(tx) && !isSettled(tx))
            .forEach((transaction) => {
              updateTransactions([
                ActionType.Add,
                transaction.state === TransactionState.Pending ? transaction : { ...transaction, isInterrupted: true },
              ]);
            });
          setRestoredSession({ provider, account: sender, chainId });
        },
        (error) => {
          console.error('Could not restore transactions:', error);
          noteWalletError(provider, error);
          // Until a restore succeeds, `restoredSession` is undefined or names another session, so
          // callers that wait for it keep waiting. The restore tries again, soon at first, so that
          // they can continue once the wallet answers.
          const retryDelayMs = Math.min(FIRST_RESTORE_RETRY_MS * 2 ** failedReadCount, TRX_REFRESH_INTERVAL);
          failedReadCount++;
          if (isCurrent) retryId = setTimeout(restore, retryDelayMs);
        }
      );
    restore();

    return () => {
      isCurrent = false;
      if (retryId !== undefined) clearTimeout(retryId);
    };
  }, [provider, account]);

  // when new transactions are added, poll for transaction receipts until all
  // pending transactions are resolved
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let isCurrent = true;

    const scheduleNextPoll = () => {
      timeoutId = setTimeout(pollForTransactionReceipt, TRX_REFRESH_INTERVAL);
    };

    function pollForTransactionReceipt() {
      requestAnimationFrame(async () => {
        if (!isCurrent || provider === undefined) return;
        if (!transactions.some((tx) => tx.state === TransactionState.Pending)) return;
        // A wallet provider built moments ago has not detected its network yet, so ask for it
        // rather than read `provider.network`, and try again later if that fails.
        let chainId: number;
        try {
          ({ chainId } = await provider.getNetwork());
        } catch (error) {
          noteWalletError(provider, error);
          if (isCurrent) scheduleNextPoll();
          return;
        }
        if (!isCurrent) return;
        const currentNetworkPendingTransactions = filterMap<Transaction, PendingTransaction>(transactions, (tx) =>
          tx.state === TransactionState.Pending && tx.networkId === chainId ? tx : undefined
        );
        if (currentNetworkPendingTransactions.length === 0) return;

        currentNetworkPendingTransactions.forEach((transaction) => {
          // A transaction can be replaced by another transaction with the same nonce. Wallets
          // typically do this with a "Cancel" or "Speed up" option.
          resolveTransaction(provider, transaction).then(
            (resolution) => {
              if (!isCurrent) return;
              if (resolution.status === 'settled') {
                settle(transaction, resolution.outcome);
                return;
              }
              const learned = withOwnNonce(transaction, resolution);
              if (learned !== transaction) updateTransactions([ActionType.Update, learned]);
            },
            (error) => {
              console.error(`Could not look up transaction ${transaction.hash}:`, error);
              noteWalletError(provider, error);
            }
          );
        });
        scheduleNextPoll();
      });
    }

    pollForTransactionReceipt();

    return () => {
      isCurrent = false;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [transactions, provider]);

  const submitTransaction = useCallback<SubmitTransaction>(
    async (request) => {
      if (provider === undefined || account === undefined) return { status: 'session-changed' };
      if (request.account !== undefined && request.account.toLowerCase() !== account.toLowerCase()) {
        return { status: 'session-changed' };
      }

      const id = uuidv4();
      let record: AwaitingConfirmationTransaction | undefined;
      let isSendCalled = false;
      const forget = () => {
        if (record !== undefined) updateTransactions([ActionType.Remove, id]);
        callbacks.current.delete(id);
      };
      try {
        // Throws if the wallet changed network since the provider was built.
        const network = await provider.getNetwork();
        if (request.chainId !== undefined && network.chainId !== request.chainId) return { status: 'session-changed' };
        const confirmedNonceBefore = await provider.getTransactionCount(account);

        const baseTransaction: BaseTransaction = {
          id,
          key: request.key,
          networkId: network.chainId,
          networkName: network.name,
          description: request.description,
          nonce: confirmedNonceBefore,
          account: account.toLowerCase(),
          step: request.step,
        };
        record = { ...baseTransaction, state: TransactionState.AwaitingConfirmation };
        updateTransactions([ActionType.Add, record]);
        if (request.onSettled !== undefined) callbacks.current.set(id, request.onSettled);

        isSendCalled = true;
        const response = await request.send();
        const hash = typeof response === 'string' ? response : response.hash;
        // A hash alone, or a `connectUnchecked` signer's response, gives no nonce.
        const ownNonce =
          typeof response !== 'string' && typeof response.nonce === 'number' ? response.nonce : undefined;
        updateTransactions([
          ActionType.Update,
          {
            ...baseTransaction,
            state: TransactionState.Pending,
            hash,
            ...(ownNonce === undefined
              ? { nonce: confirmedNonceBefore, nonceSource: 'lower-bound' as const }
              : { nonce: ownNonce, nonceSource: 'transaction' as const }),
          },
        ]);
        return typeof response === 'string'
          ? { status: 'submitted', id, hash }
          : { status: 'submitted', id, hash, response };
      } catch (error) {
        if (error instanceof SendWithdrawnError) {
          forget();
          return { status: 'session-changed' };
        }
        console.log(error);
        noteWalletError(provider, error);
        if (!isSendCalled || error instanceof NotSentError) {
          forget();
          return {
            status: 'not-sent',
            message: describeWalletError(error instanceof NotSentError ? error.cause : error),
          };
        }
        const kind = classifyWalletError(error);
        if (kind === 'rejected') {
          forget();
          return { status: 'rejected' };
        }
        // The wallet refused the request before it handled it, so it holds nothing it can send.
        if (kind === 'refused') {
          forget();
          return { status: 'refused', message: describeWalletRefusal(error) };
        }
        // The wallet had the request and can still send it. A wrapper step stays, marked
        // interrupted, so the next review of its action waits until the user clears it from the list.
        if (record !== undefined && isWrapperStep(record)) {
          const interrupted = { ...record, isInterrupted: true };
          updateTransactions([
            ActionType.Update,
            kind === 'pending-in-wallet' ? { ...interrupted, isPendingInWallet: true } : interrupted,
          ]);
        } else {
          forget();
        }
        return { status: kind, message: describeWalletError(error) };
      }
    },
    [provider, account]
  );

  const addTransaction = useCallback<AddTransaction>(
    async (key, description, trxFn, estimatedGas, trxEstimateGasFn, fnArgs, value = 0n, callback) => {
      const result = await submitTransaction({
        key,
        description,
        onSettled: callback,
        send: async () => {
          let gasLimit = estimatedGas;
          if (estimatedGas === 0) {
            const estimatedGasUsage = (await trxEstimateGasFn(...fnArgs, { value })).toNumber();
            gasLimit = Math.round(Number(estimatedGasUsage * 1.2));
          }
          return trxFn(...fnArgs, { value, gasLimit });
        },
      });
      return result.status === 'submitted' ? result.response : undefined;
    },
    [submitTransaction]
  );

  const clearTransactions = () => {
    updateTransactions([ActionType.Clear]);
  };

  return {
    transactions,
    settledTransactions,
    walletFailure,
    restoredSession,
    addTransaction,
    submitTransaction,
    clearTransactions,
  };
}
