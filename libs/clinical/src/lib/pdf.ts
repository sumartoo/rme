import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { type Tx, rows } from '@clinicrme/db';
import { ctx } from '@clinicrme/shared';
import { type ObjectStorage, objectPathFor } from '@clinicrme/storage';

/* pdfmake (MIT, OD-093) tidak menyertakan tipe; dipakai di server dengan font standar PDF (tanpa berkas font eksternal). */
interface PdfMake {
  setFonts(f: object): void; setUrlAccessPolicy(fn: (u: string) => boolean): void; setLocalAccessPolicy(fn: (p: string) => boolean): void;
  createPdf(doc: object): { getBuffer(): Promise<Buffer> };
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfmake = require('pdfmake') as PdfMake;
const STANDARD = new Set(['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique']);
pdfmake.setFonts({ Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' } });
pdfmake.setUrlAccessPolicy(() => false);                 // tidak pernah mengunduh sumber eksternal
pdfmake.setLocalAccessPolicy((p) => STANDARD.has(p));     // hanya font standar bawaan

export type Content = string | Record<string, unknown> | Content[];

/** PDF deterministik (tanggal pembuatan tetap = waktu terbit) dengan font standar. */
export function renderPdf(content: Content[], meta: { title: string; issuedAt: Date }): Promise<Buffer> {
  return pdfmake.createPdf({
    info: { title: meta.title, creator: 'ClinicRME', producer: 'ClinicRME', creationDate: meta.issuedAt },
    pageSize: 'A4', pageMargins: [48, 40, 48, 48],
    defaultStyle: { font: 'Helvetica', fontSize: 10, lineHeight: 1.25 },
    styles: { title: { fontSize: 13, bold: true, alignment: 'center', margin: [0, 8, 0, 2] }, small: { fontSize: 8, color: '#555555' },
      label: { bold: true }, clinic: { fontSize: 12, bold: true } },
    content,
  }).getBuffer();
}

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
