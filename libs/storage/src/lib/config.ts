import type { BucketKind, StorageConfig } from './storage';

/**
 * Konfigurasi penyimpanan dari environment (dipakai API & worker). Driver `fs` hanya untuk local/test;
 * di cloud wajib `gcs` (bucket privat, ADR-0013). Error menyebut nama variabel, bukan nilainya.
 */
export function storageConfigFromEnv(env: Record<string, string | undefined>, appEnv: string): StorageConfig {
  const driver = (env['STORAGE_DRIVER'] ?? 'fs') as StorageConfig['driver'];
  if (driver !== 'fs' && driver !== 'gcs') throw new Error('STORAGE_DRIVER harus fs atau gcs');
  // dev = VPS pengembangan (CR-0003, data sintetis, volume dicadangkan); staging/prod wajib object storage
  if (driver === 'fs' && !['local', 'test', 'dev'].includes(appEnv)) throw new Error('STORAGE_DRIVER=fs hanya untuk APP_ENV local/test/dev');
  const name = (k: string, def: string) => {
    const v = env[k] ?? def;
    if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(v)) throw new Error(`${k} bukan nama bucket yang valid`);
    return v;
  };
  const buckets: Record<BucketKind, string> = {
    files: name('STORAGE_BUCKET_FILES', 'clinicrme-files'),
    exports: name('STORAGE_BUCKET_EXPORTS', 'clinicrme-exports'),
  };
  const gcsEndpoint = env['STORAGE_GCS_ENDPOINT'] ?? 'https://storage.googleapis.com';
  if (!/^https?:\/\/[^\s]+$/.test(gcsEndpoint)) throw new Error('STORAGE_GCS_ENDPOINT harus URL');
  return { driver, fsDir: env['STORAGE_FS_DIR'] ?? '.data/storage', gcsEndpoint, buckets };
}
