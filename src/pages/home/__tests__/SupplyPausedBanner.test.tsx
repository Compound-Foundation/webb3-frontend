import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import SupplyPausedBanner from '../components/SupplyPausedBanner';

const FORUM_URL = 'https://www.comp.xyz/t/compound-v3-supply-paused-across-major-markets/8203';

describe('SupplyPausedBanner', () => {
  it('says Ethereum markets are unpaused except WBTC and links to the forum thread in a new tab', () => {
    render(<SupplyPausedBanner />);

    expect(
      screen.getByText(
        /All Compound V3 markets on Ethereum except WBTC Comet are now unpaused and fully operational\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Supply, borrowing, and repayments are working as normal\./)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Compound forum' });
    expect(link).toHaveAttribute('href', FORUM_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
