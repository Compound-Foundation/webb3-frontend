import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import WrappedRouteNotice from '../WrappedRouteNotice';

describe('WrappedRouteNotice', () => {
  test('says supply goes through the wrapper and that reward rates do not apply', () => {
    render(<WrappedRouteNotice baseSymbol="USDT" />);

    expect(screen.getByText(/USDT you supply to this market goes through its wrapper/)).toBeInTheDocument();
    expect(screen.getByText(/reward and boost rates do not apply to wrapped positions/i)).toBeInTheDocument();
  });
});
