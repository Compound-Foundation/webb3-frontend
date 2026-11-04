import { isScreeningBypassed, SCREENING_DISABLED } from '../envVars';

// `SCREENING_DISABLED` is `isScreeningBypassed` applied to `import.meta.env`, which Jest fixes for every test,
// so these cases call the function with the values each kind of run resolves.
describe('isScreeningBypassed', () => {
  it('skips screening on the dev server with no endpoint', () => {
    expect(isScreeningBypassed({ DEV: true, MODE: 'development' })).toBe(true);
  });

  it('treats an empty endpoint as missing on the dev server', () => {
    expect(isScreeningBypassed({ DEV: true, MODE: 'development', VITE_SCREENING_ENDPOINT: '' })).toBe(true);
  });

  it('screens on the dev server when an endpoint is set', () => {
    expect(
      isScreeningBypassed({ DEV: true, MODE: 'development', VITE_SCREENING_ENDPOINT: 'https://screening.example' })
    ).toBe(false);
  });

  it('screens in a production build with NODE_ENV=development and no endpoint', () => {
    // `NODE_ENV=development vite build` resolves DEV=true in mode production.
    expect(isScreeningBypassed({ DEV: true, MODE: 'production' })).toBe(false);
  });

  it('screens in any other mode with DEV=true and no endpoint', () => {
    expect(isScreeningBypassed({ DEV: true, MODE: 'staging' })).toBe(false);
  });

  it('screens in an ordinary production build with no endpoint', () => {
    expect(isScreeningBypassed({ DEV: false, MODE: 'production' })).toBe(false);
  });
});

describe('SCREENING_DISABLED', () => {
  it('is false under Jest, whose environment sets an endpoint', () => {
    expect(SCREENING_DISABLED).toBe(false);
  });
});
