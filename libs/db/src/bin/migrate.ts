import { resolve } from 'node:path';
import { runMigrations } from '../lib/migrate';

/** `pnpm db:migrate` — MIGRATION_DATABASE_URL = koneksi role pemilik skema (bukan role aplikasi). */
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL wajib diisi');
  process.exit(2);
}
const folder = resolve(process.env.MIGRATIONS_DIR ?? 'db/migrations');
runMigrations(url, folder)
  .then(({ applied }) => console.log(applied.length ? `Migrasi diterapkan: ${applied.join(', ')}` : 'Database sudah terbaru'))
  .catch((e) => {
    // Drizzle membungkus error PostgreSQL; tampilkan penyebab aslinya, bukan seluruh teks SQL migrasi
    const cause = e?.cause ?? e;
    console.error(`Migrasi gagal: ${cause?.message ?? e}${cause?.where ? ` — ${cause.where}` : ''}`);
    process.exit(1);
  });
