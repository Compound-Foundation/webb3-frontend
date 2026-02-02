import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import '@testing-library/jest-dom';
import { Web3 } from '@contexts/Web3Context';
import { Transaction } from '@types';

import TransactionHistory from '..';
import { mockUnitTransactionTransfer } from '../../../../__tests__/mocks/mockTransactions';
import { mockWeb3, mockWeb3NoWallet } from '../../../../__tests__/mocks/mockWeb3';

const renderTransactionsPage = (transactions: Transaction[], web3: Web3) => {
  return render(
    <MemoryRouter initialEntries={['?market=usdc-mainnet']}>
      <TransactionHistory transactions={transactions} web3={web3}></TransactionHistory>
    </MemoryRouter>
  );
};

describe('Transaction History Page', () => {
  beforeEach(() => {
    // IntersectionObserver isn't available in test environment
    const mockIntersectionObserver = jest.fn();
    mockIntersectionObserver.mockReturnValue({
      observe: () => jest.fn(),
      unobserve: () => jest.fn(),
      disconnect: () => jest.fn(),
    });
    window.IntersectionObserver = mockIntersectionObserver;
  });

  afterEach(() => {
    setTimeout(() => {
      const mockIntersectionObserver = jest.fn();
      mockIntersectionObserver.mockReturnValue(null);
      window.IntersectionObserver = mockIntersectionObserver;
    }, 500);
  });

  test('renders Transaction History loading state', async () => {
    const mockTransactions = [] as Transaction[];
    renderTransactionsPage(mockTransactions, mockWeb3);
    expect(await screen.getAllByLabelText('Transaction loader').length).toBe(5);
    expect(await screen.getAllByLabelText('Transaction title loader').length).toBe(5);
    expect(await screen.getAllByLabelText('Transaction description loader').length).toBe(5);
  });

  test('renders Transaction History no wallet', async () => {
    const mockTransactions = [] as Transaction[];
    renderTransactionsPage(mockTransactions, mockWeb3NoWallet);
    expect(await screen.findByText('No wallet connected')).toBeVisible();
    expect(await screen.getAllByLabelText('No wallet').length).toBe(1);
    expect(await screen.getAllByLabelText('Connect wallet').length).toBe(1);
    expect(await screen.findByText('Connect a wallet to view transactions')).toBeInTheDocument();
  });

  test('renders Transaction History no transactions', async () => {
    const mockTransactions = [] as Transaction[];

    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: jest.fn(() =>
          JSON.stringify({
            account: '0x124',
            items: [],
          })
        ),
        setItem: jest.fn(() => null),
      },
      writable: true,
    });
    renderTransactionsPage(mockTransactions, mockWeb3);

    expect(await screen.getAllByLabelText('No transactions').length).toBe(1);
    expect(await screen.findByText('No transactions found')).toBeInTheDocument();
  });

  test('renders Transaction History, read transactions from cache', async () => {
    const mockTransactions = [] as Transaction[];

    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: jest.fn(() =>
          JSON.stringify({
            account: '0x124',
            items: [mockUnitTransactionTransfer],
            itemCount: 2,
          })
        ),
        setItem: jest.fn(() => null),
      },
      writable: true,
    });

    const { container } = renderTransactionsPage(mockTransactions, mockWeb3);
    expect(container.getElementsByClassName('transaction-history__month').length).toBe(2);

    expect(await screen.getByText('Initiated by DeFi Saver')).toBeVisible();
    expect(await screen.getByText('Transferred 379.0006 ETH')).toBeInTheDocument();
  });

  test('renders Transaction History, not read transactions from cache', async () => {
    const mockTransactions = [] as Transaction[];

    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: jest.fn(() => null),
        setItem: jest.fn(() => null),
      },
      writable: true,
    });

    const { container } = renderTransactionsPage(mockTransactions, mockWeb3);
    expect(container.getElementsByClassName('placeholder-content__description').length).toBe(5);

    expect(await screen.findByText('Borrowed 379.0006 ETH')).toBeInTheDocument();
    expect(await screen.findByText('Initiated by DeFi Saver')).toBeInTheDocument();
    expect(await screen.findByText('Mar 03')).toBeInTheDocument();
  });
});
