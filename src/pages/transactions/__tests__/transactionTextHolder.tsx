import { render, screen } from '@testing-library/react';
import { ReactNode } from 'react';

import '@testing-library/jest-dom';
import TransactionTextHolder from '../components/TransactionTextHolder';

const renderTransactionTextHolder = (headerText: string, children?: ReactNode) => {
  return render(<TransactionTextHolder headerText={headerText}>{children}</TransactionTextHolder>);
};

describe('TransactionTextHolder', () => {
  test('renders TransactionTextHolder text header', () => {
    renderTransactionTextHolder('text header');
    expect(screen.getByText('text header')).toBeInTheDocument();
  });

  test('renders TransactionTextHolder children', () => {
    const child = <span>child</span>;
    renderTransactionTextHolder('text header 2', child);
    expect(screen.getByText('text header 2')).toBeInTheDocument();
    expect(screen.getByText('child')).toBeInTheDocument();
  });
});
