import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BodySchema, RequirePermission, Uuid, assertId, ctx, optText, problem } from '@clinicrme/shared';
import { Db, type Tx, audit, rows } from '@clinicrme/db';
import { lockStock, round4 } from './dispense.repo';
import { RESTRICTED, assertRestrictedAllowed } from './stock.repo';

const ADJ_NOT_FOUND = ['PHM-404-ADJUSTMENT', 'Penyesuaian stok tidak ditemukan'] as const;
const Body_ = z.object({
  batchId: Uuid, locationId: Uuid,
  qtyDelta: z.number().refine((n) => n !== 0 && Math.abs(n) <= 1_000_000, 'Selisih tidak boleh 0').transform(round4),
  reason: z.string().trim().min(5).max(500),
}).strict();
const Decision = z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: optText(300) }).strict()
  .refine((b) => b.decision === 'APPROVE' || (b.note ?? '').length >= 5, { message: 'Alasan penolakan wajib diisi (min. 5 karakter)', path: ['note'] });
const ListQuery = z.object({ status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED']).optional(), locationId: Uuid.optional() });

interface Row { id: string; status: string; qty_delta: string; reason: string; created_at: string; decided_at: string | null; decision_note: string | null;
  requested_by: string; requester_name: string; approver_name: string | null; batch_id: string; batch_no: string; expiry_date: string; drug_item_id: string;
  drug_name: string; drug_class: string; uom_name: string; location_id: string; location_name: string; branch_id: string; qty_on_hand: string }
const SEL = sql`
  select a.id, a.status, trim_scale(a.qty_delta)::text as qty_delta, a.reason, a.created_at, a.decided_at, a.decision_note, a.requested_by,
         ru.full_name as requester_name, au.full_name as approver_name, sb.id as batch_id, sb.batch_no, to_char(sb.expiry_date, 'YYYY-MM-DD') as expiry_date,
         d.id as drug_item_id, d.generic_name as drug_name, d.drug_class, u.name as uom_name, l.id as location_id, l.name as location_name, l.branch_id,
         trim_scale(coalesce((select qty_on_hand from stock_balance s where s.batch_id = a.batch_id and s.location_id = a.location_id), 0))::text as qty_on_hand
    from stock_adjustment a join stock_batch sb on sb.id = a.batch_id join drug_item d on d.id = sb.drug_item_id join uom u on u.id = d.base_uom_id
    join stock_location l on l.id = a.location_id join app_user ru on ru.id = a.requested_by left join app_user au on au.id = a.approved_by`;
const dto = (r: Row) => ({
  id: r.id, status: r.status, qtyDelta: Number(r.qty_delta), reason: r.reason, createdAt: r.created_at, decidedAt: r.decided_at, decisionNote: r.decision_note,
  requestedByName: r.requester_name, approvedByName: r.approver_name, mine: r.requested_by === ctx().userId,
  batch: { id: r.batch_id, batchNo: r.batch_no, expiryDate: r.expiry_date }, drug: { id: r.drug_item_id, name: r.drug_name, drugClass: r.drug_class, uomName: r.uom_name },
  location: { id: r.location_id, name: r.location_name }, qtyOnHand: Number(r.qty_on_hand),
});

/**
 * Penyesuaian stok maker–checker (PHM-FR-016): diajukan dengan alasan (rusak, hilang, salah input, dll.) oleh pemegang
 * `pharmacy.stock.adjust`, disetujui orang lain pemegang `pharmacy.stock.approve` (dijamin CHECK DB). Persetujuan menulis
 * mutasi ADJUSTMENT; saldo tidak boleh negatif. Obat golongan terbatas butuh izin khusus untuk mengajukan (OD-100).
 */
@Controller('api/v1')
export class AdjustmentsController {
  constructor(private readonly db: Db) {}

  @RequirePermission('pharmacy.stock.read') @Get('stock-adjustments')
  async list(@Query() query: Record<string, string | undefined>) {
    const P = ListQuery.safeParse(query);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const f = P.data;
    return this.db.withTenantTx(async (tx) => (await rows<Row>(tx, sql`${SEL}
      where (${f.status ?? null}::text is null or a.status = ${f.status ?? null}::text)
        and (${f.locationId ?? null}::uuid is null or a.location_id = ${f.locationId ?? null}::uuid)
      order by a.created_at desc limit 200`)).map(dto));
  }

  @RequirePermission('pharmacy.stock.adjust') @BodySchema(Body_) @Post('stock-adjustments') @HttpCode(201)
  async create(@Body() b: z.infer<typeof Body_>) {
    return this.db.withTenantTx(async (tx) => {
      const [x] = await rows<{ drug_item_id: string; drug_name: string; drug_class: string; loc_active: boolean; qty_on_hand: string }>(tx, sql`
        select d.id as drug_item_id, d.generic_name as drug_name, d.drug_class, l.is_active as loc_active,
               coalesce((select qty_on_hand from stock_balance s where s.batch_id = sb.id and s.location_id = l.id), 0)::text as qty_on_hand
          from stock_batch sb join drug_item d on d.id = sb.drug_item_id, stock_location l where sb.id = ${b.batchId} and l.id = ${b.locationId}`);
      if (!x) throw problem(400, 'PHM-400-BATCH', 'Batch atau lokasi tidak ditemukan');
      if (!x.loc_active) throw problem(400, 'PHM-400-LOCATION', 'Lokasi tidak aktif');
      if (RESTRICTED.includes(x.drug_class)) assertRestrictedAllowed(x.drug_class, x.drug_name);
      if (Number(x.qty_on_hand) + b.qtyDelta < 0) throw problem(409, 'PHM-409-NEGATIVE', `Pengurangan melebihi saldo (${Number(x.qty_on_hand)})`);
      const [{ id }] = await rows<{ id: string }>(tx, sql`
        insert into stock_adjustment(tenant_id, batch_id, location_id, qty_delta, reason, requested_by)
        values (app.current_tenant_id(), ${b.batchId}, ${b.locationId}, ${b.qtyDelta}, ${b.reason}, ${ctx().userId}) returning id`);
      await audit(tx, 'STOCK_ADJUSTMENT_REQUESTED', 'stock_adjustment', id, null, { drug: x.drug_name, qtyDelta: b.qtyDelta, reason: b.reason });
      return this.one(tx, id);
    });
  }

  @RequirePermission('pharmacy.stock.approve') @BodySchema(Decision) @Post('stock-adjustments/:id/decision') @HttpCode(200)
  async decide(@Param('id') id: string, @Body() b: z.infer<typeof Decision>) {
    assertId(id, ...ADJ_NOT_FOUND);
    return this.db.withTenantTx(async (tx) => {
      const [cur] = await rows<Row>(tx, sql`${SEL} where a.id = ${id}`);
      if (!cur) throw problem(404, ...ADJ_NOT_FOUND);
      await tx.execute(sql`select 1 from stock_adjustment where id = ${id} for update`);
      if (cur.status !== 'REQUESTED') throw problem(409, 'PHM-409-DECIDED', 'Penyesuaian sudah diputuskan');
      if (cur.requested_by === ctx().userId) throw problem(403, 'PHM-403-SELF-APPROVAL', 'Penyesuaian harus disetujui orang lain (maker–checker)');
      if (b.decision === 'APPROVE') {
        await lockStock(tx, cur.location_id, [cur.drug_item_id]);
        const [{ q }] = await rows<{ q: string }>(tx, sql`
          select coalesce((select qty_on_hand from stock_balance where batch_id = ${cur.batch_id} and location_id = ${cur.location_id}), 0)::text as q`);
        if (Number(q) + Number(cur.qty_delta) < 0) throw problem(409, 'PHM-409-NEGATIVE', `Saldo sekarang (${Number(q)}) tidak cukup untuk pengurangan ini`);
        await tx.execute(sql`insert into stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id, actor_id)
                             values (app.current_tenant_id(), ${cur.batch_id}, ${cur.location_id}, 'ADJUSTMENT', ${cur.qty_delta}::numeric,
                                     'stock_adjustment', ${id}, ${ctx().userId})`);
      }
      await tx.execute(sql`update stock_adjustment set status = ${b.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED'}, approved_by = ${ctx().userId},
                             decided_at = now(), decision_note = ${b.note ?? null} where id = ${id}`);
      await audit(tx, b.decision === 'APPROVE' ? 'STOCK_ADJUSTMENT_APPROVED' : 'STOCK_ADJUSTMENT_REJECTED', 'stock_adjustment', id, null,
        { drug: cur.drug_name, qtyDelta: Number(cur.qty_delta), note: b.note ?? null });
      return this.one(tx, id);
    });
  }

  private async one(tx: Tx, id: string) {
    const [r] = await rows<Row>(tx, sql`${SEL} where a.id = ${id}`);
    if (!r) throw problem(404, ...ADJ_NOT_FOUND);
    return dto(r);
  }
}
