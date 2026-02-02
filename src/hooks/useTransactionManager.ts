import { TransactionResponse } from '@ethersproject/providers';
import { BigNumber } from 'ethers';
import { useCallback, useEffect, useReducer } from 'react';
import { v4 as uuidv4 } from 'uuid';

import { Web3 } from '@contexts/Web3Context';
import { TRANSACTION_LOCALSTORAGE_KEY } from '@helpers/constants';
import { filterMap } from '@helpers/functions';
import { TRX_REFRESH_INTERVAL } from '@helpers/numbers';
import { BaseTransaction, PendingTransaction, TransactionState, Transaction } from '@types';

/*
useTransactionManager is a hook that keeps track of pending transactions,
polling periodically to see if the transaction has resolved.

Transactions are written to localStorage, so pending transactions will be
reloaded on page refresh.

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

function txReducer(currentTransactions: Transaction[], action: Action): Transaction[] {
  const [type] = action;
  let updatedTransactions: Transaction[];
  switch (type) {
    case ActionType.Add:
      updatedTransactions = [...currentTransactions, action[1]];
      break;
    case ActionType.Update:
      updatedTransactions = currentTransactions.map((tx) => (tx.id === action[1].id ? action[1] : tx));
      break;
    case ActionType.Remove:
      updatedTransactions = currentTransactions.filter((tx) => tx.id !== action[1]);
      break;
    case ActionType.Clear:
      updatedTransactions = [];
      break;
    default:
      throw new Error();
  }
  window.localStorage.setItem(TRANSACTION_LOCALSTORAGE_KEY, JSON.stringify(updatedTransactions));
  return updatedTransactions;
}

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
  callback?: () => void
) => Promise<TransactionResponse | undefined>;

type TransactionManager = {
  transactions: Transaction[];
  addTransaction: AddTransaction;
  clearTransactions: () => void;
};

export function useTransactionManager(web3: Web3): TransactionManager {
  const [transactions, updateTransactions] = useReducer(txReducer, []);
  const { provider, account } = web3.write;

  // load stored transactions from local storage; only add to state if it is
  // still pending
  useEffect(() => {
    if (provider) {
      const storedTransactions = window.localStorage.getItem(TRANSACTION_LOCALSTORAGE_KEY);
      const parsedTransactions: Transaction[] = storedTransactions ? JSON.parse(storedTransactions) : [];
      const networkName = provider.network ? provider.network.name : 'unknown';
      const currentNetworkPendingTransactions = filterMap<Transaction, PendingTransaction>(parsedTransactions, (tx) =>
        tx.state === TransactionState.Pending && tx.networkName === networkName ? tx : undefined
      );
      currentNetworkPendingTransactions.forEach((transaction) => {
        provider.getTransactionReceipt(transaction.hash).then((txReceipt) => {
          if (!txReceipt) {
            updateTransactions([ActionType.Add, transaction]);
          } else {
            // remove transaction to clear it from local storage
            updateTransactions([ActionType.Remove, transaction.id]);
          }
        });
      });
    }
  }, [provider]);

  // when new transactions are added, poll for transaction receipts until all
  // pending transactions are resolved
  useEffect(() => {
    let timeoutId: NodeJS.Timeout | undefined;

    function pollForTransactionReceipt() {
      requestAnimationFrame(() => {
        if (provider && account !== undefined && provider.network !== undefined) {
          const networkName = provider.network.name;
          const currentNetworkPendingTransactions = filterMap<Transaction, PendingTransaction>(transactions, (tx) =>
            tx.state === TransactionState.Pending && tx.networkName === networkName ? tx : undefined
          );

          if (currentNetworkPendingTransactions.length > 0) {
            currentNetworkPendingTransactions.forEach((transaction) => {
              provider.getTransactionReceipt(transaction.hash).then(async (txReceipt) => {
                const transactionCompleted = txReceipt !== null;

                // A transaction can be replaced by another transaction with the same nonce
                // Wallets typically do this with a "Cancel" or "Speed up" option. If the replacement
                // transaction has gone through, the current one will never be confirmed so we drop it
                const currentNonce = await provider.getTransactionCount(account);
                const transactionReplaced = currentNonce > transaction.nonce;

                if (transactionCompleted || transactionReplaced) {
                  updateTransactions([ActionType.Remove, transaction.id]);
                  transaction.callback && transaction.callback();
                }
              });
            });

            timeoutId = setTimeout(pollForTransactionReceipt, TRX_REFRESH_INTERVAL);
          } else {
            timeoutId && clearInterval(timeoutId);
          }
        }
      });
    }

    pollForTransactionReceipt();

    return () => timeoutId && clearInterval(timeoutId);
  }, [transactions, provider]);

  const addTransaction = useCallback(
    async function (
      key: string,
      description: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      trxFn: (...args: any[]) => Promise<TransactionResponse>,
      estimatedGas: number,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      trxEstimateGasFn: (...args: any[]) => Promise<BigNumber>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fnArgs: any[],
      value = 0n,
      callback?: () => void
    ): Promise<TransactionResponse | undefined> {
      if (provider && account !== undefined) {
        const id = uuidv4();
        const networkId = provider.network.chainId;
        const networkName = provider.network.name;
        const currentNonce = await provider.getTransactionCount(account);

        const baseTransaction: BaseTransaction = {
          id,
          key,
          networkId,
          networkName,
          description,
          nonce: currentNonce,
          callback,
        };
        updateTransactions([
          ActionType.Add,
          {
            ...baseTransaction,
            state: TransactionState.AwaitingConfirmation,
          },
        ]);

        try {
          let gasLimit = estimatedGas;
          if (estimatedGas === 0) {
            const estimatedGasUsage = (await trxEstimateGasFn(...fnArgs, { value })).toNumber();
            gasLimit = Math.round(Number(estimatedGasUsage * 1.2));
          }
          const txReceipt = await trxFn(...fnArgs, { value, gasLimit });

          updateTransactions([
            ActionType.Update,
            {
              ...baseTransaction,
              state: TransactionState.Pending,
              hash: txReceipt.hash,
            },
          ]);

          return txReceipt;
        } catch (e) {
          console.log(e);
          updateTransactions([ActionType.Remove, id]);
        }
      }
    },
    [provider?.network, account]
  );

  const clearTransactions = () => {
    updateTransactions([ActionType.Clear]);
  };

  return {
    transactions,
    addTransaction,
    clearTransactions,
  };
}
