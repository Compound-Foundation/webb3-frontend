import { useMemo } from 'react';
import { useConnect } from 'wagmi';

import {
  getDiscoveredWallets,
  shouldShowLegacyInjected,
  type DiscoveredWallet,
} from '@helpers/walletConnectors';

export type WalletRows = {
  /** Wallets that announced themselves over EIP-6963. */
  detected: DiscoveredWallet[];
  /** Whether to offer the generic `window.ethereum` row for wallets that don't announce. */
  showLegacy: boolean;
};

/**
 * Everything the connect modal needs to render its browser-wallet rows. EIP-6963
 * announcements can arrive after mount, so wagmi appends to `connectors` as wallets show
 * up and this recomputes when it does.
 *
 * Kept out of `helpers/walletConnectors` so that module stays free of a runtime wagmi
 * import — it holds only pure functions, and its tests run without wagmi's untransformed
 * ESM being pulled into jest.
 */
export function useWalletRows(): WalletRows {
  const { connectors } = useConnect();

  return useMemo(
    () => ({
      detected: getDiscoveredWallets(connectors),
      showLegacy: shouldShowLegacyInjected(connectors),
    }),
    [connectors],
  );
}
