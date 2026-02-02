import { GraphStem } from '@components/Icons/GraphStem';
import { assetIconForAssetSymbol } from '@helpers/assets';
import { formatUnitsWithTruncation } from '@helpers/numbers';
import { getBlockExplorerUrlForTransactionHistory } from '@helpers/urls';
import {
  getInitiatedByDescriptor,
  iconForTransactionActionType,
  convertTransactionTypeToPassiveVerb,
} from '@hooks/useTransactionHistory';
import { HistoryItemType, TransactionAction, TransactionActionType, TransactionHistoryItem } from '@types';

import BulkTransactionGraph from './BulkTransactionGraph';
import TransactionDate from './TransactionDate';
import { renderMarketDescriptorElement } from './TransactionRowByMonth';
import TransactionTextHolder from './TransactionTextHolder';

// for liquidation transactions, we message regarding seized assets
const getLiquidationHeader = (actions: TransactionAction[]) => {
  const seized = actions.filter((action) => action.actionType === TransactionActionType.SEIZED);
  if (seized.length === 1) return `Liquidated ${seized[0].token.symbol}`;
  return `Liquidated ${seized.length} Assets`;
};

const BulkTransaction = ({
  account,
  transaction,
  index,
}: {
  transaction: TransactionHistoryItem;
  account: string;
  index: number;
}) => {
  const { transactionHash, actions, timestamp, network } = transaction;
  const { chainId } = network;
  const headerText =
    transaction.itemType === HistoryItemType.BULK
      ? 'Bulk Transaction'
      : transaction.itemType === HistoryItemType.LIQUIDATION
      ? getLiquidationHeader(actions)
      : 'External Transaction';

  const trxUrl = getBlockExplorerUrlForTransactionHistory(transaction);

  const iconName =
    transaction.itemType === HistoryItemType.BULK
      ? 'COMPOUND'
      : transaction.itemType === HistoryItemType.LIQUIDATION
      ? 'LIQUIDATE'
      : 'EXTERNAL';

  return (
    <a href={trxUrl} target="_blank" rel="noreferrer">
      <div className="bulk-transaction" key={`${transactionHash}-${index}`}>
        <div className="bulk-transaction__header">
          <div className="bulk-transaction__header__info">
            <div className="bulk-transaction__header__info__icon-holder">
              <span className={`icon icon--${iconName}`}></span>
            </div>
            <TransactionTextHolder headerText={headerText}>
              {renderMarketDescriptorElement(actions[0].contract.address, chainId)}
              {getInitiatedByDescriptor({ account, transaction })}
            </TransactionTextHolder>
          </div>
          <TransactionDate timestamp={timestamp} />
        </div>
        <div className="bulk-transaction__actions">
          <GraphStem />
          {actions.map((action, index) => {
            const { actionType, amount, token } = action;

            const icon = iconForTransactionActionType(actionType);
            return (
              // TODO: Refactor class names in this file to delineate styles for bulk item
              <div key={`bulk-transaction-action-${index}`} className="bulk-transaction__actions__item">
                <BulkTransactionGraph last={index === actions.length - 1} />
                <div className="bulk-transaction__actions__info">
                  <div className="bulk-transaction__actions__info__sub-icon-holder">
                    <span className={`asset asset--${assetIconForAssetSymbol(token.symbol)}`}></span>
                    {icon}
                  </div>
                  <div className="bulk-transactions__actions__title">
                    <p className="L4 meta text-color--1">
                      {convertTransactionTypeToPassiveVerb(actionType)}{' '}
                      {amount && formatUnitsWithTruncation({ amount })} {token.symbol}
                    </p>
                    {action.actionType === 'Refund' && <p className="meta L4 text-color--2">Liquidation refund</p>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </a>
  );
};

export default BulkTransaction;
