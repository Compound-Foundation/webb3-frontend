import { useMemo } from 'react';
import { useConnect } from 'wagmi';

import { useAnnouncedRdns, useConflictedRdns } from '@helpers/eip6963Security';
import {
  getConflictedKnownWallets,
  getDiscoveredWallets,
  hasUnnamedConflict,
  shouldShowLegacyInjected,
  type ConflictedWallet,
  type DiscoveredWallet,
} from '@helpers/walletConnectors';

export type WalletRows = {
  /** Allowlisted wallets that announced themselves over EIP-6963. */
  detected: DiscoveredWallet[];
  /** Known wallets withheld because two providers announced their RDNS. */
  conflicted: ConflictedWallet[];
  /** A conflict we deliberately will not name, which still needs explaining. */
  unnamedConflict: boolean;
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
  const conflictedRdns = useConflictedRdns();
  const announcedRdns = useAnnouncedRdns();

  return useMemo(
    () => ({
      detected: getDiscoveredWallets(connectors, conflictedRdns),
      conflicted: getConflictedKnownWallets(conflictedRdns),
      unnamedConflict: hasUnnamedConflict(conflictedRdns),
      showLegacy: shouldShowLegacyInjected(announcedRdns),
    }),
    [connectors, conflictedRdns, announcedRdns],
  );
}
