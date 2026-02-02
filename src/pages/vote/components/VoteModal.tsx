import React, { ReactElement, useState, useEffect, useRef } from 'react';

import { CheckMark, CircleClose, Wallet } from '@components/Icons';
import { getBlockExplorerUrlForTransaction } from '@helpers/urls';
import { PendingTransaction, Proposal, StateType, Transaction, TransactionState, VoteValueEnum } from '@types';

type VoteModalNoAccount = [StateType.NoWallet];
type VoteModalHydrated = [
  StateType.Hydrated,
  {
    active: boolean;
    chainKey: string;
    proposal: Proposal | undefined;
    screen: VoteModalScreenEnum;
    transaction: Transaction | undefined;
    voteNumberString: string;
    voteDecimalString: string;
    setScreen: (screen: VoteModalScreenEnum) => void;
    onRequestClose: () => void;
    onCastVote: (proposalId: bigint, support: VoteValueEnum, reason: string) => void;
  }
];

export type VoteModalState = VoteModalHydrated | VoteModalNoAccount;

interface VoteModalProps {
  state: VoteModalState;
}

export enum VoteModalScreenEnum {
  VoteFor,
  VoteAgainst,
  VoteAbstain,
  ConfirmTransaction,
  PendingTransaction,
}

const VoteModal = ({ state }: VoteModalProps) => {
  const [, data] = state;
  if (!data) return null;

  const {
    active,
    proposal,
    screen,
    transaction,
    voteNumberString,
    voteDecimalString,
    onRequestClose,
    onCastVote,
    setScreen,
  } = data;
  if (active === false || proposal == undefined) return null;

  const [reason, setReason] = useState('');
  const [voteText, setVoteText] = useState('');
  const transactionRef = useRef(transaction);

  let title = '';
  let content: ReactElement = <></>;

  const onModalClose = () => {
    setReason('');
    setVoteText('');
    onRequestClose();
  };

  // listen for transaction confirmation
  useEffect(() => {
    transaction?.state === TransactionState.Pending && setScreen(VoteModalScreenEnum.PendingTransaction);
    !transaction && transactionRef.current !== undefined && onModalClose();
    transactionRef.current = transaction;
  }, [transaction]);

  if (screen === VoteModalScreenEnum.VoteFor) {
    title = 'Vote For';
    content = (
      <div className="vote-modal">
        <div className="vote-modal__header">
          <span className="vote-modal__header__icon-holder">
            <CheckMark
              className="vote-modal__header__icon-holder__icon vote-modal__header__icon-holder__icon--check"
              color="var(--ui--foreground--2)"
            />
          </span>
          <div className="vote-modal__header__text">
            <p className="L1 meta">Proposal {Number(proposal.id)}</p>
            <p className="L4 body vote-modal__header__text--title">{proposal.title}</p>
          </div>
        </div>
        <div className="vote-modal__input text-input-view">
          <textarea
            className="text-input-view__input text-input-view__input--large L4 body"
            placeholder="Tell others why you are voting this way..."
            value={reason}
            autoComplete="off"
            onChange={(e) => setReason(e.target.value)}
          />
          <label className="text-input-view__label L4 meta">
            Reason
            <span className="optional"> {`(Optional)`}</span>
          </label>
        </div>
        <button
          className="button button--x-large button--supply"
          aria-label="Confirm vote with wallet"
          onClick={() => {
            setScreen(VoteModalScreenEnum.ConfirmTransaction);
            setVoteText(VoteValueEnum[1]);
            onCastVote(proposal.id, VoteValueEnum.For, reason);
          }}
        >
          Confirm with Wallet
        </button>
      </div>
    );
  } else if (screen === VoteModalScreenEnum.VoteAgainst) {
    title = 'Vote Against';
    content = (
      <div className="vote-modal">
        <div className="vote-modal__header">
          <span className="vote-modal__header__icon-holder">
            <CircleClose className="vote-modal__header__icon-holder__icon vote-modal__header__icon-holder__icon--against" />
          </span>
          <div className="vote-modal__header__text">
            <p className="L1 meta">Proposal {Number(proposal.id)}</p>
            <p className="L4 body vote-modal__header__text--title">{proposal.title}</p>
          </div>
        </div>
        <div className="vote-modal__input text-input-view">
          <textarea
            className="text-input-view__input text-input-view__input--large L4 body"
            placeholder="Tell others why you are voting this way..."
            value={reason}
            autoComplete="off"
            onChange={(e) => setReason(e.target.value)}
          />
          <label className="text-input-view__label L4 meta">
            Reason
            <span className="optional"> {`(Optional)`}</span>
          </label>
        </div>
        <button
          className="button button--x-large button--supply"
          onClick={() => {
            setScreen(VoteModalScreenEnum.ConfirmTransaction);
            setVoteText(VoteValueEnum[0]);
            onCastVote(proposal.id, VoteValueEnum.Against, reason);
          }}
        >
          Confirm with Wallet
        </button>
      </div>
    );
  } else if (screen === VoteModalScreenEnum.VoteAbstain) {
    title = 'Vote Abstain';
    content = (
      <div className="vote-modal">
        <div className="vote-modal__header">
          <span className="vote-modal__header__icon-holder">
            <CircleClose className="vote-modal__header__icon-holder__icon vote-modal__header__icon-holder__icon--abstain" />
          </span>
          <div className="vote-modal__header__text">
            <p className="L1 meta">Proposal {Number(proposal.id)}</p>
            <p className="L4 body vote-modal__header__text--title">{proposal.title}</p>
          </div>
        </div>
        <div className="vote-modal__input text-input-view">
          <textarea
            className="text-input-view__input text-input-view__input--large L4 body"
            placeholder="Tell others why you are voting this way..."
            value={reason}
            autoComplete="off"
            onChange={(e) => setReason(e.target.value)}
          />
          <label className="text-input-view__label L4 meta">
            Reason
            <span className="optional"> {`(Optional)`}</span>
          </label>
        </div>
        <button
          className="button button--x-large button--supply"
          onClick={() => {
            setScreen(VoteModalScreenEnum.ConfirmTransaction);
            setVoteText(VoteValueEnum[2]);
            onCastVote(proposal.id, VoteValueEnum.Abstain, reason);
          }}
        >
          Confirm with Wallet
        </button>
      </div>
    );
  } else if (screen === VoteModalScreenEnum.ConfirmTransaction) {
    title = 'Confirm Transaction';
    content = (
      <div className="vote-transaction-modal">
        <div className="loading-icon-holder">
          <div className="container">
            <div className="halfclip">
              <div className="halfcircle clipped"></div>
            </div>
            <div className="halfcircle fixed"></div>
          </div>
          <Wallet className="svg--icon--1 svg--wallet" />
        </div>
        <div className="vote-transaction-modal__block">
          <h4 className="heading heading--emphasized L4">
            {voteNumberString}.{voteDecimalString} Votes
          </h4>

          <p className="L4 meta vote-transaction-modal__block__description">
            {voteText} Proposal {Number(proposal.id)}
          </p>
        </div>
      </div>
    );
  } else if (transaction !== undefined && transaction.state === TransactionState.Pending) {
    title = 'Transaction Confirmed';
    content = (
      <div className="vote-transaction-modal">
        <div className="vote-transaction-modal__content">
          <div className="vote-transaction-modal__icon-holder">
            <Wallet className="svg--icon--1" />
            <div className="overlay-icon">
              <CheckMark className="svg" color="var(--ui--foreground--2)" />
            </div>
          </div>
          <div className="L4 body">
            <p>Your transaction has been confirmed.</p>
            <p>You may close this dialog.</p>
          </div>
        </div>
        <a
          className="link"
          href={getBlockExplorerUrlForTransaction(transaction as PendingTransaction)}
          target="_blank"
          rel="noreferrer"
        >
          <button className="button button--x-large">View on Explorer</button>
        </a>
      </div>
    );
  }

  return (
    <div className="modal modal--active">
      <div className="modal__backdrop" onClick={onModalClose}></div>
      <div className="modal__content light-modal">
        <div className="modal__content__header">
          <div className="modal__content__header__left"></div>
          <h4 className="L4 heading heading--emphasized heading">{title}</h4>
          <div className="modal__content__header__right" onClick={onModalClose}>
            <CircleClose />
          </div>
        </div>
        {content}
      </div>
    </div>
  );
};

export default VoteModal;
