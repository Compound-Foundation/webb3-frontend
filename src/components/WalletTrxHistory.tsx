import { assetIconForAssetSymbol } from '@helpers/assets';
import { getMarketDescriptors } from '@helpers/markets';
import { formatUnitsWithTruncation } from '@helpers/numbers';
import { getBlockExplorerUrlForTransactionHistory } from '@helpers/urls';
import { convertTransactionTypeToPassiveVerb, shortenAddress } from '@hooks/useTransactionHistory';
import { HistoryItemType, TransactionActionType, TransactionHistoryItem } from '@types';

import { CircleMinus, CirclePlus, CircleRightArrow, ExternalLink } from './Icons';
import { SimpleLink } from './SimpleLink';

const TRX_HISTORY_ROUTE = '/transactions';

export type WalletTrxHistoryProps = {
  connectedAccount: string | undefined;
  trxHistoryLoading: boolean;
  trxHistoryItems: TransactionHistoryItem[];
};

export const WalletTrxHistoryLoadingRow = () => {
  return (
    <div className="wallet-trx-history-row">
      <div className="wallet-trx-history-row__icons">
        <span className="asset">
          <span className="placeholder-content placeholder-content--circle"></span>
        </span>
        <span className="asset">
          <span className="wallet-trx-history-row__icons__icon-with-mask wallet-trx-history-row__icons__icon-with-mask--loading">
            <span className="placeholder-content placeholder-content--circle"></span>
          </span>
        </span>
      </div>
      <div className="wallet-trx-history-row__details">
        <span className="meta placeholder-content"></span>
        <span className="meta placeholder-content"></span>
      </div>
    </div>
  );
};

const TransactionsLoader = () => {
  return (
    <div className="dropdown__content__row">
      {[0, 0, 0].map((_, index) => (
        <>
          <WalletTrxHistoryLoadingRow key={index} />
        </>
      ))}
    </div>
  );
};

type RecentTransactionsProps = {
  connectedAccount: string | undefined;
  trxHistoryItems: TransactionHistoryItem[];
};

//TODO: pass in the extra classname on the original method for this...
function iconForTransactionActionType2(actionType: TransactionActionType, isFirst: boolean) {
  const extraClassNames =
    'wallet-trx-history-row__icons__icon-with-mask' +
    (isFirst ? ' wallet-trx-history-row__icons__icon-with-mask--first-icon' : '');

  switch (actionType) {
    case TransactionActionType.BORROW:
      return <CirclePlus className={'svg--borrow ' + extraClassNames} />;
    case TransactionActionType.REPAY:
      return <CircleMinus className={'svg--borrow ' + extraClassNames} />;
    case TransactionActionType.REFUND:
    case TransactionActionType.SUPPLY:
      return <CirclePlus className={'svg--supply ' + extraClassNames} />;
    case TransactionActionType.WITHDRAW:
      return <CircleMinus className={'svg--supply ' + extraClassNames} />;
    case TransactionActionType.CLAIM:
      return <CirclePlus className={'svg--claim ' + extraClassNames} />;
    case TransactionActionType.SEIZED:
      return <CircleMinus className={'svg--seize ' + extraClassNames} />;
    case TransactionActionType.TRANSFER:
      return <CircleRightArrow className={'svg--transfer ' + extraClassNames} />;
  }
}

export type WalletTrxHistoryRowProps = {
  connectedAccount: string | undefined;
  trxHistoryItem: TransactionHistoryItem;
};
export const WalletTrxHistoryRow = ({ connectedAccount, trxHistoryItem }: WalletTrxHistoryRowProps) => {
  const { transactionHash, itemType, actions, initiatedBy, network } = trxHistoryItem;
  const { chainId } = network;
  const initiatedBySuffix =
    connectedAccount && initiatedBy && connectedAccount.toLowerCase() !== initiatedBy.address.toLowerCase()
      ? `• Initiated by ${shortenAddress(initiatedBy?.address)}`
      : '';

  const {
    actionType,
    amount,
    token,
    contract: { address },
  } = actions[0];
  const icon = iconForTransactionActionType2(actionType, false);
  const getTitle = () => {
    if (itemType === HistoryItemType.LIQUIDATION) {
      return `Liquidated ${amount && formatUnitsWithTruncation({ amount })} ${token.symbol}`;
    } else if (itemType === HistoryItemType.BULK || itemType === HistoryItemType.MULTI) {
      const extraText = actions.length - 1 > 0 ? ` & ${actions.length - 1} More` : '';
      return (
        <span>
          {convertTransactionTypeToPassiveVerb(actionType)} {amount && formatUnitsWithTruncation({ amount })}{' '}
          {token.symbol}
          <span className="meta L3 text-color--2">{extraText}</span>
        </span>
      );
    } else {
      return `${convertTransactionTypeToPassiveVerb(actionType)} ${amount && formatUnitsWithTruncation({ amount })} ${
        token.symbol
      }`;
    }
  };
  return (
    <a
      className={`label text-color--1 wallet-trx-history-row`}
      key={transactionHash}
      href={getBlockExplorerUrlForTransactionHistory(trxHistoryItem)}
      target="_blank"
      rel="noreferrer"
    >
      <div className={`wallet-trx-history-row__icons`}>
        {/* TODO: Use switch here instead */}
        {itemType !== HistoryItemType.LIQUIDATION &&
          itemType !== HistoryItemType.BULK &&
          itemType !== HistoryItemType.MULTI && (
            <>
              <span className={`asset asset--${assetIconForAssetSymbol(token.symbol)}`}></span>
              <span className="asset">{icon}</span>
            </>
          )}

        {itemType === HistoryItemType.LIQUIDATION && (
          <>
            <span className={`asset asset--LIQUIDATE`}></span>
            <span className="asset">{icon}</span>
          </>
        )}

        {(itemType === HistoryItemType.BULK || itemType === HistoryItemType.MULTI) && (
          <>
            {actions.map((action, index) => {
              if (index > 2) return <></>;
              return (
                <span className="asset" key={index}>
                  {iconForTransactionActionType2(action.actionType, index === 0)}
                </span>
              );
            })}
          </>
        )}
      </div>
      <div className={`wallet-trx-history-row__details`}>
        <div className="wallet-trx-history-row__details__header">
          <span className="meta L3 text-color--1 body--emphasized">{getTitle()}</span>
          <ExternalLink className={`svg--icon--3 wallet-trx-history-row__external-link`} />
        </div>
        <span className="meta L4 text-color--2">
          {getMarketDescriptors(address, chainId).join(' ')} {initiatedBySuffix}
        </span>
      </div>
    </a>
  );
};

const RecentTransactions = ({ connectedAccount, trxHistoryItems }: RecentTransactionsProps) => {
  return (
    <div className="dropdown__content__row">
      {trxHistoryItems.slice(0, 3).map((trx, index) => {
        return <WalletTrxHistoryRow connectedAccount={connectedAccount} trxHistoryItem={trx} key={index} />;
      })}
    </div>
  );
};

const WalletTrxHistory = ({ connectedAccount, trxHistoryLoading, trxHistoryItems }: WalletTrxHistoryProps) => {
  const hideWalletTrxHistory = !trxHistoryLoading && trxHistoryItems.length === 0;

  return (
    <>
      {!hideWalletTrxHistory && (
        <div className="wallet-trx-history">
          <div className="dropdown__content__row">
            <div className="divider" />
          </div>
          {(trxHistoryItems.length > 0 || trxHistoryLoading) && (
            <>
              <div className="dropdown__content__header-row">
                <label className="label text-color--2">Recent Transactions</label>
                <SimpleLink to={TRX_HISTORY_ROUTE}>
                  <span className="label text-color--supply">See All</span>
                </SimpleLink>
              </div>
              <RecentTransactions connectedAccount={connectedAccount} trxHistoryItems={trxHistoryItems} />
            </>
          )}
          {trxHistoryItems.length === 0 && trxHistoryLoading && <TransactionsLoader />}
          <div className="dropdown__content__row">
            <div className="divider" />
          </div>
        </div>
      )}
    </>
  );
};

export default WalletTrxHistory;
