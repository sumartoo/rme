import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

interface Journal { entries: { idx: number; tag: string; when: number }[] }

/**
 * Menerapkan migrasi `db/migrations` (format Drizzle Kit) sebagai role pemilik skema.
 * Tambahan dari Drizzle: menolak berjalan bila isi migrasi yang SUDAH diterapkan berubah
 * (migrasi immutable; perubahan selalu lewat migrasi baru).
 */
export async function runMigrations(ownerUrl: string, folder: string): Promise<{ applied: string[] }> {
  const journalPath = join(folder, 'meta', '_journal.json');
  if (!existsSync(journalPath)) throw new Error(`Journal migrasi tidak ditemukan: ${journalPath}`);
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
  const files = journal.entries.map((e) => ({
    tag: e.tag, when: e.when,
    hash: createHash('sha256').update(readFileSync(join(folder, `${e.tag}.sql`), 'utf8')).digest('hex'),
  }));

  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    const before = await appliedMigrations(pool);
    for (const a of before) {
      const f = files.find((x) => x.when === a.created_at);
      if (!f) throw new Error(`Migrasi yang sudah diterapkan (created_at=${a.created_at}) tidak ada di folder`);
      if (f.hash !== a.hash) throw new Error(`Migrasi ${f.tag} sudah diterapkan tetapi isinya berubah — buat migrasi baru`);
    }
    await migrate(drizzle(pool), { migrationsFolder: folder });
    const after = await appliedMigrations(pool);
    const appliedNow = after.filter((a) => !before.some((b) => b.created_at === a.created_at))
                            .map((a) => files.find((f) => f.when === a.created_at)?.tag ?? String(a.created_at));
    return { applied: appliedNow };
  } finally {
    await pool.end();
  }
}

async function appliedMigrations(pool: Pool): Promise<{ hash: string; created_at: number }[]> {
  const exists = await pool.query(`select to_regclass('drizzle.__drizzle_migrations') is not null as ok`);
  if (!exists.rows[0].ok) return [];
  const r = await pool.query(`select hash, created_at from drizzle.__drizzle_migrations order by created_at`);
  return r.rows.map((x) => ({ hash: x.hash, created_at: Number(x.created_at) }));
}
