import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

/**
 * Arsip ekspor tenant terenkripsi (OD-028, PLT-FR-008): tar (ustar) → gzip → AES-256-GCM.
 * Format berkas: "CRMEX1" (6 B, juga AAD) · IV (12 B) · ciphertext · tag GCM (16 B).
 * Ditulis secara streaming sehingga ukuran ekspor tidak dibatasi memori.
 */
const MAGIC = Buffer.from('CRMEX1');
const IV_LEN = 12, TAG_LEN = 16, BLOCK = 512;

export interface ArchiveEntry { name: string; path: string; size: number }

function tarHeader(name: string, size: number, mtime: number): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`nama entri terlalu panjang: ${name}`);
  const h = Buffer.alloc(BLOCK);
  const put = (s: string, off: number, len: number) => h.write(s, off, len, 'utf8');
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(oct(0o644, 8), 100, 8); put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12); put(oct(Math.floor(mtime / 1000), 12), 136, 12);
  put('        ', 148, 8); put('0', 156, 1); put('ustar\0', 257, 6); put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

async function* tarStream(entries: ArchiveEntry[], mtime: number) {
  for (const e of entries) {
    yield tarHeader(e.name, e.size, mtime);
    for await (const chunk of createReadStream(e.path)) yield chunk as Buffer;
    const pad = (BLOCK - (e.size % BLOCK)) % BLOCK;
    if (pad) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(BLOCK * 2);
}

/** Menulis arsip terenkripsi; mengembalikan sha256 & ukuran berkas akhir (untuk manifest/audit). */
export async function writeEncryptedArchive(outPath: string, entries: ArchiveEntry[], key: Buffer): Promise<{ sha256: string; size: number }> {
  if (key.length !== 32) throw new Error('kunci arsip harus 32 byte');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(MAGIC);
  const hash = createHash('sha256');
  let size = 0;
  const out = createWriteStream(outPath, { mode: 0o600 });
  const write = (b: Buffer) => new Promise<void>((res, rej) => out.write(b, (e) => (e ? rej(e) : res())));
  const prefix = Buffer.concat([MAGIC, iv]);
  hash.update(prefix); size += prefix.length;
  await write(prefix);
  const tap = new Transform({ transform(chunk: Buffer, _e, cb) { hash.update(chunk); size += chunk.length; cb(null, chunk); } });
  await pipeline(Readable.from(tarStream(entries, Date.now())), createGzip({ level: 6 }), cipher, tap, out, { end: false });
  const tag = cipher.getAuthTag();
  hash.update(tag); size += tag.length;
  await write(tag);
  await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
  return { sha256: hash.digest('hex'), size };
}

/** Membuka arsip (uji & alat dekripsi). Tag GCM diverifikasi: arsip yang diubah → error. */
export async function readEncryptedArchive(inPath: string, key: Buffer): Promise<Map<string, Buffer>> {
  const { size } = await stat(inPath);
  if (size < MAGIC.length + IV_LEN + TAG_LEN) throw new Error('arsip rusak');
  const fh = await open(inPath, 'r');
  const head = Buffer.alloc(MAGIC.length + IV_LEN), tag = Buffer.alloc(TAG_LEN);
  try {
    await fh.read(head, 0, head.length, 0);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
  } finally { await fh.close(); }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('bukan arsip ekspor ClinicRME');
  const decipher = createDecipheriv('aes-256-gcm', key, head.subarray(MAGIC.length), { authTagLength: 16 });
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  const chunks: Buffer[] = [];
  const sink = new Transform({ transform(c: Buffer, _e, cb) { chunks.push(c); cb(); } });
  await pipeline(createReadStream(inPath, { start: head.length, end: size - TAG_LEN - 1 }), decipher, createGunzip(), sink);
  return parseTar(Buffer.concat(chunks));
}

function parseTar(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (let off = 0; off + BLOCK <= buf.length;) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(h.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    files.set(name, buf.subarray(off + BLOCK, off + BLOCK + size));
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
