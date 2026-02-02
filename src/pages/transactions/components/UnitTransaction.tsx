import { assetIconForAssetSymbol } from '@helpers/assets';
import { formatUnitsWithTruncation } from '@helpers/numbers';
import { getBlockExplorerUrlForTransactionHistory } from '@helpers/urls';
import {
  getInitiatedByDescriptor,
  iconForTransactionActionType,
  convertTransactionTypeToPassiveVerb,
} from '@hooks/useTransactionHistory';
import { TransactionHistoryItem } from '@types';

import TransactionDate from './TransactionDate';
import { renderMarketDescriptorElement } from './TransactionRowByMonth';
import TransactionTextHolder from './TransactionTextHolder';

const UnitTransaction = ({ transaction, account }: { transaction: TransactionHistoryItem; account: string }) => {
  const { transactionHash, actions, timestamp, network } = transaction;
  const { chainId } = network;
  const trxUrl = getBlockExplorerUrlForTransactionHistory(transaction);

  const action = actions[0];
  const { actionType, amount, token, contract } = action;
  const icon = iconForTransactionActionType(actionType);

  const headerText = `${convertTransactionTypeToPassiveVerb(actionType)} ${
    amount && formatUnitsWithTruncation({ amount })
  } ${' '}
    ${token.symbol}`;

  return (
    <a href={trxUrl} target="_blank" rel="noreferrer" key={transactionHash}>
      <div className="unit-transaction">
        <div className="unit-transaction__info">
          <div className="unit-transaction__info__icon-holder">
            <span className={`asset asset--${assetIconForAssetSymbol(token.symbol)}`}></span>
            {icon}
          </div>
          <TransactionTextHolder headerText={headerText}>
            {renderMarketDescriptorElement(contract.address, chainId)}
            {getInitiatedByDescriptor({ account, transaction })}
          </TransactionTextHolder>
        </div>
        {/* date */}
        <TransactionDate timestamp={timestamp} />
      </div>
    </a>
  );
};

export default UnitTransaction;
