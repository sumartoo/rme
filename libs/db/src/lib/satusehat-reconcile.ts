import type { Pool, PoolClient } from 'pg';
import { SatuSehatError, asTenant, createSatuSehatClient, encounterSystem, type SatuSehatClient, type SatuSehatConnection, type SatuSehatUrls } from './satusehat';
import { VITAL_LOINC, activeConnections } from './satusehat-encounter';

/**
 * Rekonsiliasi jarak jauh (Stage 12 batch 4; INT-FR-011): setiap kunjungan yang tercatat terkirim dicocokkan dengan SATUSEHAT
 * sekali setelah setiap pengiriman/pembaruan:
 * - Encounter dicari per identifier. Tidak ditemukan → ERROR "tidak ditemukan saat rekonsiliasi" (muncul di Perlu tindakan, dapat dikirim ulang).
 *   ID berbeda → ID lokal diperbarui.
 * - Condition/Observation/Procedure dicari per Encounter: ID yang belum diketahui (respons hilang) diisi menurut kode; resource ganda
 *   (lebih banyak di SATUSEHAT daripada lokal untuk kode yang sama) dihitung & dilaporkan, tidak dihapus otomatis.
 * Tanpa payload; hanya ID & jumlah.
 */
export const RECONCILE_MISSING = 'Tidak ditemukan di SATUSEHAT saat rekonsiliasi — kirim ulang';

export interface ReconcileOptions { keyHex: string; urls?: SatuSehatUrls; batch?: number; now?: Date; allowSimulator?: boolean;
  clientFactory?: (c: SatuSehatConnection) => SatuSehatClient }
export interface ReconcileResult { checked: number; missingRemote: number; idsFilled: number; idsCorrected: number; duplicates: number; failedTenants: number }

export async function reconcileRemote(pool: Pool, o: ReconcileOptions): Promise<ReconcileResult> {
  const total: ReconcileResult = { checked: 0, missingRemote: 0, idsFilled: 0, idsCorrected: 0, duplicates: 0, failedTenants: 0 };
  const c = await pool.connect();
  try {
    const { rows: ts } = await c.query<{ id: string }>(`select id from app.tenant where status in ('TRIAL','ACTIVE','GRACE') order by id`);
    for (const t of ts) {
      try {
        await asTenant(c, t.id, async () => {
          for (const conn of await activeConnections(c, o.keyHex)) {
            if (conn.environment === 'SIMULATOR' && o.allowSimulator === false) continue;
            const client = (o.clientFactory ?? ((x) => createSatuSehatClient(x, o.urls)))(conn);
            const { rows } = await c.query<{ id: string }>(`
              select r.id from app.fhir_sync_record r
               where r.connection_id = $1 and r.resource_type = 'Encounter' and r.local_type = 'encounter' and r.status = 'SENT'
                 and (r.remote_checked_at is null or r.remote_checked_at < r.last_sent_at
                      or exists (select 1 from app.fhir_sync_record x where x.parent_id = r.id and x.status = 'SENT' and x.satusehat_id is null
                                    and x.resource_type in ('Condition', 'Observation', 'Procedure')))
               order by r.last_sent_at limit $2`, [conn.id, o.batch ?? 50]);
            for (const r of rows) await reconcileEncounter(c, client, conn, r.id, o.now ?? new Date(), total);
          }
        });
      } catch (e) {
        if (!(e instanceof SatuSehatError)) throw e;
        total.failedTenants++;
      }
    }
    return total;
  } finally {
    c.release();
  }
}

async function reconcileEncounter(c: PoolClient, client: SatuSehatClient, conn: SatuSehatConnection, recId: string, now: Date, total: ReconcileResult) {
  const { rows: [r] } = await c.query<{ local_id: string; satusehat_id: string | null; enc_ss: string | null; encounter_no: string; patient_id: string }>(`
    select r.local_id, r.satusehat_id, e.satusehat_id as enc_ss, e.encounter_no, e.patient_id
      from app.fhir_sync_record r join app.encounter e on e.id = r.local_id where r.id = $1`, [recId]);
  if (!r) return;
  total.checked++;
  const iso = now.toISOString();
  const search = await client.request('GET', `/Encounter?identifier=${encodeURIComponent(`${encounterSystem(conn.organizationId)}|${r.encounter_no}`)}`);
  const remoteId = ((search.body as { entry?: { resource?: { id?: string } }[] }).entry ?? [])[0]?.resource?.id ?? null;
  if (!remoteId) {
    // ID lama tidak berlaku lagi: kirim ulang membuat Encounter baru (setelah mencari per identifier lebih dulu)
    await c.query(`update app.fhir_sync_record set status = 'ERROR', last_error = $2, satusehat_id = null, problems = jsonb_build_object('blocking', jsonb_build_array($2::text), 'warnings', '[]'::jsonb),
                   remote_checked_at = $3::timestamptz, next_attempt_at = null, updated_at = now() where id = $1`, [recId, RECONCILE_MISSING, iso]);
    await c.query(`select app.write_audit('SATUSEHAT_RECONCILE_MISSING', 'encounter', $1::uuid, $2::uuid, $3::jsonb, 'SYSTEM', null, null)`,
      [r.local_id, r.patient_id, JSON.stringify({ environment: conn.environment })]);
    total.missingRemote++;
    return;
  }
  if (remoteId !== r.satusehat_id || remoteId !== r.enc_ss) {
    await c.query(`update app.fhir_sync_record set satusehat_id = $2 where id = $1`, [recId, remoteId]);
    await c.query(`update app.encounter set satusehat_id = $2 where id = $1`, [r.local_id, remoteId]);
    total.idsCorrected++;
  }
  // Turunan: kode lokal (kolom local_code; data lama dihitung dari sumbernya)
  const { rows: kids } = await c.query<{ id: string; resource_type: string; satusehat_id: string | null; eie: boolean; code: string | null; obs_code: string | null }>(`
    select x.id, x.resource_type, x.satusehat_id, x.entered_in_error_at is not null as eie,
           coalesce(x.local_code,
             case x.local_type
               when 'condition_dx' then (select cc.code from app.condition_dx d join app.concept cc on cc.id = d.concept_id where d.id = x.local_id)
               when 'procedure_act' then (select s.icd9cm_code from app.procedure_act a join app.service_item s on s.id = a.service_item_id where a.id = x.local_id)
             end) as code,
           case when x.local_type = 'observation' and x.local_code is null then (select o.code from app.observation o where o.id = x.local_id) end as obs_code
      from app.fhir_sync_record x
     where x.parent_id = $1 and x.status = 'SENT' and x.resource_type in ('Condition', 'Observation', 'Procedure')`, [recId]);
  let dup = 0;
  for (const type of ['Condition', 'Observation', 'Procedure']) {
    const local = kids.filter((k) => k.resource_type === type).map((k) => ({ ...k, code: k.code ?? (k.obs_code ? VITAL_LOINC[k.obs_code]?.code ?? null : null) }));
    if (!local.length) continue;
    const res = await client.request('GET', `/${type}?encounter=${encodeURIComponent(remoteId)}`);
    const remote = ((res.body as { entry?: { resource?: { id?: string; code?: { coding?: { code?: string }[] }; verificationStatus?: { coding?: { code?: string }[] } } }[] })
      .entry ?? []).map((e) => ({ id: e.resource?.id ?? '', code: e.resource?.code?.coding?.[0]?.code ?? '',
      eie: e.resource?.verificationStatus?.coding?.[0]?.code === 'entered-in-error' }));
    const used = new Set(local.map((l) => l.satusehat_id).filter(Boolean));
    for (const l of local.filter((x) => !x.satusehat_id)) {
      const m = remote.find((x) => x.code === l.code && !used.has(x.id));
      if (!m) continue;
      used.add(m.id);
      await c.query(`update app.fhir_sync_record set satusehat_id = $2, updated_at = now() where id = $1`, [l.id, m.id]);
      total.idsFilled++;
    }
    for (const code of new Set(remote.filter((x) => !x.eie).map((x) => x.code))) {
      const extra = remote.filter((x) => !x.eie && x.code === code).length - local.filter((x) => !x.eie && x.code === code).length;
      if (extra > 0) dup += extra;
    }
  }
  // Dicocokkan "sampai pengiriman terakhir" (jam worker & server dapat sedikit berbeda)
  await c.query(`update app.fhir_sync_record set remote_checked_at = greatest($2::timestamptz, last_sent_at), remote_duplicates = $3 where id = $1`, [recId, iso, dup]);
  total.duplicates += dup;
}
