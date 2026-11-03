import { TransactionReceipt } from '@ethersproject/providers';
import { act, renderHook } from '@testing-library/react';

import { SentWrapperAction, SubmissionRecord } from '@contexts/WrappedLendingContext';
import { sentActionStatus, useSubmissionStore, UseSubmissionStoreOptions } from '@hooks/useSubmissionStore';
import {
  Action,
  ActionType,
  AwaitingConfirmationTransaction,
  PendingTransaction,
  SettledTransaction,
  Transaction,
  TransactionOutcome,
  TransactionState,
} from '@types';

import { mockBaseAsset } from '../mocks/mockBaseAsset';

const ACCOUNT = '0x0000000000000000000000000000000000000aa1';
const WRAPPER = '0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73';
const ACTION: Action = [ActionType.Supply, mockBaseAsset(), 1_000_000n];

const SENT: SentWrapperAction = {
  scope: 'queue-scope',
  action: ACTION,
  type: 'supply',
  account: ACCOUNT,
  chainId: 1,
  wrapperAddress: WRAPPER,
};

function awaiting(overrides: Partial<AwaitingConfirmationTransaction> = {}): AwaitingConfirmationTransaction {
  return {
    id: 'transaction-1',
    key: WRAPPER.toLowerCase(),
    networkId: 1,
    networkName: 'homestead',
    description: 'Supply 1.000000 USDC',
    nonce: 5,
    account: ACCOUNT,
    step: 'supply',
    state: TransactionState.AwaitingConfirmation,
    ...overrides,
  };
}

function pending(overrides: Partial<PendingTransaction> = {}): PendingTransaction {
  return { ...awaiting(), state: TransactionState.Pending, hash: `0x${'1'.repeat(64)}`, ...overrides };
}

function settled(outcome: TransactionOutcome): SettledTransaction {
  return { ...pending(), outcome };
}
const receipt = { status: 1 } as TransactionReceipt;

describe('sentActionStatus', () => {
  it("links the account's record of the last step on the chain and wrapper", () => {
    expect(sentActionStatus(SENT, true, [awaiting()], [])).toEqual({ kind: 'linked', transactionId: 'transaction-1' });
    expect(sentActionStatus({ ...SENT, type: 'withdraw' }, true, [pending({ step: 'withdraw' })], [])).toEqual({
      kind: 'linked',
      transactionId: 'transaction-1',
    });
  });

  it.each<[string, Transaction]>([
    ['an approval', awaiting({ step: 'approve' })],
    ['another chain', awaiting({ networkId: 8453 })],
    ['another account', awaiting({ account: '0x0000000000000000000000000000000000000bb2' })],
    ['another contract', awaiting({ key: '0x0000000000000000000000000000000000000cc3' })],
  ])('never links a record of %s', (_, transaction) => {
    expect(sentActionStatus(SENT, true, [transaction], [])).toEqual({ kind: 'pending' });
    expect(sentActionStatus(SENT, false, [transaction], [])).toEqual({ kind: 'not-executed' });
  });

  it('waits while the submission is open, and releases the action once it ends before the last step', () => {
    expect(sentActionStatus(SENT, true, [], [])).toEqual({ kind: 'pending' });
    expect(sentActionStatus(SENT, false, [], [])).toEqual({ kind: 'not-executed' });
  });

  it('holds a linked step in the wallet or pending, after the submission is dropped', () => {
    const linked = { ...SENT, transactionId: 'transaction-1' };

    expect(sentActionStatus(linked, false, [awaiting()], [])).toEqual({ kind: 'pending' });
    expect(sentActionStatus(linked, false, [pending()], [])).toEqual({ kind: 'pending' });
  });

  it('reports a linked step that confirmed as executed, and an interrupted one as possibly executed', () => {
    const linked = { ...SENT, transactionId: 'transaction-1' };

    expect(sentActionStatus(linked, false, [], [settled({ status: 'confirmed', receipt })])).toEqual({
      kind: 'executed',
    });
    expect(sentActionStatus(linked, false, [awaiting({ isInterrupted: true })], [])).toEqual({
      kind: 'may-have-executed',
    });
  });

  it('reports a linked step whose nonce another transaction took as possibly executed', () => {
    // A sped-up copy of the same call takes the nonce under another hash, and executes.
    const linked = { ...SENT, transactionId: 'transaction-1' };

    expect(sentActionStatus(linked, false, [], [settled({ status: 'replaced' })])).toEqual({
      kind: 'may-have-executed',
    });
  });

  it('reports a linked step that reverted, or was forgotten unsent, as not executed', () => {
    const linked = { ...SENT, transactionId: 'transaction-1' };

    expect(sentActionStatus(linked, false, [], [settled({ status: 'reverted', receipt })])).toEqual({
      kind: 'not-executed',
    });
    expect(sentActionStatus(linked, false, [], [])).toEqual({ kind: 'not-executed' });
  });
});

describe('useSubmissionStore', () => {
  // A supply submitted from the queue, still running.
  const RECORD: SubmissionRecord = {
    kind: 'execute',
    wrapper: { type: 'supply', action: ACTION, amount: 1_000_000n },
    scope: 'scope-1',
    status: { kind: 'running' },
    stateBefore: { phase: 'idle' },
  };

  function renderStore(initial: Partial<UseSubmissionStoreOptions> = {}) {
    const removeAction = jest.fn();
    const options: UseSubmissionStoreOptions = {
      scope: 'scope-1',
      queueScope: 'queue-scope',
      transactions: [],
      settledTransactions: [],
      removeAction,
      ...initial,
    };
    const hook = renderHook((props: UseSubmissionStoreOptions) => useSubmissionStore(props), {
      initialProps: options,
    });
    const rerender = (changes: Partial<UseSubmissionStoreOptions>) => hook.rerender({ ...options, ...changes });
    return { ...hook, removeAction, rerender };
  }

  it('keeps a sent action across a change of network, which drops the run, until its step confirms', () => {
    const { result, rerender, removeAction } = renderStore();
    act(() => {
      result.current.setRecord(() => RECORD);
      result.current.setSent(SENT);
    });
    rerender({ transactions: [pending()] });
    expect(result.current.sent).toEqual({ ...SENT, transactionId: 'transaction-1' });

    // The wallet's network is part of the run's scope, but not the queue's.
    rerender({ scope: 'scope-on-base', transactions: [pending()] });
    expect(result.current.record).toBeUndefined();
    expect(result.current.sent).toEqual({ ...SENT, transactionId: 'transaction-1' });
    expect(removeAction).not.toHaveBeenCalled();

    rerender({ settledTransactions: [settled({ status: 'confirmed', receipt })] });
    expect(removeAction).toHaveBeenCalledWith(ACTION);
    expect(result.current.sent).toBeUndefined();
  });

  it('drops a sent action with the queue, after a change of account, connector, connection or market', () => {
    const { result, rerender, removeAction } = renderStore({ transactions: [pending()] });
    act(() => result.current.setSent(SENT));
    expect(result.current.sent).toBeDefined();

    rerender({ queueScope: 'other-account', transactions: [pending()] });
    expect(result.current.sent).toBeUndefined();
    rerender({ transactions: [pending()] });
    expect(result.current.sent).toBeUndefined();
    expect(removeAction).not.toHaveBeenCalled();
  });

  it.each<[string, SubmissionRecord | undefined]>([
    ['ended', undefined],
    ['stopped with nothing sent', { ...RECORD, status: { kind: 'stopped', label: 'Not Sent, Try Again' } }],
  ])('releases a sent action whose run %s before its last step reached the wallet', (_name, ending) => {
    const { result, removeAction } = renderStore();
    act(() => {
      result.current.setRecord(() => RECORD);
      result.current.setSent(SENT);
    });
    expect(result.current.sent).toBeDefined();

    act(() => result.current.setRecord(() => ending));
    expect(result.current.sent).toBeUndefined();
    expect(removeAction).not.toHaveBeenCalled();
  });

  it("does not hold a sent action for Approve & Add's approval, which never sends the supply", () => {
    const { result } = renderStore();
    const approval: SubmissionRecord = {
      kind: 'approve',
      action: ACTION,
      scope: 'scope-1',
      status: { kind: 'running' },
      stateBefore: { phase: 'idle' },
    };
    act(() => {
      result.current.setRecord(() => approval);
      result.current.setSent(SENT);
    });

    expect(result.current.sent).toBeUndefined();
  });
});
