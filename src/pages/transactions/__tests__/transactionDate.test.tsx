import { render, screen } from '@testing-library/react';

import '@testing-library/jest-dom';
import TransactionDate from '../components/TransactionDate';

const renderTransactionDate = (timestamp: number) => {
  return render(<TransactionDate timestamp={timestamp} />);
};

describe('Transaction Date', () => {
  test('renders transacation date from seconds to month date', () => {
    renderTransactionDate(1677780611);
    expect(screen.getByText('Mar 02')).toBeInTheDocument();
  });
});
