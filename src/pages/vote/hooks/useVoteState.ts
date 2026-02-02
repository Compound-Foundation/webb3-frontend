import { StaticJsonRpcProvider } from '@ethersproject/providers';
import { Contract, Provider } from 'ethers-multicall';
import { useEffect, useState, useRef, useCallback } from 'react';

import { isTestnet, getChainKey, CHAINS } from '@constants/chains';
import type { Web3 } from '@contexts/Web3Context';
import COMP from '@helpers/abis/COMP';
import Governor from '@helpers/abis/Governor';
import Timelock from '@helpers/abis/Timelock';
import { getEventLogCoders, proposalEvents, RawLog } from '@helpers/coders';
import { SECONDS_PER_BLOCK } from '@helpers/constants';
import { getGovernanceContractAddress, GovernanceNetworksEnum } from '@helpers/contracts';
import { parseTitleDescriptionFromBody } from '@helpers/functions';
import { TIMESTAMP_API } from '@helpers/urls';
import {
  VoteState,
  StateType,
  Proposal,
  ChainInformation,
  CompAccount,
  VoteAccountState,
  DelegateTypeEnum,
  ProposalStateEnum,
  BlockProposal,
  Transaction,
  VoteNoAccountState,
  VoteReceipt,
} from '@types';

// TODO(alex) --> confirm desired interval
const VOTE_REFRESH_INTERVAL = 300_000; // 5 mins

export function useVoteState(
  web3: Web3,
  transactions: Transaction[]
): { state: VoteState; externalRefreshData: () => void } {
  const [state, setState] = useState<VoteState>([StateType.Loading]);
  const chainRef = useRef(web3.write.chainId);
  const accountRef = useRef(web3.write.account);

  // if chainId or account changed --> set loading and refresh data
  useEffect(() => {
    if (web3.write.chainId !== chainRef.current || web3.write.account !== accountRef.current) {
      const state: VoteState = [StateType.Loading];
      setState(state);
      chainRef.current = web3.write.chainId;
      accountRef.current = web3.write.account;
    }
  }, [web3.write.chainId, web3.write.account]);

  // we care about which chain the wallet is connected to here
  // over selected market
  const refreshData = useCallback(async () => {
    const state: VoteState =
      web3.write.chainId !== undefined
        ? await getState(web3.write.chainId, web3.write.account)
        : await getState(web3.read.chainId);

    // Only update state if chainId has not changed since the start of this callback
    if (web3.write.chainId === chainRef.current) {
      setState(state);
    }
  }, [web3.write.chainId, web3.write.account, transactions]);

  // export the refreshData function
  const externalRefreshData = useCallback(() => {
    refreshData();
  }, [refreshData]);

  useEffect(() => {
    const intervalId = setInterval(refreshData, VOTE_REFRESH_INTERVAL);
    // refresh data immediately
    refreshData();

    return () => clearInterval(intervalId);
  }, [refreshData]);

  return { state, externalRefreshData };
}

// this function determines whether to allow user to write actions on Vote page
// for now, we ONLY allow on mainnet
const canWriteAction = (chainId: number) => {
  return chainId === 1;
};

const getDelegateType = (account: string, delegateAddress: string): DelegateTypeEnum => {
  if (Number(delegateAddress) === 0) return DelegateTypeEnum.Undelegated;
  else if (delegateAddress.toLowerCase() === account.toLowerCase()) return DelegateTypeEnum.Self;
  else return DelegateTypeEnum.Delegated;
};

const getBlockTimestamps = async (blockNumbers: number[], network: string) => {
  const timestampsResult = await fetch(`${TIMESTAMP_API}/${blockNumbers.join(',')}?network=${network}`);
  return await timestampsResult.json();
};

const proposalSucceeded = (proposal: Proposal, quorumVotes: bigint) => {
  // we don't need to factor decimal shift here, as we're using values from same contract
  return proposal.forVotes > quorumVotes && proposal.forVotes > proposal.againstVotes;
};

const getState = async (chainId = 1, account?: string): Promise<VoteState> => {
  // we'll show Sepolia data for any known test network, otherwise show mainnet info
  CHAINS[chainId] && isTestnet(chainId) ? (chainId = 11155111) : (chainId = 1);

  const chainInfo: ChainInformation = CHAINS[chainId];
  const provider = new StaticJsonRpcProvider(chainInfo.url);
  const ethcallProvider = new Provider(provider, chainId);

  // use Sepolia testnet info for any testnet
  // otherwise, use Eth mainnet for any other network, or no wallet connected
  const [govAddress, compAddress, timelockAddress] = getGovernanceContractAddress(
    isTestnet(chainId) ? GovernanceNetworksEnum.Testnet : GovernanceNetworksEnum.Mainnet
  );

  const governorContract = new Contract(govAddress, Governor);
  const timelockContract = new Contract(timelockAddress, Timelock);
  const chainKey = getChainKey(chainId);

  // fetch all proposal events within the timelock delay, to capture any queued proposals as well
  const currentBlock = await provider.getBlockNumber();
  const [votingPeriod, votingDelay, timelockDelay, gracePeriod, quorumVotes] = await ethcallProvider.all([
    governorContract.votingPeriod(),
    governorContract.votingDelay(),
    timelockContract.delay(),
    timelockContract.GRACE_PERIOD(),
    governorContract.quorumVotes(),
  ]);

  // we'll use this coder to determine the topic hash, and decode the raw log data
  // created using the event signatures:
  const coder = getEventLogCoders([
    proposalEvents.ProposalCreated,
    proposalEvents.ProposalCanceled,
    proposalEvents.ProposalQueued,
    proposalEvents.ProposalExecuted,
  ]);

  const topics = [
    coder.topics.ProposalExecuted(),
    coder.topics.ProposalQueued(),
    coder.topics.ProposalCanceled(),
    coder.topics.ProposalCreated(),
  ];

  const rawProposalLog: RawLog[] = [];
  const blockTimes: number[] = [];

  async function getLogs(topic: string) {
    const logs = (await provider.getLogs({
      address: govAddress,
      fromBlock: currentBlock - votingPeriod - votingDelay - gracePeriod,
      toBlock: currentBlock,
      topics: [topic],
    })) as RawLog[];

    rawProposalLog.push(...logs);
  }

  await Promise.all(topics.map(getLogs));

  const decodedLogs = await rawProposalLog.map((log) => coder.decode(log));
  const rawProposals = new Map<bigint, BlockProposal>();

  // get all the 'created proposals
  decodedLogs
    .filter((decoded) => decoded.name === 'ProposalCreated')
    .map((decoded) => {
      const { description } = decoded.body;
      let { id } = decoded.body;
      id = id.toBigInt();

      const proposal = {
        ...parseTitleDescriptionFromBody(description),
        id,
        eta: 0n,
        startBlock: decoded.body.startBlock,
        endBlock: decoded.body.endBlock,
        abstainVotes: 0n,
        againstVotes: 0n,
        forVotes: 0n,

        // create a 'pending' state
        // if proposal has been created but voting is not yet active, we still show the proposal on Active page, as "Review"
        state: {
          state: ProposalStateEnum.Pending,
          startBlock: decoded.blockNumber,
          endBlock: decoded.body.startBlock.toNumber(),
        },
      };

      blockTimes.push(decoded.blockNumber, decoded.body.startBlock.toNumber(), decoded.body.endBlock);
      rawProposals.set(id, proposal as BlockProposal);
    });

  // process queued, executed in whatever order --> if it's been executed, we'll just remove it
  decodedLogs
    .filter((decoded) => decoded.name !== 'ProposalCreated')
    .map((decoded) => {
      switch (decoded.name) {
        case 'ProposalCanceled': {
          const id = decoded.body.id.toBigInt();

          // because we are querying for only a specified range
          // we may get later events for proposals we didn't get created events for
          // if so, we can just ignore these
          if (rawProposals.has(id)) {
            const blockNumber = decoded.blockNumber;
            blockTimes.push(blockNumber);

            rawProposals.set(id, {
              ...rawProposals.get(id),
              state: {
                state: ProposalStateEnum.Canceled,
                startBlock: blockNumber,
              },
            } as BlockProposal);
          }
          break;
        }
        case 'ProposalQueued': {
          const id = decoded.body.id.toBigInt();

          if (rawProposals.has(id)) {
            const blockNumber = decoded.blockNumber;
            blockTimes.push(blockNumber);

            rawProposals.set(id, {
              ...rawProposals.get(id),
              eta: decoded.body.eta,
              state: {
                state: ProposalStateEnum.Queued,
                startBlock: blockNumber,
                endBlock: decoded.body.eta,
              },
            } as BlockProposal);
          }
          break;
        }
        case 'ProposalExecuted': {
          const id = decoded.body.id.toBigInt();

          if (rawProposals.has(id)) {
            // if a proposal has already been executed, we don't need it here
            rawProposals.delete(id);
          }
          break;
        }
      }
    });

  // get the timestamp values for each block number
  const uniqueBlockNumbers = Array.from(new Set(blockTimes));

  // TODO(alex) --> handle no api results returned or api error
  const timestamps = uniqueBlockNumbers.length > 0 && (await getBlockTimestamps(uniqueBlockNumbers, chainKey));
  const currentTime = new Date().getTime() / 1000;

  // create combined query to get proposal votes
  const [...proposalVotes] = await ethcallProvider.all([
    ...[...rawProposals.values()].map((proposal) => governorContract.proposals(Number(proposal.id))),
  ]);

  const proposals: Proposal[] = [];
  [...rawProposals.values()].map((item) => {
    // grab the latest vote count for the raw proposal
    const votes = proposalVotes.find(({ id }) => id.eq(item.id));

    // item is truly in 'pending' state if vote period hasn't started
    if (item.startBlock > currentBlock && item.state.state === ProposalStateEnum.Pending) {
      const startTime = timestamps[Number(item.state.startBlock)];

      // if endTime is future block, we need to calculate it here
      const endTime =
        timestamps[Number(item.startBlock)] ||
        currentTime + (Number(item.startBlock) - currentBlock) * SECONDS_PER_BLOCK;

      proposals.push({
        ...item,
        state: {
          state: ProposalStateEnum.Pending,
          startTime,
          endTime,
        },
      });
    }
    // if we're within the voting period, update 'pending' state to 'active'
    else if (
      item.startBlock <= currentBlock &&
      item.endBlock > currentBlock &&
      item.state.state === ProposalStateEnum.Pending
    ) {
      const startTime = timestamps[Number(item.startBlock)];
      const endTime =
        timestamps[Number(item.endBlock)] || currentTime + (Number(item.endBlock) - currentBlock) * SECONDS_PER_BLOCK;

      proposals.push({
        ...item,
        forVotes: votes.forVotes,
        againstVotes: votes.againstVotes,
        abstainVotes: votes.abstainVotes,
        state: {
          state: ProposalStateEnum.Active,
          startTime,
          endTime,
        },
      });
    } else if (
      item.state.state === ProposalStateEnum.Queued &&
      Number(votes.eta) + Number(gracePeriod) >= currentTime
    ) {
      const eta = Number(votes.eta);
      proposals.push({
        ...item,
        state: {
          state: ProposalStateEnum.Queued,
          startTime: eta - timelockDelay,
          endTime: eta,
        },
      });
    }
    // check for remaining proposals that have passed --> READY to be queued
    else if (item.state.state === ProposalStateEnum.Pending && item.endBlock <= currentBlock) {
      if (proposalSucceeded(votes, quorumVotes.toBigInt())) {
        const startTime = timestamps[Number(item.endBlock)];

        proposals.push({
          ...item,
          forVotes: votes.forVotes,
          againstVotes: votes.againstVotes,
          abstainVotes: votes.abstainVotes,
          state: {
            state: ProposalStateEnum.Succeeded,
            startTime,
            endTime: 0,
          },
        });
      }
    }
    // for expired, executed, or canceled proposals --> do nothing
    else if (
      (item.state.state === ProposalStateEnum.Queued && Number(votes.eta) + Number(gracePeriod) < currentTime) ||
      item.state.state === ProposalStateEnum.Executed ||
      item.state.state === ProposalStateEnum.Canceled
    ) {
      // Do nothing
    } else {
      // account for any other proposals and log to console
      console.log('Proposal unaccounted for: ', item.id);
    }
  });

  const [proposalThreshold] = await ethcallProvider.all([governorContract.proposalThreshold()]);

  const state: VoteNoAccountState = {
    chainKey,
    chainId,
    compAddress,
    govAddress,
    proposals: proposals.reverse(),
    proposalThreshold: proposalThreshold.toBigInt(),
    canWrite: false,
    decimals: 18,
  };

  if (account) {
    const compContract = new Contract(compAddress, COMP);

    // check vote status for active proposals
    const activeProposals = proposals.filter((proposal) => proposal.state.state === ProposalStateEnum.Active);
    const receiptsCalls = activeProposals.map((proposal) => governorContract.getReceipt(proposal.id, account));

    const [decimals, balance, votes, delegate, ...receipts] = await ethcallProvider.all([
      compContract.decimals(),
      compContract.balanceOf(account),
      compContract.getCurrentVotes(account),
      compContract.delegates(account),
      ...receiptsCalls,
    ]);

    // create map of vote status
    const voteReceipts = new Map<bigint, VoteReceipt>();
    activeProposals.forEach((element, index) => {
      voteReceipts.set(element.id, {
        voted: receipts[index][0],
        value: receipts[index][1],
        proposalId: element.id,
      });
    });

    // contract returns zero address for delegate, if undelegated
    const delegateType = getDelegateType(account, delegate);

    const compAccount: CompAccount = {
      delegateType,
      address: account,
      balance: balance.toBigInt(),
      votes: votes.toBigInt(),
      delegate,
    };

    const accountState: VoteAccountState = {
      ...state,
      decimals: Number(decimals),
      canWrite: canWriteAction(chainId),
      compAccount,
      voteReceipts,
    };

    return [StateType.Hydrated, accountState];
  }
  return [StateType.NoWallet, state];
};
