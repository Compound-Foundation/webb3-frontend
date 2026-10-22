import { JsonRpcProvider, TransactionReceipt, TransactionResponse } from '@ethersproject/providers';
import { BigNumber } from 'ethers';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';

import { Web3 } from '@contexts/Web3Context';
import { TRANSACTION_LOCALSTORAGE_KEY } from '@helpers/constants';
import { filterMap } from '@helpers/functions';
import { TRX_REFRESH_INTERVAL } from '@helpers/numbers';
import { classifyWalletError, describeWalletError } from '@helpers/walletErrors';
import {
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

function readStoredTransactions(): Transaction[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(TRANSACTION_LOCALSTORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredTransactions(transactions: Transaction[]) {
  window.localStorage.setItem(TRANSACTION_LOCALSTORAGE_KEY, JSON.stringify(transactions));
}

function txReducer(currentTransactions: Transaction[], action: Action): Transaction[] {
  const [type] = action;
  let updatedTransactions: Transaction[];
  // Storage also holds other accounts' and other chains' transactions, so each change is applied
  // to it record by record instead of replacing it with this list.
  let storedTransactions = readStoredTransactions();
  switch (type) {
    case ActionType.Add:
      if (currentTransactions.some((tx) => tx.id === action[1].id)) return currentTransactions;
      updatedTransactions = [...currentTransactions, action[1]];
      storedTransactions = [...storedTransactions.filter((tx) => tx.id !== action[1].id), action[1]];
      break;
    case ActionType.Update:
      updatedTransactions = currentTransactions.map((tx) => (tx.id === action[1].id ? action[1] : tx));
      storedTransactions = [...storedTransactions.filter((tx) => tx.id !== action[1].id), action[1]];
      break;
    case ActionType.Remove:
      updatedTransactions = currentTransactions.filter((tx) => tx.id !== action[1]);
      storedTransactions = storedTransactions.filter((tx) => tx.id !== action[1]);
      break;
    case ActionType.Clear: {
      const clearedIds = new Set(currentTransactions.map((tx) => tx.id));
      updatedTransactions = [];
      storedTransactions = storedTransactions.filter((tx) => !clearedIds.has(tx.id));
      break;
    }
    default:
      throw new Error();
  }
  writeStoredTransactions(storedTransactions);
  return updatedTransactions;
}

/** The provider calls that look up what became of a transaction. */
type TransactionReader = Pick<JsonRpcProvider, 'getTransactionReceipt' | 'getTransaction' | 'getTransactionCount'>;

function outcomeOf(receipt: TransactionReceipt): TransactionOutcome {
  return receipt.status === 1 ? { status: 'confirmed', receipt } : { status: 'reverted', receipt };
}

/**
 * What became of a broadcast transaction, or `pending` while that is unknown. A receipt shows it
 * was mined, successfully or not. Without one, it was replaced only once its sender's confirmed
 * nonce has passed the transaction's nonce and a second lookup still finds no receipt. The nonce
 * comes from the node's record of the transaction when it has one, since a wallet can queue the
 * transaction behind another with a higher nonce than the one read before sending.
 */
async function resolveTransaction(
  provider: TransactionReader,
  transaction: PendingTransaction
): Promise<TransactionOutcome | 'pending'> {
  const receipt = await provider.getTransactionReceipt(transaction.hash);
  if (receipt) return outcomeOf(receipt);
  if (transaction.account === undefined) return 'pending';

  const sentTransaction = await provider.getTransaction(transaction.hash);
  const nonce = sentTransaction?.nonce ?? transaction.nonce;
  const confirmedNonce = await provider.getTransactionCount(transaction.account);
  if (confirmedNonce <= nonce) return 'pending';

  const lateReceipt = await provider.getTransactionReceipt(transaction.hash);
  return lateReceipt ? outcomeOf(lateReceipt) : { status: 'replaced' };
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
  /** Asks the wallet to send the transaction. Resolves with its hash or response once broadcast. */
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
  clearTransactions: () => void;
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
        // A record with no sender cannot be tied to an account, and one this account never got a
        // hash for cannot be looked up. Neither can be recovered.
        writeStoredTransactions(
          storedTransactions.filter(
            (tx) => tx.account !== undefined && !(isOwn(tx) && tx.state !== TransactionState.Pending)
          )
        );
        const ownTransactions = filterMap<Transaction, PendingTransaction>(storedTransactions, (tx) =>
          isOwn(tx) && tx.state === TransactionState.Pending ? tx : undefined
        );
        ownTransactions.forEach((transaction) => {
          resolveTransaction(provider, transaction).then(
            (resolution) => {
              if (!isCurrent) return;
              if (resolution === 'pending') updateTransactions([ActionType.Add, transaction]);
              else settle(transaction, resolution);
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
              if (isCurrent && resolution !== 'pending') settle(transaction, resolution);
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
        updateTransactions([
          ActionType.Update,
          {
            ...baseTransaction,
            state: TransactionState.Pending,
            hash,
            // A hash alone, or a `connectUnchecked` signer's response, gives no nonce.
            nonce: (typeof response === 'string' ? undefined : response.nonce) ?? currentNonce,
          },
        ]);
        return typeof response === 'string'
          ? { status: 'submitted', id, hash }
          : { status: 'submitted', id, hash, response };
      } catch (error) {
        console.log(error);
        if (isRecorded) updateTransactions([ActionType.Remove, id]);
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

  return {
    transactions,
    settledTransactions,
    walletFailure,
    addTransaction,
    submitTransaction,
    clearTransactions,
  };
}
