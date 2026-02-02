import { render, screen, fireEvent } from '@testing-library/react';

import '@testing-library/jest-dom';
import { Proposal, ProposalStateEnum, VoteReceipt, Transaction } from '@types';

import {
  pendingProposal,
  activeProposal,
  mockReceipts,
  queuedProposal,
  succeededProposal,
  proposalToExecute,
  activeProposalNoVote,
} from '../../../../handlers/mock-proposals';
import ProposalItem from '../components/ProposalListItem';
import { VoteModalScreenEnum } from '../components/VoteModal';

const mockVoteOpen = jest.fn();
const mockQueueAction = jest.fn();
const mockRefresh = jest.fn();

const renderProposalItem = (
  proposal: Proposal,
  canVote: boolean,
  showQueueAction: boolean,
  receipt?: VoteReceipt,
  transaction?: Transaction
) => {
  return render(
    <ProposalItem
      proposal={proposal}
      chainKey="testChainKey"
      canVote={canVote}
      receipt={receipt}
      transaction={transaction}
      onVoteOpen={mockVoteOpen}
      onProposalAction={mockQueueAction}
      showQueueAction={showQueueAction}
      onRefresh={mockRefresh}
    />
  );
};

describe('ProposalItem', () => {
  test('renders pending proposal status and time until voting', () => {
    renderProposalItem(pendingProposal, true, true, undefined, undefined);

    expect(screen.getByText(ProposalStateEnum.Pending)).toBeInTheDocument();
    expect(screen.getByText(/until voting/)).toBeInTheDocument();
    const buttons = screen.queryAllByRole('button');
    expect(buttons.length).toBe(0);
  });

  test('renders active proposal and voting disabled', () => {
    renderProposalItem(activeProposal, false, false, undefined, undefined);

    expect(screen.getByText(ProposalStateEnum.Active)).toBeInTheDocument();
    expect(screen.getByText(/left/)).toBeInTheDocument();
    expect(screen.queryByText(/vote for/)).not.toBeInTheDocument();

    // shows correct vote % on active proposals
    expect(screen.getByLabelText('For vote percent')).toHaveTextContent('90%');
    expect(screen.getByLabelText('Against vote percent')).toHaveTextContent('0%');
    expect(screen.getByLabelText('Abstain vote percent')).toHaveTextContent('10%');

    // hides vote buttons
    const buttons = screen.queryAllByRole('button');
    expect(buttons.length).toBe(0);
  });

  test('renders active proposal with vote buttons', () => {
    const receipt = mockReceipts.get(activeProposalNoVote.id);
    renderProposalItem(activeProposalNoVote, true, true, receipt, undefined);

    const buttons = screen.queryAllByRole('button');
    expect(buttons.length).toBe(3);

    fireEvent.click(screen.getByLabelText('Vote for'));
    expect(mockVoteOpen).toHaveBeenCalledWith(VoteModalScreenEnum.VoteFor, activeProposalNoVote);
  });

  test('disables vote buttons when criteria not met', () => {
    renderProposalItem(activeProposal, false, false, undefined, undefined);

    const buttons = screen.queryAllByRole('button');
    expect(buttons.length).toBe(0);
  });

  test('hides active proposal buttons when displaying vote receipt', () => {
    const receipt = mockReceipts.get(activeProposal.id);
    renderProposalItem(activeProposal, true, true, receipt, undefined);

    const buttons = screen.queryAllByRole('button');
    expect(buttons.length).toBe(0);
    expect(screen.getByText('Your Vote')).toBeInTheDocument();
  });

  test('only show Queue button on test network', () => {
    renderProposalItem(succeededProposal, true, false, undefined, undefined);

    const buttons = screen.queryAllByRole('button');
    expect(buttons.length).toBe(0);
    expect(screen.getByText(ProposalStateEnum.Succeeded)).toBeInTheDocument();
  });

  test('renders queued proposal', () => {
    renderProposalItem(queuedProposal, true, true, undefined, undefined);

    const buttons = screen.queryAllByRole('button');
    expect(buttons.length).toBe(0);
    expect(screen.getByText(ProposalStateEnum.Queued)).toBeInTheDocument();
  });

  test('renders queued proposal to execute', () => {
    renderProposalItem(proposalToExecute, true, true, undefined, undefined);

    const buttons = screen.queryAllByRole('button');
    expect(buttons.length).toBe(1);
    expect(screen.getByText(ProposalStateEnum.Queued)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Execute proposal'));
    expect(mockQueueAction).toHaveBeenCalledWith(proposalToExecute.id);
  });

  test('calls onRefresh when second countdown reaches zero', async () => {
    const proposal = { ...activeProposal };
    proposal.state = { state: ProposalStateEnum.Active, startTime: 0, endTime: 1 }; // set endTime to current time minus 1 second

    renderProposalItem(proposal, true, true, undefined, undefined);

    // wait for countdown to reach zero
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
