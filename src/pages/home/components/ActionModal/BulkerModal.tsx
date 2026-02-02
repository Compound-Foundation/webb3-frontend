import type { ReactNode } from 'react';

import { CircleClose, Wallet } from '@components/Icons';
import { getBlockExplorerUrlForTransaction } from '@helpers/urls';
import { Action, BulkerModalProps, TransactionState } from '@types';

import ActionQueueItem, { ActionQueueItemType } from '../ActionQueueItem';

const BulkerModal = ({
  actions,
  baseAsset,
  collateralAssets,
  transactions,
  onRequestClose,
  transactionPredicate,
}: BulkerModalProps) => {
  let title: string;
  let content: ReactNode;
  const transaction = transactionPredicate(transactions);
  if (transaction === undefined) return null;

  if (transaction.state === TransactionState.AwaitingConfirmation) {
    title = `Confirm With Wallet`;
    content = (
      <>
        <div className="modal__content__paragraph" style={{ marginTop: '2.5rem' }}>
          <p className="body">Confirm the transaction with your web3 provider.</p>
        </div>
        <div className="modal__content__bulker-actions">
          {actions.map((action: Action, actionIndex) => {
            const [bulkerActionType, asset] = action;
            return (
              <ActionQueueItem
                state={[ActionQueueItemType.display, { actionIndex, actions, baseAsset, collateralAssets }]}
                key={asset.name + bulkerActionType + actionIndex}
              />
            );
          })}
        </div>
        <div className="modal__content__action-row">
          <button className="button button--x-large button--supply" disabled>
            Confirm Transaction
          </button>
        </div>
      </>
    );
  } else {
    title = `Transaction Pending`;
    content = (
      <>
        <div className="modal__content__icon-holder">
          <Wallet className="svg--icon--1 svg--wallet" />
        </div>
        <div className="modal__content__paragraph">
          <p className="body">Transaction broadcast, waiting for confirmation. You may close this dialog.</p>
        </div>
        <div className="modal__content__action-row">
          <a href={getBlockExplorerUrlForTransaction(transaction)} target="_blank" rel="noreferrer">
            <button className="button button--x-large">View on Explorer</button>
          </a>
        </div>
      </>
    );
  }

  return (
    <div className="modal modal--active">
      <div className="modal__backdrop" onClick={onRequestClose}></div>
      <div className="modal__content L4">
        <div className="modal__content__header">
          <div className="modal__content__header__left"></div>
          <h4 className="heading heading--emphasized heading">{title}</h4>
          <div className="modal__content__header__right" onClick={onRequestClose}>
            <CircleClose />
          </div>
        </div>
        {content}
      </div>
    </div>
  );
};

export default BulkerModal;
