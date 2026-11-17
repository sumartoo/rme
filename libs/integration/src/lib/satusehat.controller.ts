import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BodySchema, CONFIG, NoBody, RequirePermission, Uuid, assertId, ctx, problem, type AppConfig } from '@clinicrme/shared';
import { decrypt, encrypt } from '@clinicrme/shared/crypto';
import { Db, type Tx, audit, rows } from '@clinicrme/db';
import {
  SatuSehatError, createSatuSehatClient, ensureLocation, findPractitionerIhs, getOrganization, lookupOne,
  type SatuSehatClient, type SatuSehatConnection, type SatuSehatEnvironment,
} from '@clinicrme/db/satusehat';

const ConfigureBody = z.object({
  facilityId: Uuid,
  environment: z.enum(['SIMULATOR', 'SANDBOX', 'PRODUCTION']),
  clientId: z.string().trim().min(3).max(200),
  clientSecret: z.string().min(3).max(500).optional(),
  organizationId: z.string().trim().min(3).max(100),
}).strict();
const FacilityBody = z.object({ facilityId: Uuid }).strict();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Unit kiriman yang dapat dikirim ulang/ditindaklanjuti: kunjungan, item resep, baris penyerahan, addendum diagnosis. */
const RESENDABLE_SQL = sql`('encounter', 'prescription_item', 'dispense_line', 'clinical_addendum')`;
const NOT_CONFIGURED = ['INT-404-CONNECTION', 'Koneksi SATUSEHAT fasilitas ini belum diatur'] as const;

interface ConnRow { id: string; facility_id: string; environment: SatuSehatEnvironment; client_id: string; secret_encrypted: Buffer; organization_id: string;
  last_test_at: string | null; last_test_ok: boolean | null; last_test_message: string | null; last_sync_at: string | null; updated_at: string }

/**
 * SATUSEHAT — koneksi & identitas (Stage 12 batch 1; INT-FR-001–003, DEC-044). Kredensial per fasilitas terenkripsi
 * (OD-114), tidak pernah dikembalikan; simulator ditolak di produksi (OD-121). Sinkron master: Organization diverifikasi,
 * Location per poli dibuat idempoten, IHS tenaga kesehatan dicari dari NIK (OD-117).
 */
@Controller('api/v1')
export class SatuSehatController {
  constructor(private readonly db: Db, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  /** Fasilitas + koneksi aktif (tanpa rahasia) + status Location per poli & ringkasan IHS. */
  @RequirePermission('integration.read') @Get('integrations/satusehat')
  async get() {
    return this.db.withTenantTx(async (tx) => {
      const facs = await rows<{ id: string; name: string }>(tx, sql`select id, name from facility where is_active order by name`);
      const out = [];
      for (const f of facs) {
        const [c] = await rows<ConnRow>(tx, sql`select * from integration_connection where facility_id = ${f.id} and kind = 'SATUSEHAT' and is_active`);
        const units = await rows<{ id: string; name: string; branch_name: string; location_id: string | null; status: string | null; last_error: string | null }>(tx, sql`
          select u.id, u.name, b.name as branch_name, r.satusehat_id as location_id, r.status, r.last_error
            from service_unit u join branch b on b.id = u.branch_id
            left join fhir_sync_record r on r.local_type = 'service_unit' and r.local_id = u.id and r.resource_type = 'Location' and r.connection_id = ${c?.id ?? null}::uuid
           where b.facility_id = ${f.id} and u.is_active and u.unit_type in ('POLI', 'RUANG') order by b.name, u.name`);
        out.push({ facilityId: f.id, facilityName: f.name, connection: c ? connDto(c) : null,
          locations: units.map((u) => ({ unitId: u.id, unitName: u.name, branchName: u.branch_name, locationId: u.location_id, status: u.status ?? 'PENDING', lastError: u.last_error })) });
      }
      const [ihs] = await rows<{ practitioners: number; practitioners_found: number; patients_pending: number; patients_found: number; patients_not_found: number; patients_error: number }>(tx, sql`
        select (select count(*)::int from practitioner where is_active) as practitioners,
               (select count(*)::int from practitioner where is_active and satusehat_ihs_id is not null) as practitioners_found,
               (select count(*)::int from patient where status = 'ACTIVE' and ihs_status = 'PENDING') as patients_pending,
               (select count(*)::int from patient where status = 'ACTIVE' and ihs_status = 'FOUND') as patients_found,
               (select count(*)::int from patient where status = 'ACTIVE' and ihs_status = 'NOT_FOUND') as patients_not_found,
               (select count(*)::int from patient where status = 'ACTIVE' and ihs_status = 'ERROR') as patients_error`);
      return { simulatorAllowed: this.cfg.appEnv !== 'prod', facilities: out,
        identity: { practitioners: ihs.practitioners, practitionersFound: ihs.practitioners_found, patientsPending: ihs.patients_pending,
          patientsFound: ihs.patients_found, patientsNotFound: ihs.patients_not_found, patientsError: ihs.patients_error } };
    });
  }

  /**
   * Simpan kredensial (OD-114). Client secret wajib saat pertama atau saat lingkungan berganti; kosong = tetap. Ganti
   * lingkungan → koneksi lama nonaktif dan IHS pasien/nakes direset (ID sandbox ≠ produksi), tercatat di audit.
   */
  @RequirePermission('integration.manage') @BodySchema(ConfigureBody) @Put('integrations/satusehat')
  async configure(@Body() b: z.infer<typeof ConfigureBody>) {
    if (b.environment === 'SIMULATOR' && this.cfg.appEnv === 'prod') throw problem(400, 'INT-400-SIMULATOR', 'Simulator SATUSEHAT tidak dapat dipakai di produksi');
    return this.db.withTenantTx(async (tx) => {
      const [f] = await rows(tx, sql`select 1 from facility where id = ${b.facilityId} and is_active`);
      if (!f) throw problem(404, 'MST-404-FACILITY', 'Fasilitas tidak ditemukan');
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`satusehat-conn:${b.facilityId}`}, 0))`);
      const [cur] = await rows<ConnRow>(tx, sql`select * from integration_connection where facility_id = ${b.facilityId} and kind = 'SATUSEHAT' and is_active`);
      const [same] = await rows<ConnRow>(tx, sql`
        select * from integration_connection where facility_id = ${b.facilityId} and kind = 'SATUSEHAT' and environment = ${b.environment}`);
      const switching = !!cur && cur.environment !== b.environment;
      const secret = b.clientSecret ? encrypt(this.cfg.encryptionKeyHex, b.clientSecret) : (same?.secret_encrypted ?? null);
      if (!secret) throw problem(400, 'INT-400-SECRET', 'Client secret wajib diisi');
      if (switching) await tx.execute(sql`update integration_connection set is_active = false, updated_at = now(), updated_by = ${ctx().userId} where id = ${cur.id}`);
      let id: string;
      if (same) {
        await tx.execute(sql`
          update integration_connection set client_id = ${b.clientId}, secret_encrypted = ${secret}, organization_id = ${b.organizationId}, is_active = true,
                 last_test_at = null, last_test_ok = null, last_test_message = null, updated_at = now(), updated_by = ${ctx().userId}, version = version + 1
           where id = ${same.id}`);
        id = same.id;
      } else {
        [{ id }] = await rows<{ id: string }>(tx, sql`
          insert into integration_connection(tenant_id, facility_id, kind, environment, secret_ref, client_id, secret_encrypted, organization_id, updated_by)
          values (app.current_tenant_id(), ${b.facilityId}, 'SATUSEHAT', ${b.environment}, 'db:integration_connection.secret_encrypted', ${b.clientId}, ${secret},
                  ${b.organizationId}, ${ctx().userId})
          returning id`);
      }
      let reset = { patients: 0, practitioners: 0 };
      if (switching) {
        // ID SATUSEHAT berbeda antar lingkungan: IHS dicari ulang terhadap lingkungan baru
        const [p] = await rows<{ n: number }>(tx, sql`
          with u as (update patient set ihs_number = null, ihs_status = 'PENDING', ihs_checked_at = null, ihs_last_error = null
                      where identity_type = 'NIK' and ihs_status <> 'PENDING' returning 1) select count(*)::int as n from u`);
        const [r] = await rows<{ n: number }>(tx, sql`
          with u as (update practitioner set satusehat_ihs_id = null where satusehat_ihs_id is not null returning 1) select count(*)::int as n from u`);
        reset = { patients: p.n, practitioners: r.n };
      }
      await audit(tx, 'SATUSEHAT_CONNECTION_SAVED', 'integration_connection', id, null, {
        facilityId: b.facilityId, environment: b.environment, organizationId: b.organizationId, secretChanged: !!b.clientSecret,
        ...(switching ? { switchedFrom: cur.environment, reset } : {}) });
      const [c] = await rows<ConnRow>(tx, sql`select * from integration_connection where id = ${id}`);
      return connDto(c);
    });
  }

  /** Uji koneksi (AC-INT-FR-001-1): token OAuth2 + baca Organization fasyankes; hasil tersimpan & teraudit. */
  @RequirePermission('integration.manage') @BodySchema(FacilityBody) @Post('integrations/satusehat/test') @HttpCode(200)
  async test(@Body() b: z.infer<typeof FacilityBody>) {
    const conn = await this.db.withTenantTx((tx) => this.connection(tx, b.facilityId));
    let ok = false, message: string, organizationName: string | null = null;
    try {
      const org = await getOrganization(this.client(conn), conn.organizationId);
      ok = true; organizationName = org.name;
      message = `Terhubung ke SATUSEHAT ${label(conn.environment)}${org.name ? ` — ${org.name}` : ''}`;
    } catch (e) {
      message = e instanceof SatuSehatError ? (e.kind === 'NOT_FOUND' ? 'Organization ID tidak ditemukan di SATUSEHAT' : e.message) : 'Kesalahan tidak terduga';
    }
    return this.db.withTenantTx(async (tx) => {
      await tx.execute(sql`update integration_connection set last_test_at = now(), last_test_ok = ${ok}, last_test_message = ${message} where id = ${conn.id}`);
      await audit(tx, 'SATUSEHAT_CONNECTION_TESTED', 'integration_connection', conn.id, null, { environment: conn.environment, ok, message });
      return { ok, message, organizationName, environment: conn.environment, testedAt: new Date().toISOString() };
    });
  }

  /**
   * Sinkron master (AC-INT-FR-002-1): Organization diverifikasi; Location per poli/ruang aktif di fasilitas ini (dicari per
   * identifier lalu dibuat — tidak ganda); IHS tenaga kesehatan ber-NIK yang belum punya IHS.
   */
  @RequirePermission('integration.manage') @BodySchema(FacilityBody) @Post('integrations/satusehat/sync-master') @HttpCode(200)
  async syncMaster(@Body() b: z.infer<typeof FacilityBody>) {
    const { conn, units, practitioners } = await this.db.withTenantTx(async (tx) => ({
      conn: await this.connection(tx, b.facilityId),
      units: await rows<{ id: string; name: string; branch_name: string; location_id: string | null }>(tx, sql`
        select u.id, u.name, br.name as branch_name, r.satusehat_id as location_id
          from service_unit u join branch br on br.id = u.branch_id
          left join fhir_sync_record r on r.local_type = 'service_unit' and r.local_id = u.id and r.resource_type = 'Location'
                                       and r.connection_id = (select id from integration_connection where facility_id = ${b.facilityId} and kind = 'SATUSEHAT' and is_active)
         where br.facility_id = ${b.facilityId} and u.is_active and u.unit_type in ('POLI', 'RUANG') order by br.name, u.name`),
      practitioners: await rows<{ id: string; nik_encrypted: Buffer | null }>(tx, sql`
        select id, nik_encrypted from practitioner where is_active and satusehat_ihs_id is null order by full_name`),
    }));
    const client = this.client(conn);
    try {
      await getOrganization(client, conn.organizationId);
    } catch (e) {
      throw problem(e instanceof SatuSehatError && e.kind === 'AUTH' ? 502 : 409, 'INT-409-ORGANIZATION',
        e instanceof SatuSehatError ? (e.kind === 'NOT_FOUND' ? 'Organization ID tidak ditemukan di SATUSEHAT' : e.message) : 'Kesalahan tidak terduga');
    }
    const loc = { created: 0, existing: 0, failed: 0 };
    const locResults: { unitId: string; locationId: string | null; status: 'SENT' | 'ERROR'; error: string | null }[] = [];
    for (const u of units) {
      if (u.location_id) { loc.existing++; continue; }
      try {
        const r = await ensureLocation(client, conn.organizationId, { code: u.id, name: u.name, branchName: u.branch_name });
        if (r.created) loc.created++; else loc.existing++;
        locResults.push({ unitId: u.id, locationId: r.id, status: 'SENT', error: null });
      } catch (e) {
        loc.failed++;
        locResults.push({ unitId: u.id, locationId: null, status: 'ERROR', error: e instanceof SatuSehatError ? e.message : 'Kesalahan tidak terduga' });
      }
    }
    const prac = { found: 0, notFound: 0, noNik: 0, failed: 0 };
    const pracResults: { id: string; ihs: string }[] = [];
    for (const p of practitioners) {
      if (!p.nik_encrypted) { prac.noNik++; continue; }
      try {
        const ihs = await findPractitionerIhs(client, decrypt(this.cfg.encryptionKeyHex, p.nik_encrypted));
        if (ihs) { prac.found++; pracResults.push({ id: p.id, ihs }); } else prac.notFound++;
      } catch (e) {
        if (e instanceof SatuSehatError && e.kind === 'AUTH') throw problem(502, 'INT-502-AUTH', e.message);
        prac.failed++;
      }
    }
    return this.db.withTenantTx(async (tx) => {
      for (const r of locResults) {
        await tx.execute(sql`
          insert into fhir_sync_record(tenant_id, connection_id, resource_type, local_type, local_id, satusehat_id, status, attempts, last_error, last_sent_at)
          values (app.current_tenant_id(), ${conn.id}, 'Location', 'service_unit', ${r.unitId}, ${r.locationId}, ${r.status}, 1, ${r.error},
                  case when ${r.status} = 'SENT' then now() end)
          on conflict (tenant_id, connection_id, resource_type, local_type, local_id) do update
            set satusehat_id = coalesce(excluded.satusehat_id, fhir_sync_record.satusehat_id), status = excluded.status,
                attempts = fhir_sync_record.attempts + 1, last_error = excluded.last_error, last_sent_at = coalesce(excluded.last_sent_at, fhir_sync_record.last_sent_at),
                updated_at = now()`);
      }
      for (const p of pracResults) await tx.execute(sql`update practitioner set satusehat_ihs_id = ${p.ihs} where id = ${p.id} and satusehat_ihs_id is null`);
      await tx.execute(sql`update integration_connection set last_sync_at = now() where id = ${conn.id}`);
      const summary = { environment: conn.environment, locations: loc, practitioners: prac };
      await audit(tx, 'SATUSEHAT_MASTER_SYNCED', 'integration_connection', conn.id, null, summary);
      return summary;
    });
  }

  /** Lookup IHS manual dari halaman pasien (INT-FR-003); otomatisnya lewat worker (OD-116). */
  @RequirePermission('patient.update') @NoBody() @Post('patients/:id/ihs-lookup') @HttpCode(200)
  async lookupPatient(@Param('id') id: string) {
    assertId(id, 'PAT-404', 'Pasien tidak ditemukan');
    const { conn, nik } = await this.db.withTenantTx(async (tx) => {
      const [p] = await rows<{ identity_type: string; nik_encrypted: Buffer | null; status: string }>(tx, sql`
        select identity_type, nik_encrypted, status from patient where id = ${id}`);
      if (!p) throw problem(404, 'PAT-404', 'Pasien tidak ditemukan');
      if (p.identity_type !== 'NIK' || !p.nik_encrypted) throw problem(409, 'INT-409-NO-NIK', 'Pasien tanpa NIK tidak dapat dicari di SATUSEHAT');
      const [c] = await rows<ConnRow>(tx, sql`
        select * from integration_connection where kind = 'SATUSEHAT' and is_active order by (environment = 'PRODUCTION') desc, updated_at desc limit 1`);
      if (!c) throw problem(409, ...NOT_CONFIGURED);
      return { conn: this.toConn(c), nik: decrypt(this.cfg.encryptionKeyHex, p.nik_encrypted) };
    });
    let r: Awaited<ReturnType<typeof lookupOne>>;
    try { r = await lookupOne(this.client(conn), nik); }
    catch (e) { throw problem(502, 'INT-502-AUTH', e instanceof SatuSehatError ? e.message : 'Kesalahan tidak terduga'); }
    return this.db.withTenantTx(async (tx) => {
      await tx.execute(sql`update patient set ihs_number = coalesce(${r.ihs}, ihs_number), ihs_status = ${r.status}, ihs_checked_at = now(), ihs_last_error = ${r.error}
                            where id = ${id}`);
      await audit(tx, 'PATIENT_IHS_LOOKUP', 'patient', id, id, { status: r.status, environment: conn.environment, manual: true, error: r.error });
      return { ihsStatus: r.status, ihsNumber: r.ihs, error: r.error, environment: conn.environment };
    });
  }

  /**
   * Status pengiriman kunjungan ke SATUSEHAT (INT-FR-008): terkirim / tertahan + daftar masalah yang dapat ditindaklanjuti /
   * dicoba ulang / ditolak. Hanya data operasional, tanpa isi rekam medis.
   */
  @RequirePermission('clinical.record.read') @Get('encounters/:id/satusehat')
  async encounterStatus(@Param('id') id: string) {
    assertId(id, 'ENC-404', 'Kunjungan tidak ditemukan');
    return this.db.withTenantTx(async (tx) => {
      const [e] = await rows<{ facility_id: string; signed: boolean; satusehat_id: string | null }>(tx, sql`
        select b.facility_id, exists (select 1 from clinical_note n where n.encounter_id = e.id and n.status = 'SIGNED') as signed, e.satusehat_id
          from encounter e join branch b on b.id = e.branch_id where e.id = ${id}`);
      if (!e) throw problem(404, 'ENC-404', 'Kunjungan tidak ditemukan');
      const [c] = await rows<{ id: string; environment: SatuSehatEnvironment }>(tx, sql`
        select id, environment from integration_connection where facility_id = ${e.facility_id} and kind = 'SATUSEHAT' and is_active`);
      if (!c) return { configured: false, environment: null, signed: e.signed, status: null, resources: [] };
      const [r] = await rows<{ id: string; status: string; attempts: number; last_error: string | null; problems: { blocking?: string[]; warnings?: string[] };
                              satusehat_id: string | null; last_sent_at: string | null; next_attempt_at: string | null; updated_at: string; resource_version: number }>(tx, sql`
        select id, status, attempts, last_error, problems, satusehat_id, last_sent_at, next_attempt_at, updated_at, resource_version from fhir_sync_record
         where connection_id = ${c.id} and resource_type = 'Encounter' and local_type = 'encounter' and local_id = ${id}`);
      const iso = (v: string | null | undefined) => (v ? new Date(v).toISOString() : null);
      const kids = r ? await rows<{ id: string; resource_type: string; local_type: string; status: string; satusehat_id: string | null; problems: { blocking?: string[]; warnings?: string[] };
                                    last_error: string | null; entered_in_error_at: string | null; resource_version: number }>(tx, sql`
        select id, resource_type, local_type, status, satusehat_id, problems, last_error, entered_in_error_at, resource_version from fhir_sync_record
         where parent_id = ${r.id} order by resource_type, created_at`) : [];
      return {
        configured: true, environment: c.environment, signed: e.signed,
        status: r?.status ?? (e.signed ? 'QUEUED' : 'NOT_SIGNED'), attempts: r?.attempts ?? 0, lastError: r?.last_error ?? null,
        blocking: r?.problems?.blocking ?? [], warnings: r?.problems?.warnings ?? [], satusehatId: r?.satusehat_id ?? null,
        lastSentAt: iso(r?.last_sent_at), nextAttemptAt: iso(r?.next_attempt_at), updatedAt: iso(r?.updated_at),
        version: r?.resource_version ?? null,
        resources: kids.map((k) => ({ id: k.id, resourceType: k.resource_type, localType: k.local_type, status: k.status, satusehatId: k.satusehat_id,
          blocking: k.problems?.blocking ?? [], warnings: k.problems?.warnings ?? [], lastError: k.last_error, enteredInError: !!k.entered_in_error_at,
          version: k.resource_version })),
      };
    });
  }

  /**
   * "Perlu tindakan" (OD-119, INT-FR-009): kiriman yang ditolak (ERROR), gagal setelah semua percobaan (DEAD), atau tertahan karena data
   * belum lengkap (BLOCKED). Hanya nomor kunjungan & pesan operasional — tanpa nama pasien / isi rekam medis.
   */
  @RequirePermission('integration.read') @Get('integrations/satusehat/records')
  async records(@Query('facilityId') facilityId?: string) {
    if (!facilityId || !UUID_RE.test(facilityId)) throw problem(400, 'GEN-400-VALIDATION', 'facilityId wajib');
    return this.db.withTenantTx(async (tx) => {
      const [c] = await rows<{ id: string }>(tx, sql`select id from integration_connection where facility_id = ${facilityId} and kind = 'SATUSEHAT' and is_active`);
      if (!c) return { data: [], nextCursor: null, counts: { ERROR: 0, DEAD: 0, BLOCKED: 0 } };
      const data = await rows<{ id: string; resource_type: string; local_type: string; status: string; attempts: number; last_error: string | null;
        problems: { blocking?: string[] }; updated_at: string; resend_requested_at: string | null; encounter_id: string | null; encounter_no: string | null }>(tx, sql`
        select r.id, r.resource_type, r.local_type, r.status, r.attempts, r.last_error, r.problems, r.updated_at, r.resend_requested_at,
               e.id as encounter_id, e.encounter_no
          from fhir_sync_record r
          left join fhir_sync_record p on p.id = r.parent_id
          left join encounter e on e.id = case when r.local_type = 'encounter' then r.local_id else p.local_id end
         where r.connection_id = ${c.id} and r.status in ('ERROR', 'DEAD', 'BLOCKED')
           and r.local_type in ${RESENDABLE_SQL}
         order by case r.status when 'DEAD' then 0 when 'ERROR' then 1 else 2 end, r.updated_at desc limit 200`);
      const counts = { ERROR: 0, DEAD: 0, BLOCKED: 0 } as Record<string, number>;
      for (const x of await rows<{ status: string; n: number }>(tx, sql`
        select status, count(*)::int as n from fhir_sync_record where connection_id = ${c.id} and status in ('ERROR', 'DEAD', 'BLOCKED')
           and local_type in ${RESENDABLE_SQL} group by status`)) counts[x.status] = x.n;
      return {
        counts, nextCursor: null,
        data: data.map((x) => ({ id: x.id, resourceType: x.resource_type, localType: x.local_type, status: x.status, attempts: x.attempts, lastError: x.last_error,
          blocking: x.problems?.blocking ?? [], updatedAt: new Date(x.updated_at).toISOString(),
          resendRequestedAt: x.resend_requested_at ? new Date(x.resend_requested_at).toISOString() : null, encounterId: x.encounter_id, encounterNo: x.encounter_no,
          resendable: x.status === 'ERROR' || x.status === 'DEAD' })),
      };
    });
  }

  /**
   * Kirim ulang manual (OD-119): kiriman ERROR/DEAD dijadwalkan dikirim pada putaran worker berikutnya. Idempoten — worker lebih dulu
   * mencari resource per identifier lokal sehingga tidak membuat data ganda. Teraudit.
   */
  @RequirePermission('integration.manage') @NoBody() @Post('integrations/satusehat/records/:id/retry') @HttpCode(200)
  async resend(@Param('id') id: string) {
    assertId(id, 'INT-404-RECORD', 'Data kiriman tidak ditemukan');
    return this.db.withTenantTx(async (tx) => {
      const [r] = await rows<{ id: string; status: string; local_type: string; resource_type: string; is_active: boolean; parent_local: string | null; local_id: string }>(tx, sql`
        select r.id, r.status, r.local_type, r.resource_type, ic.is_active, p.local_id as parent_local, r.local_id
          from fhir_sync_record r join integration_connection ic on ic.id = r.connection_id left join fhir_sync_record p on p.id = r.parent_id
         where r.id = ${id} and r.local_type in ${RESENDABLE_SQL} for update of r`);
      if (!r) throw problem(404, 'INT-404-RECORD', 'Data kiriman tidak ditemukan');
      if (!r.is_active) throw problem(409, 'INT-409-INACTIVE', 'Koneksi SATUSEHAT untuk data ini sudah tidak aktif');
      if (r.status === 'PENDING') return { id, status: 'PENDING', alreadyQueued: true };
      if (r.status !== 'ERROR' && r.status !== 'DEAD') throw problem(409, 'INT-409-NOT-RESENDABLE', 'Hanya kiriman yang ditolak atau gagal yang dapat dikirim ulang');
      await tx.execute(sql`update fhir_sync_record set status = 'PENDING', next_attempt_at = now(), resend_requested_at = now(), resend_requested_by = ${ctx().userId},
                           updated_at = now() where id = ${id}`);
      const encounterId = r.local_type === 'encounter' ? r.local_id : r.parent_local;
      const [pt] = encounterId ? await rows<{ patient_id: string }>(tx, sql`select patient_id from encounter where id = ${encounterId}`) : [];
      await audit(tx, 'SATUSEHAT_RESEND_REQUESTED', 'fhir_sync_record', id, pt?.patient_id ?? null,
        { resourceType: r.resource_type, localType: r.local_type, previousStatus: r.status });
      return { id, status: 'PENDING', alreadyQueued: false };
    });
  }

  private client(conn: SatuSehatConnection): SatuSehatClient {
    if (conn.environment === 'SIMULATOR' && this.cfg.appEnv === 'prod') throw problem(400, 'INT-400-SIMULATOR', 'Simulator SATUSEHAT tidak dapat dipakai di produksi');
    return createSatuSehatClient(conn, this.cfg.satusehatUrls);
  }

  private async connection(tx: Tx, facilityId: string): Promise<SatuSehatConnection> {
    assertId(facilityId, ...NOT_CONFIGURED);
    const [c] = await rows<ConnRow>(tx, sql`select * from integration_connection where facility_id = ${facilityId} and kind = 'SATUSEHAT' and is_active`);
    if (!c) throw problem(404, ...NOT_CONFIGURED);
    return this.toConn(c);
  }

  private toConn(c: ConnRow): SatuSehatConnection {
    return { id: c.id, facilityId: c.facility_id, environment: c.environment, clientId: c.client_id, clientSecret: decrypt(this.cfg.encryptionKeyHex, c.secret_encrypted),
      organizationId: c.organization_id };
  }
}

const label = (e: SatuSehatEnvironment) => (e === 'PRODUCTION' ? 'produksi' : e === 'SANDBOX' ? 'sandbox' : 'simulator');
/** Tanpa rahasia: client ID ditampilkan tersamar, secret hanya "tersimpan". */
const connDto = (c: ConnRow) => ({
  id: c.id, facilityId: c.facility_id, environment: c.environment, clientIdMasked: mask(c.client_id), hasSecret: !!c.secret_encrypted,
  organizationId: c.organization_id, lastTestAt: c.last_test_at, lastTestOk: c.last_test_ok, lastTestMessage: c.last_test_message, lastSyncAt: c.last_sync_at,
  updatedAt: c.updated_at,
});
const mask = (s: string) => (s.length <= 6 ? '••••' : `${s.slice(0, 3)}••••${s.slice(-3)}`);
