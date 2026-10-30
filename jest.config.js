export default {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  transform: {
    '^.+\\.ts?$': [
      'ts-jest',
      {
        diagnostics: {
          ignoreCodes: [1343],
        },
        astTransformers: {
          before: [
            {
              path: 'ts-jest-mock-import-meta',
              options: {
                metaObjectReplacement: {
                  env: {
                    VITE_V3_API_HOST: 'http://localhost',
                    VITE_SCREENING_ENDPOINT: 'http://localhost/screen',
                  },
                },
              },
            },
          ],
        },
      },
    ],
    // react-router 8+ and its cookie-es dependency ship ESM-only, so they
    // must be compiled to CJS for jest
    'node_modules/(react-router|cookie-es)/.+\\.m?js$':
      '<rootDir>/scripts/jest-react-router-transform.cjs',
  },
  transformIgnorePatterns: ['<rootDir>/node_modules/(?!(msw|react-router|cookie-es)/)'],
  setupFilesAfterEnv: ['<rootDir>/setup.jest.ts', '<rootDir>/setupTests.ts'],
  // .claude/ holds Claude Code worktrees (checkouts of other branches) whose test files must not run here.
  // e2e/specs/ holds the Playwright browser suite, which runs with `yarn test:browser`, not Jest.
  // The wrapped lending fork suite needs a local mainnet fork, so only its own runner starts it:
  // `node scripts/test-wrapped-lending-fork.js`.
  // scripts/ holds Node test runner files, which Jest cannot load. `__tests__/scripts/` runs them.
  testPathIgnorePatterns: [
    '<rootDir>/__tests__/mocks/',
    '<rootDir>/.claude/',
    '<rootDir>/e2e/specs/',
    '<rootDir>/test-results/',
    '<rootDir>/__tests__/integration/wrappedLendingFork/',
    '<rootDir>/scripts/',
  ],
  moduleNameMapper: {
    '\\.(scss|css)$': 'identity-obj-proxy', // Mock SCSS imports for CSS Modules (if you use them)
    '^@components(.*)$': '<rootDir>/src/components$1',
    '^@hooks(.*)$': '<rootDir>/src/hooks$1',
    '^@contexts(.*)$': '<rootDir>/src/contexts$1',
    '^@helpers(.*)$': '<rootDir>/src/helpers$1',
    '^@types': '<rootDir>/src/types',
    '^@constants(.*)$': '<rootDir>/src/constants$1',
    '^@pages(.*)$': '<rootDir>/src/pages$1',
  },
};
