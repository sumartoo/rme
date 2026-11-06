import type { Pool, PoolClient } from 'pg';

/**
 * OD-087 (DEC-035): janji temu yang belum check-in sampai sesi praktik dokternya berakhir ditandai NO_SHOW otomatis.
 * Dipanggil worker (job `scheduling.no_show`, tiap 5 menit) dan suite integrasi. Per tenant dijalankan sebagai
 * clinicrme_app dengan tenant context (RLS berlaku); setiap perubahan dicatat di audit sebagai aktor SYSTEM.
 * Janji temu tanpa jadwal (mis. kontrol, Stage 9) memakai slot_end, atau 4 jam setelah slot bila tidak ada.
 */
export const NO_SHOW_REASON = 'Otomatis: tidak hadir sampai sesi praktik berakhir';

export async function markNoShows(pool: Pool, now: Date = new Date()): Promise<{ tenants: number; marked: number }> {
  const c = await pool.connect();
  try {
    const { rows: tenants } = await c.query<{ id: string }>(
      `select id from app.tenant where status in ('TRIAL','ACTIVE','GRACE') order by id`);
    let marked = 0;
    for (const t of tenants) marked += await asTenant(c, t.id, () => markTenant(c, now));
    return { tenants: tenants.length, marked };
  } finally {
    c.release();
  }
}

async function markTenant(c: PoolClient, now: Date): Promise<number> {
  const { rows } = await c.query<{ id: string; patient_id: string }>(`
    with due as (
      select a.id
        from app.appointment a
        join app.branch b on b.id = a.branch_id
        left join app.practitioner_schedule s on s.id = a.schedule_id
       where a.status = 'BOOKED' and a.slot_start < $1::timestamptz
         and $1::timestamptz >= coalesce(
               (((a.slot_start at time zone b.timezone)::date + s.end_time) at time zone b.timezone),
               a.slot_end, a.slot_start + interval '4 hours')
       for update of a skip locked)
    update app.appointment a set status = 'NO_SHOW', status_reason = $2, updated_by = null
      from due where a.id = due.id
    returning a.id, a.patient_id`, [now.toISOString(), NO_SHOW_REASON]);
  for (const r of rows) {
    await c.query(`select app.write_audit('APPOINTMENT_NO_SHOW', 'appointment', $1::uuid, $2::uuid, $3::jsonb, 'SYSTEM', null, null)`,
      [r.id, r.patient_id, JSON.stringify({ reason: NO_SHOW_REASON })]);
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
