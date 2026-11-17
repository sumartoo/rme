import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { blindIndex } from '@clinicrme/shared';
import { encrypt } from '@clinicrme/shared/crypto';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';

/**
 * Stage 14 batch 1 — laporan kunjungan (RPT-FR-001) & 10 besar diagnosis (RPT-FR-002); OD-124, OD-125, OD-129, OD-130 (DEC-047).
 * Setiap angka dibandingkan dengan nilai yang dihitung manual dari dataset uji di bawah. Data sintetis.
 */
const HOST = 'klinik-a.clinicrme.test';
const KEY = 'a'.repeat(64);
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const FACILITY = A(1), B1 = A(10), U1 = A(11), DR = A(20);
const B2 = A(910), U2 = A(911), DR2 = A(920), PAYER = A(930);
const R50 = 'c1000000-0000-0000-0000-000000000001', J06 = 'c1000000-0000-0000-0000-000000000002', K02 = 'c1000000-0000-0000-0000-000000000903';
let app: INestApplication;
let http: ReturnType<typeof request>;

type Jar = { cookie: string; csrf: string };
async function login(email: string): Promise<Jar> {
  const r = await http.post('/api/v1/auth/login').set('Host', HOST).send({ email, password: PASSWORD });
  expect([email, r.status]).toEqual([email, 200]);
  const set = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
  const get = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(';')[0];
  const csrf = get('crme_csrf');
  return { cookie: [get('crme_session'), csrf].filter(Boolean).join('; '), csrf: csrf?.split('=')[1] ?? '' };
}
const get = (path: string, j: Jar) => http.get(path).set('Host', HOST).set('Cookie', j.cookie);
let manajer: Jar, dokter: Jar, kasir: Jar, cabang2: Jar;

let seq = 0;
async function patient() {
  const n = ++seq;
  const nik = `317101010193${String(1000 + n).slice(-4)}`;
  const [{ id }] = await su(`insert into app.patient(tenant_id, mrn, full_name, birth_date, sex, identity_type, nik_encrypted, nik_hash)
    values ($1, $2, $3, '1990-01-01', 'P', 'NIK', $4, $5) returning id`, [ids.tenantA, `RM-T-${n}`, `Pasien Laporan ${n}`, encrypt(KEY, nik), blindIndex(KEY, 'patient-nik', nik)]);
  return id as string;
}
interface Enc { patient: string; at: string; branch?: string; unit?: string; dr?: string; status?: string; payer?: boolean; dx?: [string, 'PRIMER' | 'SEKUNDER', ('BARU' | 'LAMA')?][]; signed?: boolean }
async function encounter(o: Enc) {
  const n = ++seq;
  let coverage: string | null = null;
  if (o.payer) {
    const [c] = await su(`insert into app.patient_coverage(tenant_id, patient_id, payer_id, member_no) values ($1, $2, $3, $4) returning id`, [ids.tenantA, o.patient, PAYER, `M-${n}`]);
    coverage = c.id;
  }
  const status = o.status ?? 'FINISHED';
  const [{ id }] = await su(`insert into app.encounter(tenant_id, encounter_no, patient_id, branch_id, unit_id, practitioner_id, arrival_type, status, cancel_reason,
      arrived_at, coverage_id, payer_type, coverage_verified_at, cancelled_at)
    values ($1, $2, $3, $4, $5, $6, 'WALK_IN', $7, $8, $9::timestamptz, $10, $11, $12, $13) returning id`,
  [ids.tenantA, `KJ-T-${n}`, o.patient, o.branch ?? B1, o.unit ?? U1, o.dr ?? DR, status, status === 'CANCELLED' ? 'Batal (uji)' : null, o.at, coverage,
    o.payer ? 'ASURANSI' : 'UMUM', o.payer ? o.at : null, status === 'CANCELLED' ? o.at : null]);
  for (const [concept, rank, cs] of o.dx ?? []) {
    await su(`insert into app.condition_dx(tenant_id, encounter_id, concept_id, rank, case_status) values ($1, $2, $3, $4, $5)`, [ids.tenantA, id, concept, rank, cs ?? 'BARU']);
  }
  if (o.dx || o.signed) {
    const [{ id: noteId }] = await su(`insert into app.clinical_note(tenant_id, encounter_id, subjective, assessment) values ($1, $2, 'Keluhan', 'Penilaian') returning id`, [ids.tenantA, id]);
    if (o.signed !== false) {
      await su(`update app.clinical_note set status = 'SIGNED', signed_by = $2, signed_at = $4::timestamptz + interval '20 minutes', content_hash = 'hash-uji', signer_user_id = $3,
        sign_method = 'PASSWORD' where id = $1`, [noteId, o.dr ?? DR, ids.dokterA, o.at]);
    }
    return { id: id as string, noteId: noteId as string };
  }
  return { id: id as string, noteId: null };
}

const E: Record<string, { id: string; noteId: string | null }> = {};
const P: string[] = [];

beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  http = request(app.getHttpServer());
  await su(`update app.role set requires_mfa = false where code in ('MANAJER', 'KASIR')`);
  // Cabang kedua di zona waktu WITA, poli, dokter, penjamin, konsep ICD-10 tambahan
  await su(`insert into app.branch(id, tenant_id, facility_id, code, name, timezone) values ($1, $2, $3, 'CBG2', 'Cabang Timur', 'Asia/Makassar')`, [B2, ids.tenantA, FACILITY]);
  await su(`insert into app.service_unit(id, tenant_id, branch_id, code, name, unit_type) values ($1, $2, $3, 'GIGI', 'Poli Gigi', 'POLI')`, [U2, ids.tenantA, B2]);
  await su(`insert into app.practitioner(id, tenant_id, full_name, practitioner_type) values ($1, $2, 'drg. Laporan', 'DOKTER_GIGI')`, [DR2, ids.tenantA]);
  await su(`insert into app.payer(id, tenant_id, code, name, payer_type) values ($1, $2, 'ASR1', 'Asuransi Sehat', 'ASURANSI')`, [PAYER, ids.tenantA]);
  await su(`insert into app.concept(id, system_id, code, display_id) values ($1, 'c0000000-0000-0000-0000-000000000001', 'K02.9', 'Karies gigi, tidak spesifik') on conflict do nothing`, [K02]);
  // Pengguna dengan izin laporan kunjungan hanya untuk Cabang Timur (OD-129)
  await su(`with r as (insert into app.role(tenant_id, code, name) values ($1, 'LAPORAN_CBG2', 'Laporan cabang timur') returning id)
            insert into app.role_permission(tenant_id, role_id, permission_code) select $1, id, 'report.operational.read' from r`, [ids.tenantA]);
  await su(`insert into app.user_role_assignment(tenant_id, user_id, role_id, branch_id) select $1, $2, id, $3 from app.role where tenant_id = $1 and code = 'LAPORAN_CBG2'`,
    [ids.tenantA, ids.gudangA, B2]);
  manajer = await login('manajer@a.test');
  dokter = await login('dokter@a.test');
  kasir = await login('kasir@a.test');
  cabang2 = await login('gudang@a.test');
  // Izin dari penugasan bercabang berlaku saat cabang aktif = cabang itu (IAM-FR-009)
  expect((await http.post('/api/v1/me/branch').set('Host', HOST).set('Cookie', cabang2.cookie).set('X-CSRF-Token', cabang2.csrf).send({ branchId: B2 })).status).toBe(200);

  for (let i = 0; i < 5; i++) P.push(await patient());
  // Kunjungan lama P0 (sebelum periode) → P0 pasien lama
  E.old = await encounter({ patient: P[0], at: '2026-09-15T09:00:00+07:00', dx: [[R50, 'PRIMER']] });
  // 1 Okt (WIB): P0, P1 (23.30 WIB = 16.30 UTC, tetap 1 Okt), P2 asuransi
  E.a = await encounter({ patient: P[0], at: '2026-10-01T09:00:00+07:00', dx: [[R50, 'PRIMER', 'LAMA'], [J06, 'SEKUNDER']] });
  E.b = await encounter({ patient: P[1], at: '2026-10-01T23:30:00+07:00', dx: [[R50, 'PRIMER']] });
  E.c = await encounter({ patient: P[2], at: '2026-10-01T10:00:00+07:00', payer: true, dx: [[J06, 'PRIMER'], [R50, 'SEKUNDER']] });
  // 00.30 WIB 2 Okt (= 17.30 UTC 1 Okt) → 2 Okt
  E.d = await encounter({ patient: P[1], at: '2026-10-02T00:30:00+07:00', status: 'IN_CONSULTATION', dx: [[R50, 'PRIMER']], signed: false });
  // Cabang Timur (WITA): 2 Okt 23.30 WITA = 15.30 UTC → 2 Okt; P3 menunggu; P4 selesai, K02 primer
  E.e = await encounter({ patient: P[3], at: '2026-10-02T23:30:00+08:00', branch: B2, unit: U2, dr: DR2, status: 'ARRIVED' });
  E.f = await encounter({ patient: P[4], at: '2026-10-02T10:00:00+08:00', branch: B2, unit: U2, dr: DR2, dx: [[K02, 'PRIMER']] });
  // Batal — tidak dihitung
  E.x = await encounter({ patient: P[4], at: '2026-10-02T11:00:00+08:00', branch: B2, unit: U2, dr: DR2, status: 'CANCELLED', dx: [[K02, 'PRIMER']] });
  // 3 Nov (bulan berbeda): P2
  E.g = await encounter({ patient: P[2], at: '2026-11-03T09:00:00+07:00', dx: [[J06, 'PRIMER', 'LAMA']] });
  // Janji temu tidak datang di Cabang 1, 1 Okt
  await su(`insert into app.appointment(tenant_id, patient_id, practitioner_id, branch_id, unit_id, slot_start, slot_end, channel, status)
            values ($1, $2, $3, $4, $5, '2026-10-01T13:00:00+07:00', '2026-10-01T13:15:00+07:00', 'STAFF', 'NO_SHOW')`, [ids.tenantA, P[3], DR, B1, U1]);
}, 60_000);
afterAll(async () => { await app?.close(); });

const visits = async (q: string, j = manajer) => get(`/api/v1/reports/visits?${q}`, j);
const rowsBy = (body: { rows: { period: string; groupLabel: string }[] }) => Object.fromEntries(body.rows.map((r) => [`${r.period}|${r.groupLabel}`, r]));

describe('Laporan kunjungan (RPT-FR-001, OD-124)', () => {
  test('T01 per hari: tanggal kedatangan menurut zona waktu cabang, batal tidak dihitung, pasien baru/lama, status, no-show; identik dengan hitungan manual', async () => {
    const r = await visits('from=2026-10-01&to=2026-10-31');
    expect(r.status).toBe(200);
    expect(r.body.rows).toEqual([
      { period: '2026-10-01', groupKey: 'all', groupLabel: 'Semua', visits: 3, uniquePatients: 3, newPatients: 2, returningPatients: 1, waiting: 0, inService: 0, finished: 3 },
      { period: '2026-10-02', groupKey: 'all', groupLabel: 'Semua', visits: 3, uniquePatients: 3, newPatients: 2, returningPatients: 1, waiting: 1, inService: 1, finished: 1 },
    ]);
    // P1 baru pada 1 Okt, kunjungan 2 Okt = lama; P3 & P4 baru; P0 lama (ada kunjungan September)
    expect(r.body.totals).toEqual({ visits: 6, uniquePatients: 5, newPatients: 4, returningPatients: 2, noShows: 1 });
    expect(r.body.allBranches).toBe(true);
    const m = await visits('from=2026-10-01&to=2026-11-10&period=month');
    expect(m.body.rows.map((x: { period: string; visits: number }) => [x.period, x.visits])).toEqual([['2026-10', 6], ['2026-11', 1]]);
  });

  test('T02 dikelompokkan per cabang / poli / dokter / penjamin; filter', async () => {
    const b = rowsBy((await visits('from=2026-10-01&to=2026-10-31&groupBy=branch')).body);
    expect(Object.keys(b)).toEqual(['2026-10-01|Cabang 1', '2026-10-02|Cabang 1', '2026-10-02|Cabang Timur']);
    expect(b['2026-10-02|Cabang Timur']).toMatchObject({ visits: 2, waiting: 1, finished: 1 });
    const p = rowsBy((await visits('from=2026-10-01&to=2026-10-31&groupBy=payer')).body);
    expect(p['2026-10-01|Asuransi Sehat']).toMatchObject({ visits: 1 });
    expect(p['2026-10-01|Umum']).toMatchObject({ visits: 2 });
    const u = (await visits('from=2026-10-01&to=2026-10-31&groupBy=unit&unitId=' + U2)).body;
    expect(u.rows.map((x: { groupLabel: string; visits: number }) => [x.groupLabel, x.visits])).toEqual([['Poli Gigi', 2]]);
    expect(u.totals.noShows).toBe(0);
    const d = (await visits(`from=2026-10-01&to=2026-10-31&groupBy=practitioner&practitionerId=${DR2}`)).body;
    expect(d.rows.map((x: { groupLabel: string }) => x.groupLabel)).toEqual(['drg. Laporan']);
    expect((await visits('from=2026-10-01&to=2026-10-31&payerType=ASURANSI')).body.totals.visits).toBe(1);
  });

  test('T03 izin, cakupan cabang, validasi, CSV & audit', async () => {
    expect((await visits('from=2026-10-01&to=2026-10-31', kasir)).status).toBe(403);
    expect((await visits('from=2026-10-01&to=2026-10-31', dokter)).status).toBe(403);
    // Pengguna dengan penugasan Cabang Timur saja
    const c2 = await visits('from=2026-10-01&to=2026-10-31&groupBy=branch', cabang2);
    expect(c2.body.allBranches).toBe(false);
    expect(c2.body.rows.map((x: { groupLabel: string }) => x.groupLabel)).toEqual(['Cabang Timur']);
    expect(c2.body.totals).toMatchObject({ visits: 2, noShows: 0 });
    expect((await visits(`from=2026-10-01&to=2026-10-31&branchId=${B1}`, cabang2)).body.code).toBe('RPT-403-BRANCH');
    expect((await visits(`from=2026-10-01&to=2026-10-31&branchId=${A(999)}`)).status).toBe(404);
    for (const q of ['from=2026-10-31&to=2026-10-01', 'from=2025-01-01&to=2026-01-02', 'from=2026-10-01', 'from=2026-10-01&to=2026-10-31&groupBy=pasien',
      "from=2026-10-01&to=2026-10-31&branchId=x' or 1=1--"]) {
      expect([q, (await visits(q)).status]).toEqual([q, 400]);
    }
    expect((await visits('from=2025-11-01&to=2026-10-31')).status).toBe(200);   // tepat 365 hari
    const csv = await visits('from=2026-10-01&to=2026-10-31&format=csv');
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.text.startsWith('\uFEFFPeriode,Kelompok,Kunjungan,Pasien unik,Pasien baru,Pasien lama,Menunggu,Dilayani,Selesai\r\n2026-10-01,Semua,3,3,2,1,0,0,3')).toBe(true);
    const [a] = await su(`select change_summary from app.audit_log where action = 'REPORT_VISITS_VIEWED' and change_summary->>'format' = 'csv'`);
    expect(a.change_summary).toEqual({ from: '2026-10-01', to: '2026-10-31', period: 'day', groupBy: 'none', format: 'csv' });
    expect(JSON.stringify((await visits('from=2026-10-01&to=2026-10-31&groupBy=practitioner')).body)).not.toMatch(/Pasien Laporan|RM-T|KJ-T/);
  });
});

describe('10 besar diagnosis (RPT-FR-002, OD-125)', () => {
  const dx = async (q: string, j = dokter) => get(`/api/v1/reports/top-diagnoses?${q}`, j);

  test('T04 hanya RM disahkan, diagnosis primer (bawaan) atau semua, batal tidak dihitung; addendum mengganti diagnosis yang berlaku', async () => {
    let r = await dx('from=2026-10-01&to=2026-10-31');
    expect(r.status).toBe(200);
    // Disahkan & tidak batal: a(R50 primer, lama), b(R50 primer), c(J06 primer), f(K02 primer). d belum disahkan; x batal
    expect(r.body.rows).toEqual([
      { rank: 1, code: 'R50.9', display: 'Demam, tidak spesifik', cases: 2, newCases: 1, oldCases: 1, patients: 2, share: 50 },
      { rank: 2, code: 'J06.9', display: 'ISPA akut, tidak spesifik', cases: 1, newCases: 1, oldCases: 0, patients: 1, share: 25 },
      { rank: 3, code: 'K02.9', display: 'Karies gigi, tidak spesifik', cases: 1, newCases: 1, oldCases: 0, patients: 1, share: 25 },
    ]);
    expect(r.body.totals).toEqual({ cases: 4, encounters: 4, signedEncounters: 4 });
    r = await dx('from=2026-10-01&to=2026-10-31&scope=all');
    expect(r.body.rows.map((x: { code: string; cases: number }) => [x.code, x.cases])).toEqual([['R50.9', 3], ['J06.9', 2], ['K02.9', 1]]);
    expect((await dx('from=2026-10-01&to=2026-10-31&limit=1')).body.rows).toHaveLength(1);
    expect((await dx(`from=2026-10-01&to=2026-10-31&branchId=${B2}`)).body.rows.map((x: { code: string }) => x.code)).toEqual(['K02.9']);
    // Addendum pada kunjungan b: diagnosis berlaku menjadi J06 primer (OD-120)
    await su(`insert into app.clinical_addendum(tenant_id, note_id, reason, content, author_id, signed_at, content_hash, author_user_id, sign_method, changes)
      values ($1, $2, 'Koreksi diagnosis', 'Koreksi', $3, '2026-10-05T09:00:00+07:00', 'hash-add', $4, 'PASSWORD',
              jsonb_build_object('diagnoses', jsonb_build_array(jsonb_build_object('conceptId', $5::text, 'code', 'J06.9', 'display', 'ISPA akut, tidak spesifik',
                'rank', 'PRIMER', 'caseStatus', 'BARU', 'note', null))))`, [ids.tenantA, E.b.noteId, DR, ids.dokterA, J06]);
    r = await dx('from=2026-10-01&to=2026-10-31');
    expect(r.body.rows.map((x: { code: string; cases: number }) => [x.code, x.cases])).toEqual([['J06.9', 2], ['K02.9', 1], ['R50.9', 1]]);
  });

  test('T05 izin & CSV', async () => {
    expect((await dx('from=2026-10-01&to=2026-10-31', kasir)).status).toBe(403);
    expect((await dx('from=2026-10-01&to=2026-10-31&limit=51')).status).toBe(400);
    expect((await dx('from=2026-10-01&to=2026-10-31&scope=semua')).status).toBe(400);
    const csv = await dx('from=2026-10-01&to=2026-10-31&format=csv', manajer);
    expect(csv.text.split('\r\n')[0]).toBe('\uFEFFNo,Kode ICD-10,Diagnosis,Jumlah kasus,Kasus baru,Kasus lama,Pasien unik,% dari kasus');
    expect(csv.text).toContain('1,J06.9,ISPA akut, tidak spesifik'.replace('ISPA akut, tidak spesifik', '"ISPA akut, tidak spesifik"'));
    expect(await su(`select count(*)::int as n from app.audit_log where action = 'REPORT_TOP_DIAGNOSES_VIEWED'`)).toEqual([{ n: 6 }]);
  });
});
