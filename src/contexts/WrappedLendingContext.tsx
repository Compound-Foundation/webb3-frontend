import { createContext, useContext } from 'react';

import { LendingRoute } from '@helpers/lendingRoute';
import type { QueuedWrapperAction } from '@helpers/queuedExecution';
import type { WrappedActionDraft, WrappedBlockReason } from '@helpers/wrappedActions';
import { IDLE_WRAPPED_ACTION, WrappedActionController, WrappedActionState } from '@hooks/useWrappedAction';
import { WrappedPositionState } from '@hooks/useWrappedPosition';
import { IDLE_WRITE_WRAPPED_STATE, WriteWrappedState } from '@hooks/useWriteWrappedState';

/** A queue being submitted on the wrapped route: the wrapper action first, then the direct actions. */
export type QueuedSubmission = {
  wrapper: QueuedWrapperAction;
  /** How many queued actions go to Comet or the Bulker after the wrapper action, in one transaction. */
  directCount: number;
  /** Why the wrapper action did not start, if it did not. Nothing was sent. */
  refusal?: WrappedBlockReason;
  /** Whether the wrapper action confirmed and left the queue. */
  isWrapperDone: boolean;
  /**
   * Whether the wrapper action stopped at its last step in a state where it can still go through, such
   * as a request the wallet still holds. It then left the queue, so it is not submitted twice.
   */
  mayHaveExecuted?: boolean;
};

/** A queued submission, with the session and market it belongs to. */
export type SubmissionRecord = QueuedSubmission & {
  /** The `submissionScope` it was started in. No other scope shows it or acts on it. */
  scope: string;
  /**
   * The lifecycle's state when the submission started. It belongs to an earlier review, so the
   * submission never takes a step, or a completion, from it.
   */
  stateBefore: WrappedActionState;
  /** The draft and step the user hid the dialog for while it was being signed. */
  hiddenWhileSigning?: { draft: WrappedActionDraft; stepIndex: number };
};

/**
 * The account, connector, connection status, wallet network and market a submission belongs to. The
 * wrapper action lifecycle discards its draft when any of them changes, and so does the submission.
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
 * The queued submission in progress. App keeps it with the lifecycle, so a submission survives the
 * dashboard's unmount: on return the dialog shows it again, and its completion still takes the wrapper
 * action out of the queue.
 */
export type SubmissionStore = {
  record: SubmissionRecord | undefined;
  setRecord: (update: (current: SubmissionRecord | undefined) => SubmissionRecord | undefined) => void;
};

/**
 * What the selected market's wrapped lending needs in this session. `route` is its lending route
 * and `position` the wrapped position read for it. `action` is the wrapper action lifecycle, with
 * its check of the wallet session, and `write` starts a review in that lifecycle. `submission` is
 * the queued submission that drives them.
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
  submission: { record: undefined, setRecord: () => undefined },
});

export const WrappedLendingContext = createContext<WrappedLending>(STANDARD_LENDING);

export function useWrappedLending(): WrappedLending {
  return useContext(WrappedLendingContext);
}
