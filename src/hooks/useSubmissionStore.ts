import { useEffect, useState } from 'react';

import type { SentWrapperAction, SubmissionRecord, SubmissionStore } from '@contexts/WrappedLendingContext';
import type { WrappedActionType } from '@helpers/wrappedActions';
import { Action, SettledTransaction, Transaction, TransactionState } from '@types';

import { WRAPPED_SUPPLY_STEP_IDS, WRAPPED_WITHDRAW_STEP_ID } from './useWriteWrappedState';

/** The step of each wrapper action that carries it out. The steps before it only approve. */
const LAST_STEP_IDS: Record<WrappedActionType, string> = {
  supply: WRAPPED_SUPPLY_STEP_IDS.supply,
  withdraw: WRAPPED_WITHDRAW_STEP_ID,
};

/**
 * Where a sent wrapper action stands:
 * - `pending`: its last step can still reach the wallet, or is in the wallet or on its way to a
 *   receipt. Its queue entry stays held.
 * - `linked`: its last step has just reached the transaction manager, under this id.
 * - `executed`: the last step confirmed.
 * - `may-have-executed`: the last step can have executed without a receipt for its own hash. The
 *   wallet answered it with an error after it can have sent it, or another transaction took its
 *   nonce, which a sped-up copy of the same call also does. The entry leaves the queue so that it
 *   is not sent twice.
 * - `not-executed`: the last step reverted, or never reached the chain: the wallet declined or
 *   refused it, it was withdrawn, or the run ended before it.
 */
export type SentActionStatus =
  | { kind: 'pending' }
  | { kind: 'linked'; transactionId: string }
  | { kind: 'executed' }
  | { kind: 'may-have-executed' }
  | { kind: 'not-executed' };

/**
 * What became of a sent wrapper action, from the transaction manager's records. `isSubmissionOpen`
 * is whether the run that started it is still running in its scope.
 *
 * The lifecycle starts a wrapper action only when no other wrapper transaction of the account is
 * pending on the chain, so the only record of the last step for the account, chain and wrapper is
 * this action's. The manager records the step before it asks the wallet, and asks only while the
 * run's draft is current: a run dropped or stopped with no record never sends one.
 */
export function sentActionStatus(
  sent: SentWrapperAction,
  isSubmissionOpen: boolean,
  transactions: readonly Transaction[],
  settledTransactions: readonly SettledTransaction[]
): SentActionStatus {
  if (sent.transactionId === undefined) {
    const lastStep = transactions.find(
      (transaction) =>
        transaction.step === LAST_STEP_IDS[sent.type] &&
        transaction.key.toLowerCase() === sent.wrapperAddress.toLowerCase() &&
        transaction.account === sent.account &&
        transaction.networkId === sent.chainId
    );
    if (lastStep !== undefined) return { kind: 'linked', transactionId: lastStep.id };
    return isSubmissionOpen ? { kind: 'pending' } : { kind: 'not-executed' };
  }
  const tracked = transactions.find((transaction) => transaction.id === sent.transactionId);
  if (tracked !== undefined) {
    const isInterrupted = tracked.state === TransactionState.AwaitingConfirmation && tracked.isInterrupted === true;
    return isInterrupted ? { kind: 'may-have-executed' } : { kind: 'pending' };
  }
  const settled = settledTransactions.find((transaction) => transaction.id === sent.transactionId);
  switch (settled?.outcome.status) {
    case 'confirmed':
      return { kind: 'executed' };
    case 'replaced':
      return { kind: 'may-have-executed' };
    default:
      return { kind: 'not-executed' };
  }
}

export type UseSubmissionStoreOptions = {
  /** The `submissionScope` now. The wrapped run belongs to the scope it started in. */
  scope: string;
  /** The `queueScope` now. The sent wrapper action belongs to the scope it started in. */
  queueScope: string;
  transactions: readonly Transaction[];
  settledTransactions: readonly SettledTransaction[];
  /** Takes an action out of the live queue. */
  removeAction: (action: Action) => void;
};

/**
 * The wrapped run and the queued wrapper action it submitted, as App keeps them. A change of
 * `submissionScope`, the wallet's network included, drops the run, so no callback of it signs
 * another step. The sent wrapper action is followed until its last step's outcome is known,
 * across a change of network: an entry whose last step confirmed leaves the queue, and one whose
 * last step did not execute is released. A change of `queueScope` drops it with the queue itself.
 */
export function useSubmissionStore({
  scope,
  queueScope,
  transactions,
  settledTransactions,
  removeAction,
}: UseSubmissionStoreOptions): SubmissionStore {
  const [record, setRecord] = useState<SubmissionRecord>();
  const [sentRecord, setSentRecord] = useState<SentWrapperAction>();
  // A return to the same scope never brings back a record from before the change.
  useEffect(() => {
    setRecord((current) => (current !== undefined && current.scope !== scope ? undefined : current));
  }, [scope]);
  useEffect(() => {
    setSentRecord((current) => (current !== undefined && current.scope !== queueScope ? undefined : current));
  }, [queueScope]);
  const submission = record?.scope === scope ? record : undefined;
  const sent = sentRecord?.scope === queueScope ? sentRecord : undefined;

  // Only a supply or withdrawal still running can still hand its last step to the manager.
  const isSubmissionOpen = submission?.kind === 'execute' && submission.status.kind === 'running';
  useEffect(() => {
    if (sent === undefined) return;
    const status = sentActionStatus(sent, isSubmissionOpen, transactions, settledTransactions);
    const drop = () => setSentRecord((current) => (current === sent ? undefined : current));
    switch (status.kind) {
      case 'pending':
        return;
      case 'linked':
        setSentRecord((current) => (current === sent ? { ...sent, transactionId: status.transactionId } : current));
        return;
      case 'executed':
      case 'may-have-executed':
        removeAction(sent.action);
        drop();
        return;
      case 'not-executed':
        drop();
        return;
      default: {
        const unhandled: never = status;
        throw new Error(`Unhandled sent action status ${JSON.stringify(unhandled)}`);
      }
    }
  }, [sent, isSubmissionOpen, transactions, settledTransactions]);

  return { record: submission, setRecord, sent, setSent: setSentRecord };
}
