import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import SupplyPausedBanner from '../components/SupplyPausedBanner';

const FORUM_URL = 'https://www.comp.xyz/t/compound-v3-supply-paused-across-major-markets/8203';

describe('SupplyPausedBanner', () => {
  it('says supplies are paused and links to the forum thread in a new tab', () => {
    render(<SupplyPausedBanner />);

    expect(
      screen.getByText(/New supplies to affected Compound markets are temporarily paused as a precaution/)
    ).toBeInTheDocument();
    expect(screen.getByText(/security incident on Ethereum mainnet/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Compound forum' });
    expect(link).toHaveAttribute('href', FORUM_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
