import { render } from '@testing-library/react';

import '@testing-library/jest-dom';
import BulkTransactionGraph from '../components/BulkTransactionGraph';

const renderBulkTransactionGraph = (last: boolean) => {
  return render(<BulkTransactionGraph last={last} />);
};

describe('Bulk Transaction Graph', () => {
  test('renders Bulk transacation Graph, not the last one', () => {
    const { container } = renderBulkTransactionGraph(false);
    expect(container.getElementsByClassName('graph-stem').length).toBe(1);
    expect(container.getElementsByClassName('graph-end').length).toBe(0);
  });

  test('renders Bulk transacation Graph for the last one', () => {
    const { container } = renderBulkTransactionGraph(true);
    expect(container.getElementsByClassName('graph-stem').length).toBe(0);
    expect(container.getElementsByClassName('graph-end').length).toBe(1);
  });
});
