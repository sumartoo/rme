import { Controller, Get, Query, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { RequirePermission, Uuid, problem } from '@clinicrme/shared';
import { Db, audit, rows } from '@clinicrme/db';
import { RESTRICTED } from './stock.repo';

const Q = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), branchId: Uuid.optional(), format: z.enum(['json', 'csv']).default('json'),
});
const COLUMNS = [
  { key: 'code', label: 'Kode', type: 'string' }, { key: 'drugName', label: 'Nama obat', type: 'string' },
  { key: 'drugClass', label: 'Golongan', type: 'string' }, { key: 'uomName', label: 'Satuan', type: 'string' },
  { key: 'opening', label: 'Saldo awal', type: 'number' }, { key: 'received', label: 'Pemasukan', type: 'number' },
  { key: 'dispensed', label: 'Pengeluaran (resep)', type: 'number' }, { key: 'otherOut', label: 'Pengeluaran lain', type: 'number' },
  { key: 'adjusted', label: 'Penyesuaian/opname (±)', type: 'number' }, { key: 'closing', label: 'Saldo akhir', type: 'number' },
];

/**
 * Laporan pemakaian bulanan obat golongan terbatas (OD-100, RPT-FR-006, PHM-FR-019): per obat narkotika/psikotropika/
 * prekursor — saldo awal, pemasukan, pengeluaran resep, pengeluaran lain, penyesuaian/opname, saldo akhir — dari ledger
 * mutasi per batas bulan zona waktu cabang (atau tenant). Format pelaporan resmi **belum diverifikasi** (REG-10).
 */
@Controller('api/v1')
export class ControlledReportController {
  constructor(private readonly db: Db) {}

  @RequirePermission('report.pharmacy.controlled') @Get('reports/controlled-drugs')
  async report(@Query() query: Record<string, string | undefined>, @Res({ passthrough: true }) res: Response) {
    const P = Q.safeParse(query);
    if (!P.success) throw problem(400, 'GEN-400-QUERY', 'Parameter bulan (YYYY-MM) tidak valid');
    const f = P.data;
    const out = await this.db.withTenantTx(async (tx) => {
      const [tz] = await rows<{ tz: string; branch_name: string | null }>(tx, sql`
        select coalesce((select timezone from branch where id = ${f.branchId ?? null}::uuid), t.timezone) as tz,
               (select name from branch where id = ${f.branchId ?? null}::uuid) as branch_name
          from tenant t where t.id = app.current_tenant_id()`);
      if (f.branchId && !tz.branch_name) throw problem(404, 'MST-404-BRANCH', 'Cabang tidak ditemukan');
      const r = await rows<{ code: string; drug_name: string; drug_class: string; uom_name: string; opening: string; received: string; dispensed: string;
                             other_out: string; adjusted: string }>(tx, sql`
        with bounds as (select (${`${f.month}-01`}::date)::timestamp at time zone ${tz.tz} as t0,
                               ((${`${f.month}-01`}::date + interval '1 month')::date)::timestamp at time zone ${tz.tz} as t1),
        mv as (
          select sb.drug_item_id, m.movement_type, m.qty, m.occurred_at
            from stock_movement m join stock_batch sb on sb.id = m.batch_id join stock_location l on l.id = m.location_id
           where (${f.branchId ?? null}::uuid is null or l.branch_id = ${f.branchId ?? null}::uuid))
        select d.code, d.generic_name as drug_name, d.drug_class, u.name as uom_name,
               trim_scale(coalesce(sum(mv.qty) filter (where mv.occurred_at < b.t0), 0))::text as opening,
               trim_scale(coalesce(sum(mv.qty) filter (where mv.occurred_at >= b.t0 and mv.occurred_at < b.t1
                 and mv.movement_type in ('RECEIPT', 'RETURN_IN', 'TRANSFER_IN')), 0))::text as received,
               trim_scale(coalesce(-sum(mv.qty) filter (where mv.occurred_at >= b.t0 and mv.occurred_at < b.t1 and mv.movement_type = 'DISPENSE'), 0))::text as dispensed,
               trim_scale(coalesce(-sum(mv.qty) filter (where mv.occurred_at >= b.t0 and mv.occurred_at < b.t1
                 and mv.movement_type in ('OTC_SALE', 'RETURN_OUT', 'TRANSFER_OUT')), 0))::text as other_out,
               trim_scale(coalesce(sum(mv.qty) filter (where mv.occurred_at >= b.t0 and mv.occurred_at < b.t1
                 and mv.movement_type in ('ADJUSTMENT', 'OPNAME')), 0))::text as adjusted
          from drug_item d join uom u on u.id = d.base_uom_id cross join bounds b left join mv on mv.drug_item_id = d.id and mv.occurred_at < b.t1
         where d.drug_class = any(${`{${RESTRICTED.join(',')}}`}::text[])
         group by d.id, u.name, b.t0, b.t1
        having d.is_active or coalesce(sum(mv.qty), 0) <> 0 or count(mv.qty) filter (where mv.occurred_at >= b.t0) > 0
         order by d.drug_class, lower(d.generic_name)`);
      const data = r.map((x) => {
        const n = { opening: Number(x.opening), received: Number(x.received), dispensed: Number(x.dispensed), otherOut: Number(x.other_out), adjusted: Number(x.adjusted) };
        return { code: x.code, drugName: x.drug_name, drugClass: x.drug_class, uomName: x.uom_name, ...n,
          closing: Math.round((n.opening + n.received - n.dispensed - n.otherOut + n.adjusted) * 10_000) / 10_000 };
      });
      await audit(tx, 'REPORT_CONTROLLED_DRUGS_VIEWED', 'report', null, null, { month: f.month, branchId: f.branchId ?? null, format: f.format });
      return { data, branchName: tz.branch_name };
    });
    const meta = { month: f.month, branchName: out.branchName, note: 'Format laporan resmi belum diverifikasi (REG-10); angka dari ledger mutasi stok.' };
    if (f.format === 'csv') {
      const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const csv = [COLUMNS.map((c) => c.label).join(','), ...out.data.map((r) => COLUMNS.map((c) => esc((r as Record<string, unknown>)[c.key])).join(','))].join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="obat-terbatas-${f.month}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      return `\uFEFF${csv}\r\n`;
    }
    return { columns: COLUMNS, rows: out.data, generatedAt: new Date().toISOString(), dataAsOf: new Date().toISOString(), ...meta };
  }
}
