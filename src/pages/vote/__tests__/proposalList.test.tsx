import { render, screen } from '@testing-library/react';

import '@testing-library/jest-dom';
import { Proposal, VoteReceipt, Transaction, StateType, VoteValueEnum, ProposalStateEnum } from '@types';

import {
  activeProposal,
  mockReceipts,
  queuedProposal,
  activeProposalNoVote,
  pendingProposal,
} from '../../../../handlers/mock-proposals';
import ProposalList from '../components/ProposalList';

const mockVoteOpen = jest.fn();
const mockQueueAction = jest.fn();
const mockRefresh = jest.fn();

const renderProposalList = (
  proposals: Proposal[],
  canVote: boolean,
  showQueueAction: boolean,
  voteReceipts: Map<bigint, VoteReceipt>,
  transaction?: Transaction
) => {
  return render(
    <ProposalList
      state={[
        StateType.Hydrated,
        {
          proposals,
          chainKey: 'mainnet',
          canVote,
          showQueueAction,
          voteReceipts,
          transaction,
          onRefresh: mockRefresh,
          onExecuteProposal: mockVoteOpen,
          onQueueProposal: mockQueueAction,
          onVoteOpen: mockVoteOpen,
        },
      ]}
    />
  );
};

describe('ProposalList', () => {
  test('renders empty proposal state', () => {
    renderProposalList([], true, true, new Map());

    expect(screen.getByText('No active proposals.')).toBeInTheDocument();
    expect(screen.getByLabelText('See all proposals')).toBeInTheDocument();
    expect(screen.queryByText('Queued Proposals')).not.toBeInTheDocument();
  });

  test('renders queued proposals and empty active list', () => {
    renderProposalList([queuedProposal], true, true, new Map());

    expect(screen.getByText('No active proposals.')).toBeInTheDocument();
    expect(screen.getByText('Queued Proposals')).toBeInTheDocument();
    expect(screen.getByText(queuedProposal.title)).toBeInTheDocument();
  });

  test('renders active proposals with missing receipts', () => {
    renderProposalList([activeProposal, activeProposalNoVote], true, true, new Map());

    expect(screen.getByText(activeProposal.title)).toBeInTheDocument();
    expect(screen.getByText(activeProposalNoVote.title)).toBeInTheDocument();

    const buttons = screen.queryAllByRole('button');
    expect(buttons.length).toBe(0);
    expect(screen.queryByText('Your Vote')).not.toBeInTheDocument();
  });

  test('renders active proposals buttons when has not voted', () => {
    renderProposalList([activeProposal, activeProposalNoVote], true, true, mockReceipts);

    const buttons = screen.queryAllByRole('button');
    expect(buttons.length).toBe(3);
    expect(screen.getByText('Your Vote')).toBeInTheDocument();
  });

  test('renders active proposals with vote receipt', () => {
    const receipts = new Map();
    receipts.set(BigInt(153), {
      voted: true,
      value: VoteValueEnum.For,
      proposalId: BigInt(153),
    });

    receipts.set(BigInt(152), {
      voted: true,
      value: VoteValueEnum.Against,
      proposalId: BigInt(152),
    });

    renderProposalList([activeProposal, activeProposalNoVote], true, true, receipts);

    const buttons = screen.queryAllByRole('button');
    expect(buttons.length).toBe(0);
    expect(screen.queryAllByText('Your Vote').length).toBe(2);
    expect(screen.getByLabelText('You voted for')).toBeInTheDocument();
    expect(screen.getByLabelText('You voted against')).toBeInTheDocument();
    expect(screen.queryByLabelText('You voted abstaint')).not.toBeInTheDocument();
  });

  test('calls onRefresh when pending proposal countdown ends', async () => {
    const proposal = { ...pendingProposal, state: { state: ProposalStateEnum.Pending, startTime: 0, endTime: 10 } };
    renderProposalList([proposal], true, true, mockReceipts);

    expect(screen.getByText(/until voting/)).toBeInTheDocument();

    // wait for countdown to reach zero
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
