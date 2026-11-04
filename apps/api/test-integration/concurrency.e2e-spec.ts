import 'reflect-metadata';
import { sql } from 'drizzle-orm';
import { Db, rows } from '@clinicrme/db';
import { appUrl, ids, resetDatabase } from './support/db-setup';

/**
 * Konkurensi nomor dokumen (DATABASE_DESIGN §9, ADR-0005): app.next_document_number dipanggil oleh banyak
 * transaksi bersamaan lewat role aplikasi (RLS aktif). Nomor harus unik dan tanpa celah, juga bila sebagian
 * transaksi dibatalkan (rollback mengembalikan counter).
 */
const PARALLEL = 50;
let db: Db;

beforeAll(async () => {
  await resetDatabase();
  db = new Db({ url: appUrl(), poolMax: 20 });
});
afterAll(async () => { await db?.close(); });

const take = (docType: string, scope: string, rollback = false) =>
  db.withTenant(ids.tenantA, async (tx) => {
    const [r] = await rows<{ no: string }>(tx, sql`select app.next_document_number(${docType}, ${scope}, 'UJI/{YYYY}/{SEQ:5}') as no`);
    await new Promise((res) => setTimeout(res, Math.random() * 15)); // perpanjang transaksi agar benar-benar tumpang tindih
    if (rollback) throw Object.assign(new Error('batal'), { rolledBack: r.no });
    return r.no;
  });

const seq = (no: string) => Number(no.split('/').pop());

describe('Nomor dokumen paralel (C##)', () => {
  test(`C01 ${PARALLEL} transaksi bersamaan → ${PARALLEL} nomor unik berurutan 1..${PARALLEL}`, async () => {
    const out = await Promise.all(Array.from({ length: PARALLEL }, () => take('INVOICE', 'UJI-C01')));
    const nums = out.map(seq).sort((a, b) => a - b);
    expect(new Set(out).size).toBe(PARALLEL);
    expect(nums).toEqual(Array.from({ length: PARALLEL }, (_, i) => i + 1));
  });

  test('C02 sebagian transaksi rollback → nomor yang ter-commit tetap tanpa celah', async () => {
    const results = await Promise.allSettled(Array.from({ length: PARALLEL }, (_, i) => take('RECEIPT', 'UJI-C02', i % 5 === 0)));
    const committed = results.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled').map((r) => seq(r.value));
    const rolledBack = results.filter((r) => r.status === 'rejected').length;
    expect(rolledBack).toBe(PARALLEL / 5);
    expect(committed.sort((a, b) => a - b)).toEqual(Array.from({ length: PARALLEL - rolledBack }, (_, i) => i + 1));
  });

  test('C03 nomor per tenant terpisah: tenant B mulai dari 1 walau tenant A sudah 50', async () => {
    const [r] = await db.withTenant(ids.tenantB, (tx) => rows<{ no: string }>(tx,
      sql`select app.next_document_number('INVOICE', 'UJI-C01', 'UJI/{YYYY}/{SEQ:5}') as no`));
    expect(seq(r.no)).toBe(1);
  });

  test('C04 tanpa tenant context → ditolak', async () => {
    const e = await db.preAuth(sql`select app.next_document_number('INVOICE', 'UJI-C04', 'X/{SEQ:3}')`).then(() => null, (err) => err);
    expect(e).not.toBeNull();
  });
});
