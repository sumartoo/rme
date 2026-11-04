import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type BucketKind = 'files' | 'exports';

/** Antarmuka penyimpanan objek (ADR-0013). Unggah/unduh selalu lewat layanan yang sudah memeriksa izin. */
export interface ObjectStorage {
  putFile(bucket: BucketKind, objectPath: string, localPath: string, contentType: string): Promise<void>;
  openRead(bucket: BucketKind, objectPath: string): Promise<Readable>;
  remove(bucket: BucketKind, objectPath: string): Promise<void>;
}

export interface StorageConfig {
  driver: 'fs' | 'gcs';
  fsDir: string;
  gcsEndpoint: string;
  buckets: Record<BucketKind, string>;
}

/** `tenants/{uuid}/{kategori}/{yyyy}/{mm}/{uuid}[.ext]` — huruf kecil, angka, '-', '.', '_' per segmen. */
const OBJECT_PATH = /^tenants\/[0-9a-f-]{36}\/[a-z_]+\/\d{4}\/\d{2}\/[0-9a-f-]{36}(\.[a-z0-9]{1,8})?$/;
export function assertObjectPath(p: string) {
  if (!OBJECT_PATH.test(p)) throw new Error('object path tidak valid');
}

export function objectPathFor(tenantId: string, category: string, fileId: string, ext: string, at = new Date()) {
  const p = `tenants/${tenantId}/${category}/${at.getUTCFullYear()}/${String(at.getUTCMonth() + 1).padStart(2, '0')}/${fileId}.${ext}`;
  assertObjectPath(p);
  return p;
}

export class FsStorage implements ObjectStorage {
  private readonly root: string;
  constructor(root: string, private readonly buckets: Record<BucketKind, string>) { this.root = resolve(root); }

  private file(bucket: BucketKind, objectPath: string) {
    assertObjectPath(objectPath);
    const f = resolve(this.root, this.buckets[bucket], objectPath);
    if (!f.startsWith(this.root + sep)) throw new Error('object path di luar root');
    return f;
  }

  async putFile(bucket: BucketKind, objectPath: string, localPath: string) {
    const f = this.file(bucket, objectPath);
    await mkdir(dirname(f), { recursive: true });
    await pipeline(createReadStream(localPath), createWriteStream(f, { mode: 0o600 }));
  }

  async openRead(bucket: BucketKind, objectPath: string) {
    const f = this.file(bucket, objectPath);
    await stat(f);
    return createReadStream(f);
  }

  async remove(bucket: BucketKind, objectPath: string) {
    await rm(this.file(bucket, objectPath), { force: true });
  }
}

/** Cloud Storage JSON API. Endpoint emulator (http://…) dipakai tanpa auth; endpoint Google memakai token metadata server. */
export class GcsStorage implements ObjectStorage {
  private token?: { value: string; exp: number };
  constructor(private readonly endpoint: string, private readonly buckets: Record<BucketKind, string>,
              private readonly fetchImpl: typeof fetch = fetch) {}

  private async headers(): Promise<Record<string, string>> {
    if (!this.endpoint.startsWith('https://storage.googleapis.com')) return {};
    if (!this.token || this.token.exp < Date.now() + 60_000) {
      const r = await this.fetchImpl('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
                                     { headers: { 'Metadata-Flavor': 'Google' } });
      if (!r.ok) throw new Error(`token metadata gagal (${r.status})`);
      const t = (await r.json()) as { access_token: string; expires_in: number };
      this.token = { value: t.access_token, exp: Date.now() + t.expires_in * 1000 };
    }
    return { authorization: `Bearer ${this.token.value}` };
  }

  private objectUrl(bucket: BucketKind, objectPath: string) {
    assertObjectPath(objectPath);
    return `${this.endpoint}/storage/v1/b/${encodeURIComponent(this.buckets[bucket])}/o/${encodeURIComponent(objectPath)}`;
  }

  async putFile(bucket: BucketKind, objectPath: string, localPath: string, contentType: string) {
    assertObjectPath(objectPath);
    const { size } = await stat(localPath);
    const url = `${this.endpoint}/upload/storage/v1/b/${encodeURIComponent(this.buckets[bucket])}/o?uploadType=media&name=${encodeURIComponent(objectPath)}`;
    const r = await this.fetchImpl(url, {
      method: 'POST', headers: { ...(await this.headers()), 'content-type': contentType, 'content-length': String(size) },
      body: Readable.toWeb(createReadStream(localPath)) as never, duplex: 'half',
    } as RequestInit);
    if (!r.ok) throw new Error(`unggah objek gagal (${r.status})`);
  }

  async openRead(bucket: BucketKind, objectPath: string) {
    const r = await this.fetchImpl(`${this.objectUrl(bucket, objectPath)}?alt=media`, { headers: await this.headers() });
    if (!r.ok || !r.body) throw new Error(`unduh objek gagal (${r.status})`);
    return Readable.fromWeb(r.body as never);
  }

  async remove(bucket: BucketKind, objectPath: string) {
    const r = await this.fetchImpl(this.objectUrl(bucket, objectPath), { method: 'DELETE', headers: await this.headers() });
    if (!r.ok && r.status !== 404) throw new Error(`hapus objek gagal (${r.status})`);
  }
}

export function createStorage(cfg: StorageConfig): ObjectStorage {
  return cfg.driver === 'fs' ? new FsStorage(cfg.fsDir, cfg.buckets) : new GcsStorage(cfg.gcsEndpoint.replace(/\/$/, ''), cfg.buckets);
}

/** Folder sementara untuk proses berkas besar (ekspor); pemanggil wajib menghapusnya. */
export const tmpPath = (dir: string, name: string) => join(dir, name);
export const STORAGE = Symbol('STORAGE');
