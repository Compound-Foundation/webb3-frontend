import '@testing-library/jest-dom';
import { act, screen, waitFor } from '@testing-library/react';

import { MAX_UINT256 } from '@helpers/numbers';
import { Action, ActionType, TransactionState } from '@types';

import {
  AMOUNT,
  BASE_ASSET,
  CALLS,
  chainFor,
  expectQueueHeld,
  held,
  live,
  MARKET,
  positionCard,
  queued,
  renderDashboard,
  sendThenSwitchNetwork,
  sentCalls,
  submit,
  switchWriteNetwork,
  waitForIdle,
} from '../../../../__tests__/mocks/wrappedQueueSettlement';

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

describe('a queued wrapper action sent before a change of network', () => {
  beforeEach(() => {
    mockNextId = 0;
  });

  it('is supplied once: it is held while its receipt is pending on either network, and leaves the queue once it confirms', async () => {
    const chain = chainFor({ allowance: AMOUNT });
    const { wallet, show } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason('supply')).toBeUndefined());
    const supply: Action = [ActionType.Supply, BASE_ASSET, AMOUNT];
    act(() => live.queue.addOrUpdateAction(supply));

    await sendThenSwitchNetwork(wallet, show);
    // The run was dropped with the network, and only the sent supply holds the queue. The card
    // still shows the pending transaction, as it shows one to Comet, and says nothing more.
    expectQueueHeld(supply);
    expect(positionCard().transaction?.state).toBe(TransactionState.Pending);
    expect(positionCard().actionRules.wrappedBase.stopped).toBeUndefined();
    // The card's Submit is disabled meanwhile. A Submit callback kept from before sends nothing.
    switchWriteNetwork.mockClear();
    await submit();
    expect(sentCalls(wallet, 'supplyAndWrap')).toHaveLength(1);

    // Back on the market's network, the receipt is still pending: the entry is held, and Submit
    // sends nothing more.
    show({ walletChainId: 1 });
    await submit();
    expect(sentCalls(wallet, 'supplyAndWrap')).toHaveLength(1);
    expectQueueHeld(supply);
    expect(positionCard().transaction?.state).toBe(TransactionState.Pending);

    wallet.releaseReceipts();
    await waitFor(() => expect(live.manager.settledTransactions).toHaveLength(1));
    await waitFor(() => expect(queued()).toEqual([]));
    // No run, sent action or write is left that could send the supply again.
    await waitForIdle();

    expect(sentCalls(wallet, 'supplyAndWrap')).toHaveLength(1);
    expect(chain.balance).toBe(10_000_000_000n - AMOUNT);
  });

  it('withdraws once: a partial withdrawal leaves the queue once it confirms', async () => {
    const chain = chainFor({ shares: 250n * 10n ** 18n });
    const { wallet, show } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, AMOUNT]));

    await sendThenSwitchNetwork(wallet, show);
    wallet.releaseReceipts();
    show({ walletChainId: 1 });
    await waitFor(() => expect(live.manager.settledTransactions).toHaveLength(1));
    await waitFor(() => expect(queued()).toEqual([]));
    await submit();

    expect(sentCalls(wallet, 'unwrapAndWithdraw')).toHaveLength(1);
    expect(chain.balance).toBe(10_000_000_000n + AMOUNT);
    expect(queued()).toEqual([]);
  });

  it('returns to the queue, and can be submitted again, once its last step reverted', async () => {
    const chain = chainFor({ allowance: AMOUNT });
    const { wallet, show } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason('supply')).toBeUndefined());
    const supply: Action = [ActionType.Supply, BASE_ASSET, AMOUNT];
    act(() => live.queue.addOrUpdateAction(supply));
    chain.shouldRevertNext = true;

    await sendThenSwitchNetwork(wallet, show);
    wallet.releaseReceipts();
    show({ walletChainId: 1 });
    await waitFor(() => expect(live.manager.settledTransactions[0]?.outcome.status).toBe('reverted'));

    // It is queued again, and Submit sends it again, with no dialog.
    await waitFor(() => expect(queued()).toHaveLength(1));
    await submit();
    await waitFor(() => expect(sentCalls(wallet, 'supplyAndWrap')).toHaveLength(2));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(queued()).toEqual([]));
    expect(chain.balance).toBe(10_000_000_000n - AMOUNT);
  });
});

describe('the wrapped route through the real hooks, in the production order', () => {
  beforeEach(() => {
    mockNextId = 0;
  });

  it('Approve & Add asks the wallet for the exact approval at once and queues the supply; Submit then asks for the supply alone', async () => {
    const chain = chainFor();
    const { wallet } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason('supply')).toBeUndefined());
    wallet.holdReceipts();

    act(() => live.queue.setPendingAction([ActionType.Supply, BASE_ASSET, undefined]));
    act(() => positionCard().onPendingActionConfirm(AMOUNT));
    expect(queued()).toEqual([[ActionType.Supply, expect.anything(), AMOUNT]]);

    // The approval reaches the wallet with no other press, and its row shows Approval Pending.
    await waitFor(() => expect(sentCalls(wallet, 'approve')).toHaveLength(1));
    expect(CALLS.parseTransaction(sentCalls(wallet, 'approve')[0][0]).args.map(String)).toEqual([
      MARKET.wrapperAddress,
      String(AMOUNT),
    ]);
    await waitFor(() =>
      expect(positionCard().approvalTransactions).toEqual([
        expect.objectContaining({ key: BASE_ASSET.address, state: TransactionState.Pending }),
      ])
    );
    // An approval does not hold the dashboard.
    expect(positionCard().transaction).toBeUndefined();
    expect(sentCalls(wallet, 'supplyAndWrap')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();

    wallet.releaseReceipts();
    await waitFor(() => expect(live.action.state.phase).toBe('complete'));
    await waitFor(() => expect(positionCard().approvalTransactions).toEqual([]));
    expect(chain.allowance).toBe(AMOUNT);

    await submit();
    await waitFor(() => expect(queued()).toEqual([]));
    expect(wallet.sendUncheckedTransaction.mock.calls.map(([request]) => CALLS.parseTransaction(request).name)).toEqual(
      ['approve', 'supplyAndWrap']
    );
    expect(chain.balance).toBe(10_000_000_000n - AMOUNT);
    expect(chain.allowance).toBe(0n);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('returns the queue to Submit after a rejection in the wallet, and Submit sends the supply again', async () => {
    const chain = chainFor({ allowance: AMOUNT });
    const { wallet } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason('supply')).toBeUndefined());
    const supply: Action = [ActionType.Supply, BASE_ASSET, AMOUNT];
    act(() => live.queue.addOrUpdateAction(supply));
    wallet.sendUncheckedTransaction.mockRejectedValueOnce({ code: 4001, message: 'User rejected the request.' });

    await submit();
    expect(live.action.state.phase).toBe('stopped');

    expect(queued()).toEqual([supply]);
    expect(positionCard().transaction).toBeUndefined();
    expect(positionCard().actionRules.wrappedBase.stopped).toBeUndefined();
    expect(screen.queryByRole('dialog')).toBeNull();

    await submit();
    await waitFor(() => expect(queued()).toEqual([]));
    expect(sentCalls(wallet, 'supplyAndWrap')).toHaveLength(2);
    expect(chain.balance).toBe(10_000_000_000n - AMOUNT);
  });

  it('withdraws everything for a Max withdrawal with Confirm Transaction then Transaction Pending..., and clears it on the receipt', async () => {
    const chain = chainFor({ shares: 250n * 10n ** 18n });
    const { wallet } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, MAX_UINT256]));
    wallet.holdReceipts();
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const send = wallet.sendUncheckedTransaction.getMockImplementation();
    if (send === undefined) throw new Error('the wallet must send');
    wallet.sendUncheckedTransaction.mockImplementationOnce(async (request) => {
      await answered;
      return send(request);
    });

    act(() => positionCard().onSubmitClicked());
    // From the press until the wallet answers.
    expect(positionCard().transaction?.state).toBe(TransactionState.AwaitingConfirmation);
    await waitFor(() => expect(wallet.sendUncheckedTransaction).toHaveBeenCalledTimes(1));
    expect(positionCard().transaction?.state).toBe(TransactionState.AwaitingConfirmation);
    answer();
    await waitFor(() => expect(positionCard().transaction?.state).toBe(TransactionState.Pending));
    expect(screen.queryByRole('dialog')).toBeNull();

    wallet.releaseReceipts();
    await waitFor(() => expect(queued()).toEqual([]));
    expect(positionCard().transaction).toBeUndefined();
    expect(sentCalls(wallet, 'unwrapAndWithdraw')).toHaveLength(1);
    expect(chain.shares).toBe(0n);
  });

  it('asks the wallet to switch network on Submit from another network, as production does, and sends nothing', async () => {
    const chain = chainFor({ allowance: AMOUNT });
    const { wallet, show } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason('supply')).toBeUndefined());
    act(() => live.queue.addOrUpdateAction([ActionType.Supply, BASE_ASSET, AMOUNT]));
    show({ walletChainId: 8453 });
    switchWriteNetwork.mockClear();

    await submit();

    expect(switchWriteNetwork).toHaveBeenCalledWith(1);
    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(positionCard().transaction).toBeUndefined();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

/**
 * Another write through the same wallet provider fails as a provider broken by an extension update
 * does, so the transaction manager marks the wallet session unusable.
 */
async function breakSessionByAnotherWrite() {
  await act(async () => {
    await live.manager.submitTransaction({
      key: '0x0000000000000000000000000000000000000bb2',
      description: 'Another write',
      send: async () => {
        throw new Error("Cannot read properties of undefined (reading 'sendMessage')");
      },
    });
  });
  expect(live.action.session.status).toBe('unusable');
}

describe('a queued wrapper action when the wallet session breaks while it is being sent', () => {
  // The lifecycle warns of a step it stopped, and the manager logs the other write's error.
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

  it.each<[string, ActionType.Supply | ActionType.Withdraw, 'estimateGas' | 'getTransactionCount']>([
    ['a withdrawal whose gas is being estimated', ActionType.Withdraw, 'estimateGas'],
    ['a withdrawal whose nonce the manager is reading', ActionType.Withdraw, 'getTransactionCount'],
    ['a supply whose gas is being estimated', ActionType.Supply, 'estimateGas'],
  ])('keeps %s queued as not sent, and never asks the wallet to sign it', async (_name, type, heldRead) => {
    const isWithdraw = type === ActionType.Withdraw;
    const chain = isWithdraw ? chainFor({ shares: 250n * 10n ** 18n }) : chainFor({ allowance: AMOUNT });
    const { wallet } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason(isWithdraw ? 'withdraw' : 'supply')).toBeUndefined());
    const entry: Action = [type, BASE_ASSET, AMOUNT];
    act(() => live.queue.addOrUpdateAction(entry));
    // The read the request waits on before the wallet is asked to sign it.
    const read = held<unknown>();
    let isReadStarted = false;
    const readNow = wallet[heldRead].getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
    (wallet[heldRead] as jest.Mock).mockImplementationOnce(async (...args: unknown[]) => {
      isReadStarted = true;
      await read.promise;
      return readNow(...args);
    });

    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(isReadStarted).toBe(true));
    const { state } = live.action;
    expect(state.phase === 'signing' && state.steps[state.stepIndex]).toEqual({ status: 'awaiting-signature' });

    await breakSessionByAnotherWrite();
    await waitFor(() => expect(live.action.state.phase).toBe('stopped'));

    // Nothing reached the wallet, so the action stays queued, and its row asks for another try.
    await waitFor(() =>
      expect(positionCard().actionRules.wrappedBase.stopped).toEqual({ action: entry, label: 'Not Sent, Try Again' })
    );
    expect(queued()).toEqual([entry]);
    const stopped = live.action.state;
    if (stopped.phase !== 'stopped') throw new Error('the action must be stopped');
    expect(stopped.steps[stopped.stepIndex]).toEqual({ status: 'blocked', reason: 'session-unusable' });

    // The read answers late. The request is withdrawn at its next check, before the wallet.
    expect(live.writes.size).toBe(1);
    read.release(undefined);
    await waitFor(() => expect(live.writes.size).toBe(0));
    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(live.manager.transactions).toEqual([]);

    // Submit again is refused while the session stays unusable, and sends nothing.
    await submit();
    expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
    expect(queued()).toEqual([entry]);
  });

  it('takes a withdrawal the wallet was asked to sign out of the queue, and asks for it only once', async () => {
    const chain = chainFor({ shares: 250n * 10n ** 18n });
    const { wallet } = renderDashboard(chain);
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, AMOUNT];
    act(() => live.queue.addOrUpdateAction(entry));
    // The wallet holds the request and never answers.
    wallet.sendUncheckedTransaction.mockImplementationOnce(() => new Promise<string>(() => undefined));

    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(wallet.sendUncheckedTransaction).toHaveBeenCalledTimes(1));

    await breakSessionByAnotherWrite();
    await waitFor(() => expect(live.action.state.phase).toBe('stopped'));

    // The wallet can still send it, so it leaves the queue, as any stop that can still execute does.
    await waitFor(() => expect(queued()).toEqual([]));
    expect(positionCard().actionRules.wrappedBase.stopped).toBeUndefined();
    await submit();
    expect(wallet.sendUncheckedTransaction).toHaveBeenCalledTimes(1);

    const stopped = live.action.state;
    if (stopped.phase !== 'stopped') throw new Error('the action must be stopped');
    expect(stopped.steps[stopped.stepIndex]).toEqual({
      status: 'provider-failure',
      message:
        'The wallet stopped responding while it had the request. The request can still be approved in the wallet.',
      isStoppedBySessionFailure: true,
    });
  });
});
