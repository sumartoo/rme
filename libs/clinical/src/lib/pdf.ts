import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { type Tx, rows } from '@clinicrme/db';
import { ctx } from '@clinicrme/shared';
import { type ObjectStorage, objectPathFor } from '@clinicrme/storage';

export { renderPdf, type Content } from '@clinicrme/shared/pdf';

/**
 * Simpan berkas ke object storage (ADR-0013) + baris stored_file. Penulisan berkas terjadi sebelum commit transaksi;
 * bila transaksi gagal, objek yatim tidak dirujuk siapa pun (aman, dapat dibersihkan job berkala).
 */
export async function storeFile(tx: Tx, storage: ObjectStorage, f: { category: 'MEDICAL_DOCUMENT' | 'LAB_RESULT'; patientId: string;
  buffer: Buffer; contentType: string; ext: string }): Promise<{ id: string; sha256: string }> {
  const id = randomUUID();
  const tenantId = ctx().tenantId!;
  const objectPath = objectPathFor(tenantId, f.category.toLowerCase(), id, f.ext);
  const dir = await mkdtemp(join(tmpdir(), 'crme-'));
  try {
    const local = join(dir, `${id}.${f.ext}`);
    await writeFile(local, f.buffer, { mode: 0o600 });
    await storage.putFile('files', objectPath, local, f.contentType);
  } finally { await rm(dir, { recursive: true, force: true }); }
  const sha256 = createHash('sha256').update(f.buffer).digest('hex');
  await tx.execute(sql`insert into stored_file(id, tenant_id, category, object_path, content_type, size_bytes, sha256, patient_id, uploaded_by)
    values (${id}, app.current_tenant_id(), ${f.category}, ${objectPath}, ${f.contentType}, ${f.buffer.length}, ${sha256}, ${f.patientId}, ${ctx().userId})`);
  return { id, sha256 };
}

export async function fileOf(tx: Tx, id: string) {
  const [f] = await rows<{ object_path: string; content_type: string; size_bytes: string; patient_id: string | null }>(tx, sql`
    select object_path, content_type, size_bytes::text, patient_id from stored_file where id = ${id}`);
  return f;
}
