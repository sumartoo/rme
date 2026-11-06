import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { type AppConfig, BodySchema, CONFIG, RequirePermission, assertId, ctx, problem, problemWith } from '@clinicrme/shared';
import { Db, type Tx, audit, rows } from '@clinicrme/db';
import { ENC_NOT_FOUND, addendaOf, diagnosesOf, noteOf, proceduresOf, vitalsOf } from './chart.repo';
import { ISO, addendumHash, noteContentHash, serverNow } from './integrity';
import { REAUTH_MESSAGE, ReauthFields, hasReauth, reauthenticate } from './reauth';

export const SignBody = z.object({ ...ReauthFields, substituteReason: z.string().trim().min(5).max(500).optional() })
  .strict().refine(hasReauth, REAUTH_MESSAGE);
export const AddendumBody = z.object({ ...ReauthFields, reason: z.string().trim().min(5).max(500), content: z.string().trim().min(1).max(10_000) })
  .strict().refine(hasReauth, REAUTH_MESSAGE);
const NOTE_404 = ['CLN-404-NOTE', 'Catatan klinis tidak ditemukan'] as const;
const DOCTOR_TYPES = ['DOKTER', 'DOKTER_GIGI', 'DOKTER_SPESIALIS'];

export interface Signer { practitioner_id: string; full_name: string; practitioner_type: string; is_active: boolean; sip_number: string | null; sip_ok: boolean }
/** Akun yang login harus tertaut ke dokter/dokter gigi/spesialis aktif dengan SIP masih berlaku (IAM-FR-016). */
export async function signerOf(tx: Tx, tz: string): Promise<Signer> {
  const [s] = await rows<Signer>(tx, sql`
    select p.id as practitioner_id, p.full_name, p.practitioner_type, p.is_active, p.sip_number,
           coalesce(p.sip_valid_until >= (now() at time zone ${tz})::date, false) as sip_ok
      from app_user u join practitioner p on p.id = u.practitioner_id where u.id = ${ctx().userId}`);
  if (!s) throw problem(409, 'CLN-409-NO-PRACTITIONER', 'Akun Anda belum tertaut ke data tenaga kesehatan');
  if (!s.is_active || !DOCTOR_TYPES.includes(s.practitioner_type)) throw problem(403, 'CLN-403-SIGNER', 'Hanya dokter aktif yang dapat mengesahkan rekam medis');
  if (!s.sip_ok) throw problem(403, 'CLN-403-SIP', 'SIP Anda tidak tercatat atau sudah tidak berlaku. Hubungi admin klinik.');
  return s;
}

/**
 * Pengesahan rekam medis (CLN-FR-017, 018; OD-034, OD-092) dan addendum (CLN-FR-019). Pengesahan = tanda tangan
 * elektronik TIDAK tersertifikasi: dokter yang login mengonfirmasi ulang dengan kata sandi atau kode TOTP; sistem
 * menyimpan penandatangan, SIP, waktu server, dan hash SHA-256 isi rekam medis. Setelah disahkan, catatan & isinya
 * terkunci (trigger DB); koreksi hanya lewat addendum yang juga dikonfirmasi ulang dan di-hash.
 */
@Controller('api/v1')
export class SignController {
  constructor(private readonly db: Db, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  @RequirePermission('clinical.note.sign') @BodySchema(SignBody) @Post('encounters/:id/sign') @HttpCode(200)
  async sign(@Param('id') id: string, @Body() b: z.infer<typeof SignBody>) {
    assertId(id, ...ENC_NOT_FOUND);
    // Prasyarat diperiksa sebelum meminta konfirmasi (gagal cepat tanpa mencatat percobaan konfirmasi)
    await this.db.withTenantTx((tx) => this.precheck(tx, id, b));
    const method = await reauthenticate(this.db, this.cfg, b);
    return this.db.withTenantTx(async (tx) => {
      const { e, note, signer } = await this.precheck(tx, id, b, true);
      const signedAt = await serverNow(tx);
      const hash = await noteContentHash(tx, note.id, { practitionerId: signer.practitioner_id, userId: ctx().userId!, sip: signer.sip_number, signedAt });
      await tx.execute(sql`
        update clinical_note set status = 'SIGNED', signed_by = ${signer.practitioner_id}, signed_at = ${signedAt}::timestamptz, content_hash = ${hash},
               signer_user_id = ${ctx().userId}, signer_sip = ${signer.sip_number}, sign_method = ${method},
               substitute_reason = ${signer.practitioner_id === e.practitioner_id ? null : b.substituteReason ?? null}
         where id = ${note.id}`);
      await audit(tx, 'CLINICAL_NOTE_SIGNED', 'clinical_note', note.id, e.patient_id,
        { encounterId: id, method, substitute: signer.practitioner_id !== e.practitioner_id, contentHash: hash });
      return { noteId: note.id, status: 'SIGNED', signedAt, signedByName: signer.full_name, contentHash: hash };
    });
  }

  private async precheck(tx: Tx, id: string, b: z.infer<typeof SignBody>, lock = false) {
    const [e] = await rows<{ status: string; patient_id: string; branch_id: string; practitioner_id: string; timezone: string }>(tx, sql`
      select e.status, e.patient_id, e.branch_id, e.practitioner_id, br.timezone
        from encounter e join branch br on br.id = e.branch_id where e.id = ${id} ${lock ? sql`for update of e` : sql``}`);
    if (!e) throw problem(404, ...ENC_NOT_FOUND);
    const [note] = await rows<{ id: string; status: string; subjective: string | null; objective: string | null; assessment: string | null; plan: string | null }>(tx, sql`
      select id, status, subjective, objective, assessment, plan from clinical_note where encounter_id = ${id} ${lock ? sql`for update` : sql``}`);
    if (note?.status === 'SIGNED') throw problem(409, 'CLN-409-SIGNED', 'Rekam medis sudah disahkan');
    if (e.status !== 'IN_CONSULTATION') throw problem(409, 'CLN-409-NOT-IN-CONSULTATION', 'Pengesahan dilakukan saat pasien sedang diperiksa');
    const signer = await signerOf(tx, e.timezone);
    if (signer.practitioner_id !== e.practitioner_id) {
      // OD-092: dokter pengganti = dokter lain yang berjadwal praktik di cabang yang sama, dengan alasan tercatat
      const [onDuty] = await rows(tx, sql`select 1 from practitioner_schedule where practitioner_id = ${signer.practitioner_id}
                                           and branch_id = ${e.branch_id} and is_active limit 1`);
      if (!onDuty) throw problem(403, 'CLN-403-SUBSTITUTE', 'Hanya dokter kunjungan atau dokter yang bertugas di cabang ini yang dapat mengesahkan');
      if (!b.substituteReason) throw problemWith(400, 'CLN-400-SUBSTITUTE-REASON', 'Alasan wajib diisi bila mengesahkan sebagai dokter pengganti', { errors: [{ field: 'substituteReason', message: 'Wajib diisi' }] });
    }
    // CLN-FR-018: SOAP lengkap & satu diagnosis primer
    const missing: string[] = [];
    for (const k of ['subjective', 'objective', 'assessment', 'plan'] as const) if (!note?.[k]?.trim()) missing.push(k);
    const [dx] = await rows(tx, sql`select 1 from condition_dx where encounter_id = ${id} and rank = 'PRIMER'`);
    if (!dx) missing.push('primaryDiagnosis');
    if (missing.length) throw problemWith(422, 'CLN-422-INCOMPLETE', 'Rekam medis belum lengkap untuk disahkan', { missing });
    return { e, note: note!, signer };
  }

  @RequirePermission('clinical.note.addendum') @BodySchema(AddendumBody) @Post('clinical-notes/:noteId/addenda') @HttpCode(201)
  async addendum(@Param('noteId') noteId: string, @Body() b: z.infer<typeof AddendumBody>) {
    assertId(noteId, ...NOTE_404);
    const pre = async (tx: Tx) => {
      const [n] = await rows<{ status: string; content_hash: string | null; patient_id: string; timezone: string; encounter_id: string }>(tx, sql`
        select n.status, n.content_hash, e.patient_id, br.timezone, n.encounter_id
          from clinical_note n join encounter e on e.id = n.encounter_id join branch br on br.id = e.branch_id where n.id = ${noteId}`);
      if (!n) throw problem(404, ...NOTE_404);
      if (n.status !== 'SIGNED') throw problem(409, 'CLN-409-NOT-SIGNED', 'Catatan belum disahkan; ubah draftnya secara langsung');
      return { n, signer: await signerOf(tx, n.timezone) };
    };
    await this.db.withTenantTx(pre);
    const method = await reauthenticate(this.db, this.cfg, b);
    return this.db.withTenantTx(async (tx) => {
      const { n, signer } = await pre(tx);
      const signedAt = await serverNow(tx);
      const hash = addendumHash({ noteHash: n.content_hash!, noteId, reason: b.reason, content: b.content, authorId: signer.practitioner_id,
        authorUserId: ctx().userId!, signedAt });
      const [{ id }] = await rows<{ id: string }>(tx, sql`
        insert into clinical_addendum(tenant_id, note_id, reason, content, author_id, signed_at, content_hash, author_user_id, author_sip, sign_method)
        values (app.current_tenant_id(), ${noteId}, ${b.reason}, ${b.content}, ${signer.practitioner_id}, ${signedAt}::timestamptz, ${hash},
                ${ctx().userId}, ${signer.sip_number}, ${method}) returning id`);
      await audit(tx, 'CLINICAL_ADDENDUM_SIGNED', 'clinical_addendum', id, n.patient_id, { noteId, encounterId: n.encounter_id, method, contentHash: hash });
      return (await addendaOf(tx, noteId)).find((a) => a.id === id);
    });
  }

  /** Hitung ulang hash catatan & addendum dan bandingkan dengan yang tersimpan saat pengesahan (deteksi perubahan). */
  @RequirePermission('clinical.record.read') @Get('clinical-notes/:noteId/verify')
  async verify(@Param('noteId') noteId: string) {
    assertId(noteId, ...NOTE_404);
    return this.db.withTenantTx(async (tx) => {
      const [n] = await rows<{ status: string; content_hash: string | null; signed_by: string; signer_user_id: string; signer_sip: string | null;
                               signed_at_iso: string; patient_id: string }>(tx, sql`
        select n.status, n.content_hash, n.signed_by, n.signer_user_id, n.signer_sip, ${ISO(sql`n.signed_at`)} as signed_at_iso, e.patient_id
          from clinical_note n join encounter e on e.id = n.encounter_id where n.id = ${noteId}`);
      if (!n) throw problem(404, ...NOTE_404);
      if (n.status !== 'SIGNED') throw problem(409, 'CLN-409-NOT-SIGNED', 'Catatan belum disahkan');
      const recomputed = await noteContentHash(tx, noteId, { practitionerId: n.signed_by, userId: n.signer_user_id, sip: n.signer_sip, signedAt: n.signed_at_iso });
      const adds = await rows<{ id: string; reason: string; content: string; author_id: string; author_user_id: string; signed_at_iso: string; content_hash: string }>(tx, sql`
        select id, reason, content, author_id, author_user_id, ${ISO(sql`signed_at`)} as signed_at_iso, content_hash
          from clinical_addendum where note_id = ${noteId} order by signed_at, id`);
      await audit(tx, 'CLINICAL_NOTE_VERIFIED', 'clinical_note', noteId, n.patient_id);
      return {
        noteId, contentHash: n.content_hash, valid: recomputed === n.content_hash,
        addenda: adds.map((a) => ({ id: a.id, valid: a.content_hash === addendumHash({ noteHash: n.content_hash!, noteId, reason: a.reason, content: a.content,
          authorId: a.author_id, authorUserId: a.author_user_id, signedAt: a.signed_at_iso }) })),
      };
    });
  }

  /** Riwayat rekam medis pasien lintas kunjungan (terbaru dulu); dibuka = tercatat di audit dengan patient_id. */
  @RequirePermission('clinical.record.read') @Get('patients/:id/medical-records')
  async history(@Param('id') id: string, @Query() q: Record<string, string | undefined>) {
    assertId(id, 'PAT-404', 'Pasien tidak ditemukan');
    const P = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10), cursor: z.string().regex(/^\d{1,6}$/).optional() }).safeParse(q);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const offset = Number(P.data.cursor ?? 0), limit = P.data.limit;
    return this.db.withTenantTx(async (tx) => {
      const [p] = await rows(tx, sql`select 1 from patient where id = ${id}`);
      if (!p) throw problem(404, 'PAT-404', 'Pasien tidak ditemukan');
      const enc = await rows<{ id: string; encounter_no: string; local_date: string; unit_name: string; practitioner_name: string; status: string }>(tx, sql`
        select e.id, e.encounter_no, to_char(e.arrived_at at time zone b.timezone, 'YYYY-MM-DD') as local_date, u.name as unit_name,
               pr.full_name as practitioner_name, e.status
          from encounter e join clinical_note n on n.encounter_id = e.id join branch b on b.id = e.branch_id
          join service_unit u on u.id = e.unit_id join practitioner pr on pr.id = e.practitioner_id
         where e.patient_id = ${id} and e.status <> 'CANCELLED'
         order by e.arrived_at desc nulls last, e.id limit ${limit + 1} offset ${offset}`);
      const data = [];
      for (const e of enc.slice(0, limit)) {
        data.push({ encounterId: e.id, encounterNo: e.encounter_no, localDate: e.local_date, unitName: e.unit_name, practitionerName: e.practitioner_name,
          status: e.status, note: await noteOf(tx, e.id), diagnoses: await diagnosesOf(tx, e.id), procedures: await proceduresOf(tx, e.id),
          vitals: (await vitalsOf(tx, e.id))[0] ?? null });
      }
      await audit(tx, 'MEDICAL_RECORD_HISTORY_READ', 'patient', id, id, { count: data.length });
      return { data, page: { hasMore: enc.length > limit, nextCursor: enc.length > limit ? String(offset + limit) : null } };
    });
  }
}
