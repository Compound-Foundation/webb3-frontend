import { createContext, useContext } from 'react';

import { LendingRoute } from '@helpers/lendingRoute';
import type { QueuedWrapperAction } from '@helpers/queuedExecution';
import type { WrappedActionType } from '@helpers/wrappedActions';
import { IDLE_WRAPPED_ACTION, WrappedActionController, WrappedActionState } from '@hooks/useWrappedAction';
import { WrappedPositionState } from '@hooks/useWrappedPosition';
import { IDLE_WRITE_WRAPPED_STATE, WriteWrappedState } from '@hooks/useWriteWrappedState';
import type { Action } from '@types';

/**
 * A wrapper action the dashboard started, and what became of it:
 * - `approve`: Approve & Add's approval for a queued base supply. It never locks the queue.
 * - `execute`: Submit Transaction's supply or withdrawal, before the direct actions queued with it.
 *   Once it confirms, it leaves the queue and the direct actions are submitted as before.
 */
export type WrappedRun =
  | { kind: 'approve'; action: Action }
  | {
      kind: 'execute';
      wrapper: QueuedWrapperAction;
      /** How many queued actions go to Comet or the Bulker after the wrapper action. */
      directCount: number;
    };

/** Where a wrapped run stands. */
export type WrappedRunStatus =
  /** Being read, checked, signed or followed to its receipt. */
  | { kind: 'running' }
  /** The wrapper action confirmed and left the queue. The direct actions are submitted next. */
  | { kind: 'executed' }
  /** It stopped with nothing sent. Its queue row shows `label`, and it can be submitted again. */
  | { kind: 'stopped'; label: string };

/** A wrapped run, with the session and market it belongs to. */
export type SubmissionRecord = WrappedRun & {
  /** The `submissionScope` it was started in. No other scope shows it or acts on it. */
  scope: string;
  status: WrappedRunStatus;
  /**
   * The lifecycle's state when the run started. It belongs to an earlier run, so this run never
   * takes a step, or a completion, from it.
   */
  stateBefore: WrappedActionState;
};

/**
 * A queued wrapper action that was submitted, from its start until what became of its last step is
 * known. Its queue entry is never submitted again meanwhile. A change of the wallet's network drops
 * the run, and the lifecycle ignores what its draft sent, but the last step can still have reached
 * the wallet. Unless this record is kept, the entry stays queued after that step confirms, and the
 * next submission sends it again. It shows nothing of its own.
 */
export type SentWrapperAction = {
  /** The `queueScope` it was started in. A change of scope also resets the queue, entry included. */
  scope: string;
  /** The queue entry the wrapper action carries out. */
  action: Action;
  type: WrappedActionType;
  /** The sender, in lower case. */
  account: string;
  chainId: number;
  wrapperAddress: string;
  /** The transaction manager's record of the last step, once the step reaches the manager. */
  transactionId?: string;
};

/**
 * The account, connector, connection status and market the queue belongs to. The wallet's network
 * is not part of it, as it is not part of the queue's session, so a sent wrapper action is followed
 * across a change of network.
 */
export function queueScope(
  write: { account: string | undefined; connector?: { uid?: string }; status: string },
  market: { chainId: number; cometAddress: string } | undefined
): string {
  return [
    write.account?.toLowerCase() ?? '',
    write.connector?.uid ?? '',
    write.status,
    market === undefined ? '' : `${market.chainId}:${market.cometAddress.toLowerCase()}`,
  ].join('|');
}

/**
 * The account, connector, connection status, wallet network and market a wrapped run belongs to. The
 * wrapper action lifecycle discards its draft when any of them changes, and the run is dropped.
 */
export function submissionScope(
  write: { account: string | undefined; connector?: { uid?: string }; status: string; chainId: number | undefined },
  market: { chainId: number; cometAddress: string } | undefined
): string {
  return [
    write.account?.toLowerCase() ?? '',
    write.connector?.uid ?? '',
    write.status,
    write.chainId ?? '',
    market === undefined ? '' : `${market.chainId}:${market.cometAddress.toLowerCase()}`,
  ].join('|');
}

/**
 * The wrapped run, and the queued wrapper action it submitted. App keeps both with the lifecycle,
 * so they survive the dashboard's unmount: on return the run's completion still takes the wrapper
 * action out of the queue.
 */
export type SubmissionStore = {
  record: SubmissionRecord | undefined;
  setRecord: (update: (current: SubmissionRecord | undefined) => SubmissionRecord | undefined) => void;
  /** The wrapper action submitted from the queue, until what became of its last step is known. */
  sent: SentWrapperAction | undefined;
  setSent: (sent: SentWrapperAction | undefined) => void;
};

/**
 * What the selected market's wrapped lending needs in this session. `route` is its lending route
 * and `position` the wrapped position read for it. `action` is the wrapper action lifecycle, with
 * its check of the wallet session, and `write` starts an action in that lifecycle. `submission` is
 * the wrapped run that drives them.
 */
export type WrappedLending = {
  route: LendingRoute;
  position: WrappedPositionState;
  retry: () => void;
  action: WrappedActionController;
  write: WriteWrappedState;
  submission: SubmissionStore;
};

/** The value outside a provider: the standard route, with no wrapped position or action. */
export const STANDARD_LENDING: WrappedLending = Object.freeze({
  route: { kind: 'standard', writes: { isEligible: false, reason: 'disconnected' } },
  position: { status: 'not-applicable' },
  retry: () => undefined,
  action: IDLE_WRAPPED_ACTION,
  write: IDLE_WRITE_WRAPPED_STATE,
  submission: { record: undefined, setRecord: () => undefined, sent: undefined, setSent: () => undefined },
});

export const WrappedLendingContext = createContext<WrappedLending>(STANDARD_LENDING);

export function useWrappedLending(): WrappedLending {
  return useContext(WrappedLendingContext);
}
