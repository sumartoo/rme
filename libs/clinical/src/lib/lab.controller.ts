import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { BodySchema, NoBody, RequirePermission, Uuid, assertId, ctx, optText, problem, problemWith } from '@clinicrme/shared';
import { Db, type Tx, audit, idempotent, rows } from '@clinicrme/db';
import { type ObjectStorage, STORAGE } from '@clinicrme/storage';
import { ENC_NOT_FOUND } from './chart.repo';
import { fileOf, storeFile } from './pdf';

const ORDER_404 = ['CLN-404-LAB', 'Order lab tidak ditemukan'] as const;
export const LabOrderBody = z.object({
  serviceItemIds: z.array(Uuid).min(1).max(30).refine((a) => new Set(a).size === a.length, 'Pemeriksaan tercantum dua kali'),
  clinicalInfo: optText(1000),
}).strict();
export const LabResultBody = z.object({
  results: z.array(z.object({
    labOrderItemId: Uuid.nullable().optional(), testName: z.string().trim().min(1).max(200), value: z.string().trim().min(1).max(200),
    unit: optText(50), referenceRange: optText(100), flag: z.enum(['N', 'L', 'H', 'LL', 'HH', 'A']).nullable().optional(), notes: optText(500),
  }).strict()).min(1).max(100),
}).strict();
const PdfBody = z.custom<Buffer>((b) => Buffer.isBuffer(b) && b.length > 0, 'Kirim berkas PDF sebagai body (Content-Type application/pdf)');

/**
 * Antarmuka konektor aplikasi lab (OD-059 / DEC-038). Vendor klinik pilot belum diketahui: tersedia konektor tiruan
 * `MOCK` untuk uji alur & `NONE` (tanpa integrasi — hasil diinput manual / unggah PDF, jalur utama MVP). Adapter
 * vendor nyata mengimplementasikan antarmuka yang sama.
 */
interface LabConnector { readonly code: string; send(order: { orderNo: string; tests: { code: string; name: string }[] }): { externalOrderId: string } }
const CONNECTORS: Record<string, LabConnector> = {
  MOCK: { code: 'MOCK', send: (o) => ({ externalOrderId: `MOCK-${o.orderNo}` }) },
};

interface OrderRow { id: string; order_no: string; encounter_id: string; status: string; lab_connector: string | null; external_order_id: string | null;
  clinical_info: string | null; ordered_at: string; ordered_by_name: string; cancel_reason: string | null; resulted_at: string | null; patient_id: string }
const ORDER = sql`select o.id, o.order_no, o.encounter_id, o.status, o.lab_connector, o.external_order_id, o.clinical_info, o.ordered_at,
                         p.full_name as ordered_by_name, o.cancel_reason, o.resulted_at, e.patient_id
                    from lab_order o join practitioner p on p.id = o.ordered_by join encounter e on e.id = o.encounter_id`;

async function ordersDto(tx: Tx, list: OrderRow[]) {
  if (!list.length) return [];
  const ids = `{${list.map((o) => o.id).join(',')}}`;
  const items = await rows<{ id: string; lab_order_id: string; service_item_id: string; code: string; name: string }>(tx, sql`
    select i.id, i.lab_order_id, i.service_item_id, s.code, s.name from lab_order_item i join service_item s on s.id = i.service_item_id
     where i.lab_order_id = any(${ids}::uuid[]) order by s.name`);
  const results = await rows<{ id: string; lab_order_id: string; lab_order_item_id: string | null; source: string; test_name: string | null; value_text: string | null;
                               unit: string | null; reference_range: string | null; flag: string | null; file_id: string | null; notes: string | null;
                               resulted_at: string; entered_by_name: string | null }>(tx, sql`
    select r.id, r.lab_order_id, r.lab_order_item_id, r.source, r.test_name, r.value_text, r.unit, r.reference_range, r.flag, r.file_id, r.notes,
           r.resulted_at, u.full_name as entered_by_name
      from lab_result r left join app_user u on u.id = r.entered_by where r.lab_order_id = any(${ids}::uuid[]) order by r.resulted_at, r.test_name`);
  return list.map((o) => ({
    id: o.id, orderNo: o.order_no, encounterId: o.encounter_id, status: o.status, connector: o.lab_connector, externalOrderId: o.external_order_id,
    clinicalInfo: o.clinical_info, orderedAt: o.ordered_at, orderedByName: o.ordered_by_name, cancelReason: o.cancel_reason, resultedAt: o.resulted_at,
    items: items.filter((i) => i.lab_order_id === o.id).map((i) => ({ id: i.id, serviceItemId: i.service_item_id, code: i.code, name: i.name })),
    results: results.filter((r) => r.lab_order_id === o.id).map((r) => ({ id: r.id, labOrderItemId: r.lab_order_item_id, source: r.source,
      testName: r.test_name, value: r.value_text, unit: r.unit, referenceRange: r.reference_range, flag: r.flag, fileId: r.file_id, notes: r.notes,
      resultedAt: r.resulted_at, enteredByName: r.entered_by_name })),
  }));
}

/**
 * Order & hasil lab (CLN-FR-014, 015). Order hanya saat pasien diperiksa, oleh dokter ber-SIP, untuk layanan berjenis
 * LAB. Hasil dapat datang setelah kunjungan selesai: input manual, unggah PDF, atau dari konektor. Hasil tidak pernah
 * diubah/dihapus (koreksi = hasil baru); order dibatalkan dengan alasan.
 */
@Controller('api/v1')
export class LabController {
  constructor(private readonly db: Db, @Inject(STORAGE) private readonly storage: ObjectStorage) {}

  @RequirePermission('clinical.lab.order') @BodySchema(LabOrderBody) @Post('encounters/:id/lab-orders') @HttpCode(201)
  async order(@Param('id') id: string, @Body() b: z.infer<typeof LabOrderBody>, @Headers('idempotency-key') key: string | undefined) {
    assertId(id, ...ENC_NOT_FOUND);
    return this.db.withTenantTx((tx) => idempotent(tx, 'lab.order', key, { id, ...b }, async () => {
      const [e] = await rows<{ status: string; patient_id: string; connector: string | null }>(tx, sql`
        select e.status, e.patient_id, t.settings->>'labConnector' as connector
          from encounter e join tenant t on t.id = e.tenant_id where e.id = ${id} for update of e`);
      if (!e) throw problem(404, ...ENC_NOT_FOUND);
      if (e.status !== 'IN_CONSULTATION') throw problem(409, 'CLN-409-NOT-IN-CONSULTATION', 'Order lab dibuat saat pasien sedang diperiksa');
      const [u] = await rows<{ practitioner_id: string | null }>(tx, sql`
        select u.practitioner_id from app_user u join practitioner p on p.id = u.practitioner_id and p.is_active where u.id = ${ctx().userId}`);
      if (!u?.practitioner_id) throw problem(409, 'CLN-409-NO-PRACTITIONER', 'Akun Anda belum tertaut ke data tenaga kesehatan');
      const svc = await rows<{ id: string; code: string; name: string }>(tx, sql`
        select id, code, name from service_item where id = any(${`{${b.serviceItemIds.join(',')}}`}::uuid[]) and is_active and service_type = 'LAB'`);
      const bad = b.serviceItemIds.filter((x) => !svc.some((s) => s.id === x));
      if (bad.length) throw problemWith(400, 'CLN-400-LAB-SERVICE', 'Bukan layanan lab aktif', { serviceItemIds: bad });
      const [{ no }] = await rows<{ no: string }>(tx, sql`select app.next_document_number('LAB_ORDER', 'TENANT', 'LAB{YYYY}{MM}{SEQ:6}') as no`);
      const conn = e.connector ? CONNECTORS[e.connector] : undefined;
      const sent = conn?.send({ orderNo: no, tests: svc.map((s) => ({ code: s.code, name: s.name })) });
      const [{ id: oid }] = await rows<{ id: string }>(tx, sql`
        insert into lab_order(tenant_id, order_no, encounter_id, ordered_by, lab_connector, external_order_id, status, clinical_info)
        values (app.current_tenant_id(), ${no}, ${id}, ${u.practitioner_id}, ${conn?.code ?? null}, ${sent?.externalOrderId ?? null},
                ${sent ? 'SENT' : 'ORDERED'}, ${b.clinicalInfo ?? null}) returning id`);
      for (const s of svc) await tx.execute(sql`insert into lab_order_item(tenant_id, lab_order_id, service_item_id) values (app.current_tenant_id(), ${oid}, ${s.id})`);
      await audit(tx, 'LAB_ORDERED', 'lab_order', oid, e.patient_id, { encounterId: id, tests: svc.length, connector: conn?.code ?? null });
      return (await ordersDto(tx, await rows<OrderRow>(tx, sql`${ORDER} where o.id = ${oid}`)))[0];
    }));
  }

  @RequirePermission('clinical.record.read') @Get('encounters/:id/lab-orders')
  async list(@Param('id') id: string) {
    assertId(id, ...ENC_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => ordersDto(tx, await rows<OrderRow>(tx, sql`${ORDER} where o.encounter_id = ${id} order by o.ordered_at desc`)));
  }

  @RequirePermission('clinical.lab.result.write') @BodySchema(LabResultBody) @Post('lab-orders/:id/results') @HttpCode(201)
  async manual(@Param('id') id: string, @Body() b: z.infer<typeof LabResultBody>) {
    assertId(id, ...ORDER_404);
    return this.db.withTenantTx(async (tx) => {
      const o = await this.lockOpen(tx, id);
      const items = await rows<{ id: string }>(tx, sql`select id from lab_order_item where lab_order_id = ${id}`);
      const bad = b.results.filter((r) => r.labOrderItemId && !items.some((i) => i.id === r.labOrderItemId));
      if (bad.length) throw problem(400, 'CLN-400-LAB-ITEM', 'Item pemeriksaan bukan bagian dari order ini');
      for (const r of b.results) {
        await tx.execute(sql`insert into lab_result(tenant_id, lab_order_id, lab_order_item_id, source, test_name, value_text, unit, reference_range, flag, notes, entered_by)
          values (app.current_tenant_id(), ${id}, ${r.labOrderItemId ?? null}, 'MANUAL', ${r.testName}, ${r.value}, ${r.unit ?? null},
                  ${r.referenceRange ?? null}, ${r.flag ?? null}, ${r.notes ?? null}, ${ctx().userId})`);
      }
      return this.resulted(tx, o, 'MANUAL', b.results.length);
    });
  }

  /** Unggah PDF hasil lab (maks. 5 MB, isi harus PDF — diperiksa magic bytes, bukan hanya Content-Type). */
  @RequirePermission('clinical.lab.result.write') @BodySchema(PdfBody) @Post('lab-orders/:id/results/upload') @HttpCode(201)
  async upload(@Param('id') id: string, @Body() body: Buffer, @Headers('content-type') ct: string | undefined) {
    assertId(id, ...ORDER_404);
    if (!(ct ?? '').toLowerCase().startsWith('application/pdf') || body.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw problem(400, 'CLN-400-PDF', 'Berkas harus PDF');
    }
    return this.db.withTenantTx(async (tx) => {
      const o = await this.lockOpen(tx, id);
      const f = await storeFile(tx, this.storage, { category: 'LAB_RESULT', patientId: o.patient_id, buffer: body, contentType: 'application/pdf', ext: 'pdf' });
      await tx.execute(sql`insert into lab_result(tenant_id, lab_order_id, source, test_name, file_id, entered_by)
        values (app.current_tenant_id(), ${id}, 'UPLOAD', 'Dokumen hasil lab (PDF)', ${f.id}, ${ctx().userId})`);
      return this.resulted(tx, o, 'UPLOAD', 1);
    });
  }

  /** Konektor tiruan (OD-059): mensimulasikan hasil yang dikirim aplikasi lab. Hanya bila order dikirim lewat MOCK. */
  @RequirePermission('clinical.lab.result.write') @NoBody() @Post('lab-orders/:id/simulate-result') @HttpCode(201)
  async simulate(@Param('id') id: string) {
    assertId(id, ...ORDER_404);
    return this.db.withTenantTx(async (tx) => {
      const o = await this.lockOpen(tx, id);
      if (o.lab_connector !== 'MOCK') throw problem(409, 'CLN-409-NOT-MOCK', 'Simulasi hanya untuk order lewat konektor tiruan');
      const items = await rows<{ id: string; name: string }>(tx, sql`
        select i.id, s.name from lab_order_item i join service_item s on s.id = i.service_item_id where i.lab_order_id = ${id} order by s.name`);
      for (const i of items) {
        await tx.execute(sql`insert into lab_result(tenant_id, lab_order_id, lab_order_item_id, source, test_name, value_text, unit, reference_range, flag, notes)
          values (app.current_tenant_id(), ${id}, ${i.id}, 'CONNECTOR', ${i.name}, '12.5', 'g/dL', '12–16', 'N', 'Hasil SINTETIS dari konektor tiruan')`);
      }
      return this.resulted(tx, o, 'CONNECTOR', items.length);
    });
  }

  @RequirePermission('clinical.lab.order') @BodySchema(z.object({ reason: z.string().trim().min(5).max(500) }).strict())
  @Post('lab-orders/:id/cancel') @HttpCode(200)
  async cancel(@Param('id') id: string, @Body() b: { reason: string }) {
    assertId(id, ...ORDER_404);
    return this.db.withTenantTx(async (tx) => {
      const o = await this.lockOpen(tx, id);
      if (o.status === 'RESULTED' || o.status === 'RECEIVED') throw problem(409, 'CLN-409-LAB-RESULTED', 'Order yang sudah ada hasilnya tidak dapat dibatalkan');
      await tx.execute(sql`update lab_order set status = 'CANCELLED', cancel_reason = ${b.reason} where id = ${id}`);
      await audit(tx, 'LAB_ORDER_CANCELLED', 'lab_order', id, o.patient_id, { reason: b.reason });
      return (await ordersDto(tx, await rows<OrderRow>(tx, sql`${ORDER} where o.id = ${id}`)))[0];
    });
  }

  /** Unduh PDF hasil lab; akses tercatat di audit dengan patient_id. */
  @RequirePermission('clinical.record.read') @Get('lab-results/:id/file')
  async file(@Param('id') id: string, @Res() res: Response) {
    assertId(id, 'CLN-404-LAB-RESULT', 'Hasil lab tidak ditemukan');
    const f = await this.db.withTenantTx(async (tx) => {
      const [r] = await rows<{ file_id: string | null; patient_id: string }>(tx, sql`
        select r.file_id, e.patient_id from lab_result r join lab_order o on o.id = r.lab_order_id join encounter e on e.id = o.encounter_id where r.id = ${id}`);
      if (!r?.file_id) throw problem(404, 'CLN-404-LAB-RESULT', 'Hasil lab tidak ditemukan');
      await audit(tx, 'LAB_RESULT_FILE_READ', 'lab_result', id, r.patient_id);
      return fileOf(tx, r.file_id);
    });
    res.setHeader('Content-Type', f.content_type);
    res.setHeader('Content-Disposition', `inline; filename="hasil-lab-${id}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    (await this.storage.openRead('files', f.object_path)).pipe(res);
  }

  private async lockOpen(tx: Tx, id: string) {
    const [o] = await rows<OrderRow>(tx, sql`${ORDER} where o.id = ${id} for update of o`);
    if (!o) throw problem(404, ...ORDER_404);
    if (o.status === 'CANCELLED') throw problem(409, 'CLN-409-LAB-CANCELLED', 'Order lab sudah dibatalkan');
    return o;
  }

  private async resulted(tx: Tx, o: OrderRow, source: string, count: number) {
    await tx.execute(sql`update lab_order set status = 'RESULTED', resulted_at = coalesce(resulted_at, now()) where id = ${o.id}`);
    await audit(tx, 'LAB_RESULT_RECORDED', 'lab_order', o.id, o.patient_id, { source, count });
    return (await ordersDto(tx, await rows<OrderRow>(tx, sql`${ORDER} where o.id = ${o.id}`)))[0];
  }
}
