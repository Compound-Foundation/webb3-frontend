import { getMarketDescriptors } from '@helpers/markets';
import { HistoryItemType, TransactionHistoryItem } from '@types';

import BulkTransaction from './BulkTransaction';
import UnitTransaction from './UnitTransaction';

export const renderMarketDescriptorElement = (address: string, chainId: number) => {
  return (
    <>
      <span className="meta L3">{getMarketDescriptors(address, chainId)[0]} </span>
      {getMarketDescriptors(address, chainId)[1]}
    </>
  );
};

const TransactionRowByMonth = ({
  month,
  transactions,
  account,
}: {
  month: string;
  transactions: TransactionHistoryItem[];
  account: string;
}) => {
  return (
    <div className="transaction-history__month grid-container--7">
      <label className="transaction-history__month__date-label label L2 text-color--1 grid-column--1">{month}</label>
      <div className="transaction-history__month__content grid-column--6">
        {transactions.map((transaction: TransactionHistoryItem, index: number) => {
          if (
            transaction.itemType === HistoryItemType.BULK ||
            transaction.itemType === HistoryItemType.MULTI ||
            transaction.itemType === HistoryItemType.LIQUIDATION
          ) {
            return (
              <BulkTransaction
                key={`bulk-transaction-${index}`}
                transaction={transaction}
                account={account}
                index={index}
              />
            );
          }
          return <UnitTransaction key={`unit-transaction-${index}`} transaction={transaction} account={account} />;
        })}
      </div>
    </div>
  );
};

export default TransactionRowByMonth;
