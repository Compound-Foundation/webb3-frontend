import { StaticJsonRpcProvider } from '@ethersproject/providers';
import { ConnectionInfo } from 'ethers/lib/utils';
import { Provider } from 'ethers-multicall';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Web3 } from '@contexts/Web3Context';
import { getAssetDisplayName, getAssetDisplaySymbol } from '@helpers/assets';
import { getBaseAssetPriceFeed, getBaseAssetDollarPrice, adjustCollateralPrice } from '@helpers/baseAssetPrice';
import { getIsDeprecatedwUSDMMarket } from '@helpers/deprecatedMarkets';
import { REFRESH_INTERVAL, getCapacity, getCollateralValue, MAX_UINT256 } from '@helpers/numbers';
import CometQuery from '@helpers/sleuth/out/CometQuery.sol/CometQuery.json';
import { Sleuth } from '@helpers/sleuth/sleuth';
import { CometStateResponse, CometWithAccountStateQuery, CometWithAccountStateResponse } from '@helpers/sleuth/types';
import { getStETHAccountState, isStETH, isWrappedStETH } from '@helpers/steth';
import { useWaiter } from '@hooks/useWaiter';
import {
  CometState,
  CometStateHydrated,
  CometStateNoWallet,
  MarketData,
  MarketDataLoaded,
  MarketDataState,
  ProtocolAndAccountState,
  StateType,
  TokenWithAccountState,
  Transaction,
} from '@types';

import { getSleuthOptions, queryCometData, sanitizeCollateralAssetName } from './useSelectedMarket';

export function useCometState(web3: Web3, marketState: MarketDataState, transactions: Transaction[]): CometState {
  const [state, setState] = useState<CometState>([StateType.Loading, undefined]);
  const { waitFor } = useWaiter<Transaction[]>(transactions);
  const marketRef = useRef(marketState);

  // When network is changed, immediately set state to loading and update the chainIdRef
  useEffect(() => {
    const state: CometState = [StateType.Loading, undefined];
    setState(state);
    marketRef.current = marketState;
  }, [marketState[1]?.marketAddress, marketState[1]?.chainInformation.chainId]);

  const refreshData = useCallback(
    async (account?: string) => {
      const marketStateData = marketState[1];

      if (
        !!marketStateData &&
        web3.read.provider !== undefined &&
        web3.read.chainId === marketStateData?.chainInformation.chainId
      ) {
        let newState: CometState;
        if (account) {
          const cometResponse = await queryCometDataWithAccount(
            web3.read.provider.connection,
            marketStateData,
            account
          );
          newState = formatCometStateHydrated(cometResponse, marketStateData);
          const ethcallProvider = new Provider(web3.read.provider, marketStateData.chainInformation.chainId);
          await maybeHydrateStEthCollateral(newState, marketStateData, account, ethcallProvider);
        } else {
          const cometResponse = await queryCometData(web3.read.provider.connection, marketStateData);
          newState = formatCometStateNoWallet(cometResponse, marketStateData);
        }

        // Only update state if chainId has not changed since the start of this callback
        // We compare to a ref because the `marketState` in the callback can be stale
        if (marketState[1]?.marketAddress === marketRef.current[1]?.marketAddress) {
          waitFor(
            (transactions) => transactions.length === 0,
            async () => {
              setState(newState);
            },
            transactions
          );
        }
      }
    },
    [
      web3.read.chainId,
      web3.read.provider,
      marketState[1]?.marketAddress,
      marketState[1]?.chainInformation.chainId,
      transactions,
    ]
  );

  useEffect(() => {
    const intervalId = setInterval(() => refreshData(web3.read.account), REFRESH_INTERVAL);

    // This part is tricky. On the initial page load, if the user's account details has loaded, then we immediately
    // get the selected market data, cache the sleuth query w/ the account param, and let useCometState re-use
    // the account-specific sleuth query results.
    //
    // But otherwise if the user's account details has not loaded yet (which is almost always going to happen first
    // since loading web3 context is async), then wait a little bit of time (0.5 sec) for the web3 context to load in,
    // before deciding making the sleuth call, ideally with their account as a param.
    // 0.5 seconds is almost always enough (and helps provide the caching we're interested in), and if the web3 context
    // still hasn't loaded in, it's likely the user is simply not logged in.
    if (web3.read.account) {
      refreshData(web3.read.account);
    } else {
      const timeoutId = setTimeout(() => refreshData(web3.read.account), 500);
      // If the account does happen to load in, this effect's dependencies changes, and the timeout is invalidated,
      // which is good to prevent duplicate calls.
      return () => {
        clearInterval(intervalId);
        clearInterval(timeoutId);
      };
    }
    return () => clearInterval(intervalId);
  }, [web3.read.account, refreshData]);

  /**
   * This is a temporary fix for the USDT market.
   *
   * The code block below avoids the usage of the wUSDM collateral on the UI.
   *
   * TODO: Remove this once the collateral is fixed.
   */
  {
    const [, marketStateWithCollaterals] = state;

    if (marketStateWithCollaterals) {
      marketStateWithCollaterals.collateralAssets = marketStateWithCollaterals.collateralAssets.filter(
        ({ address }) => {
          return address.toLowerCase() !== '0x57f5e098cad7a3d1eed53991d4d66c45c9af7812';
        }
      );
    }
  }

  return state;
}

const QUERY_WITH_ACCOUNT = Sleuth.querySol(CometQuery, { queryFunctionName: 'queryWithAccount' });
export const queryCometDataWithAccount = (
  providerConnection: string | ConnectionInfo,
  market: MarketData | MarketDataLoaded,
  account: string
): Promise<CometWithAccountStateResponse> => {
  const provider = new StaticJsonRpcProvider(providerConnection);
  const sleuth = new Sleuth(provider, getSleuthOptions(market.chainInformation.chainId));

  const nativeTokenToUsdPriceFeed = getBaseAssetPriceFeed(market);

  const wrappedNativeTokenSymbol = `W${market.chainInformation.nativeToken.symbol}`;
  const checkDeprecatedwUSDM = getIsDeprecatedwUSDMMarket(market.baseAsset, market.chainInformation);
  return sleuth.fetch<CometWithAccountStateResponse, CometWithAccountStateQuery>(QUERY_WITH_ACCOUNT, [
    market.marketAddress,
    nativeTokenToUsdPriceFeed,
    account,
    market.bulkerAddress,
    wrappedNativeTokenSymbol,
    checkDeprecatedwUSDM,
  ]);
};

const formatCometStateHydrated = (
  cometResponse: CometWithAccountStateResponse,
  market: MarketData | MarketDataLoaded
): CometStateHydrated => {
  const wrappedNativeTokenSymbol = `W${market.chainInformation.nativeToken.symbol}`;

  const collateralAssets: TokenWithAccountState[] = cometResponse.collateralAssets.map((assetInfo) => {
    return {
      address: assetInfo.collateralAsset,
      allowance: assetInfo.symbol === wrappedNativeTokenSymbol ? MAX_UINT256 : assetInfo.allowance.toBigInt(),
      balance: assetInfo.balance.toBigInt(),
      bulkerAllowance:
        assetInfo.symbol === wrappedNativeTokenSymbol ? MAX_UINT256 : assetInfo.bulkerAllowance.toBigInt(),
      walletBalance: assetInfo.walletBalance.toBigInt(),
      priceFeed: assetInfo.priceFeed,
      symbol: getAssetDisplaySymbol(assetInfo.collateralAsset, assetInfo.symbol, market.chainInformation),
      decimals: assetInfo.decimals.toNumber(),
      name: getAssetDisplayName(
        assetInfo.collateralAsset,
        sanitizeCollateralAssetName(assetInfo.name),
        market.chainInformation
      ),
      collateralFactor: assetInfo.collateralFactor.toBigInt(),
      liquidateCollateralFactor: assetInfo.liquidateCollateralFactor.toBigInt(),
      liquidationFactor: assetInfo.liquidationFactor.toBigInt(),
      supplyCap: assetInfo.supplyCap.toBigInt(),
      totalSupply: assetInfo.totalSupply.toBigInt(),
      price: adjustCollateralPrice(
        cometResponse.baseAsset.symbol,
        cometResponse.baseAsset.price.toBigInt(),
        assetInfo.price.toBigInt()
      ),
    };
  });

  const baseAssetDollarPrice = getBaseAssetDollarPrice(cometResponse, market);

  const state: ProtocolAndAccountState = {
    borrowAPR: cometResponse.borrowAPR.toBigInt(),
    collateralAssets: collateralAssets,
    earnAPR: cometResponse.earnAPR.toBigInt(),
    baseAsset: {
      address: cometResponse.baseAsset.baseAsset,
      symbol: getAssetDisplaySymbol(
        cometResponse.baseAsset.baseAsset,
        cometResponse.baseAsset.symbol,
        market.chainInformation
      ),
      decimals: cometResponse.baseAsset.decimals.toNumber(),
      minBorrow: cometResponse.baseAsset.minBorrow.toBigInt(),
      name: getAssetDisplayName(
        cometResponse.baseAsset.baseAsset,
        cometResponse.baseAsset.name,
        market.chainInformation
      ),
      priceFeed: cometResponse.baseAsset.priceFeed,
      balanceOfComet: cometResponse.baseAsset.balanceOfComet.toBigInt(),
      price: cometResponse.baseAsset.price.toBigInt(),
      baseAssetPriceInDollars: baseAssetDollarPrice.toBigInt(),
      allowance:
        cometResponse.baseAsset.symbol === wrappedNativeTokenSymbol
          ? MAX_UINT256
          : cometResponse.baseAsset.allowance.toBigInt(),
      balance: cometResponse.baseAsset.balance.toBigInt(),
      borrowCapacity: getCapacity(
        'borrow',
        cometResponse.baseAsset.decimals.toNumber(),
        cometResponse.baseAsset.price.toBigInt(),
        cometResponse.baseAsset.symbol,
        collateralAssets
      ),
      bulkerAllowance:
        cometResponse.baseAsset.symbol === wrappedNativeTokenSymbol
          ? MAX_UINT256
          : cometResponse.baseAsset.bulkerAllowance.toBigInt(),
      walletBalance: cometResponse.baseAsset.walletBalance.toBigInt(),
    },
    collateralValue: getCollateralValue(collateralAssets),
    liquidationCapacity: getCapacity(
      'liquidation',
      cometResponse.baseAsset.decimals.toNumber(),
      cometResponse.baseAsset.price.toBigInt(),
      cometResponse.baseAsset.symbol,
      collateralAssets
    ),
    isBulkerAllowed: cometResponse.bulkerAllowance.gt(0),
  };

  return [StateType.Hydrated, state];
};

const maybeHydrateStEthCollateral = async (
  cometStateFormatted: CometStateHydrated,
  market: MarketData | MarketDataLoaded,
  account: string,
  provider: Provider
): Promise<void> => {
  const extraCollateralAssetsWithAccountState: TokenWithAccountState[] =
    market.chainInformation.unwrappedCollateralAssets !== undefined
      ? await Promise.all(
          cometStateFormatted[1].collateralAssets
            .filter((asset) => market.chainInformation.unwrappedCollateralAssets[asset.address] !== undefined)
            .map(async (asset) => {
              const unwrappedAsset = market.chainInformation.unwrappedCollateralAssets[asset.address];
              if (isWrappedStETH(asset.symbol) && isStETH(unwrappedAsset.symbol)) {
                //The initial values will be updated when we getStEthAccountState
                let tokenWithAccountState: TokenWithAccountState;
                tokenWithAccountState = {
                  ...asset,
                  allowance: asset.allowance,
                  balance: 0n,
                  bulkerAllowance: 0n,
                  walletBalance: 0n,
                };

                tokenWithAccountState = await getStETHAccountState(
                  account,
                  tokenWithAccountState,
                  unwrappedAsset,
                  market.bulkerAddress,
                  provider
                );
                return tokenWithAccountState;
              } else {
                console.error('Unknown handling for extra collateral asset: ', unwrappedAsset);
                return Promise.reject();
              }
            })
        )
      : ([] as TokenWithAccountState[]);
  cometStateFormatted[1].collateralAssets = cometStateFormatted[1].collateralAssets.concat(
    extraCollateralAssetsWithAccountState
  );
};

const formatCometStateNoWallet = (
  cometResponse: CometStateResponse,
  market: MarketData | MarketDataLoaded
): CometStateNoWallet => {
  const baseAssetDollarPrice = getBaseAssetDollarPrice(cometResponse, market);
  const state = {
    borrowAPR: cometResponse.borrowAPR.toBigInt(),
    collateralAssets: cometResponse.collateralAssets.map((assetInfo) => ({
      address: assetInfo.collateralAsset,
      priceFeed: assetInfo.priceFeed,
      symbol: getAssetDisplaySymbol(assetInfo.collateralAsset, assetInfo.symbol, market.chainInformation),
      decimals: assetInfo.decimals.toNumber(),
      name: getAssetDisplayName(
        assetInfo.collateralAsset,
        sanitizeCollateralAssetName(assetInfo.name),
        market.chainInformation
      ),
      collateralFactor: assetInfo.collateralFactor.toBigInt(),
      liquidateCollateralFactor: assetInfo.liquidateCollateralFactor.toBigInt(),
      liquidationFactor: assetInfo.liquidationFactor.toBigInt(),
      supplyCap: assetInfo.supplyCap.toBigInt(),
      totalSupply: assetInfo.totalSupply.toBigInt(),
      price: adjustCollateralPrice(
        cometResponse.baseAsset.symbol,
        cometResponse.baseAsset.price.toBigInt(),
        assetInfo.price.toBigInt()
      ),
    })),
    earnAPR: cometResponse.earnAPR.toBigInt(),
    baseAsset: {
      address: cometResponse.baseAsset.baseAsset,
      symbol: getAssetDisplaySymbol(
        cometResponse.baseAsset.baseAsset,
        cometResponse.baseAsset.symbol,
        market.chainInformation
      ),
      decimals: cometResponse.baseAsset.decimals.toNumber(),
      minBorrow: cometResponse.baseAsset.minBorrow.toBigInt(),
      name: getAssetDisplayName(
        cometResponse.baseAsset.baseAsset,
        cometResponse.baseAsset.name,
        market.chainInformation
      ),
      priceFeed: cometResponse.baseAsset.priceFeed,
      balanceOfComet: cometResponse.baseAsset.balanceOfComet.toBigInt(),
      price: cometResponse.baseAsset.price.toBigInt(),
      baseAssetPriceInDollars: baseAssetDollarPrice.toBigInt(),
    },
  };

  return [StateType.NoWallet, state];
};
