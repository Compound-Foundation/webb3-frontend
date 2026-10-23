import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import Redirect, { REDIRECT_COUNTDOWN_SECONDS, REDIRECT_TARGET_URL } from '../index';

describe('Redirect page', () => {
  let assign: jest.Mock;

  const renderPage = () => render(<Redirect navigate={assign} />);

  // Each tick is scheduled by an effect that only runs after the previous state update
  // flushes, so the clock has to be advanced one second per act() rather than in one jump.
  const tick = (seconds: number) => {
    for (let i = 0; i < seconds; i++) {
      act(() => {
        jest.advanceTimersByTime(1000);
      });
    }
  };

  beforeEach(() => {
    jest.useFakeTimers();
    assign = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    document.getElementById('redirect-page-fonts')?.remove();
  });

  test('renders the announcement, note, and continue button pointing at the new domain', () => {
    renderPage();

    expect(screen.getByText('Compound.finance is now')).toBeInTheDocument();
    expect(screen.getByText('Compound.xyz')).toBeInTheDocument();
    expect(screen.getByText('Your positions stay the same. No migration required.')).toBeInTheDocument();

    const button = screen.getByRole('link', { name: 'Continue to Compound.xyz' });
    expect(button).toHaveAttribute('href', REDIRECT_TARGET_URL);
    expect(document.title).toBe('Compound Finance');
  });

  test('counts down one second at a time', () => {
    renderPage();

    expect(screen.getByText(String(REDIRECT_COUNTDOWN_SECONDS))).toBeInTheDocument();

    tick(1);
    expect(screen.getByText(String(REDIRECT_COUNTDOWN_SECONDS - 1))).toBeInTheDocument();

    tick(2);
    expect(screen.getByText(String(REDIRECT_COUNTDOWN_SECONDS - 3))).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  test('redirects once the countdown reaches zero', () => {
    renderPage();

    tick(REDIRECT_COUNTDOWN_SECONDS);

    expect(screen.getByText('0')).toBeInTheDocument();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(REDIRECT_TARGET_URL);
  });

  test('loads the page fonts when the host document does not link them', () => {
    expect(document.getElementById('redirect-page-fonts')).toBeNull();

    renderPage();

    const link = document.getElementById('redirect-page-fonts') as HTMLLinkElement;
    expect(link).not.toBeNull();
    expect(link.rel).toBe('stylesheet');
    expect(link.href).toContain('fonts.googleapis.com');
  });

  test('stops the countdown when unmounted', () => {
    const { unmount } = renderPage();
    unmount();

    tick(REDIRECT_COUNTDOWN_SECONDS + 1);

    expect(assign).not.toHaveBeenCalled();
  });
});
