import { Interface } from '@ethersproject/abi';
import { JsonRpcProvider, Web3Provider } from '@ethersproject/providers';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { useAccount, useConnectorClient } from 'wagmi';

import {
  WRAPPED_MARKET_REGISTRY,
  WRAPPER_FACTORY_BY_CHAIN_ID,
  WrappedMarket,
  WrappedMarketRegistry,
} from '@constants/wrappedMarkets';
import { useWeb3Context } from '@contexts/Web3Context';
import CometAbi from '@helpers/abis/Comet';
import ERC20Abi from '@helpers/abis/ERC20';
import WrappedCometAbi from '@helpers/abis/WrappedCometERC4626';
import WrappedCometFactoryAbi from '@helpers/abis/WrappedCometERC4626Factory';
import { useConflictedRdns } from '@helpers/eip6963Security';
import { useEthersProvider } from '@helpers/ethersAdapter';
import {
  LendingRoute,
  LendingSession,
  resolveLendingRoute,
  ValidationStatus,
  WrapperValidation,
} from '@helpers/lendingRoute';
import { MarketData, MarketDataLoaded } from '@types';

export type ValidationProvider = Pick<JsonRpcProvider, 'call' | 'getNetwork'>;

const wrapperInterface = new Interface(WrappedCometAbi);
const factoryInterface = new Interface(WrappedCometFactoryAbi);
const cometInterface = new Interface(CometAbi);
const erc20Interface = new Interface(ERC20Abi);

async function readAddress(
  provider: ValidationProvider,
  contractInterface: Interface,
  to: string,
  name: string,
  args: unknown[] = [],
) {
  const data = contractInterface.encodeFunctionData(name, args);
  const [value] = contractInterface.decodeFunctionResult(name, await provider.call({ to, data }));
  return String(value).toLowerCase();
}

async function readDecimals(provider: ValidationProvider, contractInterface: Interface, to: string) {
  const data = contractInterface.encodeFunctionData('decimals');
  const [value] = contractInterface.decodeFunctionResult('decimals', await provider.call({ to, data }));
  return Number(value);
}

/**
 * Checks a mapping against the configured chain. The factory kept in code must name the
 * wrapper as the market's canonical one, the wrapper must hold the selected Comet as its
 * `asset()`, and the Comet's base token and both decimals figures must match the mapping. Any
 * failed or malformed read fails the check.
 */
export async function validateWrappedMarket(
  provider: ValidationProvider,
  market: WrappedMarket,
): Promise<Exclude<ValidationStatus, 'pending'>> {
  const factoryAddress = WRAPPER_FACTORY_BY_CHAIN_ID[market.chainId];
  if (factoryAddress === undefined) return 'failed';
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== market.chainId) return 'failed';

    const [canonicalWrapper, asset, shareDecimals, baseToken, baseDecimals] = await Promise.all([
      readAddress(provider, factoryInterface, factoryAddress, 'getWrapper', [market.cometAddress]),
      readAddress(provider, wrapperInterface, market.wrapperAddress, 'asset'),
      readDecimals(provider, wrapperInterface, market.wrapperAddress),
      readAddress(provider, cometInterface, market.cometAddress, 'baseToken'),
      readDecimals(provider, erc20Interface, market.baseTokenAddress),
    ]);
    if (canonicalWrapper !== market.wrapperAddress.toLowerCase()) return 'not-canonical';
    if (asset !== market.cometAddress.toLowerCase()) return 'asset-mismatch';
    if (
      baseToken !== market.baseTokenAddress.toLowerCase() ||
      shareDecimals !== market.shareDecimals ||
      baseDecimals !== market.baseDecimals
    ) {
      return 'metadata-mismatch';
    }
    return 'matched';
  } catch (error) {
    console.error('Wrapped market validation failed (fail-closed):', error);
    return 'failed';
  }
}

/** A validation result, with the provider it was read through. */
type RecordedValidation = WrapperValidation & { provider: ValidationProvider | undefined };

/**
 * Returns the lending route for `market` in the current session: standard, or wrapped with
 * deposit, exit and read eligibility. Wrapped eligibility waits for an on-chain check of the
 * wrapper. The check reads through the configured chain's public provider, not the wallet.
 * A result applies only to the route, session and provider it was read for.
 */
export function useLendingRoute(
  market: MarketData | MarketDataLoaded | undefined,
  registry: WrappedMarketRegistry = WRAPPED_MARKET_REGISTRY,
): LendingRoute {
  const web3 = useWeb3Context();
  const { status } = useAccount();
  const { data: connectorClient, isError: isConnectorClientError } = useConnectorClient();
  const location = useLocation();
  const conflictedRdns = useConflictedRdns();

  const { account, chainId, connector, provider } = web3.write;
  // Web3Context's rule for watch-only mode: the parameter's presence, whatever its value.
  const isWatchOnly = new URLSearchParams(location.search).has('account');
  // Web3Context builds its wallet provider from the connector client's transport in an
  // effect, so the provider can belong to an earlier client. The check requires the provider
  // built from the current client, and that client to be on this account and chain.
  const isSignerReady =
    provider instanceof Web3Provider &&
    !isConnectorClientError &&
    connectorClient !== undefined &&
    (provider.provider as unknown) === (connectorClient.transport as unknown) &&
    account !== undefined &&
    connectorClient.account?.address.toLowerCase() === account.toLowerCase() &&
    connectorClient.chain?.id === chainId;

  const session: LendingSession = {
    connector: connector === undefined ? undefined : { id: connector.id, uid: connector.uid, rdns: connector.rdns },
    status,
    account,
    chainId,
    isWatchOnly,
    isSignerReady,
    screeningStatus: web3.screeningStatus,
  };
  const identity =
    market === undefined ? undefined : { chainId: market.chainInformation.chainId, cometAddress: market.marketAddress };

  const lookup = identity === undefined ? undefined : registry.lookup(identity.chainId, identity.cometAddress);
  const wrappedMarket = lookup?.status === 'valid' ? lookup.market : undefined;
  const chainProvider = useEthersProvider({ chainId: wrappedMarket?.chainId });

  const [validation, setValidation] = useState<RecordedValidation | undefined>(undefined);
  const requestId = useRef(0);
  // The key covers every field of the mapping, so the mapping the effect reads for a key is the
  // one the key was made from.
  const wrappedMarketRef = useRef(wrappedMarket);
  wrappedMarketRef.current = wrappedMarket;

  // A result read through another provider does not apply, whatever its key.
  const currentValidation = validation?.provider === chainProvider ? validation : undefined;
  const route = resolveLendingRoute({
    market: identity,
    session,
    conflictedRdns,
    validation: currentValidation,
    registry,
  });
  const validationKey = route.kind === 'wrapped' ? route.validationKey : undefined;

  useEffect(() => {
    const id = ++requestId.current;
    // The resolver already ignores a result for another key. Clearing it here also stops a
    // later return to that key from reusing it.
    setValidation(undefined);
    const marketToValidate = wrappedMarketRef.current;
    if (validationKey === undefined || marketToValidate === undefined) return;
    if (chainProvider === undefined) {
      setValidation({ key: validationKey, status: 'failed', provider: chainProvider });
      return;
    }
    validateWrappedMarket(chainProvider, marketToValidate).then((validationStatus) => {
      if (id === requestId.current) {
        setValidation({ key: validationKey, status: validationStatus, provider: chainProvider });
      }
    });
    return () => {
      requestId.current++;
    };
  }, [validationKey, chainProvider]);

  return route;
}
