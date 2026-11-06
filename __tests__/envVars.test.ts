import { isScreeningBypassed, SCREENING_DISABLED } from '../envVars';

// `SCREENING_DISABLED` is `isScreeningBypassed` applied to `import.meta`, which Jest fixes for every test,
// so these cases call the function with the values each kind of run resolves.
describe('isScreeningBypassed', () => {
  it('skips screening on the dev server with no endpoint, in any mode', () => {
    // `yarn dev` (mode development) and `yarn dev --mode playground` both resolve DEV=true on the dev server.
    expect(isScreeningBypassed({ DEV: true, isDevServer: true })).toBe(true);
  });

  it('treats an empty endpoint as missing on the dev server', () => {
    expect(isScreeningBypassed({ DEV: true, isDevServer: true, VITE_SCREENING_ENDPOINT: '' })).toBe(true);
  });

  it('screens on the dev server when an endpoint is set', () => {
    expect(
      isScreeningBypassed({ DEV: true, isDevServer: true, VITE_SCREENING_ENDPOINT: 'https://screening.example' })
    ).toBe(false);
  });

  it('screens on the dev server when NODE_ENV=production gives DEV=false', () => {
    expect(isScreeningBypassed({ DEV: false, isDevServer: true })).toBe(false);
  });

  it('screens in a build with NODE_ENV=development and no endpoint, in any mode', () => {
    // `NODE_ENV=development vite build` resolves DEV=true in mode production, and adding `--mode development`
    // resolves DEV=true in mode development. Every build replaces `import.meta.hot` with undefined.
    expect(isScreeningBypassed({ DEV: true, isDevServer: false })).toBe(false);
  });

  it('screens in an ordinary production build with no endpoint', () => {
    expect(isScreeningBypassed({ DEV: false, isDevServer: false })).toBe(false);
  });
});

describe('SCREENING_DISABLED', () => {
  it('is false under Jest, whose import.meta has no hot context or DEV and sets an endpoint', () => {
    expect(SCREENING_DISABLED).toBe(false);
  });
});
