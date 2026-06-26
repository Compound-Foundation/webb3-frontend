import { renderHook } from '@testing-library/react';

import { CONNECTOR_LOCALSTORAGE_KEY } from '@helpers/constants';
import { ScreeningStatus } from '@hooks/useAddressScreening';
import { useDisconnectBlockedWallet } from '@hooks/useDisconnectBlockedWallet';

describe('useDisconnectBlockedWallet', () => {
  it('disconnects and forgets the stored connector when blocked', () => {
    const disconnect = jest.fn();
    const removeItem = jest.spyOn(Storage.prototype, 'removeItem');

    renderHook<void, { status: ScreeningStatus }>(({ status }) => useDisconnectBlockedWallet(status, disconnect), {
      initialProps: { status: 'blocked' },
    });

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(removeItem).toHaveBeenCalledWith(CONNECTOR_LOCALSTORAGE_KEY);
    removeItem.mockRestore();
  });

  it('does nothing for non-blocked statuses', () => {
    const disconnect = jest.fn();

    for (const status of ['idle', 'checking', 'allowed'] as ScreeningStatus[]) {
      renderHook(() => useDisconnectBlockedWallet(status, disconnect));
    }

    expect(disconnect).not.toHaveBeenCalled();
  });

  it('disconnects again on a fresh block after recovering', () => {
    const disconnect = jest.fn();

    const { rerender } = renderHook<void, { status: ScreeningStatus }>(
      ({ status }) => useDisconnectBlockedWallet(status, disconnect),
      { initialProps: { status: 'checking' } }
    );

    rerender({ status: 'blocked' });
    expect(disconnect).toHaveBeenCalledTimes(1);

    // Recover (e.g. disconnected -> idle), then a new connect that blocks again.
    rerender({ status: 'idle' });
    rerender({ status: 'blocked' });
    expect(disconnect).toHaveBeenCalledTimes(2);
  });
});
