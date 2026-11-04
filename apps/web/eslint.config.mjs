import nextEslintPluginNext from '@next/eslint-plugin-next';
import nx from '@nx/eslint-plugin';
import baseConfig from '../../eslint.config.mjs';

export default [
  { plugins: { '@next/next': nextEslintPluginNext } },
  ...nx.configs['flat/react-typescript'],
  ...baseConfig,
  {
    ignores: ['.next/**/*', '**/out-tsc'],
  },
  {
    // Harness Playwright memakai konfigurasi & seed bersama di tools/e2e (bukan kode aplikasi; tidak masuk bundle)
    files: ['e2e/**/*.ts', 'playwright.config.ts'],
    rules: { '@nx/enforce-module-boundaries': 'off' },
  },
];
