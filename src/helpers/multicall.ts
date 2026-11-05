import { Interface, Result } from '@ethersproject/abi';
import type { Provider } from '@ethersproject/providers';

// Multicall3's deterministic address, deployed on every chain in CHAINS
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3 = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
]);

export type ContractCall = { address: string; abi: Interface; name: string; params: unknown[] };

export type CallResult = { success: true; value: any } | { success: false; error: unknown };

export type MulticallReader = (calls: ContractCall[]) => Promise<CallResult[]>;

export function contractCall(address: string, abi: Interface, name: string, ...params: unknown[]): ContractCall {
  return { address, abi, name, params };
}

function decode({ abi, name }: ContractCall, returnData: string): unknown {
  const result: Result = abi.decodeFunctionResult(name, returnData);
  return result.length === 1 ? result[0] : result;
}

/**
 * Reads `calls` in one eth_call. A reverting or undecodable call fails on its own and is logged,
 * the rest of the batch still answers. Results are in the order of `calls`.
 */
export async function multicall(provider: Provider, calls: ContractCall[]): Promise<CallResult[]> {
  if (calls.length === 0) return [];

  const data = MULTICALL3.encodeFunctionData('aggregate3', [
    calls.map((call) => ({
      target: call.address,
      allowFailure: true,
      callData: call.abi.encodeFunctionData(call.name, call.params),
    })),
  ]);
  const [responses] = MULTICALL3.decodeFunctionResult(
    'aggregate3',
    await provider.call({ to: MULTICALL3_ADDRESS, data })
  ) as unknown as [{ success: boolean; returnData: string }[]];

  return calls.map((call, index): CallResult => {
    const { success, returnData } = responses[index];
    try {
      if (!success) throw new Error(`reverted with ${returnData}`);
      return { success: true, value: decode(call, returnData) };
    } catch (error) {
      console.error(`Multicall: ${call.name} on ${call.address} failed`, error);
      return { success: false, error };
    }
  });
}

/** The values of `results`, or an error naming `what` when any call failed. */
export function requireValues(results: CallResult[], what: string): any[] {
  return results.map((result) => {
    if (!result.success) throw new Error(`Could not read the ${what}`, { cause: result.error });
    return result.value;
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
