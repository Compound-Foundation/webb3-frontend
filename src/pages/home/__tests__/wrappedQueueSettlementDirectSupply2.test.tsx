import '@testing-library/jest-dom';
import { act, waitFor } from '@testing-library/react';
import { BigNumber } from 'ethers';

import { DIRECT_WITHDRAWAL_HOLDS_KEY } from '@helpers/directWithdrawalHold';
import { MAX_UINT256 } from '@helpers/numbers';
import { Action, ActionType } from '@types';

import {
  ACCOUNT,
  BASE_ASSET,
  COMET,
  cometWithdrawals,
  countHoldChecks,
  DIRECT,
  executeLate,
  expectHeldBack,
  held,
  holdFirstStep,
  holdLooks,
  isSame,
  live,
  lives,
  MARKET,
  mine,
  positionCard,
  positionOn,
  productionWithdrawData,
  queued,
  renderDashboard,
  renderMixed,
  renderMixedWithProvider,
  REPLACED_HASH,
  reportOwnNonceTaken,
  requestedCalls,
  stateWithDirectSupply,
  storedHolds,
  storedRecords,
  submit,
  USDC_COMET,
  waitForHoldChecks,
  waitForHoldLook,
  waitForIdle,
} from '../../../../__tests__/mocks/wrappedQueueSettlement';
import { mockTabProps } from '../../../../__tests__/mocks/wrappedQueueSettlementProps';

// uuid ships ESM only, which Jest does not load here. The transaction manager uses it.
let mockNextId = 0;
jest.mock('uuid', () => ({ v4: () => `transaction-${++mockNextId}` }));

// Home's children record their props in wrappedQueueSettlementProps, which the fixture reads.
jest.mock('../components/Masthead', () =>
  jest.requireActual('../../../../__tests__/mocks/wrappedQueueSettlementProps').mockRecordProps('Masthead')
);
jest.mock('../components/PositionCard', () =>
  jest.requireActual('../../../../__tests__/mocks/wrappedQueueSettlementProps').mockRecordProps('PositionCard')
);
jest.mock('../components/ActionModal', () =>
  jest.requireActual('../../../../__tests__/mocks/wrappedQueueSettlementProps').mockRecordProps('ActionModal')
);
jest.mock('../components/AssetRow', () =>
  jest.requireActual('../../../../__tests__/mocks/wrappedQueueSettlementProps').mockRecordProps('AssetRow')
);
jest.mock('../components/InstitutionalBanner', () =>
  jest.requireActual('../../../../__tests__/mocks/wrappedQueueSettlementProps').mockRecordProps('InstitutionalBanner')
);

// The describe below is split across wrappedQueueSettlementDirectSupply1 to 3, in order,
// so that no test file runs much longer than the others. This file holds part 2.
describe('a withdrawal on the wrapped route from an account with a direct Comet supply', () => {
  let quiet: jest.SpyInstance[] = [];
  beforeEach(() => {
    mockNextId = 0;
    quiet = [
      jest.spyOn(console, 'warn').mockImplementation(() => undefined),
      jest.spyOn(console, 'log').mockImplementation(() => undefined),
    ];
  });
  afterEach(() => {
    quiet.forEach((spy) => spy.mockRestore());
  });

  it('keeps the hold when another interface supplies 100 USDC and withdraws 301, which leaves the held request funded', async () => {
    // Sol's case: 450 USDC supplied directly when the 200 USDC request is held.
    const { chain, wallet, show, entry } = await holdFirstStep(450_000_000n);
    chain.directSupply += 100_000_000n;
    mine(chain, { to: USDC_COMET, data: productionWithdrawData(301_000_000n) });
    expect(chain.directSupply).toBe(249_000_000n);
    const looks = holdLooks.mock.calls.length;
    show({ state: stateWithDirectSupply(chain.directSupply) });
    await waitForHoldLook(looks);

    act(() => live.queue.addOrUpdateAction(entry));
    await submit();
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(positionCard().actionRules.wrappedBase.stopped?.label).toBe('Earlier Request Still Pending');
    // The held request executes after all: 49 USDC stay, and Comet lends nothing.
    executeLate(chain);
    expect(chain.directSupply).toBe(49_000_000n);
    expect(chain.borrowed).toBe(0n);
  });

  it('keeps the hold when the direct supply is gone by other means, which does not show the request is dead', async () => {
    const { chain, wallet, show, entry } = await holdFirstStep();
    // Another interface withdraws the whole direct supply, and the dashboard reads none.
    mine(chain, { to: USDC_COMET, data: productionWithdrawData(MAX_UINT256) });
    const looks = holdLooks.mock.calls.length;
    show({ state: stateWithDirectSupply(0n) });
    await waitForHoldLook(looks);
    // 250 USDC is supplied directly again from elsewhere.
    chain.directSupply = DIRECT;
    const looksBeforeRise = holdLooks.mock.calls.length;
    show({ state: stateWithDirectSupply(DIRECT) });
    await waitForHoldLook(looksBeforeRise);

    act(() => live.queue.addOrUpdateAction(entry));
    await expectHeldBack(wallet, chain, entry);
  });

  it('keeps the hold while the direct supply grows and the held request has not executed', async () => {
    const { chain, wallet, show, entry } = await holdFirstStep();
    chain.baseSupplyIndex += 10n ** 12n;
    chain.directSupply += 300_000_000n;
    const looks = holdLooks.mock.calls.length;
    show({ state: stateWithDirectSupply(chain.directSupply) });
    await waitForHoldLook(looks);
    act(() => live.queue.addOrUpdateAction(entry));
    await expectHeldBack(wallet, chain, entry);
  });

  it('sends the next Comet step once another transaction took the own nonce of the last, which can then no longer execute', async () => {
    const { chain, wallet, readProvider } = await renderMixed();
    reportOwnNonceTaken(readProvider, REPLACED_HASH);
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    // The step is sent, but the node never shows a receipt for it, and its own nonce has passed.
    wallet.sendUncheckedTransaction.mockImplementationOnce(async () => `0x${'ab'.repeat(32)}`);
    wallet.getTransaction.mockImplementation(async () => ({ nonce: 5 } as never));
    // The other transaction takes the nonce only once the hold has stored the step's hash, as a block
    // later on a real chain.
    const nonceTaken = held<void>();
    wallet.getTransactionCount
      .mockImplementationOnce(async () => 5)
      .mockImplementation(async () => {
        await nonceTaken.promise;
        return 6;
      });

    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(storedHolds()).toEqual([expect.objectContaining({ hash: REPLACED_HASH })]));
    nonceTaken.release();
    await waitForIdle();
    expect(queued()).toEqual([]);
    expect(live.manager.transactions).toEqual([]);
    expect(live.manager.settledTransactions.map(({ outcome }) => outcome.status)).toEqual(['replaced']);
    await waitFor(() => expect(storedHolds()).toEqual([]));

    act(() => live.queue.addOrUpdateAction(entry));
    await submit();
    await waitFor(() => expect(queued()).toEqual([]));

    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([entry[2], entry[2]]);
    expect(chain.borrowed).toBe(0n);
  });

  it('holds nothing when the Comet step fails before the wallet is asked, as when its gas estimate fails', async () => {
    const { chain, wallet } = await renderMixed();
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    wallet.cometSigner.estimateGas.mockRejectedValueOnce(new Error('request timed out'));

    await submit();
    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(live.manager.transactions).toEqual([]);
    expect(storedRecords()).toEqual([]);
    await waitFor(() => expect(storedHolds()).toEqual([]));
    expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
      action: [ActionType.Withdraw, expect.anything(), entry[2]],
      label: 'Not Sent, Try Again',
    });

    // Nothing reached the wallet, so the next Submit sends the step.
    await submit();
    await waitFor(() => expect(queued()).toEqual([]));
    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([entry[2]]);
    expect(chain.borrowed).toBe(0n);
  });

  it('estimates the call the fresh split sends, withdraw(base, max), when the supply fell below a planned part', async () => {
    const { chain, wallet } = await renderMixed();
    const amount = 200_000_000n;
    // As Comet's estimate does: a part above the supply would borrow, and the account has no collateral.
    wallet.cometSigner.estimateGas.mockImplementation(async (request: { data: string }) => {
      const asked = BigInt(COMET.decodeFunctionData('withdraw', request.data)[1].toString());
      if (asked !== MAX_UINT256 && asked > chain.directSupply) throw new Error('execution reverted: NotCollateralized');
      return BigNumber.from(100_000);
    });
    // The dashboard read 250 USDC, so Submit plans withdraw(base, 200 USDC). 150 USDC has left since.
    chain.directSupply = 100_000_000n;
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, amount]));

    await submit();
    await waitFor(() => expect(queued()).toEqual([]));

    const estimated = wallet.cometSigner.estimateGas.mock.calls.map(([request]) =>
      BigInt(COMET.decodeFunctionData('withdraw', request.data)[1].toString())
    );
    expect(estimated).toEqual([MAX_UINT256]);
    expect(requestedCalls(wallet)).toEqual(['withdraw', 'unwrapAndWithdraw']);
    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([MAX_UINT256]);
    expect(chain.balance - 10_000_000_000n).toBeGreaterThanOrEqual(amount);
    expect(chain.borrowed).toBe(0n);
  });

  it('estimates and sends withdraw(base, 40 USDC) when Comet holds less cash than the direct supply but enough for the part', async () => {
    const { chain, wallet } = await renderMixed();
    const amount = 40_000_000n;
    // Comet holds 100 USDC of cash beside the 250 USDC direct supply, so withdraw(base, max) cannot
    // transfer, while withdraw(base, 40 USDC) can.
    chain.cometCash = 100_000_000n;
    wallet.cometSigner.estimateGas.mockImplementation(async (request: { data: string }) => {
      const asked = BigInt(COMET.decodeFunctionData('withdraw', request.data)[1].toString());
      const taken = asked === MAX_UINT256 ? chain.directSupply : asked;
      if (taken > chain.cometCash) throw new Error('execution reverted: ERC20: transfer amount exceeds balance');
      return BigNumber.from(100_000);
    });
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, amount]));

    await submit();

    // The estimate is of the call the wallet is then asked for, byte for byte.
    const estimated = wallet.cometSigner.estimateGas.mock.calls.map(([request]) => request.data);
    expect(estimated).toEqual([productionWithdrawData(amount)]);
    expect(positionCard().actionRules.wrappedBase.stopped).toBeUndefined();
    await waitFor(() => expect(queued()).toEqual([]));
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(cometWithdrawals(wallet)).toEqual([
      { to: USDC_COMET, data: estimated[0], args: [MARKET.baseTokenAddress, amount] },
    ]);
    expect(chain.directSupply).toBe(DIRECT - amount);
    expect(chain.cometCash).toBe(100_000_000n - amount);
    expect(chain.borrowed).toBe(0n);
  });

  it('keeps the hold, with its calldata, when the app reloads while the Comet request is open in the wallet', async () => {
    const { chain, wallet, reload } = await renderMixed();
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    // The request waits for approval on a phone, and the tab reloads meanwhile.
    wallet.sendUncheckedTransaction.mockImplementationOnce(async () => new Promise<string>(() => undefined));
    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(requestedCalls(wallet)).toEqual(['withdraw']));
    expect(storedHolds()).toEqual([
      expect.objectContaining({ kind: 'held', calldata: productionWithdrawData(200_000_000n).toLowerCase() }),
    ]);

    reload();
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    act(() => live.queue.addOrUpdateAction(entry));
    await submit();
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(positionCard().actionRules.wrappedBase.stopped?.label).toBe('Earlier Request Still Pending');

    // The holder approves it, and it executes: its calldata is found mined, so the hold ends.
    executeLate(chain);
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 30_000_000n]));
    await submit();
    await waitFor(() => expect(queued()).toEqual([]));
    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([entry[2], 30_000_000n]);
    expect(chain.borrowed).toBe(0n);
  });

  it('holds back the Comet step while another tab of the app has stored a hold for the account', async () => {
    const { chain, wallet } = await renderMixed();
    // Another tab's open request, stored as it stores one just before it asks the wallet.
    window.localStorage.setItem(
      DIRECT_WITHDRAWAL_HOLDS_KEY,
      JSON.stringify([
        {
          kind: 'held',
          id: 'other-tab',
          account: ACCOUNT.toLowerCase(),
          chainId: 1,
          cometAddress: USDC_COMET.toLowerCase(),
          calldata: productionWithdrawData(200_000_000n).toLowerCase(),
          amount: '200000000',
          blockNumber: chain.block,
        },
      ])
    );
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));

    await submit();
    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(positionCard().actionRules.wrappedBase.stopped?.label).toBe('Earlier Request Still Pending');

    // Once the other tab's request has executed, its calldata is found mined, and this one goes.
    executeLate(chain);
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 30_000_000n]));
    await submit();
    await waitFor(() => expect(queued()).toEqual([]));
    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([30_000_000n]);
    expect(chain.borrowed).toBe(0n);
  });

  it('asks the wallet once when a second tab opens and submits while the first is between its reservation and the wallet', async () => {
    const { chain, wallet, readProvider } = await renderMixed();
    // The first tab's fresh read of the direct supply waits until the test answers it.
    const read = held<void>();
    const answer = readProvider.call.getMockImplementation();
    if (answer === undefined) throw new Error('the provider must answer');
    let isReadStarted = false;
    readProvider.call.mockImplementation(async (request: { to?: string; data?: string }, ...rest: unknown[]) => {
      if (isSame(request.to, USDC_COMET) && request.data === COMET.encodeFunctionData('balanceOf', [ACCOUNT])) {
        isReadStarted = true;
        await read.promise;
      }
      return (answer as (...args: unknown[]) => Promise<string>)(request, ...rest);
    });
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 200_000_000n]));
    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(isReadStarted).toBe(true));
    // The first tab has reserved its step, and estimates its gas only after the fresh read.
    expect(wallet.cometSigner.estimateGas).not.toHaveBeenCalled();

    // A second tab opens, restores what storage holds, and submits the same 200 USDC.
    const second = renderDashboard(chain, {
      state: stateWithDirectSupply(DIRECT),
      position: positionOn(chain),
      tab: 'b',
    });
    await waitFor(() => expect(lives.b.action.blockedReason('withdraw')).toBeUndefined());
    act(() => lives.b.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 200_000_000n]));
    act(() => mockTabProps.b.PositionCard.state[1].onSubmitClicked());
    // The second tab finds the first tab's reservation and stops before its wallet.
    await waitFor(() =>
      expect(mockTabProps.b.PositionCard.state[1].actionRules.wrappedBase.stopped?.label).toBe(
        'Earlier Request Still Pending'
      )
    );
    expect(lives.b.writes.size).toBe(0);
    read.release();
    await waitForIdle();

    // Exactly one withdraw reaches the wallet, and the second tab's row says why it sent nothing.
    expect([...requestedCalls(wallet), ...requestedCalls(second.wallet)]).toEqual(['withdraw']);
    expect(mockTabProps.b.PositionCard.state[1].actionRules.wrappedBase.stopped?.label).toBe(
      'Earlier Request Still Pending'
    );
    expect(chain.directSupply).toBe(50_000_000n);
    expect(chain.borrowed).toBe(0n);
  });

  it("keeps the hold while the configured chain's provider has not reached the wallet node's block", async () => {
    const { chain, wallet, show, entry, readProvider } = await holdFirstStep();
    const heldBlock = chain.block;
    // The wallet's node is three blocks on. The configured chain's provider stays one block past the
    // hold, where it shows 50 USDC left, as if the held request had executed there.
    chain.block += 3;
    readProvider.getBlockNumber.mockImplementation(async () => heldBlock + 1);
    const answer = readProvider.call.getMockImplementation() as (...args: unknown[]) => Promise<string>;
    readProvider.call.mockImplementation(async (request: { to?: string; data?: string }, ...rest: unknown[]) => {
      if (isSame(request.to, USDC_COMET) && request.data === COMET.encodeFunctionData('balanceOf', [ACCOUNT])) {
        return COMET.encodeFunctionResult('balanceOf', [50_000_000n]);
      }
      if (isSame(request.to, USDC_COMET) && request.data?.startsWith(COMET.getSighash('userBasic'))) {
        return COMET.encodeFunctionResult('userBasic', [
          (50_000_000n * 10n ** 15n) / chain.baseSupplyIndex,
          0n,
          0n,
          0n,
          0n,
        ]);
      }
      return answer(request, ...rest);
    });
    // The Comet state read again starts a look at the hold, which waits for the provider.
    readProvider.getBlockNumber.mockClear();
    const checksBefore = countHoldChecks();
    show({ state: stateWithDirectSupply(DIRECT) });
    await waitFor(() => expect(readProvider.getBlockNumber).toHaveBeenCalled());

    // The provider catches up. Nothing shows the held request executed, so it still holds.
    readProvider.getBlockNumber.mockImplementation(async () => chain.block);
    act(() => live.queue.addOrUpdateAction(entry));
    await submit();
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(positionCard().actionRules.wrappedBase.stopped?.label).toBe('Earlier Request Still Pending');
    // Every look since the provider lagged has ended, the one the Comet state started included, which
    // waited for the provider to ask again.
    await waitForHoldChecks(checksBefore);
    await waitForIdle();
    expect(holdLooks.mock.calls.length).toBeGreaterThan(checksBefore.looks);
    expect(storedHolds()).toEqual([expect.objectContaining({ kind: 'held' })]);
    expect(readProvider.getLogs).toHaveBeenCalled();
    for (const [filter] of readProvider.getLogs.mock.calls) expect(filter.toBlock).toBeGreaterThanOrEqual(chain.block);
  });

  it("sends nothing when the wallet node's block cannot be read, whatever a lagging provider shows", async () => {
    const { chain, wallet, readProvider } = await renderMixedWithProvider();
    // 50 USDC is left. The configured chain's provider is a block behind and still shows 250.
    chain.directSupply = 50_000_000n;
    readProvider.getBlockNumber.mockImplementation(async () => chain.block - 1);
    const answer = readProvider.call.getMockImplementation() as (...args: unknown[]) => Promise<string>;
    readProvider.call.mockImplementation(async (request: { to?: string; data?: string }, ...rest: unknown[]) => {
      if (isSame(request.to, USDC_COMET) && request.data === COMET.encodeFunctionData('balanceOf', [ACCOUNT])) {
        return COMET.encodeFunctionResult('balanceOf', [DIRECT]);
      }
      if (isSame(request.to, USDC_COMET) && request.data?.startsWith(COMET.getSighash('userBasic'))) {
        return COMET.encodeFunctionResult('userBasic', [(DIRECT * 10n ** 15n) / chain.baseSupplyIndex, 0n, 0n, 0n, 0n]);
      }
      return answer(request, ...rest);
    });
    wallet.getBlockNumber.mockRejectedValue(new Error('wallet read timeout'));
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));

    await submit();
    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(chain.borrowed).toBe(0n);
    expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
      action: [ActionType.Withdraw, expect.anything(), entry[2]],
      label: 'Not Sent, Try Again',
    });
    await waitFor(() => expect(storedHolds()).toEqual([]));
  });

  it('keeps the row locked and the hold stored while the block of a replaced Comet step cannot be read', async () => {
    const { chain, wallet } = await renderMixed();
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    wallet.sendUncheckedTransaction.mockImplementationOnce(async () => `0x${'ab'.repeat(32)}`);
    wallet.getTransaction.mockImplementation(async () => ({ nonce: 5 } as never));
    wallet.getTransactionCount.mockImplementationOnce(async () => 5).mockImplementation(async () => 6);
    // The first two lookups are the reads before and after the gas estimate. Every later one fails.
    wallet.getBlockNumber
      .mockImplementationOnce(async () => chain.block)
      .mockImplementationOnce(async () => chain.block)
      .mockRejectedValue(new Error('block timeout'));

    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(live.manager.settledTransactions).toHaveLength(1));
    await waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith(
        'The block of a replaced Comet withdrawal is not known:',
        expect.anything()
      )
    );
    expect(queued()).toEqual([entry]);
    expect(positionCard().transaction).toBeDefined();
    await waitFor(() => expect(storedHolds()).toEqual([expect.objectContaining({ hash: `0x${'ab'.repeat(32)}` })]));
  });

  it('keeps the row held until the block of a replaced Comet step is known', async () => {
    const { chain, wallet, readProvider } = await renderMixed();
    reportOwnNonceTaken(readProvider, REPLACED_HASH);
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    wallet.sendUncheckedTransaction.mockImplementationOnce(async () => `0x${'ab'.repeat(32)}`);
    wallet.getTransaction.mockImplementation(async () => ({ nonce: 5 } as never));
    wallet.getTransactionCount.mockImplementationOnce(async () => 5).mockImplementation(async () => 6);
    // The first two reads are before and after the gas estimate, the third the one after the step
    // was replaced.
    const block = held<void>();
    wallet.getBlockNumber
      .mockImplementationOnce(async () => chain.block)
      .mockImplementationOnce(async () => chain.block)
      .mockImplementationOnce(async () => {
        await block.promise;
        return chain.block;
      });

    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(live.manager.settledTransactions).toHaveLength(1));
    // The lookup of the wallet node's block after the step was replaced has started.
    await waitFor(() => expect(wallet.getBlockNumber.mock.calls.length).toBeGreaterThanOrEqual(3));
    // Replaced, but the wallet node's block is not known yet: the row and the run stay as they are.
    expect(queued()).toEqual([entry]);
    expect(positionCard().transaction).toBeDefined();

    // The hold has the step's hash by the time the block is known, as a block later on a real chain.
    await waitFor(() => expect(storedHolds()).toEqual([expect.objectContaining({ hash: REPLACED_HASH })]));
    block.release();
    await waitFor(() => expect(queued()).toEqual([]));
    await waitFor(() => expect(storedHolds()).toEqual([]));
  });

  it('keeps the hold when the manager judges the step replaced by the nonce it read before sending, while the node does not know it', async () => {
    const { chain, wallet, show } = await renderMixed();
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    // Another transaction of the account is pending at nonce 5, so the step is sent at 6. The node
    // does not know the step yet, and nonce 5 mines: the manager reports the step replaced.
    wallet.sendUncheckedTransaction.mockImplementationOnce(async () => REPLACED_HASH);
    // Nonce 5 mines only once the hold has stored the step's hash, as a block later on a real chain.
    const nonceTaken = held<void>();
    wallet.getTransactionCount
      .mockImplementationOnce(async () => 5)
      .mockImplementation(async () => {
        await nonceTaken.promise;
        return 6;
      });
    const looks = holdLooks.mock.calls.length;

    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(storedHolds()).toEqual([expect.objectContaining({ hash: REPLACED_HASH })]));
    nonceTaken.release();
    await waitForIdle();
    expect(live.manager.settledTransactions.map(({ outcome }) => outcome.status)).toEqual(['replaced']);
    // The run's look at its own hold, once the replaced step's block is known.
    await waitForHoldLook(looks);
    expect(storedHolds()).toEqual([expect.objectContaining({ hash: REPLACED_HASH })]);

    // The same 200 USDC again is held back.
    act(() => live.queue.addOrUpdateAction(entry));
    await expectHeldBack(wallet, chain, entry);

    // Once the step's own receipt is found, the hold ends.
    chain.history.push({
      hash: REPLACED_HASH,
      blockNumber: chain.block,
      from: ACCOUNT,
      to: USDC_COMET,
      data: productionWithdrawData(200_000_000n),
      status: 1,
      logs: [],
    });
    show({ state: stateWithDirectSupply(50_000_000n) });
    await waitFor(() => expect(storedHolds()).toEqual([]));
  });

  it('asks the wallet for nothing while storage cannot be written, so no reload can lose a request', async () => {
    const { chain, wallet, reload } = await renderMixed();
    const quietError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    try {
      await submit();
      expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
      expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
        action: [ActionType.Withdraw, expect.anything(), entry[2]],
        label: 'Not Sent, Try Again',
      });
    } finally {
      setItem.mockRestore();
      quietError.mockRestore();
    }

    // Storage works again after a reload: one request goes, and Comet lends nothing.
    reload();
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    act(() => live.queue.addOrUpdateAction(entry));
    await submit();
    await waitFor(() => expect(queued()).toEqual([]));
    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([entry[2]]);
    expect(chain.borrowed).toBe(0n);
  });

  it('refuses every Comet step while storage cannot be read, and holds again once it can', async () => {
    const { chain, wallet, reload, entry } = await holdFirstStep();
    const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      // A reload while storage cannot be read: whether a hold exists is unknown, never none.
      reload();
      await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
      act(() => live.queue.addOrUpdateAction(entry));
      await submit();
      expect(requestedCalls(wallet)).toEqual(['withdraw']);
      expect(positionCard().actionRules.wrappedBase.stopped?.label).toBe('Earlier Request Still Pending');
    } finally {
      getItem.mockRestore();
    }

    reload();
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    act(() => live.queue.addOrUpdateAction(entry));
    await expectHeldBack(wallet, chain, entry);
  });
});
