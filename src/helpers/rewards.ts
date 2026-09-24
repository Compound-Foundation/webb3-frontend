import { institutionalSupplyRewardRate } from '@helpers/institutionalRates';
import { getRewardsAPR } from '@helpers/numbers';
import {
  AccountRewardsState, MarketData,
  MarketDataLoaded,
  MarketDataState,
  RewardsState,
  RewardsTokenState,
  StateType
} from '@types';

export function getRewardsForSelectedMarket(
  rewards: RewardsState,
  selectedMarket: MarketDataState
): undefined | RewardsTokenState | AccountRewardsState {
  if (rewards[0] !== StateType.Loading && rewards[1] !== undefined && selectedMarket[1] !== undefined) {
    const rewardsForChain = rewards[1].find(
      ([chainId]) => chainId === selectedMarket[1]?.chainInformation.chainId.toString()
    );
    return rewardsForChain?.[1].rewardsStates.find(
      (rewardsState) => rewardsState.comet === selectedMarket[1]?.marketAddress
    );
  }
  return undefined;
}

export function getRewardsForMarket(
  rewards: RewardsState,
  accountRewardsState: AccountRewardsState
): undefined | AccountRewardsState {
  if (rewards[0] === StateType.Hydrated && rewards[1] !== undefined) {
    for (let i = 0; i < rewards[1].length; i++) {
      const [, rewardsAccountStates] = rewards[1][i];

      for (let j = 0; j < rewardsAccountStates.rewardsStates.length; j++) {
        const rewardState = rewardsAccountStates.rewardsStates[j];
        if (rewardState.comet === accountRewardsState.comet && rewardState.chainId === accountRewardsState.chainId) {
          return rewardState;
        }
      }
    }
  }
  return undefined;
}

export type MarketRewardsAPRs = {
  borrowRewardsAPR: bigint;
  supplyRewardsAPR: bigint;
  rewardsAssetSymbol?: string;
  isInstitutional?: boolean;
};

export const getMarketRewardsAPRs = (
  market: MarketData | MarketDataLoaded,
  rewards: RewardsState,
  totalBaseSupplyInDollars: bigint,
  totalBaseBorrowInDollars: bigint
): MarketRewardsAPRs => {
  if (market?.rewardsOverwrite) {
    const rewardState = rewards[1]
      ?.find(([id]) => +id === +market.chainInformation.chainId)?.[1]
      ?.rewardsStates.find(
        (state) => state.comet.toLowerCase() === market.marketAddress.toLowerCase()
      );

    const rewardsAssetPrice = rewardState?.rewardAsset.price ?? 0n;

    return {
      borrowRewardsAPR:
        market.rewardsOverwrite.borrowRewardsAPR ??
        getRewardsAPR(market.rewardsOverwrite.borrowCompPerDay, rewardsAssetPrice, totalBaseBorrowInDollars),
      supplyRewardsAPR:
        market.rewardsOverwrite.supplyRewardsAPR ??
        getRewardsAPR(market.rewardsOverwrite.supplyCompPerDay, rewardsAssetPrice, totalBaseSupplyInDollars),
      rewardsAssetSymbol: market.rewardsOverwrite.rewardsAssetSymbol,
    };
  }

  if (market?.institutional) {
    return {
      borrowRewardsAPR: 0n,
      supplyRewardsAPR: institutionalSupplyRewardRate(totalBaseSupplyInDollars),
      isInstitutional: true,
    };
  }

  return {
    borrowRewardsAPR: 0n,
    supplyRewardsAPR: 0n,
  };
};
