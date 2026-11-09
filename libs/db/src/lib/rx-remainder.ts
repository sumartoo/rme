import type { Pool, PoolClient } from 'pg';

/**
 * OD-104 (DEC-039): sisa resep parsial yang tidak diambil sampai `partialPickupDays` (bawaan 7) hari setelah penyerahan
 * pertama ditutup otomatis dengan alasan "tidak diambil" — tidak ditagih. Dipanggil worker (job `pharmacy.rx_remainder_close`,
 * tiap jam) dan suite integrasi. Per tenant sebagai clinicrme_app (RLS berlaku); setiap penutupan diaudit sebagai SYSTEM.
 */
export const REMAINDER_REASON = 'Otomatis: sisa resep tidak diambil sampai batas waktu';

export async function closeExpiredRemainders(pool: Pool, now: Date = new Date()): Promise<{ tenants: number; closed: number }> {
  const c = await pool.connect();
  try {
    const { rows: tenants } = await c.query<{ id: string }>(
      `select id from app.tenant where status in ('TRIAL','ACTIVE','GRACE') order by id`);
    let closed = 0;
    for (const t of tenants) closed += await asTenant(c, t.id, () => closeTenant(c, now));
    return { tenants: tenants.length, closed };
  } finally {
    c.release();
  }
}

async function closeTenant(c: PoolClient, now: Date): Promise<number> {
  const { rows } = await c.query<{ id: string; patient_id: string; prescription_no: string }>(`
    select p.id, e.patient_id, p.prescription_no
      from app.prescription p join app.encounter e on e.id = p.encounter_id join app.tenant t on t.id = p.tenant_id
     where p.status = 'PARTIALLY_DISPENSED'
       and p.first_dispensed_at + make_interval(days => coalesce((t.settings->>'partialPickupDays')::int, 7)) < $1::timestamptz
     for update of p skip locked`, [now.toISOString()]);
  for (const r of rows) {
    await c.query(`update app.prescription_item set qty_closed = qty - qty_dispensed, close_reason = $2
                    where prescription_id = $1 and qty_dispensed + qty_closed < qty`, [r.id, REMAINDER_REASON]);
    await c.query(`update app.prescription set status = 'DISPENSED', version = version + 1, updated_by = null where id = $1`, [r.id]);
    await c.query(`select app.write_audit('PRESCRIPTION_REMAINDER_CLOSED', 'prescription', $1::uuid, $2::uuid, $3::jsonb, 'SYSTEM', null, null)`,
      [r.id, r.patient_id, JSON.stringify({ prescriptionNo: r.prescription_no, reason: REMAINDER_REASON })]);
  }
  return rows.length;
}

async function asTenant<T>(c: PoolClient, tenantId: string, fn: () => Promise<T>): Promise<T> {
  await c.query('begin');
  try {
    await c.query('set local role clinicrme_app');
    await c.query(`select set_config('app.tenant_id', $1, true), set_config('app.user_id', '', true)`, [tenantId]);
    const r = await fn();
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  }
}
