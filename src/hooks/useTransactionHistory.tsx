import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { CircleMinus, CirclePlus, CircleRightArrow } from '@components/Icons';
import { Web3 } from '@contexts/Web3Context';
import { getShortAddress } from '@helpers/address';
import { TRX_HISTORY_NO_FURTHER_ITEMS } from '@helpers/constants';
import { convertApiResponse } from '@helpers/functions';
import { getTransactionHistoryEndpoint } from '@helpers/urls';
import {
  StateType,
  TransactionActionType,
  TransactionHistoryApiResponse,
  TransactionHistoryItem,
  TransactionsState,
} from '@types';

export const LIMIT = 30;
export const RECENT_NUM = 3;
const RECENT_TRX_DATA = 'RECENT_TRX_DATA';
const TRANSACTIONS_REFRESH_INTERVAL = 300_000; // 5 mins

export function shortenAddress(address: string) {
  if (address.startsWith('0x')) return getShortAddress(address);
  return address;
}

export function getInitiatedByText({ initiatedBy }: TransactionHistoryItem) {
  if (initiatedBy.displayName) {
    return initiatedBy.displayName;
  } else {
    return shortenAddress(initiatedBy.address);
  }
}

export function getInitiatedByDescriptor({
  account,
  transaction,
}: {
  account: string;
  transaction: TransactionHistoryItem;
}) {
  return account?.toLowerCase() === transaction.initiatedBy.address.toLowerCase() ? (
    <></>
  ) : (
    <>
      <span className="transaction__text-holder__dot-seperator"> •{/* U+02022 */}</span>
      <span>Initiated by {getInitiatedByText(transaction)}</span>
    </>
  );
}

export function iconForTransactionActionType(actionType: TransactionActionType) {
  switch (actionType) {
    case TransactionActionType.BORROW:
      return <CirclePlus className="svg--borrow transaction-history-actions__with-mask" />;
    case TransactionActionType.REPAY:
      return <CircleMinus className="svg--borrow transaction-history-actions__with-mask" />;
    case TransactionActionType.REFUND:
    case TransactionActionType.SUPPLY:
      return <CirclePlus className="svg--supply transaction-history-actions__with-mask" />;
    case TransactionActionType.WITHDRAW:
      return <CircleMinus className="svg--supply transaction-history-actions__with-mask" />;
    case TransactionActionType.CLAIM:
      return <CirclePlus className="svg--claim transaction-history-actions__with-mask" />;
    case TransactionActionType.SEIZED:
      return <CircleMinus className="svg--seize transaction-history-actions__with-mask" />;
    case TransactionActionType.TRANSFER:
      return <CircleRightArrow className="svg--transfer transaction-history-actions__with-mask" />;
  }
}

export const convertTransactionTypeToPassiveVerb = (txActionType: TransactionActionType) => {
  switch (txActionType) {
    case TransactionActionType.BORROW:
      return 'Borrowed';
    case TransactionActionType.REPAY:
      return 'Repaid';
    case TransactionActionType.WITHDRAW:
      return 'Withdrew';
    case TransactionActionType.REFUND:
    case TransactionActionType.SUPPLY:
      return 'Supplied';
    case TransactionActionType.CLAIM:
      return 'Claimed';
    case TransactionActionType.SEIZED:
      return 'Seized';
    // case TransactionActionType.LIQUIDATE: // liquidation is an item type not an action type
    //   return 'Liquidated';
    case TransactionActionType.TRANSFER:
      return 'Transferred';
  }
};

// returns data ONLY if account passed matches `account` in cache
const readCachedTranscations = (account: string) => {
  const rawCacheValue = window.localStorage.getItem(RECENT_TRX_DATA);
  try {
    const parsedCache = JSON.parse(rawCacheValue || '{}');
    if (parsedCache.account === account && parsedCache.items) {
      return parsedCache;
    } else {
      window.localStorage.removeItem(RECENT_TRX_DATA);
      window.localStorage.removeItem(TRX_HISTORY_NO_FURTHER_ITEMS);
      return null;
    }
  } catch (e) {
    return null;
  }
};

const fetchTransactions = async (account: string, cursor?: string, limit?: number, useTestnet = false) => {
  const response = await fetch(getTransactionHistoryEndpoint(account, cursor, limit, useTestnet));
  if (!response.ok) {
    throw new Error(`Error fetching transaction history: ${response.status}`);
  }
  const rawData = await response.json();
  return convertApiResponse<TransactionHistoryApiResponse>(rawData);
};

export const useTransactionHistory = (web3: Web3, limit = LIMIT) => {
  const accountRef = useRef(web3.write.account);

  // param for testing. in future we will pass markets based on filter criteria
  const [searchParams] = useSearchParams();
  const useTestnet = searchParams.has('sepolia-transactions');

  // check for cached data
  let initialState: TransactionsState = [StateType.Loading];
  if (!web3.write.account) {
    initialState = [StateType.NoWallet];
  } else {
    const cachedTrx = readCachedTranscations(web3.write.account);
    if (cachedTrx) initialState = [StateType.Hydrated, cachedTrx];
  }

  const [state, setState] = useState<TransactionsState>(initialState);

  // show loading interstitial & reset cache anytime account changes
  useEffect(() => {
    if (web3.write.account !== accountRef.current) {
      setState([StateType.Loading]);
      if (accountRef.current) {
        // We only need to wipe cache if we know we are going from 1
        // account to another. On the first load where we go from
        // no account to getting account we shouldn't wipe.
        window.localStorage.removeItem(RECENT_TRX_DATA);
        window.localStorage.removeItem(TRX_HISTORY_NO_FURTHER_ITEMS);
      }
      accountRef.current = web3.write.account;

      // See if we have cached data for this new account? (relevant for first app launch)
      if (web3.write.account) {
        const cachedTrx = readCachedTranscations(web3.write.account);
        if (cachedTrx) {
          setState([StateType.Hydrated, cachedTrx]);
        }
      }
    }
  }, [web3.write.account]);

  const refreshData = useCallback(async () => {
    web3.write.account === undefined ? setState([StateType.NoWallet]) : loadMore(web3.write.account, '', [], limit);
  }, [web3.write.account]);

  const loadMore = async (account: string, cursor: string, items: TransactionHistoryItem[], limit: number = LIMIT) => {
    const data = await fetchTransactions(account, cursor, limit, useTestnet);
    const mergedItems = [...new Set([...items, ...data.items])];
    mergedItems.sort((a, b) => b.timestamp - a.timestamp);

    const newHistory = {
      account,
      cursor: data.cursor,
      done: data.done,
      itemLimit: data.itemLimit,
      itemCount: mergedItems.length,
      items: mergedItems,
    };
    window.localStorage.setItem(RECENT_TRX_DATA, JSON.stringify(newHistory));

    if (data.done) {
      window.localStorage.setItem(TRX_HISTORY_NO_FURTHER_ITEMS, 'true');
    } else {
      window.localStorage.setItem(TRX_HISTORY_NO_FURTHER_ITEMS, 'false');
    }
    setState([StateType.Hydrated, newHistory]);
  };

  // we periodically pull new data to catch non-UI triggered transactions
  useEffect(() => {
    const intervalId = setInterval(refreshData, TRANSACTIONS_REFRESH_INTERVAL);
    refreshData();
    return () => clearInterval(intervalId);
  }, [refreshData]);

  return { state, loadMore, refreshData };
};
