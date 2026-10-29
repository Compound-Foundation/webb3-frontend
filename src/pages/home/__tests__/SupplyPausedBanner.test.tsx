import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import SupplyPausedBanner from '../components/SupplyPausedBanner';

describe('SupplyPausedBanner', () => {
  it('says supplies are paused and links to the forum in a new tab', () => {
    render(<SupplyPausedBanner />);

    expect(
      screen.getByText(/New supplies to affected Compound markets are temporarily paused as a precaution/)
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Compound forum' });
    expect(link).toHaveAttribute('href', 'https://www.comp.xyz/t/compound-v3-supply-paused-across-major-markets/8203');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
