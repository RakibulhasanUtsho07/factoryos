/** @type {import('jest').Config} */
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.(t|j)sx?$': '@swc/jest'
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  moduleFileExtensions: ['js', 'json', 'ts'],
  clearMocks: true
};
