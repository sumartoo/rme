const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

/**
 * Paket pihak ketiga TIDAK dibundel (modul native seperti argon2, dan agar versi mengikuti lockfile);
 * hanya library workspace @clinicrme/* yang dikompilasi ke bundle. Semua paket runtime wajib tercantum
 * di package.json aplikasi ini (dicek lint @nx/dependency-checks).
 */
const externals = ({ request }, callback) =>
  /^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*(?:\/.*)?$/i.test(request) && !request.startsWith('@clinicrme/')
    ? callback(null, `commonjs ${request}`)
    : callback();

module.exports = {
  externals: [externals],
  output: {
    path: join(__dirname, 'dist'),
    clean: true,
    ...(process.env.NODE_ENV !== 'production' && {
      devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    }),
  },
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      externalDependencies: 'none',  // diganti fungsi externals di atas
      mergeExternals: true,
      compiler: 'tsc',
      main: './src/main.ts',
      // Runner migrasi ikut dibundel agar image produksi dapat menjalankannya tanpa tsx (job migrasi)
      additionalEntryPoints: [
        { entryName: 'migrate', entryPath: join(__dirname, '../../libs/db/src/bin/migrate.ts') },
        { entryName: 'reference', entryPath: join(__dirname, '../../libs/db/src/bin/load-reference.ts') },   // data referensi (Stage 7)
      ],
      tsConfig: './tsconfig.app.json',
      assets: ['./src/assets'],
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: false,
      sourceMap: true,
    }),
  ],
};
