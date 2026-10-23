// The wrapped lending fork suite. `node scripts/test-wrapped-lending-fork.js` runs it against a local
// mainnet fork it starts on 127.0.0.1. The default `yarn test` skips this directory, because it
// needs that fork.
import baseConfig from '../../../jest.config.js';

export default {
  ...baseConfig,
  rootDir: '../../..',
  testMatch: ['<rootDir>/__tests__/integration/wrappedLendingFork/**/*.fork.test.ts?(x)'],
  testPathIgnorePatterns: ['<rootDir>/__tests__/mocks/', '<rootDir>/.claude/'],
  // No msw server: every request goes to the local fork, and `forkSetup.ts` refuses any other target.
  setupFilesAfterEnv: ['<rootDir>/setup.jest.ts', '<rootDir>/__tests__/integration/wrappedLendingFork/forkSetup.ts'],
  testTimeout: 600_000,
};
