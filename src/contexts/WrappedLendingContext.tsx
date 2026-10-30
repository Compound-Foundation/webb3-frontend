import { createContext, useContext } from 'react';

import { LendingRoute } from '@helpers/lendingRoute';
import { IDLE_WRAPPED_ACTION, WrappedActionController } from '@hooks/useWrappedAction';
import { WrappedPositionState } from '@hooks/useWrappedPosition';

/**
 * The selected market's lending route for this session, the wrapped position it reads, and the
 * wrapper action lifecycle with its check of the wallet session.
 */
export type WrappedLending = {
  route: LendingRoute;
  position: WrappedPositionState;
  retry: () => void;
  action: WrappedActionController;
};

/** The value outside a provider: the standard route, with no wrapped position or action. */
export const STANDARD_LENDING: WrappedLending = Object.freeze({
  route: { kind: 'standard', writes: { isEligible: false, reason: 'disconnected' } },
  position: { status: 'not-applicable' },
  retry: () => undefined,
  action: IDLE_WRAPPED_ACTION,
});

export const WrappedLendingContext = createContext<WrappedLending>(STANDARD_LENDING);

export function useWrappedLending(): WrappedLending {
  return useContext(WrappedLendingContext);
}
