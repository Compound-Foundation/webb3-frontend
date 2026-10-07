import { SAFE_ALLOWED_DOMAINS } from '@helpers/safe';

// Mirrors the Safe SDK's own check: an origin is trusted if any pattern matches it.
const isAllowed = (origin: string) => SAFE_ALLOWED_DOMAINS.some((pattern) => pattern.test(origin));

describe('SAFE_ALLOWED_DOMAINS', () => {
  it('accepts the Safe{Wallet} origin', () => {
    expect(isAllowed('https://app.safe.global')).toBe(true);
  });

  it.each([
    'http://app.safe.global',
    'https://app.safe.global.evil.com',
    'https://evil.app.safe.global',
    'https://myapp-safe.global',
    'https://appXsafeXglobal',
    'https://app.safe.global:8443',
    'https://app.compound.xyz',
    'null',
  ])('rejects %s', (origin) => {
    expect(isAllowed(origin)).toBe(false);
  });
});
