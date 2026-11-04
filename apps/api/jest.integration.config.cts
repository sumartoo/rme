/* eslint-disable */
const { readFileSync } = require('fs');

const swcJestConfig = JSON.parse(readFileSync(`${__dirname}/.spec.swcrc`, 'utf-8'));
swcJestConfig.swcrc = false;

/**
 * Uji integrasi API terhadap PostgreSQL nyata (TEST_PG_ADMIN_URL). Satu worker:
 * suite berbagi satu database uji dan berurutan (lockout, MFA, sesi).
 */
module.exports = {
  displayName: '@clinicrme/api:integration',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: { '^.+\\.[tj]s$': ['@swc/jest', swcJestConfig] },
  moduleFileExtensions: ['ts', 'js'],
  roots: ['<rootDir>/test-integration'],
  testMatch: ['**/*.e2e-spec.ts'],
  testTimeout: 60000,
  maxWorkers: 1,
};
