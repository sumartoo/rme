import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import {
  type AppConfig, BodySchema, CONFIG, RequirePermission, assertId, assertVersion, ctx, encrypt, ifMatchVersion, merge, pgError,
  problem, problemWith,
} from '@clinicrme/shared';
import { Db, type Tx, audit, auditChange, idempotent, rows } from '@clinicrme/db';
import {
  ConsentBody, CoverageBody, CoveragePatch, MergeBody, PatientCreate, PatientUpdate, RestrictionBody, SearchQuery,
  normalizePhone, registrationRules,
} from './patient.schemas';
import { SUMMARY_COLS, type SummaryRow, findDuplicates, identityHash, maskIdentity, maskNik, nikHash, summaryDto } from './patient.repo';

const NOT_FOUND = ['PAT-404', 'Pasien tidak ditemukan'] as const;

interface PatientRow extends SummaryRow {
  nik_hash: string | null; identity_value_hash: string | null; mother_patient_id: string | null; email: string | null;
  address: string | null; region_code: string | null; ihs_status: string; merged_into_id: string | null; merged_at: string | null;
  merge_reason: string | null; processing_restricted: boolean; restriction_reason: string | null; restricted_at: string | null;
  registered_branch_id: string | null; created_at: string; version: number;
}
const SELECT = sql`select ${SUMMARY_COLS}, p.nik_hash, p.identity_value_hash, p.mother_patient_id, p.email, p.address, p.region_code,
  p.ihs_status, p.merged_into_id, p.merged_at, p.merge_reason, p.processing_restricted, p.restriction_reason, p.restricted_at,
  p.registered_branch_id, p.created_at, p.version from patient p`;

interface CoverageRow { id: string; payer_id: string; payer_name: string; payer_type: string; member_no: string | null; plan_name: string | null;
  employee_no: string | null; bpjs_faskes_code: string | null; valid_from: string | null; valid_to: string | null; is_active: boolean; version: number }
const COVERAGE_SELECT = sql`select c.id, c.payer_id, y.name as payer_name, y.payer_type, c.member_no, c.plan_name, c.employee_no,
  c.bpjs_faskes_code, to_char(c.valid_from, 'YYYY-MM-DD') as valid_from, to_char(c.valid_to, 'YYYY-MM-DD') as valid_to, c.is_active, c.version
  from patient_coverage c join payer y on y.id = c.payer_id`;
const coverageDto = (c: CoverageRow) => ({
  id: c.id, payerId: c.payer_id, payerName: c.payer_name, payerType: c.payer_type, memberNo: c.member_no, planName: c.plan_name,
  employeeNo: c.employee_no, bpjsFaskesCode: c.bpjs_faskes_code, validFrom: c.valid_from, validTo: c.valid_to, isActive: c.is_active,
  version: c.version,
});

type Contact = { relation: string; fullName: string; phone: string; isGuardian?: boolean };
type Detail = Awaited<ReturnType<PatientController['detail']>>;

/**
 * Master Patient Index (Stage 8 batch 1, REG-FR-001..009, 012). Satu pasien berlaku lintas cabang (OD-022). NIK & nomor
 * paspor/KITAS disimpan terenkripsi + indeks buta HMAC; respons, log, dan audit hanya melihat bentuk tersamar/hash.
 * Pasien tidak pernah dihapus (DELETE dicabut di database); duplikat diselesaikan dengan penggabungan teraudit.
 */
@Controller('api/v1/patients')
export class PatientController {
  constructor(private readonly db: Db, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  // ---------------------------------------------------------------- pencarian
  /** REG-FR-003: nama toleran salah ketik (trigram), NIK (hash), MRN, telepon, tanggal lahir. `q` menebak jenis isian. */
  @RequirePermission('patient.read') @Get()
  async search(@Query() query: Record<string, unknown>) {
    const p = SearchQuery.safeParse(query);
    if (!p.success) throw problem(400, 'GEN-400-QUERY', 'Parameter pencarian tidak valid');
    const { q, nik, mrn, phone, birthDate, includeMerged, limit, cursor } = p.data;
    const offset = Number(cursor ?? 0);
    const nikQ = nik ?? (q && /^\d{16}$/.test(q) ? q : undefined);
    const nikH = nikQ ? nikHash(this.cfg.encryptionKeyHex, nikQ) : null;
    const phoneQ = phone ? normalizePhone(phone) : q && /^[+\d][\d\s-]{7,}$/.test(q) && !nikQ ? normalizePhone(q) : null;
    const text = q && !nikQ ? q : null;
    const name = text && /[A-Za-z]/.test(text) ? text.replace(/\s+/g, ' ') : null;
    const like = name ? `%${name.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const r = await this.db.withTenantTx(async (tx) => {
      await tx.execute(sql`set local pg_trgm.similarity_threshold = 0.3`);
      return rows<SummaryRow>(tx, sql`
        select ${SUMMARY_COLS}, case when ${name}::text is null then null else round(similarity(p.full_name, ${name})::numeric, 2) end as score
          from patient p
         where (${includeMerged === 'true'}::boolean or p.status <> 'MERGED')
           and (${nikH}::text is null or p.nik_hash = ${nikH})
           and (${mrn ?? null}::text is null or upper(p.mrn) = upper(${mrn ?? null}))
           and (${phone ? phoneQ : null}::text is null or p.phone = ${phone ? phoneQ : null})
           and (${birthDate ?? null}::date is null or p.birth_date = ${birthDate ?? null}::date)
           and (${text}::text is null
                or (${name}::text is not null and (p.full_name % ${name} or p.full_name ilike ${like}))
                or upper(p.mrn) = upper(${text}) or p.mrn like ${`%${text}`}
                or (${phone ? null : phoneQ}::text is not null and p.phone = ${phone ? null : phoneQ}))
         order by (${text}::text is not null and upper(p.mrn) = upper(${text})) desc,
                  case when ${name}::text is null then 0 else similarity(p.full_name, ${name}) end desc,
                  p.created_at desc, p.id
         limit ${limit + 1} offset ${offset}`);
    });
    const data = r.slice(0, limit).map(summaryDto);
    return { data, page: { hasMore: r.length > limit, nextCursor: r.length > limit ? String(offset + limit) : null } };
  }

  // ---------------------------------------------------------------- duplikat
  /** REG-FR-004: kandidat duplikat sebelum simpan (tidak menyimpan apa pun). */
  @RequirePermission('patient.create') @BodySchema(PatientCreate) @Post('duplicate-check') @HttpCode(200)
  async duplicateCheck(@Body() b: z.infer<typeof PatientCreate>) {
    const r = await this.db.withTenantTx((tx) => findDuplicates(tx, this.dupInput(b)));
    return { exactNikMatch: r.exactMatch, candidates: r.candidates };
  }

  private dupInput(b: { fullName: string; birthDate: string; sex: string; phone?: string | null; nik?: string | null;
                        identityType: string; identityValue?: string | null }) {
    return { fullName: b.fullName, birthDate: b.birthDate, sex: b.sex, phone: b.phone ?? null, identityType: b.identityType,
      nikHash: b.nik ? nikHash(this.cfg.encryptionKeyHex, b.nik) : null,
      identityHash: b.identityValue ? identityHash(this.cfg.encryptionKeyHex, b.identityType, b.identityValue) : null };
  }

  // ---------------------------------------------------------------- registrasi
  /**
   * REG-FR-001/002/004/006/007/009: MRN otomatis per klinik (OD-081: 8 digit, awalan dari pengaturan `mrnPrefix`).
   * Identitas sama → 409 (pasien yang ada ditunjukkan). Kandidat mirip → 409 PAT-409-DUPLICATE kecuali petugas mengisi
   * `duplicateOverrideReason` (tercatat di audit). Idempotency-Key wajib: klik ganda tidak membuat pasien ganda.
   */
  @RequirePermission('patient.create') @BodySchema(PatientCreate) @Post() @HttpCode(201)
  async create(@Body() b: z.infer<typeof PatientCreate>, @Headers('idempotency-key') key: string | undefined) {
    try {
      return await this.db.withTenantTx((tx) => idempotent(tx, 'patient.create', key, b, () => this.insert(tx, b)));
    } catch (e) {
      throw this.uniqueViolation(e);
    }
  }

  private async insert(tx: Tx, b: z.infer<typeof PatientCreate>) {
    const dup = this.dupInput(b);
    await this.assertReferences(tx, b.regionCode, b.motherPatientId, null);
    const found = await findDuplicates(tx, dup);
    if (found.exactMatch) {
      throw problemWith(409, 'PAT-409-IDENTITY', 'Identitas ini sudah terdaftar. Gunakan data pasien yang ada.',
        { candidates: found.candidates.filter((_, i) => i === 0) });
    }
    if (found.candidates.length > 0 && !b.duplicateOverrideReason) {
      throw problemWith(409, 'PAT-409-DUPLICATE', 'Ada pasien dengan data mirip. Periksa dulu, atau isi alasan bila memang pasien berbeda.',
        { candidates: found.candidates });
    }
    for (const c of b.coverages ?? []) await this.assertPayer(tx, c.payerId);
    const [{ prefix }] = await rows<{ prefix: string }>(tx, sql`
      select coalesce(settings->>'mrnPrefix', '') as prefix from tenant where id = app.current_tenant_id()`);
    const [{ seq }] = await rows<{ seq: string }>(tx, sql`select app.next_document_number('MRN', 'TENANT', '{SEQ:8}') as seq`);
    const key = this.cfg.encryptionKeyHex;
    const [{ id }] = await rows<{ id: string }>(tx, sql`
      insert into patient(tenant_id, mrn, full_name, birth_date, sex, identity_type, nik_encrypted, nik_hash, nik_masked,
                          identity_value_encrypted, identity_value_hash, identity_value_masked, mother_patient_id, phone, email,
                          address, region_code, ihs_status, registered_branch_id, created_by, updated_by)
      values (app.current_tenant_id(), ${prefix + seq}, ${b.fullName}, ${b.birthDate}::date, ${b.sex}, ${b.identityType},
              ${b.nik ? encrypt(key, b.nik) : null}, ${dup.nikHash}, ${b.nik ? maskNik(b.nik) : null},
              ${b.identityValue ? encrypt(key, b.identityValue) : null}, ${dup.identityHash},
              ${b.identityValue ? maskIdentity(b.identityValue) : null}, ${b.motherPatientId ?? null}::uuid, ${b.phone ?? null},
              ${b.email ?? null}, ${b.address}, ${b.regionCode ?? null},
              ${b.identityType === 'NIK' ? 'PENDING' : 'NOT_APPLICABLE'}, ${ctx().branchId ?? null}::uuid, ${ctx().userId}, ${ctx().userId})
      returning id`);
    await this.replaceContacts(tx, id, b.contacts ?? []);
    for (const c of b.coverages ?? []) await this.insertCoverage(tx, id, c);
    const d = await this.detail(tx, id);
    await audit(tx, 'PATIENT_CREATED', 'patient', id, id, {
      after: this.auditView(d, dup.nikHash, dup.identityHash),
      ...(b.duplicateOverrideReason ? { duplicateOverride: { reason: b.duplicateOverrideReason, candidateIds: found.candidates.map((c) => c.id) } } : {}),
    });
    return d;
  }

  /** Dua pendaftaran bersamaan dengan NIK sama: indeks unik database yang menang → 409, bukan 500. */
  private uniqueViolation(e: unknown) {
    const pg = pgError(e);
    if (pg?.code === '23505' && pg.constraint === 'ux_patient_nik') return problem(409, 'PAT-409-IDENTITY', 'Identitas ini sudah terdaftar. Gunakan data pasien yang ada.');
    return e;
  }

  // ---------------------------------------------------------------- detail
  /** Detail pasien; akses dicatat sebagai READ dengan patient_id (AUD-FR-002). Tenant lain → 404. */
  @RequirePermission('patient.read') @Get(':id')
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    assertId(id, ...NOT_FOUND);
    const d = await this.db.withTenantTx(async (tx) => {
      const out = await this.detail(tx, id);
      await audit(tx, 'READ', 'patient', id, id);
      return out;
    });
    res.setHeader('ETag', `"${d.version}"`);
    return d;
  }

  async detail(tx: Tx, id: string) {
    const [p] = await rows<PatientRow>(tx, sql`${SELECT} where p.id = ${id}`);
    if (!p) throw problem(404, ...NOT_FOUND);
    const contacts = await rows<{ id: string; relation: string; full_name: string; phone: string; is_guardian: boolean }>(tx, sql`
      select id, relation, full_name, phone, is_guardian from patient_contact where patient_id = ${id} order by created_at, id`);
    const coverages = await rows<CoverageRow>(tx, sql`${COVERAGE_SELECT} where c.patient_id = ${id} order by c.is_active desc, c.created_at`);
    const consents = await rows<{ id: string; consent_type: string; version: string; title: string | null; granted: boolean;
                                  signed_by_name: string | null; signed_by_relation: string | null; recorded_at: string; revoked_at: string | null }>(tx, sql`
      select pc.id, d.consent_type, d.version, d.title, pc.granted, pc.signed_by_name, pc.signed_by_relation, pc.recorded_at, pc.revoked_at
        from patient_consent pc join consent_document d on d.id = pc.consent_document_id
       where pc.patient_id = ${id} order by pc.recorded_at desc`);
    const link = async (pid: string | null) => {
      if (!pid) return null;
      const [r] = await rows<SummaryRow>(tx, sql`select ${SUMMARY_COLS} from patient p where p.id = ${pid}`);
      return r ? summaryDto(r) : null;
    };
    const today = new Date().toISOString().slice(0, 10);
    return {
      ...summaryDto(p), email: p.email, address: p.address, regionCode: p.region_code, ihsStatus: p.ihs_status,
      mother: await link(p.mother_patient_id), mergedInto: await link(p.merged_into_id), mergedAt: p.merged_at, mergeReason: p.merge_reason,
      processingRestricted: p.processing_restricted, restrictionReason: p.restriction_reason, restrictedAt: p.restricted_at,
      registeredBranchId: p.registered_branch_id, createdAt: p.created_at,
      contacts: contacts.map((c) => ({ id: c.id, relation: c.relation, fullName: c.full_name, phone: c.phone, isGuardian: c.is_guardian })),
      coverages: coverages.map(coverageDto),
      consents: consents.map((c) => ({ id: c.id, consentType: c.consent_type, version: c.version, title: c.title, granted: c.granted,
        signedByName: c.signed_by_name, signedByRelation: c.signed_by_relation, recordedAt: c.recorded_at, revokedAt: c.revoked_at })),
      hasConsent: consents.some((c) => c.consent_type === 'UMUM' && c.granted && !c.revoked_at),
      hasActiveCoverage: coverages.some((c) => c.is_active && (!c.valid_to || c.valid_to >= today)),
      version: p.version,
    };
  }

  /** Nilai yang diaudit: NIK/identitas hanya hash (penanda berubah), tidak pernah nilai asli maupun tersamar. */
  private auditView(d: Detail, nikH: string | null, idH: string | null) {
    return { fullName: d.fullName, birthDate: d.birthDate, sex: d.sex, identityType: d.identityType, nik: nikH, identityValue: idH,
      motherPatientId: d.mother?.id ?? null, phone: d.phone, email: d.email, address: d.address, regionCode: d.regionCode,
      contacts: d.contacts.map((c) => ({ relation: c.relation, fullName: c.fullName, phone: c.phone, isGuardian: c.isGuardian })) };
  }

  // ---------------------------------------------------------------- ubah
  @RequirePermission('patient.update') @BodySchema(PatientUpdate) @Put(':id')
  async update(@Param('id') id: string, @Body() b: z.infer<typeof PatientUpdate>,
               @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    assertId(id, ...NOT_FOUND);
    const v = ifMatchVersion(ifMatch, 'pasien');
    const key = this.cfg.encryptionKeyHex;
    let out: Detail;
    try {
      out = await this.db.withTenantTx(async (tx) => {
        const [cur] = await rows<SummaryRow & { nik_hash: string | null; nik_encrypted: Buffer | null; identity_value_hash: string | null;
                                                identity_value_encrypted: Buffer | null; version: number }>(tx, sql`
          select ${SUMMARY_COLS}, p.nik_hash, p.nik_encrypted, p.identity_value_hash, p.identity_value_encrypted, p.version
            from patient p where p.id = ${id} for update`);
        if (!cur) throw problem(404, ...NOT_FOUND);
        assertVersion(cur.version, v, 'Data pasien');
        if (cur.status === 'MERGED') throw problem(409, 'PAT-409-MERGED', 'Pasien ini sudah digabung ke pasien lain dan tidak dapat diubah');
        const before = await this.detail(tx, id);
        const { nik, identityValue, contacts, ...fields } = b;
        const n = merge({ fullName: before.fullName, birthDate: before.birthDate, sex: before.sex, identityType: before.identityType,
          motherPatientId: before.mother?.id ?? null, phone: before.phone, email: before.email, address: before.address ?? '',
          regionCode: before.regionCode }, fields);
        const typeChanged = n.identityType !== cur.identity_type;
        // Identitas: tidak dikirim = tetap (kecuali jenis identitas berubah → nilai lama tidak berlaku lagi)
        const nikNew = nik !== undefined ? nik : typeChanged ? null : undefined;
        const idNew = identityValue !== undefined ? identityValue : typeChanged ? null : undefined;
        const hasNik = nikNew === undefined ? cur.nik_hash !== null : !!nikNew;
        const hasIdv = idNew === undefined ? cur.identity_value_hash !== null : !!idNew;
        const contactCount = contacts !== undefined ? contacts.length : before.contacts.length;
        const errors = registrationRules({ ...n, identityType: n.identityType as never, nik: hasNik ? 'x' : null,
          identityValue: hasIdv ? 'x' : null, contactCount });
        if (errors.length) throw problemWith(400, 'GEN-400-VALIDATION', 'Input tidak valid', { errors });
        await this.assertReferences(tx, n.regionCode, n.motherPatientId, id);
        const nikH = nikNew === undefined ? cur.nik_hash : nikNew ? nikHash(key, nikNew) : null;
        const idH = idNew === undefined ? cur.identity_value_hash : idNew ? identityHash(key, n.identityType, idNew) : null;
        if ((nikH && nikH !== cur.nik_hash) || (idH && idH !== cur.identity_value_hash)) {
          const found = await findDuplicates(tx, { ...n, nikHash: nikH !== cur.nik_hash ? nikH : null,
            identityHash: idH !== cur.identity_value_hash ? idH : null }, id);
          if (found.exactMatch) {
            throw problemWith(409, 'PAT-409-IDENTITY', 'Identitas ini sudah terdaftar untuk pasien lain',
              { candidates: found.candidates.filter((_, i) => i === 0) });
          }
        }
        const enc = (x: string | null | undefined, old: Buffer | null) => (x === undefined ? old : x ? encrypt(key, x) : null);
        const nikMasked = nikNew === undefined ? cur.nik_masked : nikNew ? maskNik(nikNew) : null;
        const idMasked = idNew === undefined ? cur.identity_value_masked : idNew ? maskIdentity(idNew) : null;
        await tx.execute(sql`
          update patient set full_name = ${n.fullName}, birth_date = ${n.birthDate}::date, sex = ${n.sex}, identity_type = ${n.identityType},
                 nik_encrypted = ${enc(nikNew, cur.nik_encrypted)}, nik_hash = ${nikH}, nik_masked = ${nikMasked},
                 identity_value_encrypted = ${enc(idNew, cur.identity_value_encrypted)}, identity_value_hash = ${idH},
                 identity_value_masked = ${idMasked}, mother_patient_id = ${n.motherPatientId ?? null}::uuid, phone = ${n.phone ?? null},
                 email = ${n.email ?? null}, address = ${n.address}, region_code = ${n.regionCode ?? null},
                 ihs_status = case when ${nikH !== cur.nik_hash}::boolean then (case when ${nikH}::text is null then 'NOT_APPLICABLE' else 'PENDING' end)
                                   else ihs_status end,
                 updated_by = ${ctx().userId}
           where id = ${id}`);
        if (contacts !== undefined) await this.replaceContacts(tx, id, contacts);
        const after = await this.detail(tx, id);
        await auditChange(tx, 'PATIENT_UPDATED', 'patient', id, this.auditView(before, cur.nik_hash, cur.identity_value_hash),
          this.auditView(after, nikH, idH), ['nik', 'identityValue']);
        return after;
      });
    } catch (e) {
      throw this.uniqueViolation(e);
    }
    res.setHeader('ETag', `"${out.version}"`);
    return out;
  }

  private async replaceContacts(tx: Tx, patientId: string, contacts: Contact[]) {
    await tx.execute(sql`delete from patient_contact where patient_id = ${patientId}`);
    for (const c of contacts) {
      await tx.execute(sql`insert into patient_contact(tenant_id, patient_id, relation, full_name, phone, is_guardian)
                           values (app.current_tenant_id(), ${patientId}, ${c.relation}, ${c.fullName}, ${c.phone}, ${c.isGuardian ?? false})`);
    }
  }

  private async assertReferences(tx: Tx, regionCode: string | null | undefined, motherId: string | null | undefined, selfId: string | null) {
    if (regionCode) {
      const [r] = await rows(tx, sql`select 1 from region where code = ${regionCode}`);
      if (!r) throw problem(400, 'PAT-400-REGION', 'Kode wilayah tidak dikenal');
    }
    if (motherId) {
      const [m] = await rows<{ status: string; sex: string }>(tx, sql`select status, sex from patient where id = ${motherId}`);
      if (!m || motherId === selfId) throw problem(400, 'PAT-400-MOTHER', 'Data pasien ibu tidak ditemukan');
      if (m.status === 'MERGED') throw problem(400, 'PAT-400-MOTHER', 'Data pasien ibu sudah digabung; pilih data tujuan penggabungan');
    }
  }

  // ---------------------------------------------------------------- pembatasan pemrosesan (OD-068)
  @RequirePermission('patient.update') @BodySchema(RestrictionBody) @Post(':id/restriction') @HttpCode(200)
  async restrict(@Param('id') id: string, @Body() b: z.infer<typeof RestrictionBody>) {
    assertId(id, ...NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const [cur] = await rows<{ processing_restricted: boolean }>(tx, sql`select processing_restricted from patient where id = ${id} for update`);
      if (!cur) throw problem(404, ...NOT_FOUND);
      if (cur.processing_restricted !== b.restricted) {
        await tx.execute(sql`update patient set processing_restricted = ${b.restricted},
                               restriction_reason = ${b.restricted ? b.reason : null}, restricted_at = ${b.restricted ? sql`now()` : null},
                               updated_by = ${ctx().userId} where id = ${id}`);
        await audit(tx, b.restricted ? 'PATIENT_RESTRICTION_SET' : 'PATIENT_RESTRICTION_CLEARED', 'patient', id, id, { reason: b.reason });
      }
      return this.detail(tx, id);
    });
  }

  // ---------------------------------------------------------------- penjamin (REG-FR-007)
  @RequirePermission('patient.update') @BodySchema(CoverageBody) @Post(':id/coverages') @HttpCode(201)
  async addCoverage(@Param('id') id: string, @Body() b: z.infer<typeof CoverageBody>) {
    assertId(id, ...NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      await this.assertActivePatient(tx, id);
      await this.assertPayer(tx, b.payerId);
      const cid = await this.insertCoverage(tx, id, b);
      const [c] = await rows<CoverageRow>(tx, sql`${COVERAGE_SELECT} where c.id = ${cid}`);
      const dto = coverageDto(c);
      await audit(tx, 'PATIENT_COVERAGE_ADDED', 'patient_coverage', cid, id, { after: dto });
      return dto;
    });
  }

  @RequirePermission('patient.update') @BodySchema(CoveragePatch) @Put(':id/coverages/:coverageId')
  async updateCoverage(@Param('id') id: string, @Param('coverageId') coverageId: string, @Body() b: z.infer<typeof CoveragePatch>,
                       @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    assertId(id, ...NOT_FOUND);
    assertId(coverageId, 'PAT-404-COVERAGE', 'Penjamin pasien tidak ditemukan');
    const v = ifMatchVersion(ifMatch, 'penjamin');
    const out = await this.db.withTenantTx(async (tx) => {
      const [cur] = await rows<CoverageRow>(tx, sql`${COVERAGE_SELECT} where c.id = ${coverageId} and c.patient_id = ${id} for update of c`);
      if (!cur) throw problem(404, 'PAT-404-COVERAGE', 'Penjamin pasien tidak ditemukan');
      assertVersion(cur.version, v, 'Data penjamin');
      const before = coverageDto(cur);
      const n = merge(before, b);
      if (n.validFrom && n.validTo && n.validTo < n.validFrom) throw problem(400, 'PAT-400-PERIOD', 'Tanggal akhir sebelum tanggal mulai');
      await tx.execute(sql`update patient_coverage set member_no = ${n.memberNo}, plan_name = ${n.planName}, employee_no = ${n.employeeNo},
                             bpjs_faskes_code = ${n.bpjsFaskesCode}, valid_from = ${n.validFrom}::date, valid_to = ${n.validTo}::date,
                             is_active = ${n.isActive}, updated_by = ${ctx().userId} where id = ${coverageId}`);
      const [c] = await rows<CoverageRow>(tx, sql`${COVERAGE_SELECT} where c.id = ${coverageId}`);
      const after = coverageDto(c);
      await auditChange(tx, 'PATIENT_COVERAGE_UPDATED', 'patient_coverage', coverageId, before, after);
      return after;
    });
    res.setHeader('ETag', `"${out.version}"`);
    return out;
  }

  private async assertPayer(tx: Tx, payerId: string) {
    const [p] = await rows<{ is_active: boolean }>(tx, sql`select is_active from payer where id = ${payerId}`);
    if (!p) throw problem(400, 'PAT-400-PAYER', 'Penjamin tidak dikenal');
    if (!p.is_active) throw problem(400, 'PAT-400-PAYER', 'Penjamin tidak aktif');
  }

  private async insertCoverage(tx: Tx, patientId: string, c: z.infer<typeof CoverageBody>) {
    if (c.validFrom && c.validTo && c.validTo < c.validFrom) throw problem(400, 'PAT-400-PERIOD', 'Tanggal akhir penjamin sebelum tanggal mulai');
    const [{ id }] = await rows<{ id: string }>(tx, sql`
      insert into patient_coverage(tenant_id, patient_id, payer_id, member_no, plan_name, employee_no, bpjs_faskes_code, valid_from, valid_to, updated_by)
      values (app.current_tenant_id(), ${patientId}, ${c.payerId}, ${c.memberNo ?? null}, ${c.planName ?? null}, ${c.employeeNo ?? null},
              ${c.bpjsFaskesCode ?? null}, ${c.validFrom ?? null}::date, ${c.validTo ?? null}::date, ${ctx().userId})
      returning id`);
    return id;
  }

  private async assertActivePatient(tx: Tx, id: string) {
    const [p] = await rows<{ status: string }>(tx, sql`select status from patient where id = ${id}`);
    if (!p) throw problem(404, ...NOT_FOUND);
    if (p.status === 'MERGED') throw problem(409, 'PAT-409-MERGED', 'Pasien ini sudah digabung ke pasien lain');
  }

  // ---------------------------------------------------------------- consent (REG-FR-008)
  @RequirePermission('patient.update') @BodySchema(ConsentBody) @Post(':id/consents') @HttpCode(201)
  async recordConsent(@Param('id') id: string, @Body() b: z.infer<typeof ConsentBody>) {
    assertId(id, ...NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      await this.assertActivePatient(tx, id);
      const [doc] = await rows<{ consent_type: string; version: string }>(tx, sql`
        select consent_type, version from consent_document where id = ${b.consentDocumentId}`);
      if (!doc) throw problem(400, 'PAT-400-CONSENT-DOC', 'Dokumen consent tidak dikenal');
      const [{ cid, recorded_at }] = await rows<{ cid: string; recorded_at: string }>(tx, sql`
        insert into patient_consent(tenant_id, patient_id, consent_document_id, granted, signed_by_name, signed_by_relation, recorded_by)
        values (app.current_tenant_id(), ${id}, ${b.consentDocumentId}, ${b.granted}, ${b.signedByName ?? null}, ${b.signedByRelation ?? null}, ${ctx().userId})
        returning id as cid, recorded_at`);
      await audit(tx, 'PATIENT_CONSENT_RECORDED', 'patient_consent', cid, id,
        { consentType: doc.consent_type, version: doc.version, granted: b.granted, signedByRelation: b.signedByRelation ?? null });
      return { id: cid, consentType: doc.consent_type, version: doc.version, granted: b.granted, recordedAt: recorded_at };
    });
  }

  /** Pencabutan tidak menghapus catatan: revoked_at diisi (riwayat consent tetap utuh). */
  @RequirePermission('patient.update') @BodySchema(z.object({ reason: z.string().trim().min(5).max(500) }).strict())
  @Post(':id/consents/:consentId/revoke') @HttpCode(200)
  async revokeConsent(@Param('id') id: string, @Param('consentId') consentId: string, @Body() b: { reason: string }) {
    assertId(id, ...NOT_FOUND);
    assertId(consentId, 'PAT-404-CONSENT', 'Consent tidak ditemukan');
    return this.db.withTenantTx(async (tx) => {
      const [c] = await rows<{ revoked_at: string | null }>(tx, sql`
        select revoked_at from patient_consent where id = ${consentId} and patient_id = ${id} for update`);
      if (!c) throw problem(404, 'PAT-404-CONSENT', 'Consent tidak ditemukan');
      if (c.revoked_at) throw problem(409, 'PAT-409-REVOKED', 'Consent ini sudah dicabut');
      await tx.execute(sql`update patient_consent set revoked_at = now() where id = ${consentId}`);
      await audit(tx, 'PATIENT_CONSENT_REVOKED', 'patient_consent', consentId, id, { reason: b.reason });
      return this.detail(tx, id);
    });
  }

  // ---------------------------------------------------------------- gabung (REG-FR-005)
  /**
   * Sumber ditandai MERGED + merged_into_id (tidak dihapus; kunjungan & RM lama tetap pada data sumber dan ditampilkan
   * bersama data tujuan). NIK berbeda → ditolak (bukan orang yang sama). NIK sumber dipindah bila tujuan belum punya;
   * penjamin aktif & kontak yang belum ada disalin ke tujuan.
   */
  @RequirePermission('patient.merge') @BodySchema(MergeBody) @Post('merge') @HttpCode(200)
  async merge(@Body() b: z.infer<typeof MergeBody>) {
    return this.db.withTenantTx(async (tx) => {
      type R = { id: string; status: string; nik_hash: string | null; nik_encrypted: Buffer | null; nik_masked: string | null; version: number };
      const locked = await rows<R>(tx, sql`
        select id, status, nik_hash, nik_encrypted, nik_masked, version from patient
         where id in (${b.sourcePatientId}, ${b.targetPatientId}) order by id for update`);
      const src = locked.find((r) => r.id === b.sourcePatientId), dst = locked.find((r) => r.id === b.targetPatientId);
      if (!src || !dst) throw problem(404, ...NOT_FOUND);
      if (src.status === 'MERGED' || dst.status === 'MERGED') throw problem(409, 'PAT-409-MERGED', 'Salah satu pasien sudah digabung sebelumnya');
      if (src.nik_hash && dst.nik_hash && src.nik_hash !== dst.nik_hash) {
        throw problem(409, 'PAT-409-MERGE-NIK', 'NIK kedua pasien berbeda — bukan orang yang sama, tidak dapat digabung');
      }
      await tx.execute(sql`update patient set status = 'MERGED', merged_into_id = ${dst.id}, merged_at = now(), merge_reason = ${b.reason},
                             updated_by = ${ctx().userId} where id = ${src.id}`);
      if (src.nik_hash && !dst.nik_hash) {
        await tx.execute(sql`update patient set identity_type = 'NIK', nik_encrypted = ${src.nik_encrypted}, nik_hash = ${src.nik_hash},
                               nik_masked = ${src.nik_masked}, identity_value_encrypted = null, identity_value_hash = null,
                               identity_value_masked = null, ihs_status = 'PENDING', updated_by = ${ctx().userId} where id = ${dst.id}`);
      }
      await tx.execute(sql`
        insert into patient_coverage(tenant_id, patient_id, payer_id, member_no, plan_name, employee_no, bpjs_faskes_code, valid_from, valid_to, updated_by)
        select tenant_id, ${dst.id}, payer_id, member_no, plan_name, employee_no, bpjs_faskes_code, valid_from, valid_to, ${ctx().userId}
          from patient_coverage s
         where s.patient_id = ${src.id} and s.is_active
           and not exists (select 1 from patient_coverage t where t.patient_id = ${dst.id} and t.payer_id = s.payer_id
                             and t.member_no is not distinct from s.member_no)`);
      await tx.execute(sql`
        insert into patient_contact(tenant_id, patient_id, relation, full_name, phone, is_guardian)
        select tenant_id, ${dst.id}, relation, full_name, phone, is_guardian from patient_contact s
         where s.patient_id = ${src.id}
           and not exists (select 1 from patient_contact t where t.patient_id = ${dst.id} and t.phone = s.phone
                             and lower(t.full_name) = lower(s.full_name))`);
      const summary = { sourcePatientId: src.id, targetPatientId: dst.id, reason: b.reason, nikMoved: !!(src.nik_hash && !dst.nik_hash) };
      await audit(tx, 'PATIENT_MERGED', 'patient', src.id, src.id, summary);
      await audit(tx, 'PATIENT_MERGED_INTO', 'patient', dst.id, dst.id, summary);
      return this.detail(tx, dst.id);
    });
  }
}
