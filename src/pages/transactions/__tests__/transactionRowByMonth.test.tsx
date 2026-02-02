import { render, screen } from '@testing-library/react';

import '@testing-library/jest-dom';
import { TransactionHistoryItem } from '@types';

import { mockBulkTransaction, mockUnitTransactionTransfer } from '../../../../__tests__/mocks/mockTransactions';
import TransactionRowByMonth from '../components/TransactionRowByMonth';

const renderTransactionRowByMonth = ({
  month,
  transactions,
  account,
}: {
  month: string;
  transactions: TransactionHistoryItem[];
  account: string;
}) => {
  return render(<TransactionRowByMonth month={month} transactions={transactions} account={account} />);
};

describe('TransactionRowByMonth', () => {
  test('renders TransactionRowByMonth with only bulk transaction', () => {
    const { container } = renderTransactionRowByMonth({
      month: 'Mar 2022',
      transactions: [mockBulkTransaction],
      account: '0x123',
    });
    expect(screen.queryAllByText('Mar 2022').length).toBe(1);
    expect(screen.getByText('Mar 08')).toBeInTheDocument();
    expect(screen.getByText('Bulk Transaction')).toBeInTheDocument();
    expect(container.childElementCount).toBe(1);
    expect(container.getElementsByClassName('bulk-transaction__actions__item').length).toBe(4);
  });

  test('renders TransactionRowByMonth with only unit transaction', () => {
    const { container } = renderTransactionRowByMonth({
      month: 'Mar 2022',
      transactions: [mockUnitTransactionTransfer],
      account: '0x123',
    });
    expect(screen.getByText('Mar 2022')).toBeInTheDocument();
    expect(screen.getByText('Mar 03')).toBeInTheDocument();
    expect(screen.queryByText('Bulk Transaction')).not.toBeInTheDocument();
    expect(container.childElementCount).toBe(1);
    expect(container.getElementsByClassName('unit-transaction').length).toBe(1);
  });

  test('renders TransactionRowByMonth with mixed of unit and bulk transactions', () => {
    const { container } = renderTransactionRowByMonth({
      month: 'some month',
      transactions: [mockBulkTransaction, mockUnitTransactionTransfer],
      account: '0x123',
    });
    expect(screen.queryAllByText('some month').length).toBe(1);
    expect(container.getElementsByClassName('transaction-history__month__date-label').length).toBe(1);
    expect(screen.getByText('Mar 08')).toBeInTheDocument();
    expect(screen.getByText('Bulk Transaction')).toBeInTheDocument();
    expect(screen.getByText('Initiated by DeFi Saver')).toBeInTheDocument();
    expect(container.getElementsByClassName('bulk-transaction__actions__item').length).toBe(4);
  });
});
