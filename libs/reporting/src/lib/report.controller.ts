import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermission, ctx, problem } from '@clinicrme/shared';
import { Db, audit } from '@clinicrme/db';
import { REPORTS, ReportError, branchScope, csvOf, filterSummary, parseQuery, reportTimeout } from '@clinicrme/db/reports';

type QueryArg = Record<string, string | undefined>;
export const toProblem = (e: unknown) => (e instanceof ReportError ? problem(e.status, e.code, e.message) : e);

/**
 * Laporan standar MVP (Stage 14; RPT-FR-001…007). Logika hitung ada di `@clinicrme/db/reports` (dipakai juga worker ekspor);
 * controller ini hanya memvalidasi, menghitung cakupan cabang (OD-129), mengaudit (filter, tanpa isi) dan membentuk respons JSON/CSV.
 */
@Controller('api/v1/reports')
export class ReportController {
  constructor(private readonly db: Db) {}

  /** Kunjungan (RPT-FR-001, OD-124). */
  @RequirePermission('report.operational.read') @Get('visits')
  visits(@Query() q: QueryArg, @Res({ passthrough: true }) res: Response) { return this.view('visits', q, res); }

  /** 10 besar diagnosis (RPT-FR-002, OD-125). */
  @RequirePermission('report.clinical.read') @Get('top-diagnoses')
  topDiagnoses(@Query() q: QueryArg, @Res({ passthrough: true }) res: Response) { return this.view('top-diagnoses', q, res); }

  /** Pendapatan billed/cash (RPT-FR-003, OD-126). */
  @RequirePermission('report.finance.read') @Get('revenue')
  revenue(@Query() q: QueryArg, @Res({ passthrough: true }) res: Response) { return this.view('revenue', q, res); }

  /** Closing kasir (RPT-FR-004, OD-127). */
  @RequirePermission('report.finance.read') @Get('cashier-closing')
  cashierClosing(@Query() q: QueryArg, @Res({ passthrough: true }) res: Response) { return this.view('cashier-closing', q, res); }

  /** Umur piutang penjamin (RPT-FR-007, OD-127). */
  @RequirePermission('report.finance.read') @Get('receivables')
  receivables(@Query() q: QueryArg, @Res({ passthrough: true }) res: Response) { return this.view('receivables', q, res); }

  /** Stok per obat (RPT-FR-005, PHM-FR-004). */
  @RequirePermission('report.pharmacy.read') @Get('stock')
  stock(@Query() q: QueryArg, @Res({ passthrough: true }) res: Response) { return this.view('stock', q, res); }

  /** Mutasi stok (RPT-FR-005), maks. 5.000 baris tampilan. */
  @RequirePermission('report.pharmacy.read') @Get('stock-movements')
  stockMovements(@Query() q: QueryArg, @Res({ passthrough: true }) res: Response) { return this.view('stock-movements', q, res); }

  /** Obat mendekati kedaluwarsa (RPT-FR-005). */
  @RequirePermission('report.pharmacy.read') @Get('near-expiry')
  nearExpiry(@Query() q: QueryArg, @Res({ passthrough: true }) res: Response) { return this.view('near-expiry', q, res); }

  /** Obat golongan terbatas per bulan (RPT-FR-006, OD-100; format resmi belum diverifikasi — REG-10). */
  @RequirePermission('report.pharmacy.controlled') @Get('controlled-drugs')
  controlledDrugs(@Query() q: QueryArg, @Res({ passthrough: true }) res: Response) { return this.view('controlled-drugs', q, res); }

  private async view(code: string, query: QueryArg, res: Response) {
    const def = REPORTS[code];
    try {
      const f = parseQuery(def.schema, query) as Record<string, unknown> & { format: 'json' | 'csv'; branchId?: string };
      const { result, scope } = await this.db.withTenantTx(async (tx) => {
        await reportTimeout(tx);
        const s = await branchScope(tx, ctx().userId!, def.permission, f.branchId);
        const r = await def.run(tx, f as never, s);
        await audit(tx, `REPORT_${code.toUpperCase().replace(/-/g, '_')}_VIEWED`, 'report', null, null,
          { ...filterSummary(f), ...(r.extra?.['asOf'] ? { asOf: r.extra['asOf'] } : {}) });
        return { result: r, scope: s };
      });
      if (f.format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${def.filename(f, result)}.csv"`);
        res.setHeader('Cache-Control', 'no-store');
        return csvOf(result.columns, result.rows);
      }
      const filters = Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'format'));
      const now = new Date().toISOString();
      return { columns: result.columns, rows: result.rows, ...(result.totals ? { totals: result.totals } : {}), ...filters, ...result.extra,
        allBranches: scope === null, generatedAt: now, dataAsOf: now };
    } catch (e) {
      throw toProblem(e);
    }
  }
}
