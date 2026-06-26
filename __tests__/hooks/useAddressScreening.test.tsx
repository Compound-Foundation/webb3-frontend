import { renderHook, waitFor } from '@testing-library/react';

import { screenAddress } from '@helpers/screening';
import { useAddressScreening } from '@hooks/useAddressScreening';

jest.mock('@helpers/screening');

const mockScreen = screenAddress as jest.MockedFunction<typeof screenAddress>;

const SANCTIONED = '0x8589427373D6D84E98730D7795D8f6f8731FDA16';
const CLEAN = '0x0000000000000000000000000000000000000aa1';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useAddressScreening', () => {
  it('returns idle for undefined address', () => {
    const { result } = renderHook(() => useAddressScreening(undefined));
    expect(result.current).toBe('idle');
  });

  it('blocks a sanctioned address without calling the endpoint', async () => {
    const { result } = renderHook(() => useAddressScreening(SANCTIONED));
    await waitFor(() => expect(result.current).toBe('blocked'));
    expect(mockScreen).not.toHaveBeenCalled();
  });

  it('allows a clean address that the endpoint approves', async () => {
    mockScreen.mockResolvedValue(true);
    const { result } = renderHook(() => useAddressScreening(CLEAN));
    expect(result.current).toBe('checking');
    await waitFor(() => expect(result.current).toBe('allowed'));
    expect(mockScreen).toHaveBeenCalledWith(CLEAN);
  });

  it('blocks when the endpoint disallows', async () => {
    mockScreen.mockResolvedValue(false);
    const { result } = renderHook(() => useAddressScreening(CLEAN));
    await waitFor(() => expect(result.current).toBe('blocked'));
  });

  it('ignores a stale result after the address changes', async () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    let resolveFirst: (v: boolean) => void = () => {};
    mockScreen.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)));
    mockScreen.mockResolvedValueOnce(true);
    const other = '0x0000000000000000000000000000000000000bb2';

    const { result, rerender } = renderHook(({ a }) => useAddressScreening(a), {
      initialProps: { a: CLEAN },
    });
    rerender({ a: other });
    await waitFor(() => expect(result.current).toBe('allowed')); // second address resolved true
    resolveFirst(false); // stale first result arrives late
    expect(result.current).toBe('allowed'); // must NOT flip to blocked
  });
});
