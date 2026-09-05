import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import type { DiscoveredWallet } from '@helpers/walletConnectors';

import ConnectWalletModal from '../ConnectWalletModal';

jest.mock('@helpers/Ledger', () => ({
  getLedgerAddresses: jest.fn(),
}));

const METAMASK: DiscoveredWallet = {
  id: 'io.metamask',
  name: 'MetaMask',
  icon: 'data:image/svg+xml;base64,AAAA',
};
const RONIN: DiscoveredWallet = { id: 'com.roninchain.wallet', name: 'Ronin Wallet' };

const CONFLICTED_METAMASK = { id: 'io.metamask', name: 'MetaMask' };

const renderModal = (props: Partial<React.ComponentProps<typeof ConnectWalletModal>> = {}) => {
  const onSelectConnector = jest.fn();
  const { container } = render(
    <ConnectWalletModal
      isOpen
      onRequestClose={jest.fn()}
      onSelectConnector={onSelectConnector}
      detectedWallets={[]}
      showLegacyInjected={false}
      conflictedWallets={[]}
      {...props}
    />,
  );
  return { onSelectConnector, container };
};

describe('ConnectWalletModal', () => {
  test('renders a row per EIP-6963 wallet, using the curated name it was given', () => {
    renderModal({ detectedWallets: [METAMASK, RONIN] });

    expect(screen.getByText('MetaMask')).toBeInTheDocument();
    expect(screen.getByText('Ronin Wallet')).toBeInTheDocument();
  });

  test('selects a detected wallet by its RDNS', async () => {
    const { onSelectConnector } = renderModal({ detectedWallets: [METAMASK, RONIN] });

    await userEvent.click(screen.getByText('Ronin Wallet'));

    expect(onSelectConnector).toHaveBeenCalledWith({ kind: 'connector', id: 'com.roninchain.wallet' });
  });

  test('shows the legacy browser wallet row only when nothing announced', () => {
    const { unmount } = render(
      <ConnectWalletModal
        isOpen
        onRequestClose={jest.fn()}
        onSelectConnector={jest.fn()}
        detectedWallets={[]}
        showLegacyInjected
        conflictedWallets={[]}
      />,
    );
    expect(screen.getByText('Browser Wallet')).toBeInTheDocument();
    unmount();

    renderModal({ detectedWallets: [METAMASK], showLegacyInjected: true });
    expect(screen.queryByText('Browser Wallet')).not.toBeInTheDocument();
  });

  test('the legacy row connects through the generic injected connector', async () => {
    const { onSelectConnector } = renderModal({ showLegacyInjected: true });

    await userEvent.click(screen.getByText('Browser Wallet'));

    expect(onSelectConnector).toHaveBeenCalledWith({ kind: 'connector', id: 'injected' });
  });

  test('says so when no browser wallet is available', () => {
    renderModal();

    expect(screen.getByText('No browser wallet detected')).toBeInTheDocument();
    expect(screen.queryByText('Browser Wallet')).not.toBeInTheDocument();
  });

  test('always offers the fixed WalletConnect, Coinbase and Ledger rows', () => {
    renderModal({ detectedWallets: [METAMASK] });

    expect(screen.getByText('WalletConnect')).toBeInTheDocument();
    expect(screen.getByText('Coinbase Wallet')).toBeInTheDocument();
    expect(screen.getByText('Ledger')).toBeInTheDocument();
  });

  test.each([
    ['walletConnect', 'WalletConnect'],
    ['coinbaseWalletSDK', 'Coinbase Wallet'],
  ])('selects the fixed %s connector', async (id, label) => {
    const { onSelectConnector } = renderModal();

    await userEvent.click(screen.getByText(label));

    expect(onSelectConnector).toHaveBeenCalledWith({ kind: 'connector', id });
  });

  test('renders the icon a wallet announced', () => {
    renderModal({ detectedWallets: [METAMASK] });

    expect(screen.getByRole('presentation', { hidden: true })).toHaveAttribute('src', METAMASK.icon);
  });

  test('falls back to a generic mark when an announced icon fails to load', () => {
    renderModal({ detectedWallets: [METAMASK] });

    fireEvent.error(screen.getByRole('presentation', { hidden: true }));

    expect(screen.queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
    // The wallet is still selectable, just without its own artwork.
    expect(screen.getByText('MetaMask')).toBeInTheDocument();
  });

  test('warns about a conflicted wallet instead of listing it', async () => {
    const { onSelectConnector } = renderModal({
      conflictedWallets: [{ id: 'io.metamask', name: 'MetaMask' }],
    });

    expect(screen.getByText('MetaMask hidden for your safety')).toBeInTheDocument();
    await userEvent.click(screen.getByText('MetaMask hidden for your safety'));
    expect(onSelectConnector).not.toHaveBeenCalled();
  });

  test('a warning row suppresses the no-wallet row but not detected wallets', () => {
    renderModal({
      detectedWallets: [RONIN],
      conflictedWallets: [{ id: 'io.metamask', name: 'MetaMask' }],
    });

    expect(screen.getByText('MetaMask hidden for your safety')).toBeInTheDocument();
    expect(screen.getByText('Ronin Wallet')).toBeInTheDocument();
    expect(screen.queryByText('No browser wallet detected')).not.toBeInTheDocument();
  });

  test('a warning row also suppresses the legacy browser wallet row', () => {
    // Offering bare `window.ethereum` while an impersonator is present would
    // reintroduce the race EIP-6963 exists to fix.
    renderModal({ showLegacyInjected: true, conflictedWallets: [CONFLICTED_METAMASK] });

    expect(screen.getByText('MetaMask hidden for your safety')).toBeInTheDocument();
    expect(screen.queryByText('Browser Wallet')).not.toBeInTheDocument();
  });

  test('warning rows render above the wallets that are still offered', () => {
    const { container } = renderModal({
      detectedWallets: [RONIN],
      conflictedWallets: [CONFLICTED_METAMASK],
    });

    const headings = [...container.querySelectorAll('.connect-wallet-item__info .heading')].map(
      (node) => node.textContent,
    );
    expect(headings.indexOf('MetaMask hidden for your safety')).toBeLessThan(
      headings.indexOf('Ronin Wallet'),
    );
  });

  test('hides the fixed Coinbase row when its rdns is impersonated', () => {
    // The Coinbase SDK routes to the extension when installed, so that row is tainted
    // by the same conflict — leaving it would contradict the warning above it.
    renderModal({ conflictedWallets: [{ id: 'com.coinbase.wallet', name: 'Base (formerly Coinbase Wallet)' }] });

    expect(screen.queryByText('Coinbase Wallet')).not.toBeInTheDocument();
    expect(screen.getByText('WalletConnect')).toBeInTheDocument();
  });

  test('renders a wallet that announced no icon at all', () => {
    renderModal({ detectedWallets: [RONIN] });

    expect(screen.getByText('Ronin Wallet')).toBeInTheDocument();
    expect(screen.queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
  });
});
