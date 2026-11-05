import { Interface } from '@ethersproject/abi';
import type { Provider } from '@ethersproject/providers';
import { BigNumber } from 'ethers';

import ERC20 from '@helpers/abis/ERC20';
import Governor from '@helpers/abis/Governor';
import { contractCall, multicall } from '@helpers/multicall';

const MULTICALL3 = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
]);
const ERC20_ABI = new Interface(ERC20);
const GOVERNOR_ABI = new Interface(Governor);
const TOKEN = '0x00000000000000000000000000000000000000a1';
const GOVERNOR = '0x00000000000000000000000000000000000000c1';
const ACCOUNT = '0x00000000000000000000000000000000000000b1';
const SPENDER = '0x00000000000000000000000000000000000000b2';
// A revert whose data is one full word: it decodes as a number, so only the success flag marks it failed
const WORD_REVERT_DATA = ERC20_ABI.encodeFunctionResult('allowance', [7]);

const providerAnswering = (responses: { success: boolean; returnData: string }[]) => {
  const call = jest.fn<Promise<string>, [{ to: string; data: string }]>(async () =>
    MULTICALL3.encodeFunctionResult('aggregate3', [responses])
  );
  return { provider: { call } as unknown as Provider, call };
};

beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

describe('multicall', () => {
  test('sends every call to its contract in one aggregate3 call, and lets each call fail on its own', async () => {
    const { provider, call } = providerAnswering([
      { success: true, returnData: ERC20_ABI.encodeFunctionResult('balanceOf', [42]) },
      { success: false, returnData: WORD_REVERT_DATA },
      { success: true, returnData: '0x1234' },
    ]);
    const calls = [
      contractCall(TOKEN, ERC20_ABI, 'balanceOf', ACCOUNT),
      contractCall(TOKEN, ERC20_ABI, 'allowance', ACCOUNT, SPENDER),
      contractCall(GOVERNOR, GOVERNOR_ABI, 'quorumVotes'),
    ];

    const results = await multicall(provider, calls);

    expect(call).toHaveBeenCalledTimes(1);
    const [sent] = MULTICALL3.decodeFunctionData('aggregate3', call.mock.calls[0][0].data);
    expect(
      sent.map(({ target, allowFailure, callData }: { target: string; allowFailure: boolean; callData: string }) => [
        target.toLowerCase(),
        allowFailure,
        callData,
      ])
    ).toEqual([
      [TOKEN, true, ERC20_ABI.encodeFunctionData('balanceOf', [ACCOUNT])],
      [TOKEN, true, ERC20_ABI.encodeFunctionData('allowance', [ACCOUNT, SPENDER])],
      [GOVERNOR, true, GOVERNOR_ABI.encodeFunctionData('quorumVotes', [])],
    ]);
    expect(results[0]).toEqual({ success: true, value: BigNumber.from(42) });
    // a revert and an answer that does not decode both fail only their own call
    expect(results[1].success).toBe(false);
    expect(results[2].success).toBe(false);
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  test('reads the fields of a multi-output function and of a returned struct by name', async () => {
    // The vote page reads proposals() and getReceipt() this way, the wrapped position totalsBasic()
    // id, proposer, eta, startBlock, endBlock, forVotes, againstVotes, abstainVotes, canceled, executed
    const proposalOutputs = [7, ACCOUNT, 1_700, 10, 20, 300, 200, 100, false, true];
    const { provider } = providerAnswering([
      { success: true, returnData: GOVERNOR_ABI.encodeFunctionResult('proposals', proposalOutputs) },
      { success: true, returnData: GOVERNOR_ABI.encodeFunctionResult('getReceipt', [[true, 1, 55]]) },
    ]);

    const [proposal, receipt] = await multicall(provider, [
      contractCall(GOVERNOR, GOVERNOR_ABI, 'proposals', 7),
      contractCall(GOVERNOR, GOVERNOR_ABI, 'getReceipt', 7, ACCOUNT),
    ]);

    if (!proposal.success || !receipt.success) throw new Error('expected both calls to succeed');
    expect(proposal.value.forVotes).toEqual(BigNumber.from(300));
    expect(proposal.value.eta).toEqual(BigNumber.from(1_700));
    expect(proposal.value.executed).toBe(true);
    expect(receipt.value.hasVoted).toBe(true);
    expect(receipt.value.support).toBe(1);
    expect(receipt.value.votes).toEqual(BigNumber.from(55));
  });

  test('fails the whole batch when the chain has no Multicall3 contract', async () => {
    // eth_call to an address without code answers 0x, which does not decode as aggregate3's result
    const provider = { call: jest.fn(async () => '0x') } as unknown as Provider;
    await expect(multicall(provider, [contractCall(TOKEN, ERC20_ABI, 'balanceOf', ACCOUNT)])).rejects.toThrow();
  });
});
