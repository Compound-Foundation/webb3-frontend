import { createContext, useContext } from 'react';

import { LendingRoute } from '@helpers/lendingRoute';
import { IDLE_WRAPPED_ACTION, WrappedActionController } from '@hooks/useWrappedAction';
import { WrappedPositionState } from '@hooks/useWrappedPosition';
import { IDLE_WRITE_WRAPPED_STATE, WriteWrappedState } from '@hooks/useWriteWrappedState';

/**
 * What the selected market's wrapped lending needs in this session. `route` is its lending route
 * and `position` the wrapped position read for it. `action` is the wrapper action lifecycle, with
 * its check of the wallet session, and `write` starts a review in that lifecycle.
 */
export type WrappedLending = {
  route: LendingRoute;
  position: WrappedPositionState;
  retry: () => void;
  action: WrappedActionController;
  write: WriteWrappedState;
};

/** The value outside a provider: the standard route, with no wrapped position or action. */
export const STANDARD_LENDING: WrappedLending = Object.freeze({
  route: { kind: 'standard', writes: { isEligible: false, reason: 'disconnected' } },
  position: { status: 'not-applicable' },
  retry: () => undefined,
  action: IDLE_WRAPPED_ACTION,
  write: IDLE_WRITE_WRAPPED_STATE,
});

export const WrappedLendingContext = createContext<WrappedLending>(STANDARD_LENDING);

export function useWrappedLending(): WrappedLending {
  return useContext(WrappedLendingContext);
}
