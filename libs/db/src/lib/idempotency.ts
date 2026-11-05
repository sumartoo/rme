import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ctx, problem } from '@clinicrme/shared';
import { type Tx, rows } from './db';

const KEY_RE = /^[A-Za-z0-9_:.-]{16,100}$/;
const TTL_HOURS = 24;

/**
 * Idempotency-Key (API_CONTRACTS §2): dijalankan di transaksi yang sama dengan aksinya, sehingga hasil & catatan kunci
 * tersimpan bersama atau tidak sama sekali. Permintaan ulang dengan kunci & isi sama → hasil pertama tanpa menjalankan
 * aksi lagi (mis. klik dua kali "Simpan" tidak membuat pasien ganda). Kunci sama dengan isi/pengguna berbeda → 409.
 * Advisory lock per kunci membuat permintaan bersamaan menunggu, bukan keduanya berjalan.
 */
export async function idempotent<T>(tx: Tx, operation: string, key: string | undefined, request: unknown,
                                    run: () => Promise<T>): Promise<T> {
  if (!key || !KEY_RE.test(key)) throw problem(400, 'GEN-400-IDEMPOTENCY-KEY', 'Header Idempotency-Key wajib (16–100 karakter huruf/angka/-_:.)');
  const userId = ctx().userId ?? 'anonim';
  const hash = createHash('sha256').update(JSON.stringify([userId, request])).digest('hex');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${operation}:${key}`}, 0))`);
  await tx.execute(sql`delete from idempotency_record where operation = ${operation} and idem_key = ${key}
                         and created_at < now() - make_interval(hours => ${TTL_HOURS})`);
  const [prev] = await rows<{ request_hash: string; response: T }>(tx, sql`
    select request_hash, response from idempotency_record where operation = ${operation} and idem_key = ${key}`);
  if (prev) {
    if (prev.request_hash !== hash) throw problem(409, 'GEN-409-IDEMPOTENCY', 'Idempotency-Key ini sudah dipakai untuk permintaan lain');
    return prev.response;
  }
  const out = await run();
  await tx.execute(sql`insert into idempotency_record(tenant_id, operation, idem_key, user_id, request_hash, status_code, response)
                       values (app.current_tenant_id(), ${operation}, ${key}, ${ctx().userId}::uuid, ${hash}, 200, ${JSON.stringify(out)}::jsonb)`);
  return out;
}
