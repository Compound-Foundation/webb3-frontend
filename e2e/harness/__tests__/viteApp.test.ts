/**
 * @jest-environment node
 */
// Bundled dev selection and its refusal of raw file system requests.
import { BUNDLED_DEV_CONFIG, denyRawFs, devBundledOf, isRawFsRequest } from '../viteApp';

// Vite ships ESM only, which Jest cannot load. These configuration helpers need none of it.
jest.mock('vite', () => ({}));

test('selects bundled dev only when BROWSER_TEST_BUNDLED_DEV is 1', () => {
  for (const value of [undefined, '', '0']) expect(devBundledOf({ BROWSER_TEST_BUNDLED_DEV: value })).toBe(false);
  expect(devBundledOf({ BROWSER_TEST_BUNDLED_DEV: '1' })).toBe(true);
  for (const value of ['true', 'yes', '2']) {
    expect(() => devBundledOf({ BROWSER_TEST_BUNDLED_DEV: value })).toThrow('BROWSER_TEST_BUNDLED_DEV must be 0 or 1.');
  }
  expect(BUNDLED_DEV_CONFIG).toEqual({
    experimental: { bundledDev: true },
    build: { rollupOptions: { output: { strictExecutionOrder: true } } },
  });
});

test("bundled dev's middleware refuses every /@fs/ request with 403 and passes every other request on", () => {
  type Middleware = (
    request: { url?: string },
    response: { statusCode: number; end: () => void },
    next: () => void
  ) => void;
  let middleware: Middleware | undefined;
  const configureServer = denyRawFs().configureServer as (server: unknown) => void;
  configureServer({ middlewares: { use: (each: Middleware) => (middleware = each) } });
  const answer = (url: string) => {
    const response = { statusCode: 200, ended: false, end: () => (response.ended = true) };
    let passed = false;
    middleware?.(url === '' ? {} : { url }, response, () => (passed = true));
    return passed ? 'passed' : `${response.statusCode}${response.ended ? '' : ' unended'}`;
  };
  for (const url of ['/@fs/tmp/control-token', '/@fs', '/%40fs/tmp/x', '/@fs/tmp/x?import', '/@fs/%E0%A4%A']) {
    expect([url, answer(url)]).toEqual([url, '403']);
  }
  for (const url of ['/', '', '/markets/', '/@vite/client', '/@fsx', '/src/@fs/x', '/?q=/@fs/x']) {
    expect([url, answer(url)]).toEqual([url, 'passed']);
  }
  expect(isRawFsRequest(undefined)).toBe(false);
});
