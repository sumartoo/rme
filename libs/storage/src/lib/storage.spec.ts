import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage, GcsStorage, ObjectStorage, assertObjectPath, objectPathFor } from './storage';

const buckets = { files: 'crme-files-test', exports: 'crme-exports-test' };
const read = async (s: NodeJS.ReadableStream) => { const c: Buffer[] = []; for await (const x of s) c.push(x as Buffer); return Buffer.concat(c).toString(); };

describe('object path (ADR-0013 §2)', () => {
  it('format tetap; traversal & nama bebas ditolak', () => {
    const t = randomUUID(), f = randomUUID();
    expect(objectPathFor(t, 'export', f, 'crmex', new Date('2026-11-04T00:00:00Z'))).toBe(`tenants/${t}/export/2026/11/${f}.crmex`);
    for (const bad of [`tenants/${t}/export/2026/11/../../x`, `tenants/${t}/export/2026/11/laporan pasien.pdf`, '/etc/passwd', `tenants/x/export/2026/11/${f}`]) {
      expect(() => assertObjectPath(bad)).toThrow();
    }
  });
});

async function roundTrip(s: ObjectStorage, dir: string) {
  const src = join(dir, 'src'); await writeFile(src, 'isi uji sintetis');
  const p = objectPathFor(randomUUID(), 'export', randomUUID(), 'crmex');
  await s.putFile('exports', p, src, 'application/octet-stream');
  expect(await read(await s.openRead('exports', p))).toBe('isi uji sintetis');
  await s.remove('exports', p);
  await expect(s.openRead('exports', p)).rejects.toThrow();
}

describe('driver penyimpanan', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'crme-st-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('fs: simpan → baca → hapus', () => roundTrip(new FsStorage(join(dir, 'root'), buckets), dir));

  // Dijalankan bila emulator tersedia: STORAGE_TEST_GCS_ENDPOINT=http://localhost:4443 (docker compose / binary fake-gcs-server)
  const gcs = process.env.STORAGE_TEST_GCS_ENDPOINT;
  (gcs ? it : it.skip)('gcs (emulator): simpan → baca → hapus', async () => {
    for (const b of Object.values(buckets)) {
      await fetch(`${gcs}/storage/v1/b`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: b }) });
    }
    await roundTrip(new GcsStorage(gcs!, buckets), dir);
  });
});

import { storageConfigFromEnv } from './config';
describe('konfigurasi penyimpanan', () => {
  it('default fs untuk lokal; fs boleh di dev (VPS, CR-0003), ditolak di staging/prod; nama bucket divalidasi', () => {
    expect(storageConfigFromEnv({}, 'local')).toMatchObject({ driver: 'fs', buckets: { files: 'clinicrme-files', exports: 'clinicrme-exports' } });
    expect(() => storageConfigFromEnv({}, 'prod')).toThrow(/hanya untuk APP_ENV/);
    expect(() => storageConfigFromEnv({}, 'staging')).toThrow(/hanya untuk APP_ENV/);
    expect(storageConfigFromEnv({}, 'dev').driver).toBe('fs');
    expect(storageConfigFromEnv({ STORAGE_DRIVER: 'gcs' }, 'prod').gcsEndpoint).toBe('https://storage.googleapis.com');
    expect(() => storageConfigFromEnv({ STORAGE_DRIVER: 'gcs', STORAGE_BUCKET_EXPORTS: 'Bad Bucket' }, 'prod')).toThrow(/STORAGE_BUCKET_EXPORTS/);
  });
});
