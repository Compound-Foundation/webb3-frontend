import type { Connector as WagmiConnector } from 'wagmi';

/**
 * Connector ids we register ourselves in `wagmiConfig`. Everything else in
 * `useConnect().connectors` got there through wagmi's EIP-6963 discovery, which
 * turns each announced provider into `injected({ target: { id: info.rdns, ... } })`
 * — so a discovered connector's id *is* the wallet's RDNS.
 */
export const CONFIGURED_CONNECTOR_IDS: ReadonlySet<string> = new Set([
  'injected',
  'walletConnect',
  'coinbaseWalletSDK',
  'ledger',
]);

/**
 * Hard allowlist of wallets we render from EIP-6963 discovery, keyed by announced
 * RDNS. The value is the display name we use — never the announced one, so a listed
 * wallet cannot spoof its label. RDNS values are self-attested (EIP-6963 security
 * considerations), so an unlisted announcement is not shown at all; those users still
 * have the WalletConnect and Coinbase rows.
 */
export const KNOWN_WALLETS: Readonly<Record<string, string>> = Object.freeze({
  'com.anchorage.connect': 'Anchorage Digital',
  'app.backpack': 'Backpack',
  'org.base.account': 'Base Account',
  'com.binance.wallet': 'Binance Wallet',
  'com.bitget.web3': 'Bitget Wallet',
  'com.brave.wallet': 'Brave Wallet',
  'com.bybit': 'Bybit Wallet',
  // Claimed by our configured Coinbase SDK connector, so it never appears as a
  // discovered row; listed so a conflict on it still raises the warning.
  'com.coinbase.wallet': 'Base (formerly Coinbase Wallet)',
  'app.core.extension': 'Core Wallet',
  'com.enkrypt': 'Enkrypt',
  'io.gate.wallet': 'Gate Wallet',
  'com.gemini.wallet': 'Gemini Wallet',
  'io.metamask': 'MetaMask',
  'com.okex.wallet': 'OKX Wallet',
  'so.onekey.app.wallet': 'OneKey',
  'app.phantom': 'Phantom',
  'io.rabby': 'Rabby',
  'me.rainbow': 'Rainbow',
  'com.roninchain.wallet': 'Ronin Wallet',
  'xyz.talisman': 'Talisman',
  'com.trustwallet.app': 'Trust Wallet',
  'org.uniswap': 'Uniswap Wallet',
  'io.zerion.wallet': 'Zerion',
  'io.zilpay': 'ZilPay',
});

// The spec requires a data-URI icon; anything else — notably a remote URL, which would
// leak the user's IP to the wallet's server the moment the list renders — is dropped
// and the row falls back to the generic mark. `<img>` rendering already stops SVG
// script execution; this closes the non-image and remote-fetch vectors.
const SAFE_ICON_PATTERN = /^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/;

function sanitizeIcon(icon: string | undefined): string | undefined {
  return icon !== undefined && SAFE_ICON_PATTERN.test(icon) ? icon : undefined;
}

/** Connectors that got into wagmi through EIP-6963 discovery, before any filtering. */
function announcedConnectors(connectors: readonly WagmiConnector[]): WagmiConnector[] {
  return connectors.filter(
    (connector) => connector.type === 'injected' && !CONFIGURED_CONNECTOR_IDS.has(connector.id),
  );
}

export type DiscoveredWallet = {
  /** The wallet's EIP-6963 RDNS, e.g. `io.metamask`. */
  id: string;
  name: string;
  icon?: string;
};

/** Announced wallets that pass the allowlist and are not conflicted, curated for display. */
export function getDiscoveredWallets(
  connectors: readonly WagmiConnector[],
  conflictedRdns: ReadonlySet<string>,
): DiscoveredWallet[] {
  return announcedConnectors(connectors)
    .filter((connector) => connector.id in KNOWN_WALLETS && !conflictedRdns.has(connector.id))
    .map((connector) => ({
      id: connector.id,
      name: KNOWN_WALLETS[connector.id],
      icon: sanitizeIcon(connector.icon),
    }));
}

/**
 * Conflicted rdns values we can name for the warning row. Unlisted conflicts stay
 * silent: those wallets were never shown, and naming them would let an attacker put
 * arbitrary self-chosen names into our warning copy.
 */
export function getConflictedKnownWallets(
  conflictedRdns: ReadonlySet<string>,
): { id: string; name: string }[] {
  return [...conflictedRdns]
    .filter((rdns) => rdns in KNOWN_WALLETS)
    .map((rdns) => ({ id: rdns, name: KNOWN_WALLETS[rdns] }));
}

/**
 * Mobile in-app browsers and pre-6963 extensions set `window.ethereum` without
 * announcing. We fall back to the generic `injected()` connector for them, but only
 * when nothing announced — otherwise it duplicates a wallet already listed by name,
 * and connects to whichever extension won the race for `window.ethereum`. Announcements
 * we filtered out keep it hidden too, since the legacy row would reintroduce exactly
 * that `window.ethereum` race.
 */
export function shouldShowLegacyInjected(connectors: readonly WagmiConnector[]): boolean {
  if (announcedConnectors(connectors).length > 0) return false;
  return typeof window !== 'undefined' && window.ethereum != null;
}

// Pre-6963 the stored value was a JSON-encoded `[ConnectorType]` tuple.
const LEGACY_CONNECTOR_IDS: Record<string, string | null> = {
  Metamask: 'injected',
  WalletConnect: 'walletConnect',
  WalletLink: 'coinbaseWalletSDK',
  Ronin: 'com.roninchain.wallet',
  // Ledger can't autoconnect — it needs a path and address chosen first.
  Ledger: null,
};

/**
 * Resolve a stored preference to a connector id, or `null` when the caller should
 * drop the stored value and stay disconnected.
 */
export function migrateStoredConnectorId(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON, so it's already a bare connector id.
    return raw.length > 0 ? raw : null;
  }

  if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
    return LEGACY_CONNECTOR_IDS[parsed[0]] ?? null;
  }
  // A bare id that happens to parse as JSON (a number, `null`, an object) is not
  // something we ever wrote.
  return typeof parsed === 'string' && parsed.length > 0 ? parsed : null;
}
