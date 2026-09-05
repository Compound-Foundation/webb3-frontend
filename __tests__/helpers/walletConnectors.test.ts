import type { Connector as WagmiConnector } from 'wagmi';

import {
  getConflictedKnownWallets,
  getDiscoveredWallets,
  KNOWN_WALLETS,
  migrateStoredConnectorId,
  shouldShowLegacyInjected,
} from '@helpers/walletConnectors';

// Only the fields the helpers read.
const connector = (id: string, type: string, name = id, icon?: string) =>
  ({ id, type, name, icon } as unknown as WagmiConnector);

const METAMASK = connector('io.metamask', 'injected', 'MetaMask', 'data:image/svg+xml;base64,AAAA');
const RABBY = connector('io.rabby', 'injected', 'Rabby');
const GENERIC_INJECTED = connector('injected', 'injected', 'Injected');
const WALLET_CONNECT = connector('walletConnect', 'walletConnect', 'WalletConnect');
const COINBASE = connector('coinbaseWalletSDK', 'coinbaseWallet', 'Coinbase Wallet');
const LEDGER = connector('ledger', 'ledger', 'Ledger');

const CONFIGURED = [GENERIC_INJECTED, WALLET_CONNECT, COINBASE, LEDGER];

// Announces an rdns we do not list; must never render.
const UNLISTED = connector('com.evil.fake', 'injected', 'Totally Legit Wallet');
// Announced name differs from our curated one; the curated name must win.
const SPOOFED_NAME = connector('io.rabby', 'injected', 'MetaMask');

const NO_CONFLICTS: ReadonlySet<string> = new Set();

describe('getDiscoveredWallets', () => {
  test('returns allowlisted wallets with curated names and their announced icon', () => {
    expect(getDiscoveredWallets([...CONFIGURED, METAMASK, RABBY], NO_CONFLICTS)).toEqual([
      { id: 'io.metamask', name: 'MetaMask', icon: 'data:image/svg+xml;base64,AAAA' },
      { id: 'io.rabby', name: 'Rabby', icon: undefined },
    ]);
  });

  test('excludes every connector we configure ourselves', () => {
    expect(getDiscoveredWallets(CONFIGURED, NO_CONFLICTS)).toEqual([]);
  });

  test('is empty when no connectors exist at all', () => {
    expect(getDiscoveredWallets([], NO_CONFLICTS)).toEqual([]);
  });

  test('drops wallets whose rdns is not on the allowlist', () => {
    expect(getDiscoveredWallets([...CONFIGURED, UNLISTED], NO_CONFLICTS)).toEqual([]);
  });

  test.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
    'drops an rdns of %s, which only exists on the prototype chain',
    (rdns) => {
      expect(getDiscoveredWallets([connector(rdns, 'injected')], NO_CONFLICTS)).toEqual([]);
    },
  );

  test('displays our curated name, never the announced one', () => {
    expect(getDiscoveredWallets([SPOOFED_NAME], NO_CONFLICTS)).toEqual([
      { id: 'io.rabby', name: 'Rabby', icon: undefined },
    ]);
  });

  test('drops a wallet whose rdns is conflicted', () => {
    const conflicted = new Set(['io.metamask']);
    expect(getDiscoveredWallets([METAMASK, RABBY], conflicted)).toEqual([
      { id: 'io.rabby', name: 'Rabby', icon: undefined },
    ]);
  });

  test.each([
    ['data:image/png;base64,AA', 'data:image/png;base64,AA'],
    ['data:image/svg+xml;base64,AA', 'data:image/svg+xml;base64,AA'],
    ['data:image/webp,payload', 'data:image/webp,payload'],
    ['https://evil.example/pixel.png', undefined],
    ['data:text/html;base64,AA', undefined],
    // eslint-disable-next-line no-script-url
    ['javascript:alert(1)', undefined],
  ])('icon %s becomes %s', (icon, expected) => {
    const [wallet] = getDiscoveredWallets([connector('io.metamask', 'injected', 'x', icon)], NO_CONFLICTS);
    expect(wallet.icon).toBe(expected);
  });
});

describe('getConflictedKnownWallets', () => {
  test('names conflicted allowlisted wallets with the curated name', () => {
    expect(getConflictedKnownWallets(new Set(['io.metamask']))).toEqual([
      { id: 'io.metamask', name: 'MetaMask' },
    ]);
  });

  test('stays silent about conflicted rdns we do not list', () => {
    expect(getConflictedKnownWallets(new Set(['com.evil.fake']))).toEqual([]);
  });

  test('stays silent about a conflicted rdns that only exists on the prototype chain', () => {
    expect(getConflictedKnownWallets(new Set(['constructor', 'toString']))).toEqual([]);
  });

  test('is empty with no conflicts', () => {
    expect(getConflictedKnownWallets(new Set())).toEqual([]);
  });
});

describe('KNOWN_WALLETS', () => {
  test('legacy Ronin migration target stays on the allowlist', () => {
    expect(KNOWN_WALLETS['com.roninchain.wallet']).toBe('Ronin Wallet');
  });

  // A typo in a hand-typed rdns silently makes a real wallet undiscoverable, and the
  // lookup is deliberately case-sensitive, so pin the shape of every key.
  test.each(Object.keys(KNOWN_WALLETS))('%s is a well-formed rdns', (rdns) => {
    expect(rdns).toBe(rdns.trim().toLowerCase());
    expect(rdns).toContain('.');
  });

  test('holds the wallets we reviewed, so a deletion has to be deliberate', () => {
    expect(Object.keys(KNOWN_WALLETS)).toHaveLength(24);
  });
});

describe('shouldShowLegacyInjected', () => {
  afterEach(() => {
    delete (window as { ethereum?: unknown }).ethereum;
  });

  test('is true when nothing announced but window.ethereum is present', () => {
    (window as { ethereum?: unknown }).ethereum = {};
    expect(shouldShowLegacyInjected(CONFIGURED)).toBe(true);
  });

  test('is false when a wallet announced, even with window.ethereum present', () => {
    (window as { ethereum?: unknown }).ethereum = {};
    expect(shouldShowLegacyInjected([...CONFIGURED, METAMASK])).toBe(false);
  });

  test('stays false when a wallet announced but was filtered off the allowlist', () => {
    (window as { ethereum?: unknown }).ethereum = {};
    expect(shouldShowLegacyInjected([...CONFIGURED, UNLISTED])).toBe(false);
  });

  test('is false when there is no injected provider at all', () => {
    expect(shouldShowLegacyInjected(CONFIGURED)).toBe(false);
  });
});

describe('migrateStoredConnectorId', () => {
  test.each([
    ['io.metamask', 'io.metamask'],
    ['injected', 'injected'],
    ['["Metamask"]', 'injected'],
    ['["WalletConnect"]', 'walletConnect'],
    ['["WalletLink"]', 'coinbaseWalletSDK'],
    ['["Ronin"]', 'com.roninchain.wallet'],
  ])('maps %s to %s', (raw, expected) => {
    expect(migrateStoredConnectorId(raw)).toBe(expected);
  });

  test('drops Ledger, which cannot autoconnect', () => {
    expect(migrateStoredConnectorId('["Ledger"]')).toBeNull();
  });

  test.each([['["Unknown"]'], ['[]'], ['{}'], ['null'], ['42'], ['']])('drops %s', (raw) => {
    expect(migrateStoredConnectorId(raw)).toBeNull();
  });

  test.each([['["constructor"]'], ['["toString"]'], ['["__proto__"]']])(
    'drops %s rather than resolving it through the prototype chain',
    (raw) => {
      expect(migrateStoredConnectorId(raw)).toBeNull();
    },
  );
});
