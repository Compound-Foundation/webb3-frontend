import { useState, useRef, ReactNode } from 'react';

import { CHAINS } from '@constants/chains';
import type { Web3 } from '@contexts/Web3Context';
import { getShortAddress } from '@helpers/address';
import { filterMap } from '@helpers/functions';
import { getBlockExplorerUrlForTransaction } from '@helpers/urls';
import useCopyText from '@hooks/useCopyText';
import useOnClickOutside from '@hooks/useOnClickOutside';
import { RECENT_NUM, useTransactionHistory } from '@hooks/useTransactionHistory';
import { AwaitingConfirmationTransaction, PendingTransaction, StateType, Transaction, TransactionState } from '@types';

import { Copy } from './Icons';
import LoadSpinner from './LoadSpinner';
import WalletTrxHistory from './WalletTrxHistory';

export const TRX_HISTORY_ROUTE = '/transactions';

function getButtonText(
  pendingTransactions: PendingTransaction[],
  awaitingConfirmationTransactions: AwaitingConfirmationTransaction[],
  maybeAccount: string | undefined
): [string, string, ReactNode] {
  if (maybeAccount === undefined) {
    return [' button--connect-wallet--disconnected', 'Connect Wallet', null];
  } else if (pendingTransactions.length === 0 && awaitingConfirmationTransactions.length === 0) {
    return ['', getShortAddress(maybeAccount), null];
  } else {
    return [
      ' button--connect-wallet--pending',
      `${pendingTransactions.length + awaitingConfirmationTransactions.length} Pending`,
      <LoadSpinner key="loader" size={16} />,
    ];
  }
}

function getIndicator(active: boolean, chainId: number | undefined) {
  if (!active) {
    return 'yellow';
  } else {
    const foundChain = chainId ? CHAINS[chainId] : '';
    const networkName = (foundChain ? foundChain.name : '').toLowerCase();

    switch (networkName) {
      case '':
        return '';
      default:
        return `dot-indicator--${networkName}`;
    }
  }
}

export type WalletButtonProps = {
  transactions: Transaction[];
  clearTransactions: () => void;
  web3: Web3;
  onOpenWalletSelectionModal: () => void;
  onClickDisconnect: () => void;
};

const WalletButton = ({
  transactions,
  clearTransactions,
  web3,
  onOpenWalletSelectionModal,
  onClickDisconnect,
}: WalletButtonProps) => {
  const [dropdownActive, setDropdownActive] = useState(false);
  const { copy } = useCopyText();

  const pendingTransactions = filterMap<Transaction, PendingTransaction>(transactions, (tx) =>
    tx.state === TransactionState.Pending ? tx : undefined
  );
  const awaitingConfirmationTransactions = filterMap<Transaction, AwaitingConfirmationTransaction>(transactions, (tx) =>
    tx.state === TransactionState.AwaitingConfirmation ? tx : undefined
  );
  const [modifier, walletText, additionalView] = getButtonText(
    pendingTransactions,
    awaitingConfirmationTransactions,
    web3.write.account
  );

  const ref = useRef(null);
  useOnClickOutside(ref, () => setDropdownActive(false));

  const { state } = useTransactionHistory(web3, RECENT_NUM);
  const [transactionsStateType, transactionsState] = state;

  return (
    <div ref={ref} className="header__pill-dropdown connected-wallet L2">
      <div
        className="dropdown"
        onClick={() => {
          web3.write.account !== undefined ? setDropdownActive(!dropdownActive) : onOpenWalletSelectionModal();
        }}
      >
        <div className={`button button--connect-wallet${modifier}`}>
          {additionalView}
          <label className="label text-color--1">{walletText}</label>
        </div>
        {dropdownActive && (
          <div className={`dropdown__content dropdown__content__transaction-history`}>
            <div className="dropdown__content__header-row">
              <label className="label text-color--2">Connected Wallet</label>
            </div>
            <div className="dropdown__content__row">
              <div className="connected-wallet__row-info">
                <div className={`dot-indicator ${getIndicator(web3.read.isActive, web3.read.chainId)}`}></div>
                <label className="label text-color--1">{walletText}</label>
                {!!navigator?.clipboard && (
                  <div
                    className="copy"
                    onClick={() => {
                      copy(web3.write.account || '');
                    }}
                  >
                    <Copy className="svg--icon--1" />
                  </div>
                )}
              </div>
            </div>
            {pendingTransactions.length > 0 && (
              <>
                <div className="dropdown__content__row">
                  <div className="divider"></div>
                </div>
                <div className="dropdown__content__header-row">
                  <label className="label text-color--2">Pending</label>
                  <label
                    className="label text-color--supply dropdown__content__row__clear-btn"
                    onClick={clearTransactions}
                  >
                    Clear
                  </label>
                </div>
                <div className="dropdown__content__row">
                  {pendingTransactions.map((trx) => (
                    <a
                      className="label text-color--1 dropdown__content__value"
                      key={trx.id}
                      href={getBlockExplorerUrlForTransaction(trx)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {trx.description}
                    </a>
                  ))}
                </div>
              </>
            )}

            <WalletTrxHistory
              connectedAccount={web3.read.account}
              trxHistoryLoading={transactionsStateType === StateType.Loading}
              trxHistoryItems={transactionsState?.items || []}
            />

            <div className="dropdown__content__action-row">
              <button className="button button--small" onClick={onClickDisconnect}>
                Disconnect Wallet
              </button>
            </div>
            <div className="dropdown__content__action-row">
              <button className="button button--small" onClick={onOpenWalletSelectionModal}>
                Change Wallet
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default WalletButton;
