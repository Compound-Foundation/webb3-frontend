import type { Connector as WagmiConnector } from 'wagmi';

import {
  getConflictedKnownWallets,
  getDiscoveredWallets,
  isAllowedConnectorId,
  isConnectorConflicted,
  KNOWN_WALLETS,
  migrateStoredConnectorIds,
  rdnsForConnectorId,
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
    expect(shouldShowLegacyInjected(new Set())).toBe(true);
  });

  test('is false when a wallet announced, even with window.ethereum present', () => {
    (window as { ethereum?: unknown }).ethereum = {};
    expect(shouldShowLegacyInjected(new Set(['io.metamask']))).toBe(false);
  });

  test('stays false when a wallet announced but was filtered off the allowlist', () => {
    (window as { ethereum?: unknown }).ethereum = {};
    expect(shouldShowLegacyInjected(new Set(['com.evil.fake']))).toBe(false);
  });

  // Wagmi never creates a discovered connector for an rdns a configured connector
  // claims, so keying off its connector list showed this user a duplicate legacy row
  // alongside the fixed Coinbase row for the very same extension.
  test('is false for a Coinbase-extension-only user, whose rdns wagmi never surfaces', () => {
    (window as { ethereum?: unknown }).ethereum = {};
    expect(shouldShowLegacyInjected(new Set(['com.coinbase.wallet']))).toBe(false);
  });

  test('is false when there is no injected provider at all', () => {
    expect(shouldShowLegacyInjected(new Set())).toBe(false);
  });
});

describe('rdnsForConnectorId', () => {
  test('maps the Coinbase SDK connector id to the rdns it claims', () => {
    expect(rdnsForConnectorId('coinbaseWalletSDK')).toBe('com.coinbase.wallet');
  });

  test('leaves a discovered connector id alone, since it is already an rdns', () => {
    expect(rdnsForConnectorId('io.metamask')).toBe('io.metamask');
  });

  test.each(['constructor', 'toString', '__proto__'])(
    'does not resolve %s through the prototype chain',
    (id) => {
      expect(rdnsForConnectorId(id)).toBe(id);
    },
  );
});

describe('isAllowedConnectorId', () => {
  test.each(['injected', 'walletConnect', 'coinbaseWalletSDK', 'io.metamask', 'io.rabby'])(
    'allows %s',
    (id) => {
      expect(isAllowedConnectorId(id)).toBe(true);
    },
  );

  test.each(['com.evil.fake', '["Metam', '', 'constructor', '__proto__'])('rejects %s', (id) => {
    expect(isAllowedConnectorId(id)).toBe(false);
  });
});

describe('isConnectorConflicted', () => {
  test('a discovered connector is conflicted when its own rdns is', () => {
    expect(isConnectorConflicted('io.metamask', new Set(['io.metamask']))).toBe(true);
  });

  // The live session reports 'coinbaseWalletSDK', never the rdns, so without the map an
  // impersonation of com.coinbase.wallet left the session signing away.
  test('the Coinbase SDK connector is conflicted when its claimed rdns is', () => {
    expect(isConnectorConflicted('coinbaseWalletSDK', new Set(['com.coinbase.wallet']))).toBe(true);
  });

  // Bare window.ethereum resolves to whichever extension won the race, which may be
  // either side of the impersonation.
  test('the generic injected connector is conflicted by any conflict at all', () => {
    expect(isConnectorConflicted('injected', new Set(['io.metamask']))).toBe(true);
  });

  test('is false for an unrelated wallet', () => {
    expect(isConnectorConflicted('io.rabby', new Set(['io.metamask']))).toBe(false);
  });

  // A live session hands us the connector, whose own declared rdns is authoritative and
  // needs no entry in our map.
  test('reads the rdns a connector declares for itself', () => {
    const connector = { id: 'coinbaseWalletSDK', rdns: 'com.coinbase.wallet' };
    expect(isConnectorConflicted(connector, new Set(['com.coinbase.wallet']))).toBe(true);
  });

  // `rdns` is typed `string | readonly string[]`, so a bare `rdns ?? id` would compare
  // an array against the set and never match.
  test('handles a connector that declares several rdns values', () => {
    const connector = { id: 'multi', rdns: ['com.example.one', 'com.example.two'] };
    expect(isConnectorConflicted(connector, new Set(['com.example.two']))).toBe(true);
    expect(isConnectorConflicted(connector, new Set(['com.example.three']))).toBe(false);
  });

  test('falls back to the id for a discovered connector, which declares no rdns', () => {
    expect(isConnectorConflicted({ id: 'io.metamask' }, new Set(['io.metamask']))).toBe(true);
  });

  test.each(['injected', 'coinbaseWalletSDK', 'io.metamask'])(
    '%s is not conflicted when nothing conflicts',
    (id) => {
      expect(isConnectorConflicted(id, NO_CONFLICTS)).toBe(false);
    },
  );
});

describe('migrateStoredConnectorIds', () => {
  test.each([
    ['io.metamask', ['io.metamask']],
    ['injected', ['injected']],
    ['["WalletConnect"]', ['walletConnect']],
    ['["WalletLink"]', ['coinbaseWalletSDK']],
    ['["Ronin"]', ['com.roninchain.wallet']],
  ])('maps %s to %s', (raw, expected) => {
    expect(migrateStoredConnectorIds(raw)).toEqual(expected);
  });

  // The normal state of every returning MetaMask user. Resolving straight to 'injected'
  // routed them around every rdns-keyed check, so the announced wallet comes first.
  test('prefers announced MetaMask over the generic connector for a legacy Metamask value', () => {
    expect(migrateStoredConnectorIds('["Metamask"]')).toEqual(['io.metamask', 'injected']);
  });

  test('drops Ledger, which cannot autoconnect', () => {
    expect(migrateStoredConnectorIds('["Ledger"]')).toEqual([]);
  });

  test.each([['["Unknown"]'], ['[]'], ['{}'], ['null'], ['42'], ['']])('drops %s', (raw) => {
    expect(migrateStoredConnectorIds(raw)).toEqual([]);
  });

  // localStorage is writable by any content script, so a stored id is untrusted input.
  test.each([['com.evil.fake'], ['["Metam'], ['"com.evil.fake"']])(
    'drops %s rather than accepting it as a connector id',
    (raw) => {
      expect(migrateStoredConnectorIds(raw)).toEqual([]);
    },
  );

  test.each([['["constructor"]'], ['["toString"]'], ['["__proto__"]'], ['constructor']])(
    'drops %s rather than resolving it through the prototype chain',
    (raw) => {
      expect(migrateStoredConnectorIds(raw)).toEqual([]);
    },
  );
});
