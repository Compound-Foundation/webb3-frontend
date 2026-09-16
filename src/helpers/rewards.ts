import { AccountRewardsState, MarketDataState, RewardsState, RewardsTokenState, StateType } from '@types';

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
