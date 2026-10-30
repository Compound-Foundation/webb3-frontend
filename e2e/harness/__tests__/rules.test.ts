/**
 * @jest-environment node
 */
// Small rules: the browser egress allowlist, the optional public v3 API URL, and the Comet raw-unit oracle.
import { BASE_INDEX_SCALE, presentValueOf, principalAfterSupply, principalAfterWithdraw } from '../contracts';
import { allows, isAllowed, withoutQuery } from '../egress';
import { v3ApiUrl } from '../settings';

describe('egress', () => {
  const allowed = new Set(['http://127.0.0.1:5173', 'https://127.0.0.1:6000', 'https://v3-api.example.com/v3']);

  test('allows exact origins only, and a path prefix where one is given', () => {
    expect(isAllowed('http://127.0.0.1:5173/src/main.tsx', allowed)).toBe(true);
    expect(isAllowed('https://127.0.0.1:6000/ethereum-mainnet', allowed)).toBe(true);
    expect(isAllowed('https://v3-api.example.com/v3/market', allowed)).toBe(true);
    expect(isAllowed('https://v3-api.example.com/admin', allowed)).toBe(false);
    expect(isAllowed('https://v3-api.example.com/v3admin', allowed)).toBe(false);
    expect(isAllowed('https://v3-api.example.com/v3', allowed)).toBe(true);
    expect(isAllowed('http://127.0.0.1:5174/', allowed)).toBe(false);
    expect(isAllowed('http://localhost:5173/', allowed)).toBe(false);
    expect(isAllowed('https://127.0.0.1:5173/', allowed)).toBe(false);
    expect(isAllowed('not a url', allowed)).toBe(false);
  });

  test('allows any method on an allowed origin, and only GET and HEAD under a read-only prefix', () => {
    const egress = {
      http: new Set(['http://127.0.0.1:5173']),
      readOnly: new Set(['https://api.example.com/v3/market']),
      webSocket: new Set<string>(),
    };
    expect(allows(egress, 'http://127.0.0.1:5173/x', 'POST')).toBe(true);
    expect(allows(egress, 'https://api.example.com/v3/market/summary', 'GET')).toBe(true);
    expect(allows(egress, 'https://api.example.com/v3/market/summary', 'HEAD')).toBe(true);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(allows(egress, 'https://api.example.com/v3/market/summary', method)).toBe(false);
    }
    expect(allows(egress, 'https://api.example.com/v3/account/0x1/transaction_history', 'GET')).toBe(false);
  });

  test('records a blocked URL without its query or fragment', () => {
    expect(withoutQuery('https://rpc.example.com/v2/x?key=secret#frag')).toBe('https://rpc.example.com/v2/x');
    // A popup's URL can be any scheme: it is recorded by scheme, and never by a data URL's content.
    expect(withoutQuery('about:blank')).toBe('about:blank');
    expect(withoutQuery('blob:http://127.0.0.1:5173/3f2a')).toBe('blob:http://127.0.0.1:5173/…');
    expect(withoutQuery('data:text/html,<script>secret</script>')).toBe('data:…');
    expect(withoutQuery('javascript:alert(1)')).toBe('javascript:…');
  });
});

describe('the optional v3 API URL', () => {
  test('accepts a public, credential-free HTTPS base URL', () => {
    expect(v3ApiUrl({})).toBeUndefined();
    expect(v3ApiUrl({ BROWSER_TEST_V3_API_URL: 'https://v3-api.compound.finance/' })).toBe(
      'https://v3-api.compound.finance'
    );
  });

  test.each([
    'http://v3-api.example.com',
    'https://user:pass@v3-api.example.com',
    'https://v3-api.example.com?apikey=abc',
    'https://v3-api.example.com/#x',
    'https://v3-api.example.com/k3y0123456789',
  ])('refuses %s', (url) => {
    expect(() => v3ApiUrl({ BROWSER_TEST_V3_API_URL: url })).toThrow('public HTTPS base URL');
  });
});

describe('the Comet raw-unit oracle', () => {
  // A counterexample to a fixed bound of +0 to +5 raw units: an index at which a supply of 100 USDC reads back as
  // 99.999999, and a withdrawal of 40 USDC then leaves 59.999998, with no interest.
  const index = 1_234_567_890_123_456n;

  test('follows Comet rounding down on supply and on withdrawal', () => {
    const supplied = principalAfterSupply(0n, 100_000_000n, index);
    expect(supplied).toBe((100_000_000n * BASE_INDEX_SCALE) / index);
    expect(presentValueOf(supplied, index)).toBe(99_999_999n);
    const left = principalAfterWithdraw(supplied, 40_000_000n, index);
    expect(presentValueOf(left, index)).toBe(59_999_998n);
  });

  test('refuses a withdrawal that would borrow', () => {
    expect(() => principalAfterWithdraw(1n, 100_000_000n, index)).toThrow('supply balance only');
  });
});
