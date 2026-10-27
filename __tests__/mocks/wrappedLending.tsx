import { ReactNode, useState } from 'react';

import { SubmissionRecord, WrappedLending, WrappedLendingContext } from '@contexts/WrappedLendingContext';

/**
 * Provides `value` with a working submission store, as App does: the store keeps its record across
 * rerenders with new values, while the rest of the value comes from the test.
 */
export function TestLendingProvider({ value, children }: { value: WrappedLending; children: ReactNode }) {
  const [record, setRecord] = useState<SubmissionRecord>();
  return (
    <WrappedLendingContext.Provider value={{ ...value, submission: { record, setRecord } }}>
      {children}
    </WrappedLendingContext.Provider>
  );
}
