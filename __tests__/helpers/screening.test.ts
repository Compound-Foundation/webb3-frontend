import { screenAddress } from '@helpers/screening';

import { SCREENING_URL } from '../../envVars';
import { rest, server } from '../../handlers/server';

const ADDR = '0x0000000000000000000000000000000000000aa1';

describe('screenAddress', () => {
  // The worker returns { flagged: boolean }. "allowed" means NOT flagged.
  it('returns true on 200 { flagged: false }', async () => {
    server.use(rest.get(SCREENING_URL, (_req, res, ctx) => res(ctx.json({ flagged: false }))));
    await expect(screenAddress(ADDR)).resolves.toBe(true);
  });

  it('returns false on 200 { flagged: true }', async () => {
    server.use(rest.get(SCREENING_URL, (_req, res, ctx) => res(ctx.json({ flagged: true }))));
    await expect(screenAddress(ADDR)).resolves.toBe(false);
  });

  it('returns false (fail-closed) when the body lacks a boolean flagged field', async () => {
    server.use(rest.get(SCREENING_URL, (_req, res, ctx) => res(ctx.json({}))));
    await expect(screenAddress(ADDR)).resolves.toBe(false);
  });

  it('sends the lowercased address as the query param', async () => {
    let seenAddress: string | null = null;
    server.use(
      rest.get(SCREENING_URL, (req, res, ctx) => {
        seenAddress = req.url.searchParams.get('address');
        return res(ctx.json({ flagged: false }));
      })
    );
    await screenAddress(ADDR);
    expect(seenAddress).toBe(ADDR);
  });

  it('returns false on non-2xx', async () => {
    server.use(rest.get(SCREENING_URL, (_req, res, ctx) => res(ctx.status(500))));
    await expect(screenAddress(ADDR)).resolves.toBe(false);
  });

  it('returns false on malformed body', async () => {
    server.use(rest.get(SCREENING_URL, (_req, res, ctx) => res(ctx.body('not json'))));
    await expect(screenAddress(ADDR)).resolves.toBe(false);
  });

  it('returns false on network error', async () => {
    server.use(rest.get(SCREENING_URL, (_req, res) => res.networkError('boom')));
    await expect(screenAddress(ADDR)).resolves.toBe(false);
  });

  // NOTE: MSW + the whatwg-fetch polyfill does NOT honor AbortController, so a
  // ctx.delay-based timeout test is non-deterministic. Drive the real timeout/abort
  // wiring by controlling fetch directly with fake timers.
  it('returns false (fail-closed) when the request aborts on timeout', async () => {
    jest.useFakeTimers();
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit).signal;
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        })
    );
    const promise = screenAddress(ADDR, 5);
    jest.advanceTimersByTime(6); // fires setTimeout(abort) → signal aborts → fetch rejects
    await expect(promise).resolves.toBe(false);
    fetchSpy.mockRestore();
    jest.useRealTimers();
  });
});
