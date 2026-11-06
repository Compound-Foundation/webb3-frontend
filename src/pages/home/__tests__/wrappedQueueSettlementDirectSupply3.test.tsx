import { TransactionReceipt } from '@ethersproject/providers';
import '@testing-library/jest-dom';
import { act, waitFor } from '@testing-library/react';
import { BigNumber } from 'ethers';

import { recordCometStateSource } from '@helpers/cometStateSource';
import { DIRECT_WITHDRAWAL_HOLDS_KEY } from '@helpers/directWithdrawalHold';
import { MAX_UINT256 } from '@helpers/numbers';
import { Action, ActionType } from '@types';

import {
  ACCOUNT,
  BASE_ASSET,
  CALLS,
  chainFor,
  COMET,
  cometWithdrawals,
  DIRECT,
  executeLate,
  exitCashAt,
  held,
  holdFirstStep,
  isSame,
  live,
  MARKET,
  positionCard,
  positionOn,
  productionWithdrawData,
  queued,
  readProviderFor,
  renderDashboard,
  renderMixed,
  renderMixedWithProvider,
  requestedCalls,
  sentCalls,
  stateWithDirectSupply,
  storedHolds,
  submit,
  USDC_COMET,
  waitForIdle,
  WRAPPED_SHARES,
} from '../../../../__tests__/mocks/wrappedQueueSettlement';
import { mockLastProps } from '../../../../__tests__/mocks/wrappedQueueSettlementProps';

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
// so that no test file runs much longer than the others. This file holds part 3.
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

  /** A wallet connector on the standard route, which the wrapped route never uses. */
  const STANDARD_CONNECTOR = 'io.metamask';
  /** Waits until the dashboard's session is on the standard route. */
  const waitForStandardRoute = () => waitFor(() => expect(live.action.blockedReason('withdraw')).toBe('not-wrapped'));

  it('refuses a base withdrawal for the held account through another connector, on the standard route', async () => {
    const { chain, wallet, show, entry } = await holdFirstStep();
    // The same account connects through a standard-route wallet.
    show({ connectorId: STANDARD_CONNECTOR });
    await waitForStandardRoute();
    act(() => live.queue.addOrUpdateAction(entry));
    await submit();
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(queued()).toEqual([entry]);
    // Should the held request now execute, Comet takes 200 USDC of the 250 and lends nothing.
    executeLate(chain);
    expect(chain.borrowed).toBe(0n);

    // Its calldata is found mined at the next Comet read, and the standard withdrawal goes as on main.
    show({ connectorId: STANDARD_CONNECTOR, state: stateWithDirectSupply(50_000_000n) });
    await waitFor(() => expect(storedHolds()).toEqual([]));
    const rest: Action = [ActionType.Withdraw, BASE_ASSET, 30_000_000n];
    act(() => live.queue.clearActions());
    act(() => live.queue.addOrUpdateAction(rest));
    await submit();
    await waitFor(() => expect(requestedCalls(wallet)).toEqual(['withdraw', 'withdraw']));
    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([entry[2], 30_000_000n]);
  });

  it('sends a base withdrawal on the standard route exactly as on main when no hold is stored', async () => {
    const chain = chainFor({ shares: WRAPPED_SHARES, directSupply: DIRECT });
    const { wallet, show } = renderDashboard(chain, { state: stateWithDirectSupply(DIRECT) });
    show({ connectorId: STANDARD_CONNECTOR, state: stateWithDirectSupply(DIRECT) });
    await waitForStandardRoute();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 200_000_000n]));

    await submit();
    await waitFor(() => expect(requestedCalls(wallet)).toEqual(['withdraw']));
    expect(cometWithdrawals(wallet)).toEqual([
      { to: USDC_COMET, data: productionWithdrawData(200_000_000n), args: [MARKET.baseTokenAddress, 200_000_000n] },
    ]);
    expect(storedHolds()).toEqual([]);
    expect(chain.directSupply).toBe(50_000_000n);
  });

  it('sends nothing on the standard route when a hold is stored while the withdrawal is estimated', async () => {
    const chain = chainFor({ shares: WRAPPED_SHARES, directSupply: DIRECT });
    const { wallet, show } = renderDashboard(chain, { state: stateWithDirectSupply(DIRECT) });
    show({ connectorId: STANDARD_CONNECTOR, state: stateWithDirectSupply(DIRECT) });
    await waitForStandardRoute();
    // An Anchorage tab of the same account stores its hold while this request's gas is estimated.
    wallet.cometSigner.estimateGas.mockImplementationOnce(async () => {
      window.localStorage.setItem(
        DIRECT_WITHDRAWAL_HOLDS_KEY,
        JSON.stringify([
          {
            kind: 'held',
            id: 'anchorage-tab',
            account: ACCOUNT.toLowerCase(),
            chainId: 1,
            cometAddress: USDC_COMET.toLowerCase(),
            calldata: productionWithdrawData(200_000_000n).toLowerCase(),
            amount: '200000000',
            blockNumber: chain.block,
          },
        ])
      );
      return BigNumber.from(100_000);
    });
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 200_000_000n]));

    await submit();
    expect(wallet.cometSigner.estimateGas).toHaveBeenCalledTimes(1);
    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(chain.directSupply).toBe(DIRECT);
  });

  /** Makes the stored holds unreadable: a read of their key throws, or finds no JSON list. */
  const UNREADABLE_HOLDS: [string, () => () => void][] = [
    [
      'a read of the key throws',
      () => {
        const read = Storage.prototype.getItem;
        const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name) {
          if (name === DIRECT_WITHDRAWAL_HOLDS_KEY) throw new Error('SecurityError');
          return read.call(this, name);
        });
        return () => getItem.mockRestore();
      },
    ],
    [
      'the key holds invalid JSON',
      () => {
        window.localStorage.setItem(DIRECT_WITHDRAWAL_HOLDS_KEY, '{not json');
        return () => undefined;
      },
    ],
  ];

  it.each(UNREADABLE_HOLDS)(
    'refuses a base withdrawal on the standard route at Submit while the holds are unreadable, when %s',
    async (_name, makeUnreadable) => {
      const { chain, wallet, show, entry } = await holdFirstStep();
      show({ connectorId: STANDARD_CONNECTOR });
      await waitForStandardRoute();
      const restore = makeUnreadable();
      try {
        act(() => live.queue.addOrUpdateAction(entry));
        const estimates = wallet.cometSigner.estimateGas.mock.calls.length;
        await submit();
        expect(requestedCalls(wallet)).toEqual(['withdraw']);
        expect(queued()).toEqual([entry]);
        // Refused at Submit, before the manager estimates gas, not only just before the wallet.
        expect(wallet.cometSigner.estimateGas.mock.calls.length).toBe(estimates);
      } finally {
        restore();
      }
      // Should the held request now execute, Comet takes 200 USDC of the 250 and lends nothing.
      executeLate(chain);
      expect(chain.borrowed).toBe(0n);
    }
  );

  it.each(UNREADABLE_HOLDS)(
    'sends nothing on the standard route when the holds become unreadable while the withdrawal is estimated, when %s',
    async (_name, makeUnreadable) => {
      const chain = chainFor({ shares: WRAPPED_SHARES, directSupply: DIRECT });
      const { wallet, show } = renderDashboard(chain, { state: stateWithDirectSupply(DIRECT) });
      show({ connectorId: STANDARD_CONNECTOR, state: stateWithDirectSupply(DIRECT) });
      await waitForStandardRoute();
      let restore = () => undefined as void;
      wallet.cometSigner.estimateGas.mockImplementationOnce(async () => {
        restore = makeUnreadable();
        return BigNumber.from(100_000);
      });
      act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 200_000_000n]));
      try {
        await submit();
        expect(wallet.cometSigner.estimateGas).toHaveBeenCalledTimes(1);
        expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
        expect(chain.directSupply).toBe(DIRECT);
      } finally {
        restore();
      }
    }
  );

  it('sends nothing when the session changes while the direct supply is read again', async () => {
    const { chain, wallet, show } = await renderMixed();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 100_000_000n]));
    // The fresh read of the direct supply waits until the test answers it.
    const read = held<void>();
    const readProvider = mockLastProps.readProvider as ReturnType<typeof readProviderFor>;
    const answer = readProvider.call.getMockImplementation();
    if (answer === undefined) throw new Error('the provider must answer');
    let isReadStarted = false;
    readProvider.call.mockImplementation(async (request: { to?: string; data?: string }, ...rest: unknown[]) => {
      if (isSame(request.to, MARKET.cometAddress) && request.data?.startsWith(COMET.getSighash('balanceOf'))) {
        isReadStarted = true;
        await read.promise;
      }
      return (answer as (...args: unknown[]) => Promise<string>)(request, ...rest);
    });

    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(isReadStarted).toBe(true));
    show({ walletChainId: 8453 });
    read.release();
    await waitForIdle();

    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(chain.directSupply).toBe(DIRECT);
  });

  it('sends nothing, and holds nothing, when the Comet state shows no direct supply by the end of the gas estimate', async () => {
    const { chain, wallet, show } = await renderMixed();
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 100_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    // The Comet step's gas estimate waits until the test answers it.
    const estimate = held<void>();
    let isEstimateStarted = false;
    wallet.cometSigner.estimateGas.mockImplementationOnce(async () => {
      isEstimateStarted = true;
      await estimate.promise;
      return BigNumber.from(100_000);
    });

    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(isEstimateStarted).toBe(true));
    // The Comet state is read again and shows no direct supply, in the same visit and session.
    show({ state: stateWithDirectSupply(0n) });
    estimate.release();
    await waitForIdle();

    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    await waitFor(() => expect(storedHolds()).toEqual([]));
    expect(positionCard().actionRules.wrappedBase.stopped?.label).toBe('Not Sent, Try Again');
    expect(chain.directSupply).toBe(DIRECT);
  });

  it('sends nothing, and holds nothing, when the Comet state shows no direct supply during the read after the gas estimate', async () => {
    const { chain, wallet, show, readProvider } = await renderMixed();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 100_000_000n]));
    // The second read of the direct supply, made after the gas estimate, waits until the test answers it.
    const read = held<void>();
    const answer = readProvider.call.getMockImplementation();
    if (answer === undefined) throw new Error('the provider must answer');
    let directReads = 0;
    let isSecondReadStarted = false;
    readProvider.call.mockImplementation(async (request: { to?: string; data?: string }, ...rest: unknown[]) => {
      if (
        isSame(request.to, MARKET.cometAddress) &&
        request.data === COMET.encodeFunctionData('balanceOf', [ACCOUNT])
      ) {
        directReads += 1;
        if (directReads === 2) {
          isSecondReadStarted = true;
          await read.promise;
        }
      }
      return (answer as (...args: unknown[]) => Promise<string>)(request, ...rest);
    });

    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(isSecondReadStarted).toBe(true));
    expect(wallet.cometSigner.estimateGas).toHaveBeenCalledTimes(1);
    // The Comet state is read again and shows no direct supply, in the same visit and session.
    show({ state: stateWithDirectSupply(0n) });
    read.release();
    await waitForIdle();

    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    await waitFor(() => expect(storedHolds()).toEqual([]));
    expect(positionCard().actionRules.wrappedBase.stopped?.label).toBe('Not Sent, Try Again');
    expect(chain.directSupply).toBe(DIRECT);
  });

  it('refuses the Comet step while the Comet state was read for another account', async () => {
    const chain = chainFor({ shares: WRAPPED_SHARES, directSupply: DIRECT });
    const state = stateWithDirectSupply(DIRECT);
    // As useCometState records it for another account, before the next read for this one.
    recordCometStateSource(
      state,
      { chainId: 1, cometAddress: USDC_COMET },
      '0x0000000000000000000000000000000000000bb2'
    );
    const { wallet } = renderDashboard(chain, { state, position: positionOn(chain) });
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 100_000_000n]));

    await submit();

    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(chain.directSupply).toBe(DIRECT);
  });

  it('reads the direct supply again at a block no older than the last confirmed Comet step, so a stale dashboard never borrows', async () => {
    const { chain, wallet, readProvider } = await renderMixedWithProvider();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 300_000_000n]));
    const send = wallet.sendUncheckedTransaction.getMockImplementation();
    if (send === undefined) throw new Error('the wallet must send');
    wallet.sendUncheckedTransaction
      .mockImplementationOnce(send)
      .mockRejectedValueOnce({ code: 4001, message: 'User rejected.' });
    await submit();
    expect(live.action.state.phase).toBe('stopped');
    // The confirmed Comet step's hold is released.
    await waitFor(() => expect(storedHolds()).toEqual([]));
    // The Comet step took the 250 USDC. The dashboard still shows it, so the 50 USDC rest plans a
    // partial Comet step. The configured chain's provider is one block behind the wallet's node.
    const cometReceiptBlock = live.manager.settledTransactions[0].outcome;
    if (cometReceiptBlock.status !== 'confirmed') throw new Error('the Comet step must confirm');
    const lagging = cometReceiptBlock.receipt.blockNumber - 1;
    readProvider.getBlockNumber.mockImplementationOnce(async () => lagging);
    readProvider.call.mockClear();
    const directReads = () =>
      readProvider.call.mock.calls.filter(
        ([request]) =>
          isSame(request.to, MARKET.cometAddress) && request.data === COMET.encodeFunctionData('balanceOf', [ACCOUNT])
      );

    act(() => positionCard().onSubmitClicked());
    // The read waits for the provider to reach the Comet step's block, polling every 1.5 seconds.
    await waitFor(() => expect(directReads()).toHaveLength(1), { timeout: 5_000 });
    await waitForIdle();

    expect(directReads()[0][1]).toBeGreaterThanOrEqual(cometReceiptBlock.receipt.blockNumber);
    expect(requestedCalls(wallet)).toEqual(['withdraw', 'unwrapAndWithdraw']);
    expect(chain.borrowed).toBe(0n);
    expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
      action: [ActionType.Withdraw, expect.anything(), 50_000_000n],
      label: 'Balance Changed, Edit Amount',
    });
  });

  it('keeps the rest queued when the wrapper step is declined after the Comet step confirmed', async () => {
    const { chain, wallet } = await renderMixed();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 300_000_000n]));
    const send = wallet.sendUncheckedTransaction.getMockImplementation();
    if (send === undefined) throw new Error('the wallet must send');
    wallet.sendUncheckedTransaction
      .mockImplementationOnce(send)
      .mockRejectedValueOnce({ code: 4001, message: 'User rejected.' });

    await submit();
    expect(live.action.state.phase).toBe('stopped');

    expect(requestedCalls(wallet)).toEqual(['withdraw', 'unwrapAndWithdraw']);
    expect(chain.directSupply).toBe(0n);
    expect(chain.shares).toBe(WRAPPED_SHARES);
    expect(queued()).toEqual([[ActionType.Withdraw, expect.anything(), 50_000_000n]]);
    expect(positionCard().actionRules.wrappedBase.stopped).toBeUndefined();
    expect(positionCard().transaction).toBeUndefined();
  });

  it('pays exactly the queued amount from Comet alone when the direct supply rose above it before signing', async () => {
    const { chain, wallet } = await renderMixed();
    const amount = 300_000_000n;
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, amount]));
    // The dashboard read 250 USDC, so Submit plans withdraw(base, max) and 50 USDC from the wrapper.
    // Another 150 USDC is supplied to Comet directly before signing.
    chain.directSupply = 400_000_000n;

    await submit();
    expect(queued()).toEqual([]);

    // One Comet withdraw(base, 300 USDC), production's encoding, and nothing from the wrapper.
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(cometWithdrawals(wallet)).toEqual([
      { to: USDC_COMET, data: productionWithdrawData(amount), args: [MARKET.baseTokenAddress, amount] },
    ]);
    expect(chain.balance - 10_000_000_000n).toBe(amount);
    expect(chain.directSupply).toBe(100_000_000n);
    expect(chain.shares).toBe(WRAPPED_SHARES);
    expect(chain.borrowed).toBe(0n);
  });

  it('takes the fallen direct supply with max, then the rest of the queued amount from the wrapper, by what Comet took', async () => {
    const { chain, wallet } = await renderMixed();
    const amount = 300_000_000n;
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, amount];
    act(() => live.queue.addOrUpdateAction(entry));
    // 150 USDC of the direct supply leaves in another transaction after the fresh read, while the
    // manager estimates the Comet step's gas. The dashboard still shows the 250 USDC it read.
    wallet.cometSigner.estimateGas.mockImplementationOnce(async () => {
      chain.directSupply = 100_000_000n;
      return BigNumber.from(100_000);
    });
    // Between the fresh read and execution the supply earns 7 base units, which max also takes.
    const send = wallet.cometSigner.sendTransaction.getMockImplementation();
    if (send === undefined) throw new Error('the signer must send');
    wallet.cometSigner.sendTransaction.mockImplementationOnce(async (request) => {
      chain.directSupply += 7n;
      return send(request);
    });
    const send2 = wallet.sendUncheckedTransaction.getMockImplementation();
    if (send2 === undefined) throw new Error('the wallet must send');
    const wrapperAnswer = held<void>();
    wallet.sendUncheckedTransaction.mockImplementationOnce(send2).mockImplementationOnce(async (request) => {
      await wrapperAnswer.promise;
      return send2(request);
    });

    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(requestedCalls(wallet)).toEqual(['withdraw', 'unwrapAndWithdraw']));
    // Comet withdrew the 100.000007 USDC it held. The row shows the queued amount less that.
    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([MAX_UINT256]);
    expect(queued()).toEqual([[ActionType.Withdraw, expect.anything(), amount - 100_000_007n]]);
    const beforeExit = { ...chain };
    wrapperAnswer.release();
    await waitFor(() => expect(queued()).toEqual([]));

    const [unwrap] = sentCalls(wallet, 'unwrapAndWithdraw');
    const burned = BigInt(CALLS.parseTransaction(unwrap[0]).args[0].toString());
    // The fewest shares that pay the 199.999993 USDC rest, from the wrapper's state then.
    expect(exitCashAt(beforeExit, burned)).toBeGreaterThanOrEqual(amount - 100_000_007n);
    expect(exitCashAt(beforeExit, burned - 1n)).toBeLessThan(amount - 100_000_007n);
    // The payout is the queued amount, short of the shares' rounding: at most what one share pays.
    const paid = chain.balance - 10_000_000_000n;
    expect(paid).toBeGreaterThanOrEqual(amount);
    expect(paid - amount).toBeLessThanOrEqual(exitCashAt(beforeExit, burned) - exitCashAt(beforeExit, burned - 1n));
    expect(chain.directSupply).toBe(0n);
    expect(chain.borrowed).toBe(0n);
  });

  it('keeps the rest by the fresh read, and asks the wrapper for nothing, when the Comet receipt names no amount', async () => {
    const { chain, wallet } = await renderMixed();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 300_000_000n]));
    const lookUp = wallet.getTransactionReceipt.getMockImplementation();
    if (lookUp === undefined) throw new Error('the wallet must look up receipts');
    wallet.getTransactionReceipt.mockImplementation(async (hash: string) => {
      const receipt = await lookUp(hash);
      return receipt === null ? null : ({ ...receipt, logs: [] } as unknown as TransactionReceipt);
    });

    await submit();
    expect(live.manager.settledTransactions).toHaveLength(1);

    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(chain.directSupply).toBe(0n);
    expect(queued()).toEqual([[ActionType.Withdraw, expect.anything(), 50_000_000n]]);
    expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
      action: [ActionType.Withdraw, expect.anything(), 50_000_000n],
      label: 'Balance Changed, Edit Amount',
    });
  });

  it('sends nothing, and asks for a new amount, when the direct supply is gone before signing', async () => {
    const { chain, wallet } = await renderMixed();
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    // After the fresh read, while the manager estimates the Comet step's gas, the whole direct supply
    // leaves in another transaction. The dashboard still shows the 250 USDC it read. The finite
    // withdraw(base, 200 USDC) now borrows, so the read made after the estimate sends nothing.
    wallet.cometSigner.estimateGas.mockImplementationOnce(async () => {
      chain.directSupply = 0n;
      return BigNumber.from(100_000);
    });

    await submit();

    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(chain.borrowed).toBe(0n);
    expect(queued()).toEqual([entry]);
    expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
      action: [ActionType.Withdraw, expect.anything(), entry[2]],
      label: 'Balance Changed, Edit Amount',
    });
    expect(live.manager.transactions).toEqual([]);
    await waitFor(() => expect(storedHolds()).toEqual([]));
  });

  it('sends nothing when the direct supply falls below a finite part during the estimate, though the wrapper could pay the rest', async () => {
    const { chain, wallet } = await renderMixed();
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 200_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    // The fresh read shows 250 USDC, so the Comet step is withdraw(base, 200 USDC). While its gas is
    // estimated, 150 USDC of the supply leaves. That call now borrows 100 USDC, while a split from the
    // 100 USDC left, max then 100 USDC from the wrapper, could pay.
    wallet.cometSigner.estimateGas.mockImplementationOnce(async () => {
      chain.directSupply = 100_000_000n;
      return BigNumber.from(100_000);
    });

    await submit();

    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(chain.borrowed).toBe(0n);
    expect(queued()).toEqual([entry]);
    expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
      action: [ActionType.Withdraw, expect.anything(), entry[2]],
      label: 'Balance Changed, Edit Amount',
    });
    await waitFor(() => expect(storedHolds()).toEqual([]));
  });

  it('sends nothing when the direct supply fell further than the wrapper can make up before signing', async () => {
    // A 10 USDC wrapped position beside the 250 USDC direct supply.
    const chain = chainFor({ shares: 10n * 10n ** 18n, directSupply: DIRECT });
    const { wallet } = renderDashboard(chain, { state: stateWithDirectSupply(DIRECT), position: positionOn(chain) });
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 255_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    // 200 USDC of the direct supply leaves after the fresh read, while the manager estimates the
    // Comet step's gas, which leaves 205 USDC for a wrapper that pays at most 10 USDC.
    wallet.cometSigner.estimateGas.mockImplementationOnce(async () => {
      chain.directSupply = 50_000_000n;
      return BigNumber.from(100_000);
    });

    await submit();

    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(queued()).toEqual([entry]);
    expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
      action: [ActionType.Withdraw, expect.anything(), entry[2]],
      label: 'Balance Changed, Edit Amount',
    });
    await waitFor(() => expect(storedHolds()).toEqual([]));
  });
});
