import type { ReactNode } from 'react';

import { CircleCheckmark, CircleClose } from '@components/Icons';
import { getBlockExplorerUrlForTransaction } from '@helpers/urls';
import { BulkerApproveModalProps, TransactionState } from '@types';

const BulkerApproveModal = ({
  isBulkerAllowed,
  transactions,
  onActionClicked,
  onCompleteClicked,
  onRequestClose,
  transactionPredicate,
}: BulkerApproveModalProps) => {
  let title = `Enable Compound III`;
  let text = `To submit this transaction, you need to approve the Compound III proxy contract first. You only need to do this once.`;
  let checkmark: ReactNode = null;
  let button: ReactNode;
  const transaction = transactionPredicate(transactions);

  if (isBulkerAllowed) {
    title = `Approval Confirmed`;
    text = 'Your approval of the Compound III proxy contract is confirmed. You may now complete your transaction.';
    checkmark = <CircleCheckmark className="svg--supply svg--checkmark" />;
    button = (
      <>
        <button className="button button--x-large button--borrow" onClick={onCompleteClicked}>
          Complete Transaction
        </button>
      </>
    );
  } else if (transaction === undefined) {
    button = (
      <div className="modal__content__action-row">
        <button className="button button--x-large button--supply" onClick={onActionClicked}>
          Submit Transaction
        </button>
      </div>
    );
  } else if (transaction.state === TransactionState.AwaitingConfirmation) {
    button = (
      <div className="modal__content__action-row">
        <button className="button button--x-large button--supply" disabled>
          Confirm Transaction
        </button>
      </div>
    );
  } else {
    title = `Approval Pending`;
    text = 'You may complete your transaction as soon as the network confirms your approval. This may take a moment.';
    button = (
      <>
        <a href={getBlockExplorerUrlForTransaction(transaction)} target="_blank" rel="noreferrer">
          <button className="button button--x-large">View on Explorer</button>
        </a>
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
        <div className="modal__content__icon-holder">
          <div className={`modal__content__icon asset asset--COMP`}></div>
          {checkmark}
        </div>
        <div className="modal__content__paragraph">
          <p className="body">{text}</p>
        </div>
        <div className="modal__content__action-row">{button}</div>
      </div>
    </div>
  );
};

export default BulkerApproveModal;
