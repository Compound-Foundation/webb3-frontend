import { renderHook, waitFor } from '@testing-library/react';

import { screenAddress } from '@helpers/screening';
import { useAddressScreening } from '@hooks/useAddressScreening';

jest.mock('@helpers/screening');
// Stand in for the local dev server with no VITE_SCREENING_ENDPOINT configured.
jest.mock('../../envVars', () => ({
  SCREENING_DISABLED: true,
  SCREENING_URL: 'http://localhost/screen',
}));

const mockScreen = screenAddress as jest.MockedFunction<typeof screenAddress>;

const SANCTIONED = '0x8589427373D6D84E98730D7795D8f6f8731FDA16';
const CLEAN = '0x0000000000000000000000000000000000000aa1';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useAddressScreening with screening disabled (local dev)', () => {
  it('allows without calling the endpoint', async () => {
    const { result } = renderHook(() => useAddressScreening(CLEAN));
    await waitFor(() => expect(result.current).toBe('allowed'));
    expect(mockScreen).not.toHaveBeenCalled();
  });

  it('still blocks a sanctioned address', async () => {
    const { result } = renderHook(() => useAddressScreening(SANCTIONED));
    await waitFor(() => expect(result.current).toBe('blocked'));
    expect(mockScreen).not.toHaveBeenCalled();
  });

  it('still returns idle for undefined address', () => {
    const { result } = renderHook(() => useAddressScreening(undefined));
    expect(result.current).toBe('idle');
  });
});
