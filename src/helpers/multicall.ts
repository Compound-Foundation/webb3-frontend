import type { JsonRpcProvider } from '@ethersproject/providers';
import { createPublicClient, defineChain, http } from 'viem';

import { ChainInformation } from '@types';

// Multicall3's deterministic address, deployed on every chain in CHAINS
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

/**
 * A viem client that reads from the same RPC endpoint as `provider`. Contract reads started in the
 * same tick go out together as one Multicall3 call.
 */
export function readClient(provider: JsonRpcProvider, chain: ChainInformation) {
  return createPublicClient({
    // viem batches reads only when the chain names its Multicall3 address; otherwise each read is its own eth_call
    chain: defineChain({
      id: chain.chainId,
      name: chain.name,
      nativeCurrency: chain.nativeToken,
      rpcUrls: { default: { http: [provider.connection.url] } },
      contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
    }),
    transport: http(provider.connection.url),
    batch: { multicall: true },
  });
}

/**
 * The Sleuth query, or `fallback` when it fails: a chain without the Sleuth contract, or a market
 * that reverts one of the query's reads.
 */
export async function sleuthWithFallback<T>(
  label: string,
  query: () => Promise<T>,
  fallback: () => Promise<T>
): Promise<T> {
  try {
    return await query();
  } catch (error) {
    console.warn(`${label}: the Sleuth query failed, reading through the fallback`, error);
    return fallback();
  }
}
