import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { CircleExclamation } from '@components/Icons/CircleExclamation';
import { ScreeningStatus } from '@hooks/useAddressScreening';

type Props = {
  screeningStatus: ScreeningStatus;
};

/**
 * Shows a dismissible "Unexpected error" overlay on the rising edge of a
 * `blocked` screening result (i.e. each connect-wallet flow that ends blocked).
 *
 * A blocked wallet is fully disconnected (see useDisconnectBlockedWallet), which
 * sends the status `blocked -> idle`. The overlay therefore LATCHES: once shown,
 * it stays until the user navigates away or a clean wallet connects (`allowed`).
 * `idle`/`checking` leave it unchanged so the disconnect doesn't dismiss it.
 */
const ScreeningErrorOverlay = ({ screeningStatus }: Props) => {
  const [visible, setVisible] = useState(false);
  const prevStatus = useRef<ScreeningStatus | undefined>(undefined);
  const location = useLocation();
  const mounted = useRef(false);

  useEffect(() => {
    if (screeningStatus === 'blocked' && prevStatus.current !== 'blocked') {
      // Show only on the rising edge into `blocked`, not on every render while
      // already blocked — that is what keeps the overlay dismissible. After the
      // user dismisses it (via navigation) the status can still be `blocked`
      // (e.g. the `?account=` view-as path, which a wallet disconnect does not
      // clear), and we must not immediately re-show it.
      setVisible(true);
    } else if (screeningStatus === 'allowed') {
      // A clean wallet connected: clear any stale error.
      setVisible(false);
    }
    // `idle`/`checking` intentionally leave `visible` unchanged so the overlay
    // survives the disconnect a blocked wallet triggers (blocked -> idle).
    prevStatus.current = screeningStatus;
  }, [screeningStatus]);

  // Any route change after the initial mount dismisses the overlay.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setVisible(false);
  }, [location.pathname]);

  if (!visible) return null;

  return (
    <div className="screening-error-overlay" role="alert">
      <div className="screening-error-overlay__content">
        <CircleExclamation className="screening-error-overlay__icon" />
        <h1 className="screening-error-overlay__title">Unexpected error</h1>
        <p className="screening-error-overlay__text">
          Please retry later or contact{' '}
          <a href="mailto:info@comp.xyz">info@comp.xyz</a> for assistance.
        </p>
      </div>
    </div>
  );
};

export default ScreeningErrorOverlay;
