import { render, screen } from '@testing-library/react';

import '@testing-library/jest-dom';
import { TransactionHistoryItem } from '@types';

import {
  mockUnitTransactionTransfer,
  mockUnitTransactionBorrow,
  mockUnitTransactionSupply,
  mockUnitTransactionRepay,
  mockUnitTransactionClaim,
  mockUnitTransactionWithdraw,
} from '../../../../__tests__/mocks/mockTransactions';
import UnitTransaction from '../components/UnitTransaction';

const renderUnitTransaction = (transaction: TransactionHistoryItem) => {
  return render(<UnitTransaction transaction={transaction} account={'0x123'} />);
};

describe('Unit Transaction', () => {
  test('renders Unit transacation header', () => {
    renderUnitTransaction(mockUnitTransactionTransfer);
    expect(screen.getByText('Transferred 379.0006 ETH')).toBeInTheDocument();
  });

  test('renders Unit transacation initiated by', () => {
    renderUnitTransaction(mockUnitTransactionTransfer);
    expect(screen.getByText('•')).toBeInTheDocument();
    expect(screen.getByText('Initiated by DeFi Saver')).toBeInTheDocument();
  });

  test('renders Unit transacation date', () => {
    renderUnitTransaction(mockUnitTransactionTransfer);
    expect(screen.getByText('Mar 03')).toBeInTheDocument();
  });

  test('renders Unit transacation link', () => {
    renderUnitTransaction(mockUnitTransactionTransfer);
    const link = screen.getAllByRole('link')[0];
    expect(link).toHaveAttribute('href', 'https://etherscan.io/tx/0x7432ffeeee...');
  });

  test('renders Unit transacation for borrow', () => {
    const { container } = renderUnitTransaction(mockUnitTransactionBorrow);
    expect(container.getElementsByClassName('svg--borrow').length).toBe(1);
    expect(screen.getByText('Borrowed 379.0006 ETH')).toBeInTheDocument();
    expect(screen.getByText('ETH')).toBeInTheDocument();
    expect(screen.getByText('Ethereum')).toBeInTheDocument();
  });

  test('renders Unit transacation for supply', () => {
    const { container } = renderUnitTransaction(mockUnitTransactionSupply);
    expect(container.getElementsByClassName('svg--supply').length).toBe(1);
    expect(screen.getByText('Supplied 379.0006 ETH')).toBeInTheDocument();
    expect(screen.getByText('ETH')).toBeInTheDocument();
    expect(screen.getByText('Ethereum')).toBeInTheDocument();
  });

  test('renders Unit transacation for repay', () => {
    const { container } = renderUnitTransaction(mockUnitTransactionRepay);
    expect(container.getElementsByClassName('svg--borrow').length).toBe(1);
    expect(screen.getByText('Repaid 379.0006 ETH')).toBeInTheDocument();
    expect(screen.getByText('ETH')).toBeInTheDocument();
    expect(screen.getByText('Ethereum')).toBeInTheDocument();
  });

  test('renders Unit transacation for withdraw', () => {
    const { container } = renderUnitTransaction(mockUnitTransactionWithdraw);
    expect(container.getElementsByClassName('svg--supply').length).toBe(1);
    expect(screen.getByText('Withdrew 379.0006 ETH')).toBeInTheDocument();
    expect(screen.getByText('ETH')).toBeInTheDocument();
    expect(screen.getByText('Ethereum')).toBeInTheDocument();
  });

  test('renders Unit transacation for claim', () => {
    const { container } = renderUnitTransaction(mockUnitTransactionClaim);
    expect(container.getElementsByClassName('svg--claim').length).toBe(1);
    expect(screen.getByText('Claimed 379.0006 ETH')).toBeInTheDocument();
    expect(screen.getByText('ETH')).toBeInTheDocument();
    expect(screen.getByText('Ethereum')).toBeInTheDocument();
  });

  test('renders Unit transacation for transfer', () => {
    const { container } = renderUnitTransaction(mockUnitTransactionTransfer);
    expect(container.getElementsByClassName('svg--transfer').length).toBe(1);
    expect(screen.getByText('Transferred 379.0006 ETH')).toBeInTheDocument();
    expect(screen.getByText('ETH')).toBeInTheDocument();
    expect(screen.getByText('Ethereum')).toBeInTheDocument();
  });
});
