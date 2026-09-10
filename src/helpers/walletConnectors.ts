import type { Connector as WagmiConnector } from 'wagmi';

/**
 * The one connector we register ourselves that reports `type: 'injected'`. Our other
 * configured connectors carry their own types ('walletConnect', 'coinbaseWallet',
 * 'ledger'), so excluding this single id is enough to leave only wagmi's EIP-6963
 * discoveries — each of which is an `injected({ target: { id: info.rdns, ... } })`, so
 * a discovered connector's id *is* the wallet's RDNS.
 */
const CONFIGURED_INJECTED_ID = 'injected';

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

/**
 * Own-property lookup, never `in`: an rdns like `constructor` or `toString` would
 * otherwise pass the allowlist through the prototype chain and resolve to a function.
 */
function curatedName(rdns: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(KNOWN_WALLETS, rdns) ? KNOWN_WALLETS[rdns] : undefined;
}

/** Connectors that got into wagmi through EIP-6963 discovery, before any filtering. */
function announcedConnectors(connectors: readonly WagmiConnector[]): WagmiConnector[] {
  return connectors.filter(
    (connector) => connector.type === 'injected' && connector.id !== CONFIGURED_INJECTED_ID,
  );
}

export type DiscoveredWallet = {
  /** The wallet's EIP-6963 RDNS, e.g. `io.metamask`. */
  id: string;
  name: string;
  icon?: string;
};

/** A known wallet withheld because two providers announced its RDNS. */
export type ConflictedWallet = { id: string; name: string };

/**
 * Claimed by our configured Coinbase SDK connector, which is why it never appears as a
 * discovered row. The SDK routes to the extension when one is installed, so a conflict
 * here also taints the fixed Coinbase row and the modal hides that too.
 */
export const COINBASE_RDNS = 'com.coinbase.wallet';

/** Announced wallets that pass the allowlist and are not conflicted, curated for display. */
export function getDiscoveredWallets(
  connectors: readonly WagmiConnector[],
  conflictedRdns: ReadonlySet<string>,
): DiscoveredWallet[] {
  return announcedConnectors(connectors).flatMap((connector) => {
    const name = curatedName(connector.id);
    if (name === undefined || conflictedRdns.has(connector.id)) return [];
    return [{ id: connector.id, name, icon: sanitizeIcon(connector.icon) }];
  });
}

/**
 * Conflicted rdns values we can name for the warning row. Unlisted conflicts stay
 * silent: those wallets were never shown, and naming them would let an attacker put
 * arbitrary self-chosen names into our warning copy.
 */
export function getConflictedKnownWallets(conflictedRdns: ReadonlySet<string>): ConflictedWallet[] {
  return [...conflictedRdns].flatMap((rdns) => {
    const name = curatedName(rdns);
    return name === undefined ? [] : [{ id: rdns, name }];
  });
}

/**
 * Whether some conflict exists that `getConflictedKnownWallets` will not name. Those
 * conflicts still taint the generic `injected` connector — bare `window.ethereum` may
 * resolve to either impersonator — so a session can be severed over one. Without this
 * the modal would explain nothing, and the user would see an unexplained disconnect.
 */
export function hasUnnamedConflict(conflictedRdns: ReadonlySet<string>): boolean {
  return [...conflictedRdns].some((rdns) => curatedName(rdns) === undefined);
}

/**
 * Mobile in-app browsers and pre-6963 extensions set `window.ethereum` without
 * announcing. We fall back to the generic `injected()` connector for them, but only
 * when nothing announced — otherwise it duplicates a wallet already listed by name,
 * and connects to whichever extension won the race for `window.ethereum`. Announcements
 * we filtered out keep it hidden too, since the legacy row would reintroduce exactly
 * that `window.ethereum` race.
 *
 * Takes the watcher's announced set rather than wagmi's connectors: wagmi never creates
 * a discovered connector for an rdns a configured connector already claims, so a user
 * whose only wallet is the Coinbase extension would otherwise look like "nothing
 * announced" and get this row *plus* the fixed Coinbase row for the same wallet.
 */
export function shouldShowLegacyInjected(announcedRdns: ReadonlySet<string>): boolean {
  if (announcedRdns.size > 0) return false;
  return typeof window !== 'undefined' && window.ethereum != null;
}

/**
 * The rdns a wagmi connector id speaks for. Discovered connectors use their rdns as the
 * id already; the connectors we configure ourselves do not, so an impersonation of
 * `com.coinbase.wallet` has to be matched against the Coinbase SDK's own id or the
 * conflict checks silently pass a live session through.
 */
const CONNECTOR_RDNS: Readonly<Record<string, string>> = Object.freeze({
  coinbaseWalletSDK: COINBASE_RDNS,
});

export function rdnsForConnectorId(id: string): string {
  return Object.prototype.hasOwnProperty.call(CONNECTOR_RDNS, id) ? CONNECTOR_RDNS[id] : id;
}

/** Connector ids we configure ourselves, none of which is an rdns. */
const CONFIGURED_CONNECTOR_IDS: readonly string[] = ['injected', 'walletConnect', 'coinbaseWalletSDK'];

/**
 * Whether a connector id is one we would ever connect to. Announcements are
 * self-attested and `localStorage` is writable by any content script, so a stored id is
 * untrusted input: without this, a hostile extension that announces `com.evil.wallet`
 * and writes that id gets auto-connected on the next load, with no row ever rendered.
 */
export function isAllowedConnectorId(id: string): boolean {
  return (
    CONFIGURED_CONNECTOR_IDS.includes(id) || Object.prototype.hasOwnProperty.call(KNOWN_WALLETS, id)
  );
}

/**
 * Whether connecting through this id is unsafe because two providers claimed the rdns
 * it speaks for. The generic `injected` connector is tainted by *any* conflict: it
 * resolves to whichever extension won the race for `window.ethereum`, which may be
 * either side of the impersonation.
 */
export function isConnectorConflicted(id: string, conflictedRdns: ReadonlySet<string>): boolean {
  if (conflictedRdns.size === 0) return false;
  if (id === CONFIGURED_INJECTED_ID) return true;
  return conflictedRdns.has(rdnsForConnectorId(id));
}

/**
 * Pre-6963 the stored value was a JSON-encoded `[ConnectorType]` tuple. Each maps to
 * candidates in preference order: `Metamask` was stored by every returning MetaMask
 * user and used to mean bare `window.ethereum`, so prefer the announced MetaMask and
 * fall back to the generic connector only when nothing announced. Resolving it to
 * `injected` outright would route those users around every rdns-keyed protection.
 */
const LEGACY_CONNECTOR_IDS: Record<string, readonly string[]> = {
  Metamask: ['io.metamask', 'injected'],
  WalletConnect: ['walletConnect'],
  WalletLink: ['coinbaseWalletSDK'],
  Ronin: ['com.roninchain.wallet'],
  // Ledger can't autoconnect — it needs a path and address chosen first.
  Ledger: [],
};

/**
 * Resolve a stored preference to connector ids in preference order, the caller taking
 * the first that resolves against the connectors present. Empty means the caller should
 * drop the stored value and stay disconnected — including for anything not on the
 * allowlist, since `localStorage` is writable by any content script.
 */
export function migrateStoredConnectorIds(raw: string): readonly string[] {
  const allowed = (ids: readonly string[]) => ids.filter(isAllowedConnectorId);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON, so it's already a bare connector id.
    return allowed([raw]);
  }

  if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
    // Own-property lookup, as in `curatedName`: a stored `["constructor"]` would
    // otherwise resolve to a function through the prototype chain.
    return Object.prototype.hasOwnProperty.call(LEGACY_CONNECTOR_IDS, parsed[0])
      ? allowed(LEGACY_CONNECTOR_IDS[parsed[0]])
      : [];
  }
  // A bare id that happens to parse as JSON (a number, `null`, an object) is not
  // something we ever wrote.
  return typeof parsed === 'string' ? allowed([parsed]) : [];
}
