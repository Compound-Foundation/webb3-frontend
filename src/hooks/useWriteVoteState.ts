import { Contract } from '@ethersproject/contracts';
import { useCallback } from 'react';

import { isTestnet } from '@constants/chains';
import type { Web3 } from '@contexts/Web3Context';
import COMP from '@helpers/abis/COMP';
import Governor from '@helpers/abis/Governor';
import { getGovernanceContractAddress, GovernanceNetworksEnum } from '@helpers/contracts';
import { VoteValueEnum } from '@types';

import { AddTransaction } from './useTransactionManager';

export type WriteVoteState = {
  delegate: (delegatee: string, estimatedGas: number, chainId: number, callback?: () => void) => Promise<void>;
  castVote: (
    proposalId: bigint,
    support: VoteValueEnum,
    reason: string,
    estimatedGas: number,
    chainId: number,
    callback?: () => void
  ) => Promise<void>;
  queueProposal: (proposalId: bigint, estimatedGas: number, callback?: () => void) => Promise<void>;
  executeProposal: (proposalId: bigint, estimatedGas: number, callback?: () => void) => Promise<void>;
};

// some of these we can allow multiple at once
// others, we need to restrict creating new transactions until previous ones have been confirmed
export enum GovTransactionsEnum {
  CastVote = 'Cast Vote',
  Queue = 'Queue',
  Execute = 'Execute',
}

export function useWriteVoteState(web3: Web3, addTransaction: AddTransaction): WriteVoteState {
  const delegate = useCallback(
    async (delegatee: string, estimatedGas: number, chainId: number) => {
      // chainId was set in useVoteState. we just need to check if it matches web3.write
      // this should always be the case, as ui will prompt network switch if not
      if (
        web3.write.provider !== undefined &&
        web3.write.chainId === chainId &&
        web3.write.chainId !== undefined &&
        web3.write.account !== undefined
      ) {
        const sender = web3.write.account;
        const signer = web3.write.provider.getSigner(sender).connectUnchecked();

        const [, compAddress] = getGovernanceContractAddress(
          isTestnet(web3.write.chainId) ? GovernanceNetworksEnum.Testnet : GovernanceNetworksEnum.Mainnet
        );

        const compContract = new Contract(compAddress, COMP, signer);
        addTransaction(
          compAddress,
          'Delegate Voting',
          compContract.delegate,
          estimatedGas,
          compContract.estimateGas.delegate,
          [delegatee]
        );
      } else {
        console.log('Bad account connection.');
      }
    },
    [web3.write.provider, web3.write.account, web3.write.chainId]
  );

  const castVote = useCallback(
    async (proposalId: bigint, support: VoteValueEnum, reason: string, estimatedGas: number, chainId: number) => {
      if (
        web3.write.provider !== undefined &&
        web3.write.chainId === chainId &&
        web3.write.chainId !== undefined &&
        web3.write.account !== undefined
      ) {
        const sender = web3.write.account;
        const signer = web3.write.provider.getSigner(sender).connectUnchecked();

        const [govAddress] = getGovernanceContractAddress(
          isTestnet(web3.write.chainId) ? GovernanceNetworksEnum.Testnet : GovernanceNetworksEnum.Mainnet
        );

        const govContract = new Contract(govAddress, Governor, signer);

        reason !== ''
          ? addTransaction(
              govAddress,
              GovTransactionsEnum.CastVote,
              govContract.castVoteWithReason,
              estimatedGas,
              govContract.estimateGas.castVoteWithReason,
              [proposalId, support, reason]
            )
          : addTransaction(
              govAddress,
              GovTransactionsEnum.CastVote,
              govContract.castVote,
              estimatedGas,
              govContract.estimateGas.castVote,
              [proposalId, support]
            );
      } else {
        console.log('Bad account connection.');
      }
    },
    [web3.write.provider, web3.write.account, web3.write.chainId]
  );

  const queueProposal = useCallback(
    async (proposalId: bigint, estimatedGas: number) => {
      if (web3.write.provider !== undefined && web3.write.chainId !== undefined && web3.write.account !== undefined) {
        const sender = web3.write.account;
        const signer = web3.write.provider.getSigner(sender).connectUnchecked();

        const [govAddress] = getGovernanceContractAddress(
          isTestnet(web3.write.chainId) ? GovernanceNetworksEnum.Testnet : GovernanceNetworksEnum.Mainnet
        );

        const govContract = new Contract(govAddress, Governor, signer);
        addTransaction(
          govAddress,
          GovTransactionsEnum.Queue,
          govContract.queue,
          estimatedGas,
          govContract.estimateGas.queue,
          [proposalId]
        );
      } else {
        console.log('Bad account connection.');
      }
    },
    [web3.write.provider, web3.write.account, web3.write.chainId, web3.read.chainId]
  );

  const executeProposal = useCallback(
    async (proposalId: bigint, estimatedGas: number) => {
      if (web3.write.provider !== undefined && web3.write.chainId !== undefined && web3.write.account !== undefined) {
        const sender = web3.write.account;
        const signer = web3.write.provider.getSigner(sender).connectUnchecked();

        const [govAddress] = getGovernanceContractAddress(
          isTestnet(web3.write.chainId) ? GovernanceNetworksEnum.Testnet : GovernanceNetworksEnum.Mainnet
        );

        const govContract = new Contract(govAddress, Governor, signer);
        addTransaction(
          govAddress,
          GovTransactionsEnum.Execute,
          govContract.execute,
          estimatedGas,
          govContract.estimateGas.execute,
          [proposalId]
        );
      } else {
        console.log('Bad account connection.');
      }
    },
    [web3.write.provider, web3.write.account, web3.write.chainId, web3.read.chainId]
  );

  return {
    delegate,
    castVote,
    queueProposal,
    executeProposal,
  };
}
