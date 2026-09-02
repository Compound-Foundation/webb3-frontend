import type { Connector as WagmiConnector } from 'wagmi';

import {
  getDiscoveredWallets,
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

describe('getDiscoveredWallets', () => {
  test('returns wallets announced over EIP-6963, with their name and icon', () => {
    expect(getDiscoveredWallets([...CONFIGURED, METAMASK, RABBY])).toEqual([
      { id: 'io.metamask', name: 'MetaMask', icon: 'data:image/svg+xml;base64,AAAA' },
      { id: 'io.rabby', name: 'Rabby', icon: undefined },
    ]);
  });

  test('excludes every connector we configure ourselves', () => {
    expect(getDiscoveredWallets(CONFIGURED)).toEqual([]);
  });

  test('is empty when no connectors exist at all', () => {
    expect(getDiscoveredWallets([])).toEqual([]);
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
});
