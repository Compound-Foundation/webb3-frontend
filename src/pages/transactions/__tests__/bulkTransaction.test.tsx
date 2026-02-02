import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import '@testing-library/jest-dom';

import { TransactionHistoryItem } from '@types';

import { mockBulkTransaction, mockLiquidationTransaction } from '../../../../__tests__/mocks/mockTransactions';
import BulkTransaction from '../components/BulkTransaction';

const renderBulkTransaction = (transaction: TransactionHistoryItem) => {
  return render(<BulkTransaction transaction={transaction} account={'0x123'} index={1} />);
};

describe('Bulk Transaction', () => {
  test('renders Bulk transacation header', () => {
    const { container } = renderBulkTransaction(mockBulkTransaction);
    expect(screen.getByText('Bulk Transaction')).toBeInTheDocument();
    expect(container.getElementsByClassName('icon--COMPOUND').length).toBe(1);
  });

  test('renders Bulk transacation network and market', () => {
    renderBulkTransaction(mockBulkTransaction);
    expect(screen.getByText('ETH')).toBeInTheDocument();
    expect(screen.getByText('Ethereum')).toBeInTheDocument();
  });

  test('renders Bulk transacation date', () => {
    renderBulkTransaction(mockBulkTransaction);
    expect(screen.getByText('Mar 08')).toBeInTheDocument();
  });

  test('renders Bulk transacation link', () => {
    renderBulkTransaction(mockBulkTransaction);
    const link = screen.getAllByRole('link')[0];
    expect(link).toHaveAttribute('href', 'https://etherscan.io/tx/0xabefdea...');
  });

  test('renders Bulk transacation external link with hover state', async () => {
    const user = userEvent.setup();
    const { container } = renderBulkTransaction(mockBulkTransaction);
    const header = container.getElementsByClassName('bulk-transaction__header')[0];
    await user.hover(header);
    const externalLink = container.getElementsByClassName('transaction__date-holder__external-link')[0];
    const style = window.getComputedStyle(externalLink);
    expect(style.visibility).toBe('visible');
    await user.unhover(header);
  });

  test('renders Bulk transacation graphs', () => {
    const { container } = renderBulkTransaction(mockBulkTransaction);
    expect(container.getElementsByClassName('graph-stem').length).toBe(3);
  });

  test('renders liquidation transacation', () => {
    const { container } = renderBulkTransaction(mockLiquidationTransaction);
    expect(screen.getByText('Liquidated LINK')).toBeInTheDocument();
    expect(container.getElementsByClassName('icon--LIQUIDATE').length).toBe(1);
    expect(container.getElementsByClassName('asset--LINK').length).toBe(1);
    expect(container.getElementsByClassName('svg--seize').length).toBe(1);
    expect(screen.getByText('Seized LINK')).toBeInTheDocument();
    expect(screen.getByText('Repaid 1,028,361.3153 USDC')).toBeInTheDocument();
  });
});
