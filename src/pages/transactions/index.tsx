import { format } from 'date-fns';
import { ReactElement, useCallback, useEffect, useRef } from 'react';

import { CircleExclamation, Wallet } from '@components/Icons';
import { Web3 } from '@contexts/Web3Context';
import { TRX_HISTORY_NO_FURTHER_ITEMS } from '@helpers/constants';
import { useTransactionHistory } from '@hooks/useTransactionHistory';
import { StateType, Transaction, TransactionHistoryItem } from '@types';

import TransactionRowByMonth from './components/TransactionRowByMonth';
import TransactionRowLoader from './components/TransactionRowLoader';

const EmptyTransactions = ({ account }: { account: boolean }) => (
  <>
    {account ? (
      <div className="unit-transaction__info">
        <div className="unit-transaction__info__empty-icon">
          <CircleExclamation className="svg--icon--3" />
        </div>
        <div className="transaction__text-holder" aria-label="No transactions">
          <p className="L4 body--emphasized text-color--3">No transactions found</p>
          <p className="L4 meta text-color--3 ">for this address</p>
        </div>
      </div>
    ) : (
      <div className="unit-transaction__info">
        <div className="unit-transaction__info__empty-icon">
          <Wallet className="svg--icon--3" />
        </div>
        <div className="transaction__text-holder">
          <p className="L4 body--emphasized text-color--3" aria-label="No wallet">
            No wallet connected
          </p>
          <p className="L4 meta text-color--3" aria-label="Connect wallet">
            Connect a wallet to view transactions
          </p>
        </div>
      </div>
    )}
    <div className="transaction-history__month__end transaction-history__month__end--full">
      <div className="divider"></div>
      <div className="transaction-history__month__end__text">
        <span className="L4 meta text-color--3">End</span>
      </div>
    </div>
  </>
);

const aggregateTransactionDataByMonth = (
  items: TransactionHistoryItem[]
): { [key: string]: TransactionHistoryItem[] } => {
  return items.reduce((acc: { [key: string]: TransactionHistoryItem[] }, item) => {
    const monthString = format(new Date(item.timestamp * 1000), 'MMM yyyy');
    acc[monthString] = acc[monthString] || [];
    acc[monthString].push(item);
    return acc;
  }, {});
};

const TransactionHistory = ({ transactions, web3 }: { transactions: Transaction[]; web3: Web3 }) => {
  const { state, loadMore, refreshData } = useTransactionHistory(web3);
  const [transactionsStateType, transactionsState] = state;
  // use a ref here so we can track in our callback function
  const stateRef = useRef(transactionsState);
  const trxRef = useRef(transactions.length || 0);

  // when there's a change in pendingTransactions.length
  // we refresh to check for any new transaction history
  useEffect(() => {
    if (transactions.length || 0 < trxRef.current) {
      refreshData();
      trxRef.current = transactions.length || 0;
    }
  }, [transactions]);

  useEffect(() => {
    // We update the stateRef whenever transactionsState changes
    stateRef.current = transactionsState;
  }, [transactionsState]);

  const observer = useRef<IntersectionObserver | null>(null);

  const loadMoreElementRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (observer.current) {
        observer.current.disconnect();
      }

      // we only loadMore for hydrated state w/ prev items
      if (transactionsStateType === StateType.Hydrated && transactionsState?.items) {
        const { account, cursor } = transactionsState;
        observer.current = new IntersectionObserver(async (entries) => {
          if (entries[0].isIntersecting && window.localStorage.getItem(TRX_HISTORY_NO_FURTHER_ITEMS) !== 'true') {
            await loadMore(account, cursor, transactionsState.items);
          }
        });
      }

      if (node && observer.current) {
        observer.current.observe(node);
      }
    },
    [loadMore]
  );

  useEffect(() => {
    return () => observer?.current?.disconnect();
  }, []);

  let content: ReactElement = <></>;
  if (transactionsStateType === StateType.Loading) {
    content = <TransactionRowLoader key={`transaction-loader`} count={5} />;
  } else if (transactionsStateType === StateType.NoWallet) {
    content = <EmptyTransactions account={false} />;
  } else if (transactionsStateType === StateType.Hydrated && transactionsState?.items.length === 0) {
    content = <EmptyTransactions account={true} />;
  } else if (transactionsState && transactionsState.itemCount > 0) {
    const aggregatedData = aggregateTransactionDataByMonth(transactionsState?.items);
    const { account } = transactionsState;
    content = (
      <>
        {Object.keys(aggregatedData).map((month, index) => {
          return (
            <TransactionRowByMonth
              key={`${index}-${month.split(' ').join('-')}`}
              month={month}
              transactions={aggregatedData[month] || []}
              account={account}
            />
          );
        })}
        {window.localStorage.getItem(TRX_HISTORY_NO_FURTHER_ITEMS) !== 'true' ? (
          <div ref={loadMoreElementRef}>
            <TransactionRowLoader count={3} />
          </div>
        ) : (
          <div className="transaction-history__month__end">
            <div className="divider"></div>
            <div className="transaction-history__month__end__text">
              <span className="L4 meta text-color--3">End</span>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="page transactions">
      <div className="hero-panel text-color--1">
        <h1 className="L0 heading heading--emphasized">
          <span>Transactions</span>
        </h1>
      </div>
      <div className="grid-container">
        <div className="transactions__content grid-column--7">{content}</div>
        <div className="transactions__sidebar grid-column--4">{/* filters place holder */}</div>
      </div>
    </div>
  );
};

export default TransactionHistory;
