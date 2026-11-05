import { waitFor } from '@testing-library/react';

// setup.jest.ts sets the interval at which `waitFor` checks its callback again. Testing Library starts
// that timer with `setInterval` before its first check, so the interval shows without waiting for it.
describe('waitFor in the Jest setup', () => {
  let setIntervalSpy: jest.SpyInstance;
  beforeEach(() => {
    setIntervalSpy = jest.spyOn(global, 'setInterval');
  });
  afterEach(() => {
    setIntervalSpy.mockRestore();
  });

  it('checks its callback again every 5 ms by default', async () => {
    await waitFor(() => undefined);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5);
  });

  it('keeps an interval the call passes', async () => {
    await waitFor(() => undefined, { interval: 30 });

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30);
  });
});
