import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { MemoryRouter, useNavigate } from 'react-router-dom';

import { ScreeningStatus } from '@hooks/useAddressScreening';

import ScreeningErrorOverlay from '../ScreeningErrorOverlay';

// Harness: renders the overlay plus a button that navigates, so we can
// simulate a header/footer nav click changing the route.
const Harness = ({ status }: { status: ScreeningStatus }) => {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate('/markets')}>go</button>
      <ScreeningErrorOverlay screeningStatus={status} />
    </>
  );
};

describe('ScreeningErrorOverlay', () => {
  test('renders nothing for non-blocked statuses', () => {
    const { rerender } = render(
      <MemoryRouter initialEntries={['/']}>
        <Harness status="idle" />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Unexpected error')).not.toBeInTheDocument();

    for (const s of ['checking', 'allowed'] as ScreeningStatus[]) {
      rerender(
        <MemoryRouter initialEntries={['/']}>
          <Harness status={s} />
        </MemoryRouter>,
      );
      expect(screen.queryByText('Unexpected error')).not.toBeInTheDocument();
    }
  });

  test('shows on rising edge into blocked, with copy and mailto link', () => {
    const { rerender } = render(
      <MemoryRouter initialEntries={['/']}>
        <Harness status="checking" />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Unexpected error')).not.toBeInTheDocument();

    rerender(
      <MemoryRouter initialEntries={['/']}>
        <Harness status="blocked" />
      </MemoryRouter>,
    );

    expect(screen.getByText('Unexpected error')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /info@comp\.xyz/ });
    expect(link).toHaveAttribute('href', 'mailto:info@comp.xyz');
  });

  test('dismisses on navigation', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <Harness status="blocked" />
      </MemoryRouter>,
    );
    // Mounting at 'blocked' is a rising edge from undefined -> blocked, so it shows.
    expect(screen.getByText('Unexpected error')).toBeInTheDocument();

    await user.click(screen.getByText('go'));
    expect(screen.queryByText('Unexpected error')).not.toBeInTheDocument();
  });

  test('re-shows on a second rising edge after dismissal', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <MemoryRouter initialEntries={['/']}>
        <Harness status="blocked" />
      </MemoryRouter>,
    );
    expect(screen.getByText('Unexpected error')).toBeInTheDocument();

    // Dismiss via navigation.
    await user.click(screen.getByText('go'));
    expect(screen.queryByText('Unexpected error')).not.toBeInTheDocument();

    // Status clears (e.g. wallet disconnected), then a new connect flow blocks again.
    rerender(
      <MemoryRouter initialEntries={['/markets']}>
        <Harness status="allowed" />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Unexpected error')).not.toBeInTheDocument();

    rerender(
      <MemoryRouter initialEntries={['/markets']}>
        <Harness status="blocked" />
      </MemoryRouter>,
    );
    expect(screen.getByText('Unexpected error')).toBeInTheDocument();
  });
});
