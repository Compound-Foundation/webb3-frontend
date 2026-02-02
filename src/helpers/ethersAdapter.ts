import { providers } from 'ethers';
import { useMemo } from 'react';
import type { Chain, Client, Transport } from 'viem';
import { Config, useClient } from 'wagmi';

// @dev ref: https://wagmi.sh/react/guides/ethers
export function clientToProvider(client: Client<Transport, Chain>) {
  const { chain, transport } = client;
  const network = {
    chainId: chain.id,
    name: chain.name,
    ensAddress: chain.contracts?.ensRegistry?.address,
  };
  return new providers.JsonRpcProvider(transport.url, network);
}

export function useEthersProvider({ chainId }: { chainId?: number | undefined } = {}) {
  const client = useClient<Config>({ chainId });
  return useMemo(() => (client ? clientToProvider(client) : undefined), [client]);
}
