import 'reflect-metadata';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app/create-app';
import { PASSWORD, ids, resetDatabase, su } from './support/db-setup';
import { testConfig } from './support/test-config';
import { freshTotp } from './support/totp';

/**
 * Gate Stage 8 (STAGE_PLAN §5) + layar TV (batch 4, OD-088/089):
 *  - D01–D04 tautan layar & stream SSE tanpa data pasien
 *  - G01 konkurensi nomor antrean (200 pendaftaran bersamaan)
 *  - G02 deteksi duplikat dengan dataset sintetis (deterministik)
 *  - G03 alur WF-01..04 tahap pendaftaran untuk setiap kategori pasien (Umum, Asuransi, Perusahaan)
 */
const HOST = 'klinik-a.clinicrme.test';
const HOST_B = 'klinik-b.clinicrme.test';
const A = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const BRANCH = A(10), UNIT = A(11), DR = A(20);
let app: INestApplication;
let http_: ReturnType<typeof request>;
let port: number;

type Jar = { cookie: string; csrf: string };
function jar(res: request.Response, prev?: Jar): Jar {
  const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const get = (n: string) => set.find((c) => c.startsWith(`${n}=`))?.split(';')[0];
  const session = get('crme_session') ?? prev?.cookie.split('; ').find((c) => c.startsWith('crme_session='));
  const csrf = get('crme_csrf') ?? (prev ? `crme_csrf=${prev.csrf}` : undefined);
  return { cookie: [session, csrf].filter(Boolean).join('; '), csrf: csrf?.split('=')[1] ?? '' };
}
const login = async (email: string, host = HOST) => {
  const r = await http_.post('/api/v1/auth/login').set('Host', host).send({ email, password: PASSWORD });
  expect([email, r.status]).toEqual([email, 200]);
  return jar(r);
};
const get = (path: string, j: Jar | null, host = HOST) => { const r = http_.get(path).set('Host', host); return j ? r.set('Cookie', j.cookie) : r; };
const post = (path: string, j: Jar) => http_.post(path).set('Host', HOST).set('Cookie', j.cookie).set('X-CSRF-Token', j.csrf);
const idem = () => `uji-${randomUUID()}`;
const walkIn = (j: Jar, body: object) => post('/api/v1/encounters/walk-in', j).set('Idempotency-Key', idem()).send(body);

let admin: Jar, daftar: Jar, dokter: Jar;
let seq = 0;
async function mkPatient(name: string, birth = '1980-01-01', phone: string | null = null, sex = 'P') {
  const [{ id }] = await su(`insert into app.patient(tenant_id, mrn, full_name, birth_date, sex, identity_type, phone, ihs_status)
                             values ($1, $2, $3, $4, $5, 'TANPA_IDENTITAS', $6, 'NOT_APPLICABLE') returning id`,
  [ids.tenantA, `G${String(++seq).padStart(7, '0')}`, name, birth, sex, phone]);
  return id as string;
}

beforeAll(async () => {
  await resetDatabase();
  app = await createApp(testConfig());
  await app.listen(0, '127.0.0.1');
  port = (app.getHttpServer().address() as AddressInfo).port;
  http_ = request(app.getHttpServer());
  let j = await login('admin@a.test');
  const e = await post('/api/v1/auth/mfa/enroll', j);
  const secret = new URL(e.body.otpauthUrl).searchParams.get('secret')!;
  const v = await post('/api/v1/auth/mfa/verify', j).send({ code: await freshTotp(secret) });
  admin = j = jar(v, j);
  daftar = await login('pendaftaran@a.test');
  dokter = await login('dokter@a.test');
}, 60_000);
const openStreams: http.ClientRequest[] = [];
// Stream yang masih terbuka (mis. uji gagal sebelum s.close()) ditutup agar app.close() tidak menggantung
afterEach(() => { for (const r of openStreams.splice(0)) r.destroy(); });
afterAll(async () => { await app?.close(); });

/** Buka stream SSE dan kumpulkan event `board`/`revoked`. */
function openStream(token: string, host = HOST) {
  const events: { event: string; data: unknown }[] = [];
  let buf = '';
  let status = 0;
  const req = http.get({ host: '127.0.0.1', port, path: `/api/v1/public/queue-display/${token}/stream`, headers: { host } }, (res) => {
    status = res.statusCode ?? 0;
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
      }
    });
  });
  req.on('error', () => undefined);
  openStreams.push(req);
  const waitFor = async (pred: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return pred();
  };
  return { events, waitFor, status: () => status, close: () => req.destroy() };
}

describe('Layar TV antrean (OD-088, OD-089)', () => {
  let token: string, linkId: string;
  const names = ['Ratna Kusumawati', 'Bambang Sutrisno'];
  test('D01 admin membuat tautan layar per cabang: token tampil sekali, daftar tidak memuat token; petugas tidak berhak', async () => {
    expect((await post('/api/v1/queue-displays', daftar).send({ branchId: BRANCH, label: 'TV ruang tunggu' })).status).toBe(403);
    const r = await post('/api/v1/queue-displays', admin).send({ branchId: BRANCH, label: 'TV ruang tunggu' });
    expect(r.status).toBe(201);
    expect(r.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.body).toMatchObject({ label: 'TV ruang tunggu', branchName: 'Cabang 1', path: `/display/${r.body.token}`, revokedAt: null });
    token = r.body.token; linkId = r.body.id;
    const list = await get('/api/v1/queue-displays', admin);
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(token);
    const [row] = await su(`select token_hash from app.queue_display_link where id = $1`, [linkId]);
    expect(row.token_hash).not.toContain(token);
  });

  test('D02 data layar tanpa login: nomor dipanggil & menunggu per poli, tanpa nama/MRN pasien; inisial hanya bila diaktifkan', async () => {
    const p1 = await mkPatient(names[0]), p2 = await mkPatient(names[1]);
    await walkIn(daftar, { patientId: p1, unitId: UNIT, practitionerId: DR });
    await walkIn(daftar, { patientId: p2, unitId: UNIT, practitionerId: DR });
    await post('/api/v1/queue/call-next', dokter).send({ unitId: UNIT });
    const b = await get(`/api/v1/public/queue-display/${token}`, null);
    expect(b.status).toBe(200);
    expect(b.headers['cache-control']).toBe('no-store');
    const umum = b.body.units.find((u: { unitName: string }) => u.unitName === 'Poli Umum');
    expect(umum).toMatchObject({ waiting: 1, next: ['U-002'], calling: [{ displayCode: 'U-001', practitionerName: 'dr. Uji a', callCount: 1 }] });
    expect(b.body.recentlyCalled[0]).toMatchObject({ displayCode: 'U-001', unitName: 'Poli Umum' });
    const text = JSON.stringify(b.body);
    for (const n of names) expect(text).not.toContain(n);
    expect(text).not.toMatch(/G\d{7}/);   // MRN
    expect(umum.calling[0].initials).toBeUndefined();
    await su(`update app.tenant set settings = settings || '{"queueDisplayInitials": true}' where id = $1`, [ids.tenantA]);
    const withInitials = await get(`/api/v1/public/queue-display/${token}`, null);
    expect(withInitials.body.units.find((u: { unitName: string }) => u.unitName === 'Poli Umum').calling[0].initials).toBe('R. K.');
    expect(JSON.stringify(withInitials.body)).not.toContain('Ratna');
    await su(`update app.tenant set settings = settings - 'queueDisplayInitials' where id = $1`, [ids.tenantA]);
    // Pratinjau petugas (queue.display) = data yang sama
    expect((await get(`/api/v1/queue/board?branchId=${BRANCH}`, daftar)).body.units).toEqual(b.body.units);
  });

  test('D03 stream SSE: data awal saat terhubung, data baru setelah antrean dipanggil; heartbeat tidak memuat data', async () => {
    const s = openStream(token);
    expect(await s.waitFor(() => s.events.length >= 1)).toBe(true);
    expect(s.status()).toBe(200);
    expect(s.events[0].event).toBe('board');
    await post('/api/v1/queue/call-next', dokter).send({ unitId: UNIT });
    expect(await s.waitFor(() => s.events.some((e) => JSON.stringify(e.data).includes('"displayCode":"U-002"') && e.event === 'board'
      && (e.data as { units: { calling: { displayCode: string }[] }[] }).units.some((u) => u.calling.some((c) => c.displayCode === 'U-002'))))).toBe(true);
    for (const e of s.events) for (const n of names) expect(JSON.stringify(e.data)).not.toContain(n);
    s.close();
  });

  test('D04 token klinik lain / salah format / sudah dicabut → 404', async () => {
    expect((await get(`/api/v1/public/queue-display/${token}`, null, HOST_B)).status).toBe(404);
    expect((await get('/api/v1/public/queue-display/bukan-token', null)).status).toBe(404);
    expect((await post(`/api/v1/queue-displays/${linkId}/revoke`, admin).send()).body.revokedAt).not.toBeNull();
    expect((await get(`/api/v1/public/queue-display/${token}`, null)).status).toBe(404);
    const s = openStream(token);
    expect(await s.waitFor(() => s.status() !== 0)).toBe(true);
    expect(s.status()).toBe(404);
    s.close();
    const [a] = await su(`select count(*)::int as n from app.audit_log where action in ('QUEUE_DISPLAY_CREATED', 'QUEUE_DISPLAY_REVOKED')`);
    expect(a.n).toBe(2);
  });
});

describe('Gate Stage 8', () => {
  test('G01 200 pendaftaran walk-in bersamaan di dua poli: nomor antrean per poli 1..100 tanpa celah/duplikat; nomor kunjungan unik', async () => {
    const [{ id: unit2 }] = await su(`insert into app.service_unit(tenant_id, branch_id, code, name, unit_type) values ($1, $2, 'MATA', 'Poli Mata', 'POLI') returning id`, [ids.tenantA, BRANCH]);
    const [{ id: unit3 }] = await su(`insert into app.service_unit(tenant_id, branch_id, code, name, unit_type) values ($1, $2, 'THT', 'Poli THT', 'POLI') returning id`, [ids.tenantA, BRANCH]);
    const patients: string[] = [];
    for (let i = 0; i < 200; i++) patients.push(await mkPatient(`Pasien Beban ${i}`));
    const rs = await Promise.all(patients.map((p, i) => walkIn(daftar, { patientId: p, unitId: i % 2 ? unit2 : unit3, practitionerId: DR })));
    expect(rs.filter((r) => r.status !== 201).map((r) => r.body.code)).toEqual([]);
    for (const [unit, prefix] of [[unit2, 'M'], [unit3, 'T']] as const) {
      const mine = rs.filter((r) => r.body.unitId === unit).map((r) => r.body.queue);
      expect(mine.map((q) => q.queueNumber).sort((a: number, b: number) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
      expect(new Set(mine.map((q) => q.displayCode)).size).toBe(100);
      expect(mine.every((q) => q.displayCode.startsWith(`${prefix}-`))).toBe(true);
    }
    expect(new Set(rs.map((r) => r.body.encounterNo)).size).toBe(200);
    const [{ dup }] = await su(`select count(*)::int as dup from (select unit_id, queue_number from app.queue_ticket group by 1, 2 having count(*) > 1) x`);
    expect(dup).toBe(0);
  }, 180_000);

  test('G02 dataset sintetis duplikat: semua varian salah ketik ditemukan; orang berbeda bertanggal lahir sama jarang ditandai; NIK sama selalu ditolak', async () => {
    // Generator deterministik (LCG) — hasil stabil antar lingkungan
    let s = 20261106;
    const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
    const first = ['Ahmad', 'Siti', 'Budi', 'Dewi', 'Agus', 'Rina', 'Eko', 'Sri', 'Hendra', 'Wulan', 'Yusuf', 'Fitri', 'Dimas', 'Ayu', 'Rizky', 'Nur', 'Bayu', 'Indah', 'Fajar', 'Lestari'];
    const last = ['Pratama', 'Wijaya', 'Saputra', 'Hidayat', 'Kusuma', 'Santoso', 'Lestari', 'Nugroho', 'Wibowo', 'Purnama', 'Setiawan', 'Rahmawati', 'Susanto', 'Handayani', 'Firmansyah', 'Maharani', 'Gunawan', 'Permata', 'Siregar', 'Nasution'];
    const typo = (name: string) => {
      const t = pick(['swap', 'drop', 'double', 'sub', 'case']);
      const i = 1 + Math.floor(rnd() * (name.length - 2));
      if (t === 'swap') return name.slice(0, i) + name[i + 1] + name[i] + name.slice(i + 2);
      if (t === 'drop') return name.slice(0, i) + name.slice(i + 1);
      if (t === 'double') return name.slice(0, i) + name[i] + name.slice(i);
      if (t === 'sub') return name.slice(0, i) + (name[i] === 'a' ? 'e' : 'a') + name.slice(i + 1);
      return name.toUpperCase();
    };
    const base: { name: string; birth: string }[] = [];
    const used = new Set<string>();
    while (base.length < 150) {
      const name = `${pick(first)} ${pick(last)} ${pick(last)}`;
      const birth = `19${50 + Math.floor(rnd() * 50)}-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`;
      if (used.has(name)) continue;
      used.add(name); base.push({ name, birth });
    }
    const baseIds = new Map<string, string>();
    for (const b of base) baseIds.set(b.name, await mkPatient(b.name, b.birth));
    const check = (name: string, birth: string) => post('/api/v1/patients/duplicate-check', daftar).send({
      fullName: name, birthDate: birth, sex: 'P', identityType: 'TANPA_IDENTITAS', phone: '081200000000', address: 'Jl. Uji Duplikat 1' });
    let found = 0;
    const variants = base.slice(0, 60);
    for (const b of variants) {
      const r = await check(typo(b.name), b.birth);
      if (r.body.candidates.some((c: { id: string }) => c.id === baseIds.get(b.name))) found++;
    }
    let falsePositive = 0;
    const others = base.slice(60, 120);
    for (const b of others) {
      let name = '';
      do name = `${pick(first)} ${pick(last)} ${pick(last)}`; while (used.has(name));
      const r = await check(name, b.birth);   // orang lain, tanggal lahir sama dengan pasien yang ada
      if (r.body.candidates.length > 0) falsePositive++;
    }
    console.log(`deteksi duplikat: ${found}/${variants.length} varian salah ketik ditemukan; ${falsePositive}/${others.length} orang berbeda ditandai kandidat`);
    expect(found).toBe(variants.length);
    expect(falsePositive).toBeLessThanOrEqual(6);   // ≤ 10% — petugas memutuskan, alasan tercatat bila tetap mendaftar
    // Identitas sama (NIK) selalu ditolak walau nama ditulis berbeda
    const niks = Array.from({ length: 20 }, (_, i) => `32010${String(1000000 + i * 7919).padStart(7, '0')}${String(i).padStart(4, '0')}`);
    for (const [i, nik] of niks.entries()) {
      const ok = await post('/api/v1/patients', daftar).set('Idempotency-Key', idem()).send({ fullName: `Pemilik NIK ${String.fromCharCode(65 + i)}`,
        birthDate: '1975-05-05', sex: 'L', identityType: 'NIK', nik, phone: '081211110000', address: 'Jl. NIK Uji 1', duplicateOverrideReason: 'Data uji dataset NIK' });
      expect(ok.status).toBe(201);
    }
    let blocked = 0;
    for (const [i, nik] of niks.entries()) {
      const r = await post('/api/v1/patients', daftar).set('Idempotency-Key', idem()).send({ fullName: `Nama Lain ${i}`, birthDate: '1990-09-09', sex: 'P',
        identityType: 'NIK', nik, phone: '081299990000', address: 'Jl. Lain 2', duplicateOverrideReason: 'Mencoba mendaftar ulang' });
      if (r.body.code === 'PAT-409-IDENTITY') blocked++;
    }
    expect(blocked).toBe(20);
  }, 180_000);

  test('G03 WF-01..04 tahap pendaftaran per kategori: Umum walk-in, pasien lama dengan janji temu, Asuransi, Perusahaan', async () => {
    const [{ id: asr }] = await su(`insert into app.payer(tenant_id, code, name, payer_type) values ($1, 'ASR-G', 'Asuransi Gate', 'ASURANSI') returning id`, [ids.tenantA]);
    const [{ id: prs }] = await su(`insert into app.payer(tenant_id, code, name, payer_type) values ($1, 'PT-G', 'PT Gate Sejahtera', 'PERUSAHAAN') returning id`, [ids.tenantA]);
    const [{ id: unit }] = await su(`insert into app.service_unit(tenant_id, branch_id, code, name, unit_type) values ($1, $2, 'GATE', 'Poli Gate', 'POLI') returning id`, [ids.tenantA, BRANCH]);
    const register = async (name: string, nik: string, coverages: object[] = []) => {
      const r = await post('/api/v1/patients', daftar).set('Idempotency-Key', idem()).send({ fullName: name, birthDate: '1988-08-08', sex: 'L',
        identityType: 'NIK', nik, phone: '081277770000', address: 'Jl. Alur Uji 1', coverages, duplicateOverrideReason: 'Pasien uji alur gate' });
      expect([name, r.status]).toEqual([name, 201]);
      return r.body as { id: string; coverages: { id: string; payerType: string }[] };
    };
    // WF-01: pasien baru, Umum, walk-in
    const umum = await register('Alur Umum Baru', '3201019901010001');
    const e1 = await walkIn(daftar, { patientId: umum.id, unitId: unit, practitionerId: DR });
    expect(e1.body).toMatchObject({ payerType: 'UMUM', arrivalType: 'WALK_IN', status: 'ARRIVED', queue: { displayCode: 'G-001' } });
    // WF-02: pasien lama dengan janji temu hari ini → check-in
    const [{ id: appt }] = await su(`insert into app.appointment(tenant_id, patient_id, practitioner_id, branch_id, unit_id, slot_start, slot_end)
      values ($1, $2, $3, $4, $5, date_trunc('minute', now()) + interval '25 minutes', date_trunc('minute', now()) + interval '40 minutes') returning id`,
    [ids.tenantA, ids.patientA, DR, BRANCH, unit]);
    const e2 = await post(`/api/v1/appointments/${appt}/check-in`, daftar).set('Idempotency-Key', idem()).send({});
    expect(e2.body).toMatchObject({ arrivalType: 'APPOINTMENT', arrivedLate: false, payerType: 'UMUM', queue: { displayCode: 'G-002' } });
    // WF-03: Asuransi — verifikasi manual; bila ditolak dialihkan Umum dengan persetujuan pasien
    const ins = await register('Alur Asuransi', '3201019901010003', [{ payerId: asr, memberNo: 'POL-G1' }]);
    const e3 = await walkIn(daftar, { patientId: ins.id, unitId: unit, practitionerId: DR, coverageId: ins.coverages[0].id, eligibilityNote: 'Verifikasi portal asuransi OK' });
    expect(e3.body).toMatchObject({ payerType: 'ASURANSI', coverage: { payerName: 'Asuransi Gate', memberNo: 'POL-G1' }, coverageVerificationNote: 'Verifikasi portal asuransi OK' });
    const rejected = await register('Alur Asuransi Ditolak', '3201019901010004', [{ payerId: asr, memberNo: 'POL-G2' }]);
    const e3b = await walkIn(daftar, { patientId: rejected.id, unitId: unit, practitionerId: DR });   // eligibilitas ditolak → Umum
    expect(e3b.body).toMatchObject({ payerType: 'UMUM', coverage: null });
    // WF-04: tanggungan perusahaan
    const emp = await register('Alur Karyawan', '3201019901010005', [{ payerId: prs, employeeNo: 'K-778' }]);
    const e4 = await walkIn(daftar, { patientId: emp.id, unitId: unit, practitionerId: DR, coverageId: emp.coverages[0].id, eligibilityNote: 'Surat jaminan HRD no. 12' });
    expect(e4.body).toMatchObject({ payerType: 'PERUSAHAAN', coverage: { payerName: 'PT Gate Sejahtera' } });
    // Semua masuk antrean poli dan dapat dipanggil; urutan layanan: walk-in sesuai waktu datang, janji temu pada jam slotnya
    const q = await get(`/api/v1/queue?unitId=${unit}`, dokter);
    expect(q.body.filter((t: { status: string }) => t.status === 'WAITING').map((t: { displayCode: string }) => t.displayCode))
      .toEqual(['G-001', 'G-003', 'G-004', 'G-005', 'G-002']);
    const called = await post('/api/v1/queue/call-next', dokter).send({ unitId: unit });
    expect(called.body).toMatchObject({ displayCode: 'G-001', patient: { id: umum.id } });
    const board = await get(`/api/v1/encounters?unitId=${unit}`, daftar);
    expect(board.body.data.map((e: { payerType: string }) => e.payerType).sort()).toEqual(['ASURANSI', 'PERUSAHAAN', 'UMUM', 'UMUM', 'UMUM']);
  });
});
