import { render } from '@testing-library/react';

import '@testing-library/jest-dom';
import TransactionRowLoader from '../components/TransactionRowLoader';

const renderTransactionRowLoader = (count: number) => {
  return render(<TransactionRowLoader count={count} />);
};

describe('TransactionRowLoader', () => {
  test('renders placeholder content loaders', () => {
    const { container } = renderTransactionRowLoader(2);
    expect(container.getElementsByClassName('placeholder-content').length).toBe(9);
  });

  test('renders 2 loaders', () => {
    const { container } = renderTransactionRowLoader(2);
    expect(container.getElementsByClassName('unit-transaction').length).toBe(2);
  });
});
