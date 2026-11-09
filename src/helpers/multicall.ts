import type { JsonRpcProvider } from '@ethersproject/providers';
import { createPublicClient, http } from 'viem';

// Multicall3's deterministic address, deployed on every chain in CHAINS
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** A viem client that reads from the same RPC endpoint as `provider`. */
export function readClient(provider: JsonRpcProvider) {
  return createPublicClient({ transport: http(provider.connection.url) });
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
