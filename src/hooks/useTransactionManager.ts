import { JsonRpcProvider, TransactionReceipt, TransactionResponse } from '@ethersproject/providers';
import { BigNumber } from 'ethers';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';

import { Web3 } from '@contexts/Web3Context';
import { TRANSACTION_LOCALSTORAGE_KEY } from '@helpers/constants';
import { filterMap } from '@helpers/functions';
import { TRX_REFRESH_INTERVAL } from '@helpers/numbers';
import { classifyWalletError, describeWalletError, SendWithdrawnError } from '@helpers/walletErrors';
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
transactions on the connected chain, and looks each one up before resuming it:
a settled transaction is reported in `settledTransactions` with its outcome,
never treated as a success it may not have been. A restored transaction has no
callback, so nothing that was to follow it is sent.

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
 * Whether the record is a step of a wrapper action. While such a step may still be live, the next
 * review of its action waits, so neither a reload nor clearing the list drops it. Only records
 * keyed to a configured wrapper qualify, so a record written to storage by anyone else cannot
 * hold any other contract's buttons.
 */
function isWrapperStep(transaction: Transaction): boolean {
  return transaction.step !== undefined && isWrapperAddress(transaction.key);
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
      updatedTransactions = currentTransactions.filter(isWrapperStep);
      const clearedIds = new Set(currentTransactions.filter((tx) => !isWrapperStep(tx)).map((tx) => tx.id));
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
 * review of the action start, and a lower bound could report a transaction that is still pending.
 */
async function resolveTransaction(provider: TransactionReader, transaction: PendingTransaction): Promise<Resolution> {
  const receipt = await provider.getTransactionReceipt(transaction.hash);
  if (receipt) return { status: 'settled', outcome: outcomeOf(receipt) };
  if (transaction.account === undefined) return { status: 'pending' };

  const sentTransaction = await provider.getTransaction(transaction.hash);
  const reportedNonce = typeof sentTransaction?.nonce === 'number' ? sentTransaction.nonce : undefined;
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
 * - `provider-failure`: the wallet reported another error. Whether anything reached the chain is
 *   unknown, so this is never shown as a rejection and never retried automatically.
 * - `session-broken`: the provider itself is broken, as after an extension update.
 * - `session-changed`: the session is gone, or is not the account or chain the caller checked.
 *   Nothing was sent.
 */
export type SendResult =
  | { status: 'submitted'; id: string; hash: string; response?: TransactionResponse }
  | { status: 'rejected' }
  | { status: 'provider-failure'; message: string }
  | { status: 'session-broken'; message: string }
  | { status: 'session-changed' };

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

export type TransactionManager = {
  /** Transactions awaiting a wallet's confirmation or a receipt. */
  transactions: Transaction[];
  /** Transactions this session saw settle, including restored ones, with what became of them. */
  settledTransactions: SettledTransaction[];
  /** The last wallet provider found broken, if any. */
  walletFailure: WalletFailure | undefined;
  addTransaction: AddTransaction;
  submitTransaction: SubmitTransaction;
  /** Clears the list, except wrapper steps, which stay until they settle or are dismissed. */
  clearTransactions: () => void;
  /** Stops tracking one transaction, with no outcome and no callback. */
  dismissTransaction: (id: string) => void;
};

export function useTransactionManager(web3: Web3): TransactionManager {
  const [transactions, updateTransactions] = useReducer(txReducer, []);
  const [settledTransactions, setSettledTransactions] = useState<SettledTransaction[]>([]);
  const [walletFailure, setWalletFailure] = useState<WalletFailure | undefined>(undefined);
  const settledIds = useRef(new Set<string>());
  const { provider, account } = web3.write;

  const noteWalletError = useCallback((failedProvider: object, error: unknown) => {
    if (classifyWalletError(error) === 'session-broken') {
      setWalletFailure({ provider: failedProvider, message: describeWalletError(error) });
    }
  }, []);

  const settle = useCallback((transaction: PendingTransaction, outcome: TransactionOutcome) => {
    if (settledIds.current.has(transaction.id)) return;
    settledIds.current.add(transaction.id);
    updateTransactions([ActionType.Remove, transaction.id]);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { callback, ...record } = transaction;
    setSettledTransactions((settled) => [...settled, { ...record, outcome }].slice(-MAX_SETTLED_TRANSACTIONS));
    callback?.(outcome);
  }, []);

  // Restore the connected account's broadcast transactions on the connected chain, looking each
  // one up first. Other accounts' and chains' records stay stored until they connect.
  useEffect(() => {
    if (provider === undefined || account === undefined) return;
    let isCurrent = true;
    const sender = account.toLowerCase();

    provider.getNetwork().then(
      ({ chainId }) => {
        if (!isCurrent) return;
        const storedTransactions = readStoredTransactions();
        const isOwn = (tx: Transaction) => tx.networkId === chainId && tx.account?.toLowerCase() === sender;
        const isInterrupted = (tx: Transaction): tx is AwaitingConfirmationTransaction =>
          isOwn(tx) && tx.state === TransactionState.AwaitingConfirmation && isWrapperStep(tx);
        // A record with no sender cannot be tied to an account, and a wallet request with no hash
        // cannot be looked up. A wrapper step stays, though: its wallet request may still be open,
        // so the next review of its action waits until the user dismisses it.
        updateStoredTransactions((stored) =>
          stored.filter(
            (tx) =>
              tx.account !== undefined && (!isOwn(tx) || tx.state === TransactionState.Pending || isInterrupted(tx))
          )
        );
        storedTransactions.filter(isInterrupted).forEach((transaction) => {
          updateTransactions([ActionType.Add, { ...transaction, isInterrupted: true }]);
        });
        const ownTransactions = filterMap<Transaction, PendingTransaction>(storedTransactions, (tx) =>
          isOwn(tx) && tx.state === TransactionState.Pending ? tx : undefined
        );
        ownTransactions.forEach((transaction) => {
          resolveTransaction(provider, transaction).then(
            (resolution) => {
              if (!isCurrent) return;
              if (resolution.status === 'pending')
                updateTransactions([ActionType.Add, withOwnNonce(transaction, resolution)]);
              else settle(transaction, resolution.outcome);
            },
            (error) => {
              // Unknown, so it stays tracked as pending.
              console.error(`Could not look up transaction ${transaction.hash}:`, error);
              noteWalletError(provider, error);
              if (isCurrent) updateTransactions([ActionType.Add, transaction]);
            }
          );
        });
      },
      (error) => {
        console.error('Could not restore transactions:', error);
        noteWalletError(provider, error);
      }
    );

    return () => {
      isCurrent = false;
    };
  }, [provider, account]);

  // when new transactions are added, poll for transaction receipts until all
  // pending transactions are resolved
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let isCurrent = true;

    function pollForTransactionReceipt() {
      requestAnimationFrame(() => {
        if (!isCurrent || provider === undefined || provider.network === undefined) return;
        const chainId = provider.network.chainId;
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
        timeoutId = setTimeout(pollForTransactionReceipt, TRX_REFRESH_INTERVAL);
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
      let isRecorded = false;
      try {
        // Throws if the wallet changed network since the provider was built.
        const network = await provider.getNetwork();
        if (request.chainId !== undefined && network.chainId !== request.chainId) return { status: 'session-changed' };
        const currentNonce = await provider.getTransactionCount(account);

        const baseTransaction: BaseTransaction = {
          id,
          key: request.key,
          networkId: network.chainId,
          networkName: network.name,
          description: request.description,
          nonce: currentNonce,
          account: account.toLowerCase(),
          step: request.step,
          callback: request.onSettled,
        };
        updateTransactions([ActionType.Add, { ...baseTransaction, state: TransactionState.AwaitingConfirmation }]);
        isRecorded = true;

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
              ? { nonce: currentNonce, nonceSource: 'lower-bound' as const }
              : { nonce: ownNonce, nonceSource: 'transaction' as const }),
          },
        ]);
        return typeof response === 'string'
          ? { status: 'submitted', id, hash }
          : { status: 'submitted', id, hash, response };
      } catch (error) {
        if (isRecorded) updateTransactions([ActionType.Remove, id]);
        if (error instanceof SendWithdrawnError) return { status: 'session-changed' };
        console.log(error);
        noteWalletError(provider, error);
        const kind = classifyWalletError(error);
        return kind === 'rejected' ? { status: 'rejected' } : { status: kind, message: describeWalletError(error) };
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

  const dismissTransaction = useCallback((id: string) => {
    updateTransactions([ActionType.Remove, id]);
  }, []);

  return {
    transactions,
    settledTransactions,
    walletFailure,
    addTransaction,
    submitTransaction,
    clearTransactions,
    dismissTransaction,
  };
}
