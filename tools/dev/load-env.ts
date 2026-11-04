import { existsSync, readFileSync } from 'node:fs';

/** Memuat .env sederhana (KEY=VALUE) ke process.env tanpa menimpa variabel yang sudah ada. */
export function loadDotEnv(path = '.env') {
  if (!existsSync(path)) {
    // Kontainer deploy (CR-0003) menerima konfigurasi lewat variabel lingkungan, bukan berkas .env
    if (process.env.APP_ENV) return;
    throw new Error('.env belum ada — jalankan pnpm dev:env');
  }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export function need(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} wajib diisi di .env`);
  return v;
}
