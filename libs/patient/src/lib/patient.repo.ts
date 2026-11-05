import { sql } from 'drizzle-orm';
import { type Tx, rows } from '@clinicrme/db';
import { blindIndex } from '@clinicrme/shared';

/** NIK/identitas tidak pernah dikembalikan utuh: 4 karakter awal + 4 akhir (paspor pendek: 2 akhir). */
export const maskNik = (nik: string) => `${nik.slice(0, 4)}********${nik.slice(-4)}`;
export const maskIdentity = (v: string) => (v.length <= 6 ? `****${v.slice(-2)}` : `${v.slice(0, 2)}****${v.slice(-3)}`);
export const nikHash = (key: string, nik: string) => blindIndex(key, 'patient-nik', nik);
export const identityHash = (key: string, type: string, v: string) => blindIndex(key, 'patient-identity', `${type}:${v}`);

export interface SummaryRow { id: string; mrn: string; full_name: string; birth_date: string; sex: string; nik_masked: string | null;
  phone: string | null; status: string; identity_type: string; identity_value_masked: string | null; score?: number }
export const summaryDto = (r: SummaryRow) => ({
  id: r.id, mrn: r.mrn, fullName: r.full_name, birthDate: r.birth_date, sex: r.sex, nikMasked: r.nik_masked, phone: r.phone,
  status: r.status, identityType: r.identity_type, identityMasked: r.identity_value_masked,
  ...(r.score !== undefined ? { score: Number(r.score) } : {}),
});
export const SUMMARY_COLS = sql`p.id, p.mrn, p.full_name, to_char(p.birth_date, 'YYYY-MM-DD') as birth_date, p.sex, p.nik_masked,
  p.phone, p.status, p.identity_type, p.identity_value_masked`;

export interface DuplicateInput { fullName: string; birthDate: string; sex: string; phone?: string | null;
  nikHash: string | null; identityType: string; identityHash: string | null }

/**
 * REG-FR-004 deteksi duplikat (STAGE_08 §3.1): NIK/identitas sama = pasti; selain itu kandidat bila nama mirip (trigram)
 * dengan tanggal lahir sama, atau nama mirip dengan telepon sama. Skor 0–1 untuk urutan tampilan; petugas yang memutuskan.
 * Pasien yang sudah digabung tidak menjadi kandidat.
 */
export async function findDuplicates(tx: Tx, d: DuplicateInput, excludeId: string | null = null) {
  await tx.execute(sql`set local pg_trgm.similarity_threshold = 0.35`);
  const r = await rows<SummaryRow & { exact: boolean }>(tx, sql`
    with c as (
      select ${SUMMARY_COLS},
             (${d.nikHash}::text is not null and p.nik_hash = ${d.nikHash})
               or (${d.identityHash}::text is not null and p.identity_value_hash = ${d.identityHash}) as exact,
             similarity(p.full_name, ${d.fullName}) as sim,
             p.birth_date = ${d.birthDate}::date as same_dob, p.sex = ${d.sex} as same_sex,
             (${d.phone ?? null}::text is not null and p.phone = ${d.phone ?? null}) as same_phone
        from patient p
       where p.status <> 'MERGED' and p.id is distinct from ${excludeId}::uuid
         and ((${d.nikHash}::text is not null and p.nik_hash = ${d.nikHash})
           or (${d.identityHash}::text is not null and p.identity_value_hash = ${d.identityHash})
           or (p.full_name % ${d.fullName} and (p.birth_date = ${d.birthDate}::date
                                                or (${d.phone ?? null}::text is not null and p.phone = ${d.phone ?? null}))))
    )
    select c.*, case when exact then 1
                     else round(least(0.99, sim * 0.6 + (case when same_dob then 0.25 else 0 end)
                                      + (case when same_sex then 0.05 else 0 end) + (case when same_phone then 0.1 else 0 end))::numeric, 2)
                end as score
      from c order by exact desc, score desc, mrn limit 10`);
  return { exactMatch: r.some((x) => x.exact), candidates: r.map((x) => summaryDto(x)) };
}
