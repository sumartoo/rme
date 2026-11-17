import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { type Base, BaseFilter, type Column, PAYER_LABEL, type Q, type ReportResult, inBranches, rowsOf } from './common';

export const VisitsQ = BaseFilter.extend({
  period: z.enum(['day', 'month']).default('day'),
  groupBy: z.enum(['none', 'branch', 'unit', 'practitioner', 'payer']).default('none'),
});
export const DxQ = BaseFilter.extend({
  scope: z.enum(['primary', 'all']).default('primary'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const VISIT_COLUMNS: Column[] = [
  { key: 'period', label: 'Periode', type: 'string' }, { key: 'groupLabel', label: 'Kelompok', type: 'string' },
  { key: 'visits', label: 'Kunjungan', type: 'number' }, { key: 'uniquePatients', label: 'Pasien unik', type: 'number' },
  { key: 'newPatients', label: 'Pasien baru', type: 'number' }, { key: 'returningPatients', label: 'Pasien lama', type: 'number' },
  { key: 'waiting', label: 'Menunggu', type: 'number' }, { key: 'inService', label: 'Dilayani', type: 'number' }, { key: 'finished', label: 'Selesai', type: 'number' },
];
const DX_COLUMNS: Column[] = [
  { key: 'rank', label: 'No', type: 'number' }, { key: 'code', label: 'Kode ICD-10', type: 'string' }, { key: 'display', label: 'Diagnosis', type: 'string' },
  { key: 'cases', label: 'Jumlah kasus', type: 'number' }, { key: 'newCases', label: 'Kasus baru', type: 'number' }, { key: 'oldCases', label: 'Kasus lama', type: 'number' },
  { key: 'patients', label: 'Pasien unik', type: 'number' }, { key: 'share', label: '% dari kasus', type: 'percent' },
];

/**
 * Kunjungan terfilter (OD-124): encounter tidak batal pada tanggal kedatangan menurut zona waktu cabangnya. Rentang UTC dilebarkan
 * ±1 hari agar indeks waktu tetap terpakai, lalu disaring tepat pada tanggal lokal.
 */
const encounters = (f: Base, scope: string[] | null): SQL => sql`
  select * from (
    select e.id, e.patient_id, e.status, e.branch_id, b.name as branch_name, e.unit_id, e.practitioner_id, e.payer_type, pc.payer_id,
           (coalesce(e.arrived_at, e.created_at) at time zone b.timezone)::date as d
      from encounter e join branch b on b.id = e.branch_id left join patient_coverage pc on pc.id = e.coverage_id
     where e.status <> 'CANCELLED'
       and coalesce(e.arrived_at, e.created_at) >= (${f.from}::date - 1)::timestamptz and coalesce(e.arrived_at, e.created_at) < (${f.to}::date + 2)::timestamptz
       and ${inBranches(sql`b.id`, scope)}
       and (${f.unitId ?? null}::uuid is null or e.unit_id = ${f.unitId ?? null}::uuid)
       and (${f.practitionerId ?? null}::uuid is null or e.practitioner_id = ${f.practitionerId ?? null}::uuid)
       and (${f.payerType ?? null}::text is null or e.payer_type = ${f.payerType ?? null}::text)) x
   where x.d between ${f.from}::date and ${f.to}::date`;

/** Kunjungan (RPT-FR-001, OD-124). */
export async function visits(tx: Q, f: z.infer<typeof VisitsQ>, scope: string[] | null): Promise<ReportResult> {
  const period = f.period === 'month' ? sql`to_char(v.d, 'YYYY-MM')` : sql`to_char(v.d, 'YYYY-MM-DD')`;
  const [key, label]: [SQL, SQL] = {
    none: [sql`'all'`, sql`'Semua'`],
    branch: [sql`v.branch_id::text`, sql`v.branch_name`],
    unit: [sql`v.unit_id::text`, sql`(select name from service_unit where id = v.unit_id)`],
    practitioner: [sql`v.practitioner_id::text`, sql`(select full_name from practitioner where id = v.practitioner_id)`],
    payer: [sql`coalesce(v.payer_id::text, v.payer_type)`, sql`coalesce((select name from payer where id = v.payer_id), v.payer_type)`],
  }[f.groupBy] as [SQL, SQL];
  const data = await rowsOf<{ period: string; group_key: string; group_label: string; visits: number; unique_patients: number; new_patients: number;
                            waiting: number; in_service: number; finished: number }>(tx, sql`
    with v as (${encounters(f, scope)}),
    firsts as (
      select distinct on (e.patient_id) e.patient_id, e.id from encounter e
       where e.status <> 'CANCELLED' and e.patient_id in (select patient_id from v)
       order by e.patient_id, coalesce(e.arrived_at, e.created_at), e.id)
    select ${period} as period, ${key} as group_key, ${label} as group_label, count(*)::int as visits,
           count(distinct v.patient_id)::int as unique_patients,
           count(*) filter (where exists (select 1 from firsts f where f.id = v.id))::int as new_patients,
           count(*) filter (where v.status in ('REGISTERED', 'ARRIVED', 'TRIAGED'))::int as waiting,
           count(*) filter (where v.status in ('IN_CONSULTATION', 'CONSULT_DONE', 'PHARMACY', 'BILLING'))::int as in_service,
           count(*) filter (where v.status = 'FINISHED')::int as finished
      from v group by 1, 2, 3 order by 1, 3, 2`);
  const [t] = await rowsOf<{ visits: number; unique_patients: number; new_patients: number }>(tx, sql`
    with v as (${encounters(f, scope)}),
    firsts as (
      select distinct on (e.patient_id) e.patient_id, e.id from encounter e
       where e.status <> 'CANCELLED' and e.patient_id in (select patient_id from v)
       order by e.patient_id, coalesce(e.arrived_at, e.created_at), e.id)
    select count(*)::int as visits, count(distinct patient_id)::int as unique_patients,
           count(*) filter (where exists (select 1 from firsts f where f.id = v.id))::int as new_patients from v`);
  // Janji temu tidak datang (OD-124: dilaporkan terpisah; tidak ada penjamin pada janji temu)
  const [ns] = await rowsOf<{ n: number }>(tx, sql`
    select count(*)::int as n from appointment a join branch b on b.id = a.branch_id
     where a.status = 'NO_SHOW' and (a.slot_start at time zone b.timezone)::date between ${f.from}::date and ${f.to}::date
       and ${inBranches(sql`b.id`, scope)}
       and (${f.unitId ?? null}::uuid is null or a.unit_id = ${f.unitId ?? null}::uuid)
       and (${f.practitionerId ?? null}::uuid is null or a.practitioner_id = ${f.practitionerId ?? null}::uuid)`);
  const rowsOut = data.map((r) => ({ period: r.period, groupKey: r.group_key, groupLabel: f.groupBy === 'payer' ? PAYER_LABEL[r.group_label] ?? r.group_label : r.group_label,
    visits: r.visits, uniquePatients: r.unique_patients, newPatients: r.new_patients, returningPatients: r.visits - r.new_patients,
    waiting: r.waiting, inService: r.in_service, finished: r.finished }));
  return { columns: VISIT_COLUMNS, rows: rowsOut,
    totals: { visits: t.visits, uniquePatients: t.unique_patients, newPatients: t.new_patients, returningPatients: t.visits - t.new_patients, noShows: ns.n },
    extra: { period: f.period, groupBy: f.groupBy } };
}

/**
 * 10 besar diagnosis (RPT-FR-002, OD-125): kunjungan dengan RM disahkan, memakai diagnosis yang berlaku — daftar dari addendum terakhir yang
 * mengganti diagnosis (OD-120) atau diagnosis saat pengesahan. Bawaan diagnosis primer.
 */
export async function topDiagnoses(tx: Q, f: z.infer<typeof DxQ>, scope: string[] | null): Promise<ReportResult> {
  const base = sql`
    enc as (select v.id, v.patient_id, n.id as note_id from (${encounters(f, scope)}) v
              join clinical_note n on n.encounter_id = v.id and n.status = 'SIGNED'),
    la as (select distinct on (a.note_id) a.note_id, a.changes from clinical_addendum a join enc on enc.note_id = a.note_id
            where a.changes ? 'diagnoses' order by a.note_id, a.signed_at desc, a.id desc),
    dx as (
      select enc.id as encounter_id, enc.patient_id, d.code, d.display, d.rank, d."caseStatus" as case_status
        from enc join la on la.note_id = enc.note_id
        cross join lateral jsonb_to_recordset(la.changes -> 'diagnoses') as d(code text, display text, rank text, "caseStatus" text)
      union all
      select enc.id, enc.patient_id, c.code, c.display_id, x.rank, x.case_status
        from enc join condition_dx x on x.encounter_id = enc.id join concept c on c.id = x.concept_id
       where not exists (select 1 from la where la.note_id = enc.note_id)),
    sel as (select * from dx where ${f.scope === 'all' ? sql`true` : sql`rank = 'PRIMER'`})`;
  const data = await rowsOf<{ code: string; display: string; cases: number; new_cases: number; patients: number }>(tx, sql`
    with ${base}
    select code, min(display) as display, count(*)::int as cases, count(*) filter (where case_status = 'BARU')::int as new_cases,
           count(distinct patient_id)::int as patients
      from sel group by code order by cases desc, code limit ${f.limit}`);
  const [t] = await rowsOf<{ cases: number; encounters: number; signed: number }>(tx, sql`
    with ${base}
    select (select count(*)::int from sel) as cases, (select count(distinct encounter_id)::int from sel) as encounters, (select count(*)::int from enc) as signed`);
  const totals = { cases: t.cases, encounters: t.encounters, signedEncounters: t.signed };
  const rowsOut = data.map((r, i) => ({ rank: i + 1, code: r.code, display: r.display, cases: r.cases, newCases: r.new_cases, oldCases: r.cases - r.new_cases,
    patients: r.patients, share: totals.cases ? Math.round((r.cases / totals.cases) * 1000) / 10 : 0 }));
  return { columns: DX_COLUMNS, rows: rowsOut, totals, extra: { scope: f.scope } };
}
