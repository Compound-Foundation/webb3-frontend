import '@testing-library/jest-dom';
import { act, screen, waitFor } from '@testing-library/react';

import { MAX_UINT256 } from '@helpers/numbers';
import { Action, ActionType, TransactionState } from '@types';

import { mockEthCollateralAsset } from '../../../../__tests__/mocks/mockCollateralAssets';
import {
  ACCOUNT,
  BASE_ASSET,
  CALLS,
  Chain,
  chainFor,
  cometWithdrawals,
  DIRECT,
  executeLate,
  exitCashAt,
  expectHeldBack,
  expectQueueHeld,
  held,
  holdFirstStep,
  live,
  MARKET,
  positionCard,
  positionOn,
  productionWithdrawData,
  queued,
  renderDashboard,
  renderMixed,
  requestedCalls,
  sentCalls,
  stateWithDirectSupply,
  storedHolds,
  submit,
  USDC_COMET,
  waitForIdle,
  Wallet,
  WRAPPED_SHARES,
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

// The describe below is split across wrappedQueueSettlementDirectSupply1 to 3, in order,
// so that no test file runs much longer than the others. This file holds part 1.
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

  it.each([
    // A part below the direct supply is withdrawn as itself.
    ['below', 100_000_000n, 100_000_000n],
    // An amount equal to it is withdrawn with type(uint256).max, which never borrows.
    ['equal to', DIRECT, MAX_UINT256],
  ])(
    'sends an amount %s the direct supply as one Comet base withdrawal, the transaction production sends, and never calls the wrapper',
    async (_name, amount, sentAmount) => {
      const { chain, wallet } = await renderMixed();
      act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, amount]));

      await submit();
      await waitFor(() => expect(queued()).toEqual([]));

      expect(live.manager.settledTransactions.map(({ key, outcome }) => [key, outcome.status])).toEqual([
        [USDC_COMET, 'confirmed'],
      ]);
      expect(requestedCalls(wallet)).toEqual(['withdraw']);
      expect(cometWithdrawals(wallet)).toEqual([
        { to: USDC_COMET, data: productionWithdrawData(sentAmount), args: [MARKET.baseTokenAddress, sentAmount] },
      ]);
      expect(chain.directSupply).toBe(DIRECT - amount);
      expect(chain.borrowed).toBe(0n);
      expect(chain.shares).toBe(WRAPPED_SHARES);
      expect(chain.balance).toBe(10_000_000_000n + amount);
      expect(screen.queryByRole('dialog')).toBeNull();
    }
  );

  it('withdraws an amount equal to the direct supply without borrowing when the supply falls before signing', async () => {
    const { chain, wallet } = await renderMixed();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, DIRECT]));
    // 50 USDC of the direct supply leaves in another transaction after the fresh read, before the
    // Comet step executes. A finite withdraw(base, 250 USDC) would borrow 50 USDC.
    const send = wallet.cometSigner.sendTransaction.getMockImplementation();
    if (send === undefined) throw new Error('the signer must send');
    wallet.cometSigner.sendTransaction.mockImplementationOnce(async (request) => {
      chain.directSupply -= 50_000_000n;
      return send(request);
    });

    await submit();
    expect(live.manager.settledTransactions).toHaveLength(1);

    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([MAX_UINT256]);
    expect(chain.borrowed).toBe(0n);
    expect(chain.directSupply).toBe(0n);
    // Comet paid the 200 USDC it held. The split planned no wrapper step, so none is asked for: the
    // row keeps the 50 USDC rest and asks for a new amount.
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(queued()).toEqual([[ActionType.Withdraw, expect.anything(), 50_000_000n]]);
    expect(positionCard().actionRules.wrappedBase.stopped).toEqual({
      action: [ActionType.Withdraw, expect.anything(), 50_000_000n],
      label: 'Balance Changed, Edit Amount',
    });
  });

  it('sends a larger amount as Comet withdraw(base, max), then unwrapAndWithdraw for the rest only once the Comet step confirms', async () => {
    const { chain, wallet } = await renderMixed();
    const amount = 300_000_000n;
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, amount];
    act(() => live.queue.addOrUpdateAction(entry));
    const send = wallet.sendUncheckedTransaction.getMockImplementation();
    if (send === undefined) throw new Error('the wallet must send');
    const wrapperAnswer = held<void>();
    wallet.sendUncheckedTransaction.mockImplementationOnce(send).mockImplementationOnce(async (request) => {
      await wrapperAnswer.promise;
      return send(request);
    });
    wallet.holdReceipts();

    act(() => positionCard().onSubmitClicked());
    // From the press, the dashboard is held as for a transaction to Comet.
    expect(positionCard().transaction?.state).toBe(TransactionState.AwaitingConfirmation);
    await waitFor(() => expect(requestedCalls(wallet)).toEqual(['withdraw']));
    await waitFor(() => expect(positionCard().transaction?.state).toBe(TransactionState.Pending));
    // The Comet step's receipt is pending: nothing is asked of the wrapper, and the row is held.
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(cometWithdrawals(wallet)).toEqual([
      { to: USDC_COMET, data: productionWithdrawData(MAX_UINT256), args: [MARKET.baseTokenAddress, MAX_UINT256] },
    ]);
    expectQueueHeld(entry);
    expect(positionCard().transaction?.state).toBe(TransactionState.Pending);

    wallet.releaseReceipts();
    await waitFor(() => expect(requestedCalls(wallet)).toEqual(['withdraw', 'unwrapAndWithdraw']));
    // The row now holds what the wrapper still pays, and stays held while the wallet has the request.
    expect(queued()).toEqual([[ActionType.Withdraw, expect.anything(), amount - DIRECT]]);
    expect(positionCard().transaction?.state).toBe(TransactionState.AwaitingConfirmation);
    expect(chain.directSupply).toBe(0n);

    const beforeExit = { ...chain };
    wrapperAnswer.release();
    await waitFor(() => expect(queued()).toEqual([]));
    const [unwrap] = sentCalls(wallet, 'unwrapAndWithdraw');
    const burned = BigInt(CALLS.parseTransaction(unwrap[0]).args[0].toString());
    expect(beforeExit.shares - chain.shares).toBe(burned);
    // The fewest shares that pay the rest: one share fewer pays less.
    expect(exitCashAt(beforeExit, burned)).toBeGreaterThanOrEqual(amount - DIRECT);
    expect(exitCashAt(beforeExit, burned - 1n)).toBeLessThan(amount - DIRECT);
    expect(chain.borrowed).toBe(0n);
    expect(chain.balance - 10_000_000_000n).toBeGreaterThanOrEqual(amount);
    expect(chain.balance - 10_000_000_000n).toBeLessThan(amount + 10n);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('withdraws everything for Max: Comet withdraw(base, max), then a full exit of every share', async () => {
    const { chain, wallet } = await renderMixed();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, MAX_UINT256]));

    await submit();
    await waitFor(() => expect(queued()).toEqual([]));

    expect(requestedCalls(wallet)).toEqual(['withdraw', 'unwrapAndWithdraw']);
    expect(cometWithdrawals(wallet)[0].args).toEqual([MARKET.baseTokenAddress, MAX_UINT256]);
    const [unwrap] = sentCalls(wallet, 'unwrapAndWithdraw');
    expect(BigInt(CALLS.parseTransaction(unwrap[0]).args[0].toString())).toBe(WRAPPED_SHARES);
    expect(chain.directSupply).toBe(0n);
    expect(chain.shares).toBe(0n);
    expect(chain.borrowed).toBe(0n);
  });

  it.each<[string, (wallet: Wallet, chain: Chain) => void, { queue: 'kept' | 'rest'; label?: string }]>([
    [
      'is declined in the wallet',
      (wallet) => wallet.sendUncheckedTransaction.mockRejectedValueOnce({ code: 4001, message: 'User rejected.' }),
      { queue: 'kept' },
    ],
    ['reverts', (_wallet, chain) => (chain.shouldRevertNext = true), { queue: 'kept', label: 'Transaction Failed' }],
    [
      'is refused by the wallet before it handles it',
      (wallet) => wallet.sendUncheckedTransaction.mockRejectedValueOnce({ code: 4100, message: 'Unauthorized' }),
      { queue: 'kept', label: 'Reconnect Your Wallet' },
    ],
    [
      'fails in the wallet after it had the request',
      (wallet) => wallet.sendUncheckedTransaction.mockRejectedValueOnce({ code: -32603, message: 'Internal error' }),
      { queue: 'rest' },
    ],
  ])('sends nothing to the wrapper when the Comet step %s', async (_name, fail, expected) => {
    const { chain, wallet } = await renderMixed();
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, 300_000_000n];
    act(() => live.queue.addOrUpdateAction(entry));
    fail(wallet, chain);

    await submit();

    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(sentCalls(wallet, 'unwrapAndWithdraw')).toHaveLength(0);
    expect(chain.shares).toBe(WRAPPED_SHARES);
    expect(chain.borrowed).toBe(0n);
    expect(queued()).toEqual(
      expected.queue === 'kept' ? [entry] : [[ActionType.Withdraw, expect.anything(), 300_000_000n - DIRECT]]
    );
    const stopped = positionCard().actionRules.wrappedBase.stopped;
    expect(stopped).toEqual(
      expected.label === undefined
        ? undefined
        : { action: [ActionType.Withdraw, expect.anything(), entry[2]], label: expected.label }
    );
    expect(positionCard().transaction).toBeUndefined();
  });

  it('leaves the rest queued, and asks the wrapper for nothing, when the Comet step confirms while another page is shown', async () => {
    const { chain, wallet, show } = await renderMixed();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 300_000_000n]));
    wallet.holdReceipts();
    act(() => positionCard().onSubmitClicked());
    await waitFor(() => expect(requestedCalls(wallet)).toEqual(['withdraw']));

    show({ isHomeShown: false });
    wallet.releaseReceipts();
    await waitFor(() => expect(live.manager.settledTransactions).toHaveLength(1));
    // The run ends with the Comet step.
    await waitForIdle();

    // No wallet request opens on another page. The row holds what the wrapper still pays.
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(chain.directSupply).toBe(0n);
    expect(queued()).toEqual([[ActionType.Withdraw, expect.anything(), 50_000_000n]]);

    show({ isHomeShown: true });
    await waitForIdle();
    expect(requestedCalls(wallet)).toEqual(['withdraw']);
    expect(positionCard().transaction).toBeUndefined();
  });

  it.each<[string, (collateral: ReturnType<typeof mockEthCollateralAsset>) => Action]>([
    ['a collateral supply', (collateral) => [ActionType.SupplyCollateral, collateral, 10n ** 17n]],
    ['a borrow', () => [ActionType.Borrow, BASE_ASSET, 100_000_000n]],
  ])('refuses %s beside the queued withdrawal, so the split is submitted on its own', async (_name, other) => {
    const chain = chainFor({ shares: WRAPPED_SHARES, directSupply: DIRECT });
    const collateral = mockEthCollateralAsset({ walletBalance: 10n ** 18n, allowance: MAX_UINT256 });
    const { wallet } = renderDashboard(chain, {
      state: stateWithDirectSupply(DIRECT, [collateral]),
      position: positionOn(chain),
    });
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    const entry: Action = [ActionType.Withdraw, BASE_ASSET, MAX_UINT256];
    act(() => live.queue.addOrUpdateAction(entry));
    // The wrapped route's queue holds one action, so the second one is refused before Submit.
    let added: boolean | undefined;
    act(() => {
      added = live.queue.addOrUpdateAction(other(collateral));
    });
    expect(added).toBe(false);
    expect(queued()).toEqual([entry]);

    await submit();
    await waitFor(() => expect(queued()).toEqual([]));

    expect(requestedCalls(wallet)).toEqual(['withdraw', 'unwrapAndWithdraw']);
    expect(cometWithdrawals(wallet)[0].args).toEqual([MARKET.baseTokenAddress, MAX_UINT256]);
    expect(chain.directSupply).toBe(0n);
    expect(chain.shares).toBe(0n);
    expect(chain.borrowed).toBe(0n);
  });

  it('stores a Comet step the wallet still holds (Anchorage 4900) as a hold with its calldata and block', async () => {
    await holdFirstStep();

    // Not shown as a transaction to follow: the dashboard is free, and the next Comet step is held.
    expect(positionCard().transaction).toBeUndefined();
    expect(storedHolds()).toEqual([
      {
        kind: 'held',
        id: expect.any(String),
        account: ACCOUNT.toLowerCase(),
        chainId: 1,
        cometAddress: USDC_COMET.toLowerCase(),
        calldata: productionWithdrawData(200_000_000n).toLowerCase(),
        amount: '200000000',
        blockNumber: 100,
      },
    ]);
  });

  it('holds back a second partial withdrawal after a 4900, so the two never borrow', async () => {
    const { chain, wallet, entry } = await holdFirstStep();
    act(() => live.queue.addOrUpdateAction(entry));
    await expectHeldBack(wallet, chain, entry);
  });

  it('keeps the hold after a change of market and back', async () => {
    const { chain, wallet, show, entry } = await holdFirstStep();
    // USDT is selected, then USDC again: App's store follows the other market meanwhile.
    show({
      isHomeShown: false,
      storeMarket: { chainId: 1, cometAddress: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840' },
    });
    await waitFor(() => expect(live.submission.record).toBeUndefined());
    show({ isHomeShown: true });
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    act(() => live.queue.addOrUpdateAction(entry));
    await expectHeldBack(wallet, chain, entry);
  });

  it('keeps the hold when the row is removed and added again, or edited', async () => {
    const { chain, wallet, entry } = await holdFirstStep();
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 150_000_000n]));
    act(() => live.queue.removeAction([ActionType.Withdraw, BASE_ASSET, 150_000_000n]));
    act(() => live.queue.addOrUpdateAction([ActionType.Withdraw, BASE_ASSET, 100_000_000n]));
    // Edited to the same 200 USDC.
    act(() => live.queue.addOrUpdateAction(entry));
    await expectHeldBack(wallet, chain, entry);
  });

  it('keeps the hold across a reload, from what storage holds', async () => {
    const { chain, wallet, reload, entry } = await holdFirstStep();
    reload();
    await waitFor(() => expect(live.action.blockedReason('withdraw')).toBeUndefined());
    act(() => live.queue.addOrUpdateAction(entry));
    await expectHeldBack(wallet, chain, entry);
  });

  it('keeps the hold when the transaction list is cleared', async () => {
    const { chain, wallet, entry } = await holdFirstStep();
    act(() => live.manager.clearTransactions());
    await waitFor(() => expect(live.manager.transactions).toEqual([]));
    act(() => live.queue.addOrUpdateAction(entry));
    await expectHeldBack(wallet, chain, entry);
  });

  it('ends the hold once the held calldata is found mined from the account, and then sends the next Comet step', async () => {
    const { chain, wallet, entry } = await holdFirstStep();
    executeLate(chain);
    // 30 USDC more: within the 50 USDC the direct supply still holds.
    const next: Action = [ActionType.Withdraw, BASE_ASSET, 30_000_000n];
    act(() => live.queue.addOrUpdateAction(next));

    await submit();
    await waitFor(() => expect(queued()).toEqual([]));

    expect(cometWithdrawals(wallet).map(({ args }) => args[1])).toEqual([entry[2], 30_000_000n]);
    await waitFor(() => expect(storedHolds()).toEqual([]));
    expect(chain.directSupply).toBe(20_000_000n);
    expect(chain.borrowed).toBe(0n);
  });

  it('ends the hold once the Comet state is read again and the held calldata is found mined', async () => {
    const { chain, show } = await holdFirstStep();
    executeLate(chain);
    // useCometState reads the account again, and finds 50 USDC.
    show({ state: stateWithDirectSupply(50_000_000n) });
    await waitFor(() => expect(storedHolds()).toEqual([]));
  });
});
