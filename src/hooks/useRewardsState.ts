import { getAddress } from 'ethers/lib/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Web3 } from '@contexts/Web3Context';
import { convertApiResponse } from '@helpers/functions';
import { getMarketsByNetwork } from '@helpers/markets';
import { PRICE_PRECISION, REWARDS_API_REFRESH_INTERVAL } from '@helpers/numbers';
import { getAccountRewardsStateEndpoint, getMarketRewardsStateEndpoint } from '@helpers/urls';
import { useMarkets } from '@hooks/useMarkets';
import {
  AccountRewardsState,
  MarketsByNetwork,
  MarketData,
  RewardsState,
  RewardsTokenState,
  StateType,
  ChainInformation,
  Transaction,
} from '@types';

type RewardsStateResponse = {
  chainId: number;
  baseAsset: {
    address: string;
    decimals: number;
    minBorrow: string;
    description: string;
    priceFeed: string;
    symbol: string;
  };
  comet: {
    address: string;
  };
  cometRewards: {
    address: string;
  };
  rewardAsset: { address: string; decimals: number; description: string; price: string; symbol: string };
};

type RewardsWithAccountStateResponse = RewardsStateResponse & {
  amountOwed: string;
  borrowBalance: string;
  supplyBalance: string;
  walletBalance: string;
};

type MarketsWithPriceFeeds = [
  string, // chainId
  {
    chainInformation: ChainInformation;
    markets: MarketData[];
  }
][];

function areRewardsSupported(chainInformation: ChainInformation) {
  return chainInformation.extraPriceFeeds.rewards && Object.keys(chainInformation.extraPriceFeeds.rewards).length > 0;
}

export function useRewardsState(web3: Web3, transactions: Transaction[]): RewardsState {
  const [state, setState] = useState<RewardsState>([StateType.Loading]);
  const maybeAccount = web3.write.account;
  const accountRef = useRef(maybeAccount);
  const [marketsStateType, marketsState] = useMarkets();
  const marketsLoading = marketsStateType === StateType.Loading;
  // Undefined until the market list loads; the hydrated list keeps its reference between renders
  const markets = marketsStateType === StateType.Hydrated ? marketsState.markets : undefined;

  const marketsByNetwork = useMemo(() => getMarketsByNetwork(markets ?? []), [markets]);

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    accountRef.current = maybeAccount;

    // @dev we delay the initial refresh so to wait for connected wallet to be ready
    // otherwise refreshData() is triggered twice on a connected wallet, once with an undefined account
    const timeoutId = setTimeout(() => {
      refreshData();
    }, 1000);

    return () => clearTimeout(timeoutId);
    // re-trigger when maybeAccount changes -- so during wallet disconnect/connect we refresh the rewards
    // and once the market list has loaded
  }, [maybeAccount, marketsLoading]);

  const refreshData = useCallback(async () => {
    // Rewards are grouped by the networks of the markets, so wait for the market list
    if (marketsLoading) {
      return;
    }

    const currentAccount = accountRef.current;
    if (currentAccount === undefined && stateRef.current[0] === StateType.NoWallet) {
      // If the user has no wallet connect and we already loaded the market state then
      // we should not be doing a refresh since nothing should change.
      return;
    }

    try {
      const updatedState: RewardsState = await getState(marketsByNetwork, currentAccount);
      if (currentAccount === accountRef.current) {
        setState(updatedState);
      }
    } catch (error) {
      console.error('[useRewardsState] Failed to refresh rewards state:', error);

      if (currentAccount === accountRef.current) {
        setState((prevState) =>
          prevState[0] === StateType.Loading
            ? [currentAccount === undefined ? StateType.NoWallet : StateType.Hydrated, []]
            : prevState
        );
      }
    }
  }, [marketsByNetwork, marketsLoading]);

  useEffect(() => {
    const intervalId = setInterval(refreshData, REWARDS_API_REFRESH_INTERVAL);

    return () => clearInterval(intervalId);
  }, [refreshData]);

  useEffect(() => {
    // Trigger an auto refresh only when pending transactions goes back to 0
    // If there are multiple pending, we are probably fine to wait until the
    // last transaction finishes
    if (stateRef.current[0] !== StateType.Loading && transactions.length === 0) {
      refreshData();
    }
  }, [transactions]);

  return state;
}

const getState = async (marketsByNetwork: MarketsByNetwork, maybeAccount?: string): Promise<RewardsState> => {
  const marketsWithPriceFeeds: MarketsWithPriceFeeds = Object.entries(marketsByNetwork).filter(
    ([, { chainInformation }]) => {
      return areRewardsSupported(chainInformation);
    }
  );

  if (maybeAccount === undefined) {
    const rewardsStateResponse = await fetch(getMarketRewardsStateEndpoint());
    const rewardsState = await rewardsStateResponse.json();

    const sanitizedRewardState: RewardsTokenState[] = rewardsState.map(convertApiResponse).map(sanitizeRewardState);
    const responses = getRewardStatesPerChain(sanitizedRewardState, marketsWithPriceFeeds);

    return [StateType.NoWallet, responses];
  } else {
    const rewardStateResponse = await fetch(getAccountRewardsStateEndpoint(maybeAccount));
    const rewardState = await rewardStateResponse.json();
    const sanitizedRewardState: AccountRewardsState[] = rewardState
      .map(convertApiResponse)
      .map(sanitizeRewardWithAccountState);

    const responses = getRewardStatesPerChain(sanitizedRewardState, marketsWithPriceFeeds);
    return [StateType.Hydrated, responses];
  }
};

/**
 * Convert responses from the API into a format that is easier to work with
 * on the rest of the frontend
 * 1. Convert the formatted string amounts to BigInts
 * 2. Convert the non-checksummed addresses to checksummed addresses
 * @param rewardState
 * @returns
 */
function sanitizeRewardState(rewardState: RewardsStateResponse) {
  // Floor to be safe. The API may return more decimal places than we need
  const minBorrow = BigInt(Math.floor(Number(rewardState.baseAsset.minBorrow) * 10 ** rewardState.baseAsset.decimals));
  const rewardAssetPrice = BigInt(Math.floor(Number(rewardState.rewardAsset.price) * 10 ** PRICE_PRECISION));

  return {
    baseAsset: {
      address: getAddress(rewardState.baseAsset.address),
      decimals: rewardState.baseAsset.decimals,
      minBorrow: minBorrow,
      name: rewardState.baseAsset.description,
      priceFeed: getAddress(rewardState.baseAsset.priceFeed),
      symbol: rewardState.baseAsset.symbol,
    },
    chainId: rewardState.chainId,
    comet: getAddress(rewardState.comet.address),
    cometRewards: getAddress(rewardState.cometRewards.address),
    rewardAsset: {
      address: getAddress(rewardState.rewardAsset.address),
      decimals: rewardState.rewardAsset.decimals,
      name: rewardState.rewardAsset.description,
      price: rewardAssetPrice,
      symbol: rewardState.rewardAsset.symbol,
    },
  };
}

function sanitizeRewardWithAccountState(rewardState: RewardsWithAccountStateResponse) {
  const amountOwed = BigInt(Math.floor(Number(rewardState.amountOwed) * 10 ** rewardState.rewardAsset.decimals));
  const borrowBalance = BigInt(Math.floor(Number(rewardState.borrowBalance) * 10 ** rewardState.baseAsset.decimals));
  const supplyBalance = BigInt(Math.floor(Number(rewardState.supplyBalance) * 10 ** rewardState.baseAsset.decimals));
  const walletBalance = BigInt(Math.floor(Number(rewardState.walletBalance) * 10 ** rewardState.rewardAsset.decimals));

  return {
    ...sanitizeRewardState(rewardState),
    amountOwed: amountOwed,
    borrowBalance: borrowBalance,
    supplyBalance: supplyBalance,
    walletBalance: walletBalance,
  };
}

/**
 * Converts the array of reward states into an array containing chainId and chain information as well
 * @param rewardStates: Reward states from the API. Could be either AccountRewardsState or RewardsTokenState
 * @param marketsWithPriceFeeds: Markets with price feeds
 * @returns
 */
function getRewardStatesPerChain<T extends { chainId: number }>(
  rewardStates: T[],
  marketsWithPriceFeeds: MarketsWithPriceFeeds
): [string, { chainInformation: ChainInformation; rewardsStates: T[] }][] {
  return marketsWithPriceFeeds.map(([chainId, { chainInformation }]) => {
    const rewardsStates = rewardStates.filter((rewardState) => {
      return rewardState.chainId === Number(chainId);
    });

    return [
      chainId,
      {
        chainInformation,
        rewardsStates,
      },
    ];
  });
}
