import { Interface } from '@ethersproject/abi';
import type { Provider } from '@ethersproject/providers';
import { BigNumber } from 'ethers';

import ERC20 from '@helpers/abis/ERC20';
import { contractCall, multicall, requireValues, sleuthWithFallback } from '@helpers/multicall';

const MULTICALL3 = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
]);
const ERC20_ABI = new Interface(ERC20);
const TOKEN = '0x00000000000000000000000000000000000000a1';
const ACCOUNT = '0x00000000000000000000000000000000000000b1';

const providerAnswering = (responses: { success: boolean; returnData: string }[]) => {
  const call = jest.fn<Promise<string>, [{ data: string }]>(async () =>
    MULTICALL3.encodeFunctionResult('aggregate3', [responses])
  );
  return { provider: { call } as unknown as Provider, call };
};

describe('multicall', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));

  test('reads the batch in one call and lets each call fail on its own', async () => {
    const { provider, call } = providerAnswering([
      { success: true, returnData: ERC20_ABI.encodeFunctionResult('balanceOf', [42]) },
      { success: false, returnData: '0x' },
      { success: true, returnData: '0x1234' },
    ]);

    const results = await multicall(provider, [
      contractCall(TOKEN, ERC20_ABI, 'balanceOf', ACCOUNT),
      contractCall(TOKEN, ERC20_ABI, 'allowance', ACCOUNT, ACCOUNT),
      contractCall(TOKEN, ERC20_ABI, 'decimals'),
    ]);

    expect(call).toHaveBeenCalledTimes(1);
    const [[{ allowFailure }]] = MULTICALL3.decodeFunctionData('aggregate3', call.mock.calls[0][0].data);
    expect(allowFailure).toBe(true);
    expect(results[0]).toEqual({ success: true, value: BigNumber.from(42) });
    // a revert and an answer that does not decode both fail only their own call
    expect(results[1].success).toBe(false);
    expect(results[2].success).toBe(false);
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  test('makes no request for an empty batch', async () => {
    const { provider, call } = providerAnswering([]);
    expect(await multicall(provider, [])).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });
});

describe('requireValues', () => {
  test('throws naming what could not be read when any call failed', () => {
    expect(requireValues([{ success: true, value: 1 }], 'reserves')).toEqual([1]);
    expect(() =>
      requireValues(
        [
          { success: true, value: 1 },
          { success: false, error: new Error('reverted') },
        ],
        'reserves'
      )
    ).toThrow('Could not read the reserves');
  });
});

describe('sleuthWithFallback', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));

  test('uses the Sleuth query when it answers', async () => {
    const fallback = jest.fn();
    expect(await sleuthWithFallback('test', async () => 'sleuth', fallback)).toBe('sleuth');
    expect(fallback).not.toHaveBeenCalled();
  });

  test('reads through the fallback when the Sleuth query fails', async () => {
    const result = await sleuthWithFallback(
      'test',
      async () => {
        throw new Error('no Sleuth contract on this chain');
      },
      async () => 'fallback'
    );
    expect(result).toBe('fallback');
    expect(console.warn).toHaveBeenCalled();
  });
});
