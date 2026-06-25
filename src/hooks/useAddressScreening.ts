import { useEffect, useRef, useState } from 'react';

import { isSanctioned } from '@helpers/sanctions';
import { screenAddress } from '@helpers/screening';

export type ScreeningStatus = 'idle' | 'checking' | 'allowed' | 'blocked';

/**
 * Screens `address` fail-closed. Caller exposes the account only on 'allowed'.
 * `address` MUST be the raw (pre-gate) address to avoid a gating feedback loop.
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
