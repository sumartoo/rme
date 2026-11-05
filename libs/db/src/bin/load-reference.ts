import { resolve } from 'node:path';
import { loadReference } from '../lib/reference';

/** `pnpm db:reference` / job `reference` saat deploy — muat data referensi global (wilayah, ICD). Role pemilik skema. */
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL wajib diisi');
  process.exit(2);
}
loadReference(url, resolve(process.env.REFERENCE_DIR ?? 'db/reference'), (m) => console.log(m))
  .then((r) => { const skipped = r.filter((x) => x.status === 'skipped').map((x) => x.id); if (skipped.length) console.log(`Sudah terbaru: ${skipped.join(', ')}`); })
  .catch((e) => { console.error(`Pemuatan referensi gagal: ${e?.cause?.message ?? e?.message ?? e}`); process.exit(1); });
