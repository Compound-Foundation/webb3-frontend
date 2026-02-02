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
              options: { metaObjectReplacement: { env: { VITE_V3_API_HOST: 'http://localhost' } } },
            },
          ],
        },
      },
    ],
  },
  transformIgnorePatterns: ['<rootDir>/node_modules/(?!msw)/'],
  setupFilesAfterEnv: ['<rootDir>/setup.jest.ts', '<rootDir>/setupTests.ts'],
  testPathIgnorePatterns: ['<rootDir>/__tests__/mocks/'],
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
