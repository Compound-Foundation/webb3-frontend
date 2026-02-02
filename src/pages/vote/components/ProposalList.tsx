import React, { useEffect, useState } from 'react';

import { Proposal, ProposalStateEnum, StateType, VoteReceipt, Transaction } from '@types';

import ProposalItem from './ProposalListItem';
import { VoteModalScreenEnum } from './VoteModal';

type ProposalListLoading = [StateType.Loading];

type ProposalListHydrated = [
  StateType.Hydrated,
  {
    proposals: Proposal[];
    chainKey: string;
    canVote: boolean;
    showQueueAction: boolean;
    transaction?: Transaction;
    voteReceipts: Map<bigint, VoteReceipt>;
    onRefresh: () => void;
    onExecuteProposal: (proposalId: bigint) => void;
    onQueueProposal: (proposalId: bigint) => void;
    onVoteOpen: (screen: VoteModalScreenEnum, proposal: Proposal) => void;
  }
];

export type ProposalListState = ProposalListLoading | ProposalListHydrated;

interface ProposalListProps {
  state: ProposalListState;
}

const LoadingProposalItem = () => {
  return (
    <div className="proposal-item L3">
      <p className="placeholder-content placeholder-content__title"></p>
      <div className="proposal-item__details meta L3">
        <span className="placeholder-content placeholder-content__body"></span>
      </div>
    </div>
  );
};

const LoadingState = () => (
  <div className="panel vote-proposals">
    <div className="vote-panel__header-row">
      <label className="L2 label text-color--2">Active Proposals</label>
    </div>
    {[...Array(4).keys()].map((i) => (
      <LoadingProposalItem key={`loading-proposal-${i}`} />
    ))}
    <div className="divider"></div>
    <div className="vote-proposals__footer">
      <a className="vote-proposals__footer__link L2 label placeholder-content"></a>
    </div>
  </div>
);

const ProposalList = ({ state }: ProposalListProps) => {
  const [, data] = state;

  if (!data) {
    return <LoadingState />;
  }

  const [activeProposals, setActiveProposals] = useState<Proposal[]>([]);
  const [queuedProposals, setQueuedProposals] = useState<Proposal[]>([]);

  useEffect(() => {
    setActiveProposals(
      data.proposals.filter((proposal) =>
        [ProposalStateEnum.Active, ProposalStateEnum.Pending, ProposalStateEnum.Succeeded].includes(
          proposal.state.state
        )
      )
    );
    setQueuedProposals(data.proposals.filter((proposal) => proposal.state.state === ProposalStateEnum.Queued));
  }, [data.proposals]);

  return (
    <>
      <div className="panel vote-proposals">
        <div className="vote-panel__header-row vote-proposals__header">
          <label className="L2 label text-color--2">Active Proposals</label>
        </div>
        <div className="vote-panel__body">
          {activeProposals.length > 0 ? (
            activeProposals.map((proposal: Proposal) => (
              <ProposalItem
                canVote={data.canVote}
                key={`proposal-${proposal.id}`}
                proposal={proposal}
                receipt={data.voteReceipts.get(proposal.id)}
                chainKey={data.chainKey}
                showQueueAction={data.showQueueAction}
                transaction={data.transaction}
                onProposalAction={data.onQueueProposal}
                onVoteOpen={data.onVoteOpen}
                onRefresh={data.onRefresh}
              />
            ))
          ) : (
            <div className="vote-proposals__empty">
              <p className="body L4 text-color--3">No active proposals.</p>
            </div>
          )}
        </div>
        <div className="divider"></div>
        <div className="vote-proposals__footer">
          <a
            className="vote-proposals__footer__link L2 label"
            target={'_blank'}
            aria-label="See all proposals"
            href={`https://compound.finance/governance/proposals?target_network=$${data.chainKey}`}
          >
            See All Proposals
          </a>
        </div>
      </div>
      {queuedProposals.length > 0 && (
        <div className="panel vote-panel vote-proposals">
          <div className="vote-panel__header-row vote-proposals__header">
            <label className="L2 label text-color--2">Queued Proposals</label>
          </div>
          <div className="vote-panel__body">
            {queuedProposals?.map((proposal: Proposal) => (
              <ProposalItem
                canVote={false}
                key={`proposal-${proposal.id}`}
                proposal={proposal}
                chainKey={data.chainKey}
                transaction={undefined}
                showQueueAction={data.showQueueAction}
                onRefresh={() => undefined}
                onProposalAction={data.onExecuteProposal}
                onVoteOpen={data.onVoteOpen}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
};

export default ProposalList;
