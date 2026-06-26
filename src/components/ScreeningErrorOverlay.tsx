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
 * Plain navigation dismisses it and produces no new screening result, so it
 * stays dismissed while the user browses.
 */
const ScreeningErrorOverlay = ({ screeningStatus }: Props) => {
  const [visible, setVisible] = useState(false);
  const prevStatus = useRef<ScreeningStatus | undefined>(undefined);
  const location = useLocation();
  const mounted = useRef(false);

  // Rising edge into `blocked`: show.
  useEffect(() => {
    if (screeningStatus === 'blocked' && prevStatus.current !== 'blocked') {
      setVisible(true);
    }
    if (screeningStatus !== 'blocked') {
      setVisible(false);
    }
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
