import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import type { DiscoveredWallet } from '@helpers/walletConnectors';
import { useWalletRows } from '@hooks/useWalletRows';

import ConnectWalletModal from '../ConnectWalletModal';

jest.mock('@helpers/Ledger', () => ({
  getLedgerAddresses: jest.fn(),
}));

// The row-derivation helpers keep their own unit tests; here we stub the hook so these
// cases drive the component directly.
jest.mock('@hooks/useWalletRows', () => ({
  useWalletRows: jest.fn(),
}));

const mockedUseWalletRows = useWalletRows as jest.MockedFunction<typeof useWalletRows>;

const METAMASK: DiscoveredWallet = {
  id: 'io.metamask',
  name: 'MetaMask',
  icon: 'data:image/svg+xml;base64,AAAA',
};
const RONIN: DiscoveredWallet = { id: 'com.roninchain.wallet', name: 'Ronin Wallet' };

type WalletRowsOverrides = {
  detectedWallets?: DiscoveredWallet[];
  showLegacyInjected?: boolean;
};

const renderModal = ({ detectedWallets = [], showLegacyInjected = false }: WalletRowsOverrides = {}) => {
  mockedUseWalletRows.mockReturnValue({ detected: detectedWallets, showLegacy: showLegacyInjected });

  const onSelectConnector = jest.fn();
  const { unmount } = render(
    <ConnectWalletModal isOpen onRequestClose={jest.fn()} onSelectConnector={onSelectConnector} />,
  );
  return { onSelectConnector, unmount };
};

describe('ConnectWalletModal', () => {
  test('renders a row per EIP-6963 wallet, using its announced name', () => {
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
    const { unmount } = renderModal({ showLegacyInjected: true });
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

  test('renders a wallet that announced no icon at all', () => {
    renderModal({ detectedWallets: [RONIN] });

    expect(screen.getByText('Ronin Wallet')).toBeInTheDocument();
    expect(screen.queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
  });
});
