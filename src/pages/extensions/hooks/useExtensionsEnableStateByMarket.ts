import { JsonRpcProvider, StaticJsonRpcProvider } from '@ethersproject/providers';
import { BigNumber } from 'ethers';
import { Contract, Provider } from 'ethers-multicall';
import { useEffect, useState } from 'react';

import type { Web3 } from '@contexts/Web3Context';
import Comet from '@helpers/abis/Comet';
import { isV2Market } from '@helpers/markets';
import { MarketData, MarketDataLoaded, MarketDataState, StateType, ExtensionsEnableState } from '@types';

import { Extension } from '../helpers/core';
import { allExtensions, getOperator } from '../helpers/list';

// Get the extensions supported for this particular market, which can be either be
// explicitly enabled (if there's an operator contract), or not enabled, for
// a particular account address.
export function useExtensionsEnableStateByMarket(web3: Web3, selectedMarket: MarketDataState): ExtensionsEnableState {
  const [state, setState] = useState<ExtensionsEnableState>([StateType.Loading]);
  // The account's address to look up their enabled extensions.
  const maybeAccountAddress = web3.read.account;
  const web3Provider = web3.read.provider;
  // Look up extensions for this particular market (and network).
  const marketData = selectedMarket[1];

  useEffect(() => {
    // Can't look up extensions without info around the market.
    if (!web3Provider || !marketData) {
      return;
    }

    // Get the extensions that are supported on this particular market (and chain).
    // TODO(kevin): For now, just show all the extensions irrespective of market.
    const supportedExtensions = allExtensions;
    // const supportedExtensions = allExtensions.filter((ext) =>
    //   typeof ext.supportedMarkets === 'string' ?
    //     ext.supportedMarkets === AllMarkets
    //     : marketKey(marketData) in ext.supportedMarkets);

    if (!maybeAccountAddress || isV2Market(marketData)) {
      // If the account has not connected their wallet yet, show all supported extensions as not enabled.
      setState([StateType.Hydrated, { enabled: [], notEnabled: supportedExtensions.map((ext) => ext.id) }]);
    } else {
      // Look up which supported extensions are enabled for this account.
      getState(web3Provider, marketData, supportedExtensions, maybeAccountAddress).then(setState);
    }
  }, [marketData, maybeAccountAddress]);

  return state;
}

async function getState(
  rawProvider: JsonRpcProvider,
  marketData: MarketData | MarketDataLoaded,
  extensions: Extension[],
  accountAddress: string
): Promise<ExtensionsEnableState> {
  const provider = new StaticJsonRpcProvider(rawProvider.connection);
  const chainId = marketData?.chainInformation.chainId;
  const ethcallProvider = new Provider(provider, chainId);

  // Contract address for the V3 market.
  const cometAddress = marketData?.marketAddress;
  const cometContract = new Contract(cometAddress, Comet);

  // For each extension, hydrate their operator (contract) addresses.
  const extensionswithMaybeOperator = extensions.map((ext) => ({
    ...ext,
    operatorAddress: getOperator(ext, marketData),
  }));

  // Get all extensions with operator contracts (only those can be enabled).
  const extensionsWithOperators = extensionswithMaybeOperator.filter((ext) => !!ext.operatorAddress);
  // Look up on comet market contract, whether the operator is allowed to perform extension
  // actions on behalf of the account.
  const extensionsEnableStatusCall = extensionsWithOperators.map((ext) =>
    cometContract.allowance(accountAddress, ext.operatorAddress)
  );
  const extensionsEnableStatus = await ethcallProvider.all<BigNumber[]>(extensionsEnableStatusCall);

  const enabledExtensionsIds = extensionsWithOperators
    .filter((_, idx) => extensionsEnableStatus[idx].gt(0))
    .map((ext) => ext.id);
  // Any supported extensions that are not enabled are considered disabled.
  const notEnabledExtensionsIds = extensionswithMaybeOperator
    .filter((ext) => !enabledExtensionsIds.includes(ext.id))
    .map((ext) => ext.id);

  return [
    StateType.Hydrated,
    {
      enabled: enabledExtensionsIds,
      notEnabled: notEnabledExtensionsIds,
    },
  ];
}
