import { Contract } from '@ethersproject/contracts';
import { useCallback } from 'react';

import type { Web3 } from '@contexts/Web3Context';
import Comet from '@helpers/abis/Comet';
import ERC20 from '@helpers/abis/ERC20';
import Fauceteer from '@helpers/abis/Fauceteer';
import Rewards from '@helpers/abis/Rewards';
import { getBulkerTrxData, BulkerTrxData } from '@helpers/bulkerActions';
import { tryOrDecodeError } from '@helpers/functions';
import { MAX_UINT256 } from '@helpers/numbers';
import {
  AccountRewardsState,
  Action,
  BaseAssetWithAccountState,
  MarketData,
  MarketDataLoaded,
  TokenWithAccountState,
} from '@types';

import { AddTransaction } from './useTransactionManager';

export type WriteCometState = {
  approve: (
    spender: string,
    address: string,
    description: string,
    estimatedGas: number,
    callback?: () => void
  ) => Promise<void>;
  allowOperator: (
    market: MarketDataLoaded | MarketData,
    operatorAddress: string,
    description: string,
    estimatedGas: number,
    allow?: boolean
  ) => Promise<void>;
  supply: (
    market: MarketDataLoaded,
    address: string,
    amount: bigint,
    description: string,
    estimatedGas: number,
    callback?: () => void
  ) => Promise<void>;
  withdraw: (
    market: MarketDataLoaded,
    address: string,
    amount: bigint,
    description: string,
    estimatedGas: number,
    callback?: () => void
  ) => Promise<void>;
  claimReward: (
    rewardsAccountState: AccountRewardsState,
    address: string,
    description: string,
    estimatedGas: number,
    callback?: () => void
  ) => Promise<void>;
  invokeBulker: (
    market: MarketDataLoaded,
    actions: Action[],
    baseAssetPre: BaseAssetWithAccountState,
    collateralAssetsPre: TokenWithAccountState[],
    description: string,
    estimatedGas: number,
    callback?: () => void
  ) => Promise<void>;
  drip: (market: MarketDataLoaded, address: string) => Promise<void>;
};

export function useWriteCometState(web3: Web3, addTransaction: AddTransaction): WriteCometState {
  const approve = useCallback(
    async (spender: string, address: string, description: string, estimatedGas: number, callback?: () => void) => {
      if (
        web3.write.provider !== undefined &&
        web3.write.chainId === web3.read.chainId &&
        web3.write.account !== undefined
      ) {
        const sender = web3.write.account;
        const signer = web3.write.provider.getSigner(sender).connectUnchecked();

        const tokenErc20 = new Contract(address, ERC20, signer);

        addTransaction(
          address,
          description,
          tokenErc20.approve,
          estimatedGas,
          tokenErc20.estimateGas.approve,
          [spender, MAX_UINT256.toString()],
          0n,
          callback
        );
      }
    },
    [web3.write.provider, web3.write.account, web3.write.chainId, web3.read.chainId]
  );

  const allowOperator = useCallback(
    async (
      market: MarketData | MarketDataLoaded,
      operatorAddress: string,
      description: string,
      estimatedGas: number,
      allow = true
    ) => {
      if (
        web3.write.provider !== undefined &&
        web3.write.chainId === web3.read.chainId &&
        web3.write.account !== undefined
      ) {
        const sender = web3.write.account;
        const signer = web3.write.provider.getSigner(sender).connectUnchecked();

        const comet = new Contract(market.marketAddress, Comet, signer);

        addTransaction(operatorAddress, description, comet.allow, estimatedGas, comet.estimateGas.allow, [
          operatorAddress,
          allow.toString(),
        ]);
      }
    },
    [web3.write.provider, web3.write.account, web3.write.chainId, web3.read.chainId]
  );

  const supply = useCallback(
    async (
      market: MarketDataLoaded,
      address: string,
      amount: bigint,
      description: string,
      estimatedGas: number,
      callback?: () => void
    ) => {
      if (
        web3.write.provider !== undefined &&
        web3.write.chainId === web3.read.chainId &&
        web3.write.account !== undefined
      ) {
        const sender = web3.write.account;
        const signer = web3.write.provider.getSigner(sender).connectUnchecked();

        const comet = new Contract(market.marketAddress, Comet, signer);

        // the key for the supply action is the Comet address, not the asset address
        addTransaction(
          market.marketAddress,
          description,
          comet.supply,
          estimatedGas,
          comet.estimateGas.supply,
          [address, amount.toString()],
          0n,
          callback
        );
      }
    },
    [web3.write.provider, web3.write.account, web3.write.chainId, web3.read.chainId]
  );

  const withdraw = useCallback(
    async (
      market: MarketDataLoaded,
      address: string,
      amount: bigint,
      description: string,
      estimatedGas: number,
      callback?: () => void
    ) => {
      if (web3.write.provider !== undefined && web3.write.chainId === web3.read.chainId && web3.write.account) {
        const sender = web3.write.account;
        const signer = web3.write.provider.getSigner(sender).connectUnchecked();

        const comet = new Contract(market.marketAddress, Comet, signer);

        // the key for the withdraw action is the Comet address, not the asset address
        addTransaction(
          market.marketAddress,
          description,
          comet.withdraw,
          estimatedGas,
          comet.estimateGas.withdraw,
          [address, amount.toString()],
          0n,
          callback
        );
      }
    },
    [web3.write.provider, web3.write.account, web3.write.chainId, web3.read.chainId]
  );

  const invokeBulker = useCallback(
    async (
      market: MarketDataLoaded,
      actions: Action[],
      baseAssetPre: BaseAssetWithAccountState,
      collateralAssetsPre: TokenWithAccountState[],
      description: string,
      estimatedGas: number,
      callback?: () => void
    ) => {
      if (web3.write.provider !== undefined && web3.write.chainId === web3.read.chainId && web3.write.account) {
        const { bulker, bulkerActions, bulkerCallData, bulkerCallValue }: BulkerTrxData = getBulkerTrxData(
          web3.write.account,
          web3.write.provider,
          market,
          baseAssetPre,
          collateralAssetsPre,
          actions
        );

        addTransaction(
          market.bulkerAddress,
          description,
          bulker.invoke,
          estimatedGas,
          bulker.estimateGas.invoke,
          [bulkerActions, bulkerCallData],
          bulkerCallValue,
          callback
        );
      }
    },
    [web3.write.provider, web3.write.account, web3.write.chainId, web3.read.chainId]
  );

  const drip = useCallback(
    async (market: MarketDataLoaded, address: string) => {
      if (
        web3.write.provider !== undefined &&
        web3.write.chainId === web3.read.chainId &&
        web3.write.account &&
        market.fauceteerAddress !== undefined
      ) {
        const sender = web3.write.account;
        const signer = web3.write.provider.getSigner(sender).connectUnchecked();

        const fauceteer = new Contract(market.fauceteerAddress, Fauceteer, signer);
        await tryOrDecodeError(fauceteer, 'drip', [address]);
      }
    },
    [web3.write.provider, web3.write.account, web3.write.chainId, web3.read.chainId]
  );

  const claimReward = useCallback(
    async (
      rewardsAccountState: AccountRewardsState,
      address: string,
      description: string,
      estimatedGas: number,
      callback?: () => void
    ) => {
      if (
        web3.write.provider !== undefined &&
        web3.write.chainId === web3.read.chainId &&
        web3.write.account !== undefined
      ) {
        const sender = web3.write.account;
        const signer = web3.write.provider.getSigner(sender).connectUnchecked();

        const rewards = new Contract(rewardsAccountState.cometRewards, Rewards, signer);
        addTransaction(
          address,
          description,
          rewards.claim,
          estimatedGas,
          rewards.estimateGas.claim,
          [rewardsAccountState.comet, sender, true],
          0n,
          callback
        );
      }
    },
    [web3.write.provider, web3.write.account, web3.write.chainId, web3.read.chainId]
  );

  return {
    approve,
    allowOperator,
    supply,
    withdraw,
    invokeBulker,
    drip,
    claimReward,
  };
}
