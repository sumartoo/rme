#!/usr/bin/env node
// Membuka arsip ekspor ClinicRME (.crmex) — berdiri sendiri, hanya butuh Node.js ≥ 18 (tanpa paket tambahan).
// Pemakaian:  node decrypt-export.mjs <arsip.crmex> <kunci-base64> <folder-tujuan>
// Kunci diambil tenant admin dari aplikasi (Ekspor data → Tampilkan kunci). Format: "CRMEX1" · IV 12 B · AES-256-GCM(tar.gz) · tag 16 B.
import { createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

const [file, keyB64, outDir] = process.argv.slice(2);
if (!file || !keyB64 || !outDir) {
  console.error('Pemakaian: node decrypt-export.mjs <arsip.crmex> <kunci-base64> <folder-tujuan>');
  process.exit(2);
}
const key = Buffer.from(keyB64, 'base64');
if (key.length !== 32) { console.error('Kunci harus 32 byte (base64)'); process.exit(2); }
const blob = readFileSync(file);
const MAGIC = Buffer.from('CRMEX1');
if (!blob.subarray(0, 6).equals(MAGIC)) { console.error('Bukan arsip ekspor ClinicRME'); process.exit(1); }
const d = createDecipheriv('aes-256-gcm', key, blob.subarray(6, 18), { authTagLength: 16 });
d.setAAD(MAGIC);
d.setAuthTag(blob.subarray(blob.length - 16));
let tar;
try {
  tar = gunzipSync(Buffer.concat([d.update(blob.subarray(18, blob.length - 16)), d.final()]));
} catch {
  console.error('Gagal membuka: kunci salah atau berkas rusak/diubah');
  process.exit(1);
}
const root = normalize(outDir) + sep;
let n = 0;
for (let off = 0; off + 512 <= tar.length;) {
  const h = tar.subarray(off, off + 512);
  if (h.every((b) => b === 0)) break;
  const name = h.subarray(0, 100).toString().replace(/\0.*$/s, '');
  const size = parseInt(h.subarray(124, 136).toString().replace(/\0.*$/s, '').trim() || '0', 8);
  const target = normalize(join(outDir, name));
  if (!target.startsWith(root)) { console.error(`Entri berbahaya ditolak: ${name}`); process.exit(1); }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, tar.subarray(off + 512, off + 512 + size));
  n++;
  off += 512 + Math.ceil(size / 512) * 512;
}
console.log(`${n} berkas diekstrak ke ${outDir} — mulai dari manifest.json`);
