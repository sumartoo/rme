import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BodySchema, NoBody, RequirePermission, Uuid, assertId, assertVersion, ctx, ifMatchVersion, optText, problem, problemWith } from '@clinicrme/shared';
import { Db, type Tx, audit, rows } from '@clinicrme/db';
import { lockStock, round4 } from './dispense.repo';
import { RESTRICTED } from './stock.repo';

const OPN_NOT_FOUND = ['PHM-404-OPNAME', 'Stock opname tidak ditemukan'] as const;
const StartBody = z.object({ locationId: Uuid, notes: optText(500) }).strict();
const CountBody = z.object({
  lines: z.array(z.object({
    batchId: Uuid, countedQty: z.number().min(0).max(10_000_000).transform(round4), note: optText(300),
  }).strict()).min(1).max(500),
}).strict();
const Decision = z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: optText(300) }).strict()
  .refine((b) => b.decision === 'APPROVE' || (b.note ?? '').length >= 5, { message: 'Alasan penolakan wajib diisi (min. 5 karakter)', path: ['note'] });

interface Head { id: string; status: string; version: number; location_id: string; location_name: string; branch_id: string; branch_name: string; notes: string | null;
  started_by: string; started_by_name: string; started_at: string; submitted_at: string | null; submitted_by_name: string | null; approved_at: string | null;
  approved_by_name: string | null; decision_note: string | null }
const HEAD = sql`
  select o.id, o.status, o.version, l.id as location_id, l.name as location_name, l.branch_id, br.name as branch_name, o.notes, o.started_by,
         su.full_name as started_by_name, o.started_at, o.submitted_at, sbu.full_name as submitted_by_name, o.approved_at, au.full_name as approved_by_name,
         o.decision_note
    from stock_opname o join stock_location l on l.id = o.location_id join branch br on br.id = l.branch_id join app_user su on su.id = o.started_by
    left join app_user sbu on sbu.id = o.submitted_by left join app_user au on au.id = o.approved_by`;

/**
 * Stock opname (PHM-FR-017): satu sesi aktif per lokasi. Mulai → baris dibuat dari batch bersaldo → hitung fisik per batch
 * (saldo sistem dicatat saat dihitung, sehingga mutasi sesudahnya tidak ikut dikoreksi) → kirim (semua baris dihitung,
 * selisih wajib catatan) → disetujui orang lain (≠ yang memulai) → selisih menjadi mutasi OPNAME. Ditolak → kembali dihitung.
 * Baris obat golongan terbatas hanya dapat dihitung pemegang izin khusus (OD-100).
 */
@Controller('api/v1')
export class OpnameController {
  constructor(private readonly db: Db) {}

  @RequirePermission('pharmacy.stock.read') @Get('stock-opnames')
  async list(@Query('locationId') locationId?: string) {
    if (locationId) assertId(locationId, 'PHM-400-LOCATION', 'Lokasi tidak ditemukan');
    return this.db.withTenantTx(async (tx) => {
      const r = await rows<Head & { lines: number; counted: number; diffs: number }>(tx, sql`
        select h.*, (select count(*)::int from stock_opname_line x where x.opname_id = h.id) as lines,
               (select count(*)::int from stock_opname_line x where x.opname_id = h.id and x.counted_qty is not null) as counted,
               (select count(*)::int from stock_opname_line x where x.opname_id = h.id and x.counted_qty is distinct from x.system_qty and x.counted_qty is not null) as diffs
          from (${HEAD}) h where (${locationId ?? null}::uuid is null or h.location_id = ${locationId ?? null}::uuid)
         order by h.started_at desc limit 100`);
      return r.map((h) => ({ ...this.headDto(h), lineCount: h.lines, countedCount: h.counted, diffCount: h.diffs }));
    });
  }

  @RequirePermission('pharmacy.stock.read') @Get('stock-opnames/:id')
  async get(@Param('id') id: string) {
    assertId(id, ...OPN_NOT_FOUND);
    return this.db.withTenantTx((tx) => this.view(tx, id));
  }

  @RequirePermission('pharmacy.stock.opname') @BodySchema(StartBody) @Post('stock-opnames') @HttpCode(201)
  async start(@Body() b: z.infer<typeof StartBody>) {
    return this.db.withTenantTx(async (tx) => {
      const [l] = await rows<{ is_active: boolean }>(tx, sql`select is_active from stock_location where id = ${b.locationId}`);
      if (!l?.is_active) throw problem(400, 'PHM-400-LOCATION', 'Lokasi tidak ditemukan atau tidak aktif');
      const [active] = await rows(tx, sql`select 1 from stock_opname where location_id = ${b.locationId} and status in ('COUNTING', 'SUBMITTED')`);
      if (active) throw problem(409, 'PHM-409-OPNAME-ACTIVE', 'Masih ada stock opname yang berjalan di lokasi ini');
      const [{ id }] = await rows<{ id: string }>(tx, sql`
        insert into stock_opname(tenant_id, location_id, started_by, notes) values (app.current_tenant_id(), ${b.locationId}, ${ctx().userId}, ${b.notes ?? null})
        returning id`);
      await tx.execute(sql`
        insert into stock_opname_line(tenant_id, opname_id, batch_id, system_qty)
        select app.current_tenant_id(), ${id}, s.batch_id, s.qty_on_hand from stock_balance s where s.location_id = ${b.locationId} and s.qty_on_hand <> 0`);
      await audit(tx, 'STOCK_OPNAME_STARTED', 'stock_opname', id, null, { locationId: b.locationId });
      return this.view(tx, id);
    });
  }

  /** Input hasil hitung; batch yang belum ada di daftar (ditemukan fisik) ditambahkan. */
  @RequirePermission('pharmacy.stock.opname') @BodySchema(CountBody) @Put('stock-opnames/:id/counts')
  async count(@Param('id') id: string, @Body() b: z.infer<typeof CountBody>, @Headers('if-match') ifMatch: string | undefined) {
    assertId(id, ...OPN_NOT_FOUND);
    const v = ifMatchVersion(ifMatch, 'stock opname');
    return this.db.withTenantTx(async (tx) => {
      const h = await this.lock(tx, id);
      assertVersion(h.version, v, 'Stock opname');
      if (h.status !== 'COUNTING') throw problem(409, 'PHM-409-OPNAME-STATE', 'Penghitungan hanya saat status menghitung');
      const ids = [...new Set(b.lines.map((l) => l.batchId))];
      if (ids.length !== b.lines.length) throw problem(400, 'PHM-400-OPNAME', 'Batch ganda dalam satu kiriman');
      const batches = new Map((await rows<{ id: string; drug_name: string; drug_class: string }>(tx, sql`
        select sb.id, d.generic_name as drug_name, d.drug_class from stock_batch sb join drug_item d on d.id = sb.drug_item_id
         where sb.id = any(${`{${ids.join(',')}}`}::uuid[])`)).map((x) => [x.id, x]));
      const errors: { field: string; message: string }[] = [];
      for (const [n, l] of b.lines.entries()) {
        const bt = batches.get(l.batchId);
        if (!bt) { errors.push({ field: `lines.${n}.batchId`, message: 'Batch tidak ditemukan' }); continue; }
        if (RESTRICTED.includes(bt.drug_class) && !ctx().permissions?.has('pharmacy.restricted.dispense')) {
          errors.push({ field: `lines.${n}.batchId`, message: `${bt.drug_name} golongan ${bt.drug_class.toLowerCase()}: butuh izin khusus obat terbatas` });
        }
      }
      if (errors.length) throw problemWith(errors.some((e) => e.message.includes('izin khusus')) ? 403 : 400, 'PHM-400-OPNAME', 'Hasil hitung tidak dapat disimpan', { errors });
      for (const l of b.lines) {
        // Saldo sistem dicatat saat baris dihitung
        await tx.execute(sql`
          insert into stock_opname_line(tenant_id, opname_id, batch_id, system_qty, counted_qty, note, counted_by, counted_at)
          values (app.current_tenant_id(), ${id}, ${l.batchId},
                  coalesce((select qty_on_hand from stock_balance where batch_id = ${l.batchId} and location_id = ${h.location_id}), 0),
                  ${l.countedQty}, ${l.note ?? null}, ${ctx().userId}, now())
          on conflict (tenant_id, opname_id, batch_id) do update set counted_qty = excluded.counted_qty, note = excluded.note,
             system_qty = excluded.system_qty, counted_by = excluded.counted_by, counted_at = excluded.counted_at`);
      }
      await tx.execute(sql`update stock_opname set version = version + 1 where id = ${id}`);
      return this.view(tx, id);
    });
  }

  @RequirePermission('pharmacy.stock.opname') @NoBody() @Post('stock-opnames/:id/submit') @HttpCode(200)
  async submit(@Param('id') id: string, @Headers('if-match') ifMatch: string | undefined) {
    assertId(id, ...OPN_NOT_FOUND);
    const v = ifMatchVersion(ifMatch, 'stock opname');
    return this.db.withTenantTx(async (tx) => {
      const h = await this.lock(tx, id);
      assertVersion(h.version, v, 'Stock opname');
      if (h.status !== 'COUNTING') throw problem(409, 'PHM-409-OPNAME-STATE', 'Stock opname tidak dalam status menghitung');
      const bad = await rows<{ batch_no: string; drug_name: string; counted: boolean }>(tx, sql`
        select sb.batch_no, d.generic_name as drug_name, x.counted_qty is not null as counted
          from stock_opname_line x join stock_batch sb on sb.id = x.batch_id join drug_item d on d.id = sb.drug_item_id
         where x.opname_id = ${id} and (x.counted_qty is null or (x.counted_qty <> x.system_qty and coalesce(length(trim(x.note)), 0) < 3))`);
      if (bad.length) {
        throw problemWith(422, 'PHM-422-OPNAME-INCOMPLETE', 'Semua batch wajib dihitung dan setiap selisih diberi catatan', {
          errors: bad.map((x) => ({ field: x.batch_no, message: `${x.drug_name} batch ${x.batch_no}: ${x.counted ? 'selisih belum diberi catatan' : 'belum dihitung'}` })) });
      }
      await tx.execute(sql`update stock_opname set status = 'SUBMITTED', submitted_by = ${ctx().userId}, submitted_at = now(), version = version + 1 where id = ${id}`);
      await audit(tx, 'STOCK_OPNAME_SUBMITTED', 'stock_opname', id, null, { locationId: h.location_id });
      return this.view(tx, id);
    });
  }

  @RequirePermission('pharmacy.stock.approve') @BodySchema(Decision) @Post('stock-opnames/:id/decision') @HttpCode(200)
  async decide(@Param('id') id: string, @Body() b: z.infer<typeof Decision>, @Headers('if-match') ifMatch: string | undefined) {
    assertId(id, ...OPN_NOT_FOUND);
    const v = ifMatchVersion(ifMatch, 'stock opname');
    return this.db.withTenantTx(async (tx) => {
      const h = await this.lock(tx, id);
      assertVersion(h.version, v, 'Stock opname');
      if (h.status !== 'SUBMITTED') throw problem(409, 'PHM-409-OPNAME-STATE', 'Stock opname belum dikirim atau sudah diputuskan');
      if (h.started_by === ctx().userId) throw problem(403, 'PHM-403-SELF-APPROVAL', 'Stock opname harus disetujui orang lain (bukan yang memulai)');
      if (b.decision === 'REJECT') {
        await tx.execute(sql`update stock_opname set status = 'COUNTING', decision_note = ${b.note!}, submitted_at = null, submitted_by = null,
                               version = version + 1 where id = ${id}`);
        await audit(tx, 'STOCK_OPNAME_REJECTED', 'stock_opname', id, null, { note: b.note });
        return this.view(tx, id);
      }
      const diffs = await rows<{ batch_id: string; drug_item_id: string; delta: string }>(tx, sql`
        select x.batch_id, sb.drug_item_id, (x.counted_qty - x.system_qty)::text as delta from stock_opname_line x join stock_batch sb on sb.id = x.batch_id
         where x.opname_id = ${id} and x.counted_qty <> x.system_qty`);
      await lockStock(tx, h.location_id, diffs.map((d) => d.drug_item_id));
      for (const d of diffs) {
        await tx.execute(sql`insert into stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id, actor_id)
                             values (app.current_tenant_id(), ${d.batch_id}, ${h.location_id}, 'OPNAME', ${d.delta}::numeric, 'stock_opname', ${id}, ${ctx().userId})`);
      }
      await tx.execute(sql`update stock_opname set status = 'APPROVED', approved_by = ${ctx().userId}, approved_at = now(), decision_note = ${b.note ?? null},
                             version = version + 1 where id = ${id}`);
      await audit(tx, 'STOCK_OPNAME_APPROVED', 'stock_opname', id, null, { locationId: h.location_id, adjustments: diffs.length,
        net: round4(diffs.reduce((t, d) => t + Number(d.delta), 0)) });
      return this.view(tx, id);
    }).catch((e: { cause?: { code?: string } }) => {
      // CHECK saldo ≥ 0: mutasi sejak penghitungan membuat koreksi negatif — hitung ulang
      if (e?.cause?.code === '23514') throw problem(409, 'PHM-409-NEGATIVE', 'Saldo sekarang lebih kecil dari koreksi; tolak dan hitung ulang batch tersebut');
      throw e;
    });
  }

  @RequirePermission('pharmacy.stock.opname') @NoBody() @Post('stock-opnames/:id/cancel') @HttpCode(200)
  async cancel(@Param('id') id: string, @Headers('if-match') ifMatch: string | undefined) {
    assertId(id, ...OPN_NOT_FOUND);
    const v = ifMatchVersion(ifMatch, 'stock opname');
    return this.db.withTenantTx(async (tx) => {
      const h = await this.lock(tx, id);
      assertVersion(h.version, v, 'Stock opname');
      if (!['COUNTING', 'SUBMITTED'].includes(h.status)) throw problem(409, 'PHM-409-OPNAME-STATE', 'Stock opname sudah selesai');
      await tx.execute(sql`update stock_opname set status = 'CANCELLED', version = version + 1 where id = ${id}`);
      await audit(tx, 'STOCK_OPNAME_CANCELLED', 'stock_opname', id, null, {});
      return this.view(tx, id);
    });
  }

  private async lock(tx: Tx, id: string) {
    const [h] = await rows<{ status: string; version: number; started_by: string; location_id: string }>(tx, sql`
      select status, version, started_by, location_id from stock_opname where id = ${id} for update`);
    if (!h) throw problem(404, ...OPN_NOT_FOUND);
    return h;
  }

  private headDto(h: Head) {
    return { id: h.id, status: h.status, version: h.version, location: { id: h.location_id, name: h.location_name, branchName: h.branch_name },
      notes: h.notes, startedByName: h.started_by_name, startedAt: h.started_at, submittedAt: h.submitted_at, submittedByName: h.submitted_by_name,
      approvedAt: h.approved_at, approvedByName: h.approved_by_name, decisionNote: h.decision_note, mine: h.started_by === ctx().userId };
  }

  private async view(tx: Tx, id: string) {
    const [h] = await rows<Head>(tx, sql`${HEAD} where o.id = ${id}`);
    if (!h) throw problem(404, ...OPN_NOT_FOUND);
    const lines = await rows<{ batch_id: string; batch_no: string; expiry_date: string; drug_item_id: string; drug_name: string; drug_class: string;
                               uom_name: string; system_qty: string; counted_qty: string | null; note: string | null; counted_by_name: string | null }>(tx, sql`
      select x.batch_id, sb.batch_no, to_char(sb.expiry_date, 'YYYY-MM-DD') as expiry_date, d.id as drug_item_id, d.generic_name as drug_name, d.drug_class,
             u.name as uom_name, trim_scale(x.system_qty)::text as system_qty, trim_scale(x.counted_qty)::text as counted_qty, x.note, cu.full_name as counted_by_name
        from stock_opname_line x join stock_batch sb on sb.id = x.batch_id join drug_item d on d.id = sb.drug_item_id join uom u on u.id = d.base_uom_id
        left join app_user cu on cu.id = x.counted_by
       where x.opname_id = ${id} order by lower(d.generic_name), sb.expiry_date, sb.batch_no`);
    return {
      ...this.headDto(h),
      lines: lines.map((l) => ({
        batchId: l.batch_id, batchNo: l.batch_no, expiryDate: l.expiry_date, drugItemId: l.drug_item_id, drugName: l.drug_name, drugClass: l.drug_class,
        restricted: RESTRICTED.includes(l.drug_class), uomName: l.uom_name, systemQty: Number(l.system_qty),
        countedQty: l.counted_qty === null ? null : Number(l.counted_qty), difference: l.counted_qty === null ? null : round4(Number(l.counted_qty) - Number(l.system_qty)),
        note: l.note, countedByName: l.counted_by_name,
      })),
    };
  }
}
