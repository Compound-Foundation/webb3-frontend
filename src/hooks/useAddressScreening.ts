import { useEffect, useRef, useState } from 'react';

import { isSanctioned } from '@helpers/sanctions';
import { screenAddress } from '@helpers/screening';

import { SCREENING_DISABLED } from '../../envVars';

export type ScreeningStatus = 'idle' | 'checking' | 'allowed' | 'blocked';

/**
 * Screens `address` fail-closed. Caller exposes the account only on 'allowed'.
 * `address` MUST be the raw (pre-gate) address to avoid a gating feedback loop.
 *
 * The one exception is the local dev server — see `SCREENING_DISABLED` in envVars.ts.
 */
export function useAddressScreening(address: string | undefined): ScreeningStatus {
  const [status, setStatus] = useState<ScreeningStatus>('idle');
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    const isCurrent = () => id === requestId.current;

    if (!address) {
      setStatus('idle');
      return;
    }

    setStatus('checking');

    if (isSanctioned(address)) {
      setStatus('blocked');
      return;
    }

    // Dev server only, and only when no endpoint is configured. See
    // `SCREENING_DISABLED` in envVars.ts — this branch is compiled out of any build.
    if (SCREENING_DISABLED) {
      console.warn('Address screening is disabled on the local dev server (no VITE_SCREENING_ENDPOINT set).');
      setStatus('allowed');
      return;
    }

    (async () => {
      try {
        const allowed = await screenAddress(address);
        if (isCurrent()) setStatus(allowed ? 'allowed' : 'blocked');
      } catch (error) {
        console.error('Screening failed (fail-closed):', error);
        if (isCurrent()) setStatus('blocked');
      }
    })();

    return () => {
      // bump so any in-flight result for this address is ignored
      requestId.current++;
    };
  }, [address]);

  return status;
}
