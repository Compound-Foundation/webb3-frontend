import { createContext, useContext } from 'react';

import { LendingRoute } from '@helpers/lendingRoute';
import { WrappedPositionState } from '@hooks/useWrappedPosition';

/** The selected market's lending route for this session, and the wrapped position it reads. */
export type WrappedLending = {
  route: LendingRoute;
  position: WrappedPositionState;
  retry: () => void;
};

/** The value outside a provider: the standard route, with no wrapped position. */
export const STANDARD_LENDING: WrappedLending = Object.freeze({
  route: { kind: 'standard', writes: { isEligible: false, reason: 'disconnected' } },
  position: { status: 'not-applicable' },
  retry: () => undefined,
});

export const WrappedLendingContext = createContext<WrappedLending>(STANDARD_LENDING);

export function useWrappedLending(): WrappedLending {
  return useContext(WrappedLendingContext);
}
