import { useState, useEffect } from 'react';

import Meter from '@components/Meter';
import { formatDateWithSuffix, timeInWords } from '@helpers/functions';
import {
  Proposal,
  UnixProposalState,
  ProposalStateEnum,
  VoteReceipt,
  VoteValueEnum,
  Transaction,
  TransactionState,
} from '@types';

import { VoteModalScreenEnum } from './VoteModal';

export interface ProposalItemProps {
  proposal: Proposal;
  chainKey: string;
  canVote: boolean;
  receipt?: VoteReceipt;
  showQueueAction: boolean;
  transaction?: Transaction;
  onRefresh: () => void;
  onProposalAction: (proposalId: bigint) => void;
  onVoteOpen: (screen: VoteModalScreenEnum, proposal: Proposal) => void;
}

// calculate what to display based on proposal state & current time
const displayTime = (proposalState: UnixProposalState) => {
  const { state, startTime, endTime } = proposalState;
  const currentTime = new Date().getTime() / 1000;

  if (state === ProposalStateEnum.Pending) {
    const time = timeInWords(endTime - currentTime);
    return time + ' until voting';
  } else if (state === ProposalStateEnum.Active) {
    const time = timeInWords(endTime - currentTime);
    return time + ' left';
  } else if (state === ProposalStateEnum.Queued) {
    const time = formatDateWithSuffix(new Date(endTime * 1000));
    return 'Executing ' + time;
  } else if (state === ProposalStateEnum.Succeeded) {
    const time = formatDateWithSuffix(new Date(startTime * 1000));
    return 'Succeeded ' + time;
  }
  return '';
};

const ProposalItem = ({
  proposal,
  chainKey,
  canVote,
  receipt,
  showQueueAction,
  transaction,
  onRefresh,
  onVoteOpen,
  onProposalAction,
}: ProposalItemProps) => {
  const { state, id, title, eta } = proposal;
  const [remainingTime, setRemainingTime] = useState<string>(displayTime(state));

  const showVote = canVote && receipt && !receipt.voted;
  const voteTotal = Number(proposal.forVotes) + Number(proposal.abstainVotes) + Number(proposal.againstVotes);
  const currentTime = new Date().getTime() / 1000;

  const forVotes = voteTotal ? (Number(proposal.forVotes) / voteTotal) * 100 : 0;
  const abstainVotes = voteTotal ? (Number(proposal.abstainVotes) / voteTotal) * 100 : 0;
  const againstVotes = voteTotal ? (Number(proposal.againstVotes) / voteTotal) * 100 : 0;

  // show second countdown
  useEffect(() => {
    if (state.state === ProposalStateEnum.Pending || state.state === ProposalStateEnum.Active) {
      const intervalId = setInterval(() => {
        if (state.endTime - currentTime <= 3600 && state.endTime - currentTime > 0) {
          setRemainingTime(displayTime(state));
        } else if (state.endTime - currentTime <= 0) {
          clearInterval(intervalId);
          onRefresh();
        }
      }, 1000);

      return () => clearInterval(intervalId);
    } else {
      setRemainingTime(displayTime(state));
    }
  }, [remainingTime]);

  // do not let user attempt to vote again if existing transaction
  const transactionScreen =
    transaction?.state === TransactionState.AwaitingConfirmation
      ? VoteModalScreenEnum.ConfirmTransaction
      : VoteModalScreenEnum.PendingTransaction;

  return (
    <div className="proposal-item L3">
      <a
        className="proposal-item__link"
        target={'_blank'}
        href={`https://compound.finance/governance/proposals/${id}?target_network=${chainKey}`}
      >
        <h4 className="heading heading--emphasized L4">{title}</h4>
      </a>
      <div className="proposal-item__info">
        <div className="proposal-item__details">
          <div className={`L3 meta proposal-item__details__status ${state.state}`} aria-label="Proposal status">
            {state.state}
          </div>
          <span className="proposal-item__details__id ">
            <span className="L3 meta ">{Number(id)}</span>
            <span>•</span>
            <span className="L4 meta">{remainingTime}</span>
          </span>
        </div>
        {showQueueAction && state.state === ProposalStateEnum.Succeeded && (
          <button
            className="button button--small"
            aria-label="Queue proposal"
            onClick={() => onProposalAction(proposal.id)}
          >
            Queue
          </button>
        )}
        {showQueueAction && state.state === ProposalStateEnum.Queued && eta <= currentTime && (
          <button
            className="button button--small"
            aria-label="Execute proposal"
            onClick={() => onProposalAction(proposal.id)}
          >
            Execute
          </button>
        )}
      </div>
      {state.state === ProposalStateEnum.Active && (
        <div className="proposal-item__votes">
          <div className="proposal-item__votes__group">
            <div className="proposal-item__votes__group__count">
              <div className="L3 meta proposal-item__votes__group__count--text">
                <span>For</span>
                <span className="L4 meta text-color--2" aria-label="For vote percent">
                  {Math.floor(forVotes)}%
                </span>
                {receipt?.voted && receipt?.value === VoteValueEnum.For && (
                  <>
                    <span className="text-color--2"> • </span>
                    <span aria-label="You voted for">Your Vote</span>
                  </>
                )}
              </div>
              <Meter percentageFill={`${forVotes}%`} />
            </div>
            {showVote && (
              <button
                className="button button--small proposal-item__votes__group__button"
                onClick={() => onVoteOpen(!transaction ? VoteModalScreenEnum.VoteFor : transactionScreen, proposal)}
                aria-label="Vote for"
              >
                Vote For
              </button>
            )}
          </div>
          <div className="proposal-item__votes__group">
            <div className="proposal-item__votes__group__count">
              <div className="L3 meta proposal-item__votes__group__count--text">
                <span>Against</span>
                <span className="L4 meta text-color--2" aria-label="Against vote percent">
                  {Math.floor(againstVotes)}%
                </span>
                {receipt?.voted && receipt?.value === VoteValueEnum.Against && (
                  <>
                    <span className="text-color--2"> • </span>
                    <span aria-label="You voted against">Your Vote</span>
                  </>
                )}
              </div>
              <Meter riskLevel="high" percentageFill={`${againstVotes}%`} />
            </div>
            {showVote && (
              <button
                className="button button--small proposal-item__votes__group__button"
                onClick={() => onVoteOpen(!transaction ? VoteModalScreenEnum.VoteAgainst : transactionScreen, proposal)}
                aria-label="Vote against"
              >
                Vote Against
              </button>
            )}
          </div>
          <div className="proposal-item__votes__group">
            <div className="L3 meta proposal-item__votes__group__count">
              <div className="L3 meta proposal-item__votes__group__count--text">
                <span>Abstain</span>
                <span className="L4 meta text-color--2" aria-label="Abstain vote percent">
                  {Math.floor(abstainVotes)}%
                </span>
                {receipt?.voted && receipt?.value === VoteValueEnum.Abstain && (
                  <>
                    <span className="text-color--2"> • </span>
                    <span aria-label="You voted abstain">Your Vote</span>
                  </>
                )}
              </div>
              <Meter riskLevel="neutral" percentageFill={`${abstainVotes}%`} />
            </div>
            {showVote && (
              <button
                className="button button--small proposal-item__votes__group__button"
                onClick={() => onVoteOpen(!transaction ? VoteModalScreenEnum.VoteAbstain : transactionScreen, proposal)}
                aria-label="Vote abstain"
              >
                Vote Abstain
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ProposalItem;
