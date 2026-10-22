import { Interface } from '@ethersproject/abi';
import { JsonRpcProvider, Web3Provider } from '@ethersproject/providers';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { useAccount, useConnectorClient } from 'wagmi';

import { WRAPPED_MARKET_REGISTRY, WrappedMarket, WrappedMarketRegistry } from '@constants/wrappedMarkets';
import { useWeb3Context } from '@contexts/Web3Context';
import CometAbi from '@helpers/abis/Comet';
import ERC20Abi from '@helpers/abis/ERC20';
import WrappedCometAbi from '@helpers/abis/WrappedCometERC4626';
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
const cometInterface = new Interface(CometAbi);
const erc20Interface = new Interface(ERC20Abi);

async function readAddress(provider: ValidationProvider, iface: Interface, to: string, name: string) {
  const [value] = iface.decodeFunctionResult(name, await provider.call({ to, data: iface.encodeFunctionData(name) }));
  return String(value);
}

async function readDecimals(provider: ValidationProvider, iface: Interface, to: string) {
  const [value] = iface.decodeFunctionResult(
    'decimals',
    await provider.call({ to, data: iface.encodeFunctionData('decimals') }),
  );
  return Number(value);
}

/**
 * Check a mapping against the configured chain: the wrapper must hold the selected Comet as
 * its `asset()`, and the Comet's base token and every decimals figure must match the registry.
 * Any failed or malformed read fails the check.
 */
export async function validateWrappedMarket(
  provider: ValidationProvider,
  market: WrappedMarket,
): Promise<Exclude<ValidationStatus, 'pending'>> {
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== market.chainId) return 'failed';

    const [asset, shareDecimals, baseToken, baseDecimals] = await Promise.all([
      readAddress(provider, wrapperInterface, market.wrapperAddress, 'asset'),
      readDecimals(provider, wrapperInterface, market.wrapperAddress),
      readAddress(provider, cometInterface, market.cometAddress, 'baseToken'),
      readDecimals(provider, erc20Interface, market.baseTokenAddress),
    ]);
    if (asset.toLowerCase() !== market.cometAddress.toLowerCase()) return 'asset-mismatch';
    if (
      baseToken.toLowerCase() !== market.baseTokenAddress.toLowerCase() ||
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

/**
 * The lending route for `market` in the current session: standard, or wrapped with deposit,
 * exit and read eligibility. Wrapped eligibility waits for an on-chain check of the wrapper,
 * made through the configured chain's public provider rather than the wallet, and a result
 * applies only to the route and session it was read for.
 */
export function useLendingRoute(
  market: MarketData | MarketDataLoaded | undefined,
  registry: WrappedMarketRegistry = WRAPPED_MARKET_REGISTRY,
): LendingRoute {
  const web3 = useWeb3Context();
  const { status } = useAccount();
  const { data: connectorClient, isError: connectorClientFailed } = useConnectorClient();
  const location = useLocation();
  const conflictedRdns = useConflictedRdns();

  const { account, chainId, connector, provider } = web3.write;
  // Web3Context's rule for watch-only mode: the parameter's presence, whatever its value.
  const isWatchOnly = new URLSearchParams(location.search).has('account');
  // The wallet-backed provider, and a connector client that has caught up with this account
  // and chain. A failed refresh can leave the previous provider in place.
  const signerReady =
    provider instanceof Web3Provider &&
    !connectorClientFailed &&
    connectorClient !== undefined &&
    account !== undefined &&
    connectorClient.account?.address.toLowerCase() === account.toLowerCase() &&
    connectorClient.chain?.id === chainId;

  const session: LendingSession = {
    connector: connector === undefined ? undefined : { id: connector.id, uid: connector.uid, rdns: connector.rdns },
    status,
    account,
    chainId,
    isWatchOnly,
    signerReady,
    screeningStatus: web3.screeningStatus,
  };
  const identity =
    market === undefined ? undefined : { chainId: market.chainInformation.chainId, cometAddress: market.marketAddress };

  const lookup = identity === undefined ? undefined : registry.lookup(identity.chainId, identity.cometAddress);
  const wrappedMarket = lookup?.status === 'valid' ? lookup.market : undefined;
  const chainProvider = useEthersProvider({ chainId: wrappedMarket?.chainId });

  const [validation, setValidation] = useState<WrapperValidation | undefined>(undefined);
  const requestId = useRef(0);
  const route = resolveLendingRoute({ market: identity, session, conflictedRdns, validation, registry });
  const validationKey = route.kind === 'wrapped' ? route.validationKey : undefined;

  useEffect(() => {
    const id = ++requestId.current;
    // A result for an earlier key is already ignored by the resolver; dropping it keeps a
    // return to that key from reusing it.
    setValidation(undefined);
    if (validationKey === undefined || wrappedMarket === undefined) return;
    if (chainProvider === undefined) {
      setValidation({ key: validationKey, status: 'failed' });
      return;
    }
    validateWrappedMarket(chainProvider, wrappedMarket).then((status) => {
      if (id === requestId.current) setValidation({ key: validationKey, status });
    });
    return () => {
      requestId.current++;
    };
  }, [validationKey, wrappedMarket, chainProvider]);

  return route;
}
