import { useEffect } from 'react';

import { CONNECTOR_LOCALSTORAGE_KEY } from '@helpers/constants';

import { ScreeningStatus } from './useAddressScreening';

/**
 * Fail-closed: when screening blocks a wallet, fully disconnect the wagmi
 * session and forget the stored connector, so the app, wagmi, and the
 * auto-reconnect on next load all agree the wallet is disconnected — rather
 * than leaving a hidden-but-live session (the account is gated out of view but
 * the wallet still shows as connected). The screening overlay remains to
 * explain the block.
 *
 * `disconnect` must be wagmi's `useDisconnect().disconnect`.
 */
export function useDisconnectBlockedWallet(screeningStatus: ScreeningStatus, disconnect: () => void) {
  useEffect(() => {
    if (screeningStatus === 'blocked') {
      disconnect();
      window.localStorage.removeItem(CONNECTOR_LOCALSTORAGE_KEY);
    }
  }, [screeningStatus, disconnect]);
}
