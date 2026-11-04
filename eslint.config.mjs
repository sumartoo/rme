import nx from '@nx/eslint-plugin';

/**
 * Aturan lint seluruh monorepo (CODING_STANDARDS.md).
 * Batas modul (OD-003): app → feature/data/util; feature → data/util (feature tidak boleh saling impor);
 * data → util; util → util. Web hanya boleh memakai library UI/web — tidak pernah library server.
 */
export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  { ignores: ['**/dist', '**/out-tsc', '**/.next', '**/test-output', 'poc/**', 'docs/**', 'api/**', 'db/**', 'tools/**'] },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': ['error', {
        enforceBuildableLibDependency: true,
        allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
        depConstraints: [
          { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['type:feature', 'type:data', 'type:util', 'type:ui'] },
          { sourceTag: 'type:feature', onlyDependOnLibsWithTags: ['type:data', 'type:util'] },
          { sourceTag: 'type:data', onlyDependOnLibsWithTags: ['type:util'] },
          { sourceTag: 'type:util', onlyDependOnLibsWithTags: ['type:util'] },
          { sourceTag: 'scope:web', onlyDependOnLibsWithTags: ['type:ui', 'scope:web'] },
        ],
      }],
      // SC-WEB-04: query selalu terparameter — sql.raw tidak boleh dipakai
      'no-restricted-syntax': ['error', {
        selector: "CallExpression[callee.object.name='sql'][callee.property.name='raw']",
        message: 'sql.raw dilarang (SC-WEB-04). Gunakan template sql`...` yang terparameter.',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Akses database hanya lewat libs/db (Db.withTenant / withTenantTx) — SC-TEN-02
    files: ['apps/api/src/**/*.ts', 'apps/web/**/*.ts', 'apps/web/**/*.tsx', 'libs/iam/**/*.ts', 'libs/patient/**/*.ts', 'libs/platform/**/*.ts', 'libs/tenant/**/*.ts', 'libs/storage/**/*.ts', 'libs/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'pg', message: 'Akses database hanya lewat @clinicrme/db (SC-TEN-02).' },
          { name: 'drizzle-orm/node-postgres', message: 'Akses database hanya lewat @clinicrme/db (SC-TEN-02).' },
        ],
      }],
    },
  },
];
