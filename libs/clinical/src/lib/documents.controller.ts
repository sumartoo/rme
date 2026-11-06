import { Body, Controller, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { BodySchema, IsoDate, RequirePermission, assertId, ctx, optText, problem, sha256Hex } from '@clinicrme/shared';
import { Db, type Tx, audit, rows } from '@clinicrme/db';
import { type ObjectStorage, STORAGE } from '@clinicrme/storage';
import { ENC_NOT_FOUND, ageText, diagnosesOf, noteOf, proceduresOf, vitalsOf } from './chart.repo';
import { stableStringify } from './integrity';
import { type Content, fileOf, renderPdf, storeFile } from './pdf';
import { prescriptionOf } from './prescription.repo';
import { signerOf } from './sign.controller';

export const DocumentBody = z.discriminatedUnion('docType', [
  z.object({ docType: z.literal('RESUME') }).strict(),
  z.object({ docType: z.literal('SURAT_SAKIT'), restDays: z.number().int().min(1).max(30), startDate: IsoDate.optional(),
    includeDiagnosis: z.boolean().default(false) }).strict(),
  z.object({ docType: z.literal('SURAT_SEHAT'), purpose: z.string().trim().min(3).max(200), notes: optText(500) }).strict(),
]);
export const ReferralBody = z.object({
  destination: z.string().trim().min(3).max(200), destinationUnit: optText(200), reason: z.string().trim().min(5).max(1000),
  clinicalSummary: optText(2000),
}).strict();
const DOC_404 = ['CLN-404-DOCUMENT', 'Dokumen tidak ditemukan'] as const;
/** OD-093: `{KODE}/{YYYY}/{MM}/{SEQ:4}`, urutan per jenis per bulan per klinik. */
const NUMBERING = { RESUME: 'RES', SURAT_SEHAT: 'SKH', SURAT_SAKIT: 'SKS', RUJUKAN: 'RJK' } as const;
const TITLE = { RESUME: 'RESUME MEDIS RAWAT JALAN', SURAT_SEHAT: 'SURAT KETERANGAN SEHAT', SURAT_SAKIT: 'SURAT KETERANGAN SAKIT', RUJUKAN: 'SURAT RUJUKAN' } as const;
type DocType = keyof typeof NUMBERING;
const SEX = { L: 'Laki-laki', P: 'Perempuan', TIDAK_DIKETAHUI: 'Tidak diketahui' } as Record<string, string>;
const VITAL = { SYSTOLIC: 'TD sistolik', DIASTOLIC: 'TD diastolik', HEART_RATE: 'Nadi', RESP_RATE: 'Napas', TEMPERATURE: 'Suhu', SPO2: 'SpO2',
  WEIGHT: 'BB', HEIGHT: 'TB', BMI: 'IMT', PAIN_SCALE: 'Nyeri' } as Record<string, string>;
const UNIT = { SYSTOLIC: 'mmHg', DIASTOLIC: 'mmHg', HEART_RATE: 'x/mnt', RESP_RATE: 'x/mnt', TEMPERATURE: '°C', SPO2: '%', WEIGHT: 'kg', HEIGHT: 'cm',
  BMI: 'kg/m²', PAIN_SCALE: '/10' } as Record<string, string>;
const fmtDate = (d: string) => new Intl.DateTimeFormat('id-ID', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

interface Ctx {
  encounter_id: string; encounter_no: string; status: string; local_date: string; unit_name: string; timezone: string; today: string;
  patient_id: string; mrn: string; full_name: string; birth_date: string; sex: string; address: string | null;
  clinic: string; letterhead: Record<string, string> | null; note_status: string | null;
}

/**
 * Dokumen medis PDF (CLN-FR-020–022; OD-093 / DEC-038): resume medis, surat keterangan sakit/sehat, surat rujukan.
 * Hanya dari rekam medis yang sudah disahkan; diterbitkan dokter ber-SIP. PDF memuat kop klinik, nomor surat, nama &
 * SIP dokter, waktu terbit, dan kode verifikasi (hash isi) — tanda tangan elektronik tidak tersertifikasi (OD-034).
 * Berkas & metadata tidak dapat diubah; setiap unduhan tercatat di audit.
 */
@Controller('api/v1')
export class DocumentsController {
  constructor(private readonly db: Db, @Inject(STORAGE) private readonly storage: ObjectStorage) {}

  @RequirePermission('clinical.document.issue') @BodySchema(DocumentBody) @Post('encounters/:id/documents') @HttpCode(201)
  async issue(@Param('id') id: string, @Body() b: z.infer<typeof DocumentBody>) {
    assertId(id, ...ENC_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const c = await this.context(tx, id);
      const extra: Record<string, unknown> = {};
      if (b.docType === 'SURAT_SAKIT') {
        const start = b.startDate ?? c.today;
        Object.assign(extra, { restDays: b.restDays, startDate: start, endDate: addDays(start, b.restDays - 1),
          diagnoses: b.includeDiagnosis ? (await diagnosesOf(tx, id)).map((d) => `${d.code} ${d.display}`) : null });
      }
      if (b.docType === 'SURAT_SEHAT') Object.assign(extra, { purpose: b.purpose, notes: b.notes ?? null, vitals: (await vitalsOf(tx, id))[0]?.values ?? {} });
      return this.create(tx, c, b.docType, extra);
    });
  }

  @RequirePermission('clinical.document.issue') @BodySchema(ReferralBody) @Post('encounters/:id/referrals') @HttpCode(201)
  async referral(@Param('id') id: string, @Body() b: z.infer<typeof ReferralBody>) {
    assertId(id, ...ENC_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const c = await this.context(tx, id);
      const d = await this.create(tx, c, 'RUJUKAN', { destination: b.destination, destinationUnit: b.destinationUnit ?? null, reason: b.reason,
        clinicalSummary: b.clinicalSummary ?? null });
      await tx.execute(sql`insert into referral(tenant_id, encounter_id, destination, destination_unit, reason, clinical_summary, document_id, created_by)
        values (app.current_tenant_id(), ${id}, ${b.destination}, ${b.destinationUnit ?? null}, ${b.reason}, ${b.clinicalSummary ?? null}, ${d.id}, ${ctx().userId})`);
      return d;
    });
  }

  @RequirePermission('clinical.record.read') @Get('encounters/:id/documents')
  async list(@Param('id') id: string) {
    assertId(id, ...ENC_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => (await rows<DocRow>(tx, sql`${DOC} where d.encounter_id = ${id} order by d.issued_at desc`)).map(docDto));
  }

  @RequirePermission('clinical.record.read') @Get('medical-documents/:id')
  async get(@Param('id') id: string) {
    assertId(id, ...DOC_404);
    return this.db.withTenantTx(async (tx) => {
      const [d] = await rows<DocRow>(tx, sql`${DOC} where d.id = ${id}`);
      if (!d) throw problem(404, ...DOC_404);
      return docDto(d);
    });
  }

  @RequirePermission('clinical.record.read') @Get('medical-documents/:id/file')
  async file(@Param('id') id: string, @Res() res: Response) {
    assertId(id, ...DOC_404);
    const { f, no } = await this.db.withTenantTx(async (tx) => {
      const [d] = await rows<{ file_id: string; patient_id: string; document_no: string }>(tx, sql`
        select file_id, patient_id, document_no from medical_document where id = ${id}`);
      if (!d) throw problem(404, ...DOC_404);
      await audit(tx, 'MEDICAL_DOCUMENT_READ', 'medical_document', id, d.patient_id);
      return { f: await fileOf(tx, d.file_id), no: d.document_no };
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${no.replace(/[^A-Za-z0-9-]/g, '-')}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    (await this.storage.openRead('files', f.object_path)).pipe(res);
  }

  private async context(tx: Tx, id: string): Promise<Ctx> {
    const [c] = await rows<Ctx>(tx, sql`
      select e.id as encounter_id, e.encounter_no, e.status, to_char(e.arrived_at at time zone b.timezone, 'YYYY-MM-DD') as local_date,
             u.name as unit_name, b.timezone, to_char(now() at time zone b.timezone, 'YYYY-MM-DD') as today,
             p.id as patient_id, p.mrn, p.full_name, to_char(p.birth_date, 'YYYY-MM-DD') as birth_date, p.sex, p.address,
             t.display_name as clinic, t.letterhead, n.status as note_status
        from encounter e join branch b on b.id = e.branch_id join service_unit u on u.id = e.unit_id join patient p on p.id = e.patient_id
        join tenant t on t.id = e.tenant_id left join clinical_note n on n.encounter_id = e.id
       where e.id = ${id}`);
    if (!c) throw problem(404, ...ENC_NOT_FOUND);
    if (c.status === 'CANCELLED') throw problem(409, 'CLN-409-ENCOUNTER-CLOSED', 'Kunjungan dibatalkan');
    if (c.note_status !== 'SIGNED') throw problem(409, 'CLN-409-NOT-SIGNED', 'Dokumen hanya dapat diterbitkan dari rekam medis yang sudah disahkan');
    return c;
  }

  private async create(tx: Tx, c: Ctx, docType: DocType, extra: Record<string, unknown>) {
    const signer = await signerOf(tx, c.timezone);
    const [{ no }] = await rows<{ no: string }>(tx, sql`
      select app.next_document_number(${docType === 'RUJUKAN' ? 'REFERRAL' : 'LETTER'},
                                      ${docType} || ':' || to_char(now() at time zone ${c.timezone}, 'YYYY-MM'),
                                      ${`${NUMBERING[docType]}/{YYYY}/{MM}/{SEQ:4}`}) as no`);
    const [{ issued_at }] = await rows<{ issued_at: string }>(tx, sql`select now() as issued_at`);
    const issuedAt = new Date(issued_at);
    const data: Record<string, unknown> = {
      v: 1, docType, documentNo: no, issuedAt: issuedAt.toISOString(),
      clinic: { name: c.letterhead?.['name'] || c.clinic, address: c.letterhead?.['address'] ?? null, phone: c.letterhead?.['phone'] ?? null,
        license: c.letterhead?.['license'] ?? null },
      patient: { id: c.patient_id, name: c.full_name, mrn: c.mrn, birthDate: c.birth_date, age: ageText(c.birth_date, new Date(`${c.local_date}T12:00:00Z`)),
        sex: SEX[c.sex] ?? c.sex, address: c.address },
      encounter: { id: c.encounter_id, no: c.encounter_no, date: c.local_date, unit: c.unit_name },
      doctor: { practitionerId: signer.practitioner_id, name: signer.full_name, sip: signer.sip_number },
      ...extra,
    };
    if (docType === 'RESUME' || docType === 'RUJUKAN') {
      const note = await noteOf(tx, c.encounter_id);
      const rx = await prescriptionOf(tx, c.encounter_id);
      Object.assign(data, {
        soap: { subjective: note?.subjective, objective: note?.objective, assessment: note?.assessment, plan: note?.plan },
        vitals: (await vitalsOf(tx, c.encounter_id))[0]?.values ?? {},
        diagnoses: (await diagnosesOf(tx, c.encounter_id)).map((d) => ({ code: d.code, display: d.display, rank: d.rank })),
        procedures: (await proceduresOf(tx, c.encounter_id)).map((p) => ({ name: p.serviceName, code: p.code })),
        medications: (rx?.items ?? []).map((i) => `${i.kind === 'DRUG' ? i.drugName : `${i.compoundName} (racikan)`} — ${i.doseQty} ${i.uomName} ${i.frequency}`),
      });
    }
    const hash = sha256Hex(stableStringify(data));
    const pdf = await renderPdf(layout(data, hash), { title: `${TITLE[docType]} ${no}`, issuedAt });
    const f = await storeFile(tx, this.storage, { category: 'MEDICAL_DOCUMENT', patientId: c.patient_id, buffer: pdf, contentType: 'application/pdf', ext: 'pdf' });
    const [{ id }] = await rows<{ id: string }>(tx, sql`
      insert into medical_document(tenant_id, document_no, doc_type, encounter_id, patient_id, file_id, data, issued_by, issued_at, content_hash)
      values (app.current_tenant_id(), ${no}, ${docType}, ${c.encounter_id}, ${c.patient_id}, ${f.id}, ${JSON.stringify(data)}::jsonb, ${ctx().userId},
              ${issued_at}::timestamptz, ${hash}) returning id`);
    await audit(tx, 'MEDICAL_DOCUMENT_ISSUED', 'medical_document', id, c.patient_id, { docType, documentNo: no, encounterId: c.encounter_id });
    const [d] = await rows<DocRow>(tx, sql`${DOC} where d.id = ${id}`);
    return docDto(d);
  }
}

interface DocRow { id: string; document_no: string; doc_type: string; encounter_id: string; patient_id: string; issued_at: string; issued_by_name: string | null;
  content_hash: string; size_bytes: string; data: Record<string, unknown> }
const DOC = sql`select d.id, d.document_no, d.doc_type, d.encounter_id, d.patient_id, d.issued_at, u.full_name as issued_by_name, d.content_hash,
                       f.size_bytes::text, d.data
                  from medical_document d join stored_file f on f.id = d.file_id left join app_user u on u.id = d.issued_by`;
const docDto = (r: DocRow) => ({ id: r.id, documentNo: r.document_no, docType: r.doc_type, encounterId: r.encounter_id, patientId: r.patient_id,
  issuedAt: r.issued_at, issuedByName: r.issued_by_name, doctorName: (r.data['doctor'] as { name?: string } | undefined)?.name ?? null,
  verificationCode: verificationCode(r.content_hash), sizeBytes: Number(r.size_bytes) });
const verificationCode = (hash: string) => hash.slice(0, 12).toUpperCase().replace(/(.{4})(?=.)/g, '$1-');

/** Tata letak PDF per jenis dokumen (Bahasa Indonesia). Teks berlabel CONTOH untuk ditinjau klinik [REVIEW-MEDIS]. */
function layout(d: Record<string, any>, hash: string): Content[] {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const kv = (rowsKv: [string, unknown][]) => ({ table: { widths: [120, '*'], body: rowsKv.filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => [{ text: k, style: 'label' }, String(v)]) }, layout: 'noBorders', margin: [0, 2, 0, 6] });
  const section = (t: string) => ({ text: t, bold: true, margin: [0, 8, 0, 2] });
  const out: Content[] = [
    { text: d.clinic.name, style: 'clinic', alignment: 'center' },
    { text: [d.clinic.address, d.clinic.phone ? `Telp. ${d.clinic.phone}` : null, d.clinic.license ? `Izin: ${d.clinic.license}` : null].filter(Boolean).join(' · '),
      style: 'small', alignment: 'center' },
    { canvas: [{ type: 'line', x1: 0, y1: 4, x2: 499, y2: 4, lineWidth: 1 }] },
    { text: TITLE[d.docType as DocType], style: 'title' },
    { text: `Nomor: ${d.documentNo}`, alignment: 'center', margin: [0, 0, 0, 10] },
    kv([['Nama pasien', d.patient.name], ['No. RM', d.patient.mrn], ['Tanggal lahir / umur', `${fmtDate(d.patient.birthDate)} / ${d.patient.age}`],
      ['Jenis kelamin', d.patient.sex], ['Alamat', d.patient.address], ['Kunjungan', `${d.encounter.no} · ${fmtDate(d.encounter.date)} · ${d.encounter.unit}`]]),
  ];
  const vitals = (v: Record<string, number>) => Object.entries(v).map(([k, x]) => `${VITAL[k] ?? k} ${x} ${UNIT[k] ?? ''}`.trim()).join(' · ') || '—';
  if (d.docType === 'SURAT_SAKIT') {
    out.push({ text: `Yang bertanda tangan di bawah ini menerangkan bahwa pasien tersebut di atas telah diperiksa dan memerlukan istirahat karena sakit `
      + `selama ${d.restDays} hari, terhitung mulai ${fmtDate(d.startDate)} sampai dengan ${fmtDate(d.endDate)}.`, margin: [0, 6, 0, 6] });
    if (d.diagnoses?.length) out.push(kv([['Diagnosis', d.diagnoses.join('; ')]]));
    out.push({ text: 'Demikian surat keterangan ini dibuat untuk dipergunakan sebagaimana mestinya.' });
  } else if (d.docType === 'SURAT_SEHAT') {
    out.push({ text: 'Yang bertanda tangan di bawah ini menerangkan bahwa pada pemeriksaan tanggal tersebut di atas, pasien dalam keadaan SEHAT.', margin: [0, 6, 0, 6] },
      kv([['Hasil pemeriksaan', vitals(d.vitals)], ['Keperluan', d.purpose], ['Catatan', d.notes]]),
      { text: 'Demikian surat keterangan ini dibuat untuk dipergunakan sebagaimana mestinya.' });
  } else {
    if (d.docType === 'RUJUKAN') {
      out.push(kv([['Kepada', [d.destination, d.destinationUnit].filter(Boolean).join(' — ')], ['Alasan rujukan', d.reason], ['Ringkasan klinis', d.clinicalSummary]]));
    }
    out.push(section('Anamnesis & pemeriksaan'), kv([['Subjektif', d.soap.subjective], ['Objektif', d.soap.objective], ['Tanda vital', vitals(d.vitals)]]),
      section('Diagnosis'), { ul: d.diagnoses.length ? d.diagnoses.map((x: { code: string; display: string; rank: string }) => `${x.code} ${x.display}${x.rank === 'PRIMER' ? ' (primer)' : ''}`) : ['—'] },
      section('Tindakan'), { ul: d.procedures.length ? d.procedures.map((p: { name: string; code: string | null }) => `${p.name}${p.code ? ` (${p.code})` : ''}`) : ['—'] },
      section('Terapi / resep'), { ul: d.medications.length ? d.medications : ['—'] },
      section('Asesmen & rencana'), kv([['Asesmen', d.soap.assessment], ['Rencana', d.soap.plan]]));
  }
  const issued = new Intl.DateTimeFormat('id-ID', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(new Date(d.issuedAt));
  out.push({ margin: [260, 24, 0, 0], stack: [
    { text: `Diterbitkan ${issued} WIB` }, { text: 'Disahkan secara elektronik oleh', margin: [0, 6, 0, 0] },
    { text: d.doctor.name, bold: true }, { text: d.doctor.sip ? `SIP ${d.doctor.sip}` : '' },
  ] }, { text: `Kode verifikasi: ${verificationCode(hash)} · Tanda tangan elektronik tidak tersertifikasi (bukan PSrE). Dokumen dibuat oleh ClinicRME.`,
    style: 'small', margin: [0, 24, 0, 0] });
  return out;
}
