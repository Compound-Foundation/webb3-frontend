import { JsonRpcProvider, StaticJsonRpcProvider } from '@ethersproject/providers';
import { useEffect, useState } from 'react';

import type { Web3 } from '@contexts/Web3Context';
import { isV2Market } from '@helpers/markets';
import CometQuery from '@helpers/sleuth/out/CometQuery.sol/CometQuery.json';
import { Sleuth } from '@helpers/sleuth/sleuth';
import { OperatorAllowancesQuery, OperatorAllowancesResponse } from '@helpers/sleuth/types';
import { getSleuthOptions } from '@hooks/useSelectedMarket';
import { MarketData, MarketDataLoaded, MarketDataState, StateType, ExtensionsEnableState } from '@types';

import { Extension } from '../helpers/core';
import { allExtensions, getOperator } from '../helpers/list';

const QUERY_OPERATOR_ALLOWANCES = Sleuth.querySol(CometQuery, { queryFunctionName: 'queryOperatorAllowances' });

// Comet allowance of each operator for the account: an extension is enabled when its operator's is above zero
export function queryOperatorAllowances(
  rawProvider: JsonRpcProvider,
  marketData: MarketData | MarketDataLoaded,
  accountAddress: string,
  operators: string[]
): Promise<OperatorAllowancesResponse> {
  const sleuth = new Sleuth(
    new StaticJsonRpcProvider(rawProvider.connection),
    getSleuthOptions(marketData.chainInformation.chainId)
  );
  return sleuth.fetch<OperatorAllowancesResponse, OperatorAllowancesQuery>(QUERY_OPERATOR_ALLOWANCES, [
    marketData.marketAddress,
    accountAddress,
    operators,
  ]);
}

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
  // For each extension, hydrate their operator (contract) addresses.
  const extensionswithMaybeOperator = extensions.map((ext) => ({
    ...ext,
    operatorAddress: getOperator(ext, marketData),
  }));

  // Get all extensions with operator contracts (only those can be enabled).
  const extensionsWithOperators = extensionswithMaybeOperator.filter((ext) => !!ext.operatorAddress);
  // Look up on comet market contract, whether the operator is allowed to perform extension
  // actions on behalf of the account.
  const extensionsEnableStatus = await queryOperatorAllowances(
    rawProvider,
    marketData,
    accountAddress,
    extensionsWithOperators.map((ext) => ext.operatorAddress as string)
  );

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
