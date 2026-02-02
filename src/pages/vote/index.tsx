import { useState } from 'react';

import { isTestnet } from '@constants/chains';
import type { Web3 } from '@contexts/Web3Context';
import { PreEstimatedAction } from '@helpers/gasEstimator';
import { formatTokenBalance } from '@helpers/numbers';
import { AddTransaction } from '@hooks/useTransactionManager';
import { GovTransactionsEnum, useWriteVoteState } from '@hooks/useWriteVoteState';
import {
  CompAccount,
  DelegateTypeEnum,
  Proposal,
  StateType,
  Transaction,
  TransactionState,
  VoteAccountState,
  VoteNoAccountState,
  VoteValueEnum,
} from '@types';

import DelegateModal, { DelegateModalScreenEnum, DelegateModalState } from './components/DelegateModal';
import ProposalList, { ProposalListState } from './components/ProposalList';
import VoteHeroPanel, { VoteHeroPanelState } from './components/VoteHeroPanel';
import VoteModal, { VoteModalScreenEnum, VoteModalState } from './components/VoteModal';
import VoteWallet, { VoteWalletState } from './components/VoteWallet';
import { useVoteState } from './hooks/useVoteState';

type VoteProps = {
  web3: Web3;
  estimatedGasMap: Map<string, number>;
  transactions: Transaction[];
  addTransaction: AddTransaction;
  switchWriteNetwork: (chainId: number, description?: string) => Promise<boolean>;
};

const Vote = ({ web3, estimatedGasMap, transactions, addTransaction, switchWriteNetwork }: VoteProps) => {
  const { state, externalRefreshData } = useVoteState(web3, transactions);
  const writeState = useWriteVoteState(web3, addTransaction);

  const [voteStateType, voteStateData] = state;
  const [delegateModal, setDelegateModal] = useState(false);
  const [voteModal, setVoteModal] = useState(false);
  const [voteModalScreen, setVoteModalScreen] = useState<VoteModalScreenEnum>(VoteModalScreenEnum.VoteFor);
  const [voteProposal, setVoteProposal] = useState<Proposal>();

  let voteWalletState: VoteWalletState;
  let proposalListState: ProposalListState;
  let voteHeroPanelState: VoteHeroPanelState = [StateType.Loading];
  let delegateModalState: DelegateModalState = [StateType.NoWallet];
  let voteModalState: VoteModalState = [StateType.NoWallet];

  if (voteStateType === StateType.Loading) {
    voteWalletState = [StateType.Loading];
    proposalListState = [StateType.Loading];
  } else if (voteStateType === StateType.NoWallet) {
    const { proposals, chainKey } = voteStateData as VoteNoAccountState;

    voteHeroPanelState = [
      StateType.NoWallet,
      {
        label: 'Votes',
        value: ['0', '0000'],
      },
    ];

    voteWalletState = [StateType.NoWallet];
    proposalListState = [
      StateType.Hydrated,
      {
        proposals,
        chainKey,
        canVote: false,
        showQueueAction: false,
        transaction: undefined,
        voteReceipts: new Map(),
        onRefresh: () => externalRefreshData(),
        onExecuteProposal: () => undefined,
        onQueueProposal: () => undefined,
        onVoteOpen: () => undefined,
      },
    ];
  } else {
    const {
      proposals,
      proposalThreshold,
      decimals,
      canWrite,
      compAccount,
      chainKey,
      chainId,
      compAddress,
      voteReceipts,
    } = voteStateData as VoteAccountState;
    const { delegateType, votes, balance } = compAccount as CompAccount;
    let heroLabel = '';
    let [heroNumberValue, heroDecimalValue]: [string, string] = ['', ''];

    if (delegateType === DelegateTypeEnum.Delegated) {
      heroLabel = 'Delegated Votes';
      [heroNumberValue, heroDecimalValue] = formatTokenBalance(decimals, balance).split('.');
    } else {
      heroLabel = 'Votes';
      [heroNumberValue, heroDecimalValue] = formatTokenBalance(decimals, votes).split('.');
    }

    const castVoteTransaction = transactions.find(
      (transaction) => transaction.description === GovTransactionsEnum.CastVote
    );

    const showQueueAction = canWrite && isTestnet(chainId) && chainId === web3.write.chainId;

    voteHeroPanelState = [
      StateType.Hydrated,
      {
        label: heroLabel,
        value: [heroNumberValue, heroDecimalValue],
        threshold: proposalThreshold,
        decimals,
        delegateType,
        votes,
      },
    ];

    voteWalletState = [
      StateType.Hydrated,
      {
        compAccount,
        decimals,
        chainId,
        chainKey,
        modalActive: delegateModal,
        onChangeDelegate: () =>
          web3.write.chainId === chainId
            ? setDelegateModal(true)
            : switchWriteNetwork(
                chainId,
                delegateType === DelegateTypeEnum.Undelegated && !compAccount.votes ? 'get started' : 'delegate voting'
              ),
      },
    ];

    proposalListState = [
      StateType.Hydrated,
      {
        proposals,
        chainKey,
        canVote: canWrite && delegateType !== DelegateTypeEnum.Delegated && compAccount.votes > 0,
        showQueueAction,
        transaction: castVoteTransaction,
        voteReceipts,
        onRefresh: () => externalRefreshData(),
        onExecuteProposal: (proposalId: bigint) =>
          writeState.executeProposal(proposalId, estimatedGasMap.get(PreEstimatedAction.ExecuteProposal) || 0),
        onQueueProposal: (proposalId: bigint) =>
          writeState.queueProposal(proposalId, estimatedGasMap.get(PreEstimatedAction.QueueProposal) || 0),
        onVoteOpen: (screen: VoteModalScreenEnum, proposal: Proposal) => {
          if (web3.write.chainId === chainId) {
            setVoteModal(true);
            setVoteModalScreen(screen);
            setVoteProposal(proposal);
          } else switchWriteNetwork(chainId, 'vote');
        },
      },
    ];

    // if user is already delegated, their votes show as 0, so we use their compBalance to determine votes 'reclaimed' or to be re-delegated
    const [voteNumberString, voteDecimalString] = formatTokenBalance(decimals, votes ? votes : balance).split('.');

    const delegateTransaction = transactions.find((transaction) => transaction.key === compAddress);
    const delegateModalScreen = !delegateTransaction
      ? DelegateModalScreenEnum.ChooseType
      : delegateTransaction.state === TransactionState.AwaitingConfirmation
      ? DelegateModalScreenEnum.ConfirmTransaction
      : DelegateModalScreenEnum.PendingTransaction;

    delegateModalState = [
      StateType.Hydrated,
      {
        active: delegateModal,
        chainId,
        chainKey,
        compAccount,
        transaction: delegateTransaction,
        startScreen: delegateModalScreen,
        voteNumberString,
        voteDecimalString,
        onRequestClose: () => setDelegateModal(false),
        onDelegateTransaction: (delegatee: string) =>
          writeState.delegate(delegatee, estimatedGasMap.get(PreEstimatedAction.Delegate) || 0, chainId),
      },
    ];

    voteModalState = [
      StateType.Hydrated,
      {
        active: voteModal,
        chainKey,
        proposal: voteProposal,
        screen: voteModalScreen,
        transaction: castVoteTransaction,
        voteNumberString,
        voteDecimalString,
        setScreen: (screen: VoteModalScreenEnum) => setVoteModalScreen(screen),
        onRequestClose: () => setVoteModal(false),
        onCastVote: (proposalId: bigint, support: VoteValueEnum, reason: string) =>
          writeState.castVote(
            proposalId,
            support,
            reason,
            estimatedGasMap.get(PreEstimatedAction.CastVote) || 0,
            chainId
          ),
      },
    ];
  }
  return (
    <div className="page vote">
      <DelegateModal state={delegateModalState} />
      <VoteModal state={voteModalState} />
      <VoteHeroPanel state={voteHeroPanelState} />
      <div className="vote__content grid-container">
        <div className="vote__proposals grid-column--7">
          <ProposalList state={proposalListState} />
        </div>
        <div className="vote__sidebar grid-column--5">
          <VoteWallet state={voteWalletState} />
        </div>
      </div>
    </div>
  );
};

export default Vote;
