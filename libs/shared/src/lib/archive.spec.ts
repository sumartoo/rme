import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEncryptedArchive, writeEncryptedArchive } from './archive';

describe('arsip ekspor terenkripsi (OD-028)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'crmex-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('bolak-balik: isi utuh, termasuk entri kosong & ukuran bukan kelipatan 512', async () => {
    const a = join(dir, 'a'), b = join(dir, 'b');
    await writeFile(a, '{"x":1}\n'.repeat(1000)); await writeFile(b, '');
    const key = randomBytes(32);
    const out = join(dir, 'x.crmex');
    const r = await writeEncryptedArchive(out, [{ name: 'tables/a.ndjson', path: a, size: 8000 }, { name: 'manifest.json', path: b, size: 0 }], key);
    expect(r.size).toBe((await readFile(out)).length);
    const files = await readEncryptedArchive(out, key);
    expect(files.get('tables/a.ndjson')!.toString()).toBe('{"x":1}\n'.repeat(1000));
    expect(files.get('manifest.json')!.length).toBe(0);
  });

  it('tanpa kunci yang benar atau bila berkas diubah → gagal (tag GCM)', async () => {
    const a = join(dir, 'a');
    await writeFile(a, 'rahasia pasien sintetis');
    const key = randomBytes(32), out = join(dir, 'x.crmex');
    await writeEncryptedArchive(out, [{ name: 'a', path: a, size: 23 }], key);
    expect((await readFile(out)).includes(Buffer.from('rahasia'))).toBe(false);
    await expect(readEncryptedArchive(out, randomBytes(32))).rejects.toThrow();
    const blob = await readFile(out); blob[30] ^= 1; await writeFile(out, blob);
    await expect(readEncryptedArchive(out, key)).rejects.toThrow();
  });
});
