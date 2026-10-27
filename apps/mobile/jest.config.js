/**
 * Ghita Agent - Mobile Jest Configuration
 *
 * Custom minimal config (no jest-expo preset) to avoid loading RN internals
 * that use Flow types in node_modules. All RN APIs are mocked via
 * tests/mocks/react-native.ts and tests/setup.ts.
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.{ts,tsx}', '**/?(*.)+(spec|test).{ts,tsx}'],
  moduleNameMapper: {
    '^react-native$': '<rootDir>/tests/mocks/react-native.ts',
  },
  transform: {
    '^.+\\.[jt]sx?$': 'babel-jest',
  },
  // Don't transform node_modules at all - everything RN-related is mocked.
  transformIgnorePatterns: ['/node_modules/'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.d.ts', '!src/index.ts'],
};
