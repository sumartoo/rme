import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermission, ctx } from '@clinicrme/shared';
import { Db } from '@clinicrme/db';
import { DashboardQ, branchScope, dashboard, parseQuery, reportTimeout } from '@clinicrme/db/reports';
import { toProblem } from './report.controller';

/**
 * Dashboard manajer hari ini (RPT-FR-009, OD-131). Cakupan cabang dari penugasan role (OD-129). Tidak diaudit per tampilan karena dimuat
 * ulang tiap 60 detik dan hanya berisi agregat tanpa identitas pasien (lihat REPORT_CATALOG.md).
 */
@Controller('api/v1')
export class DashboardController {
  constructor(private readonly db: Db) {}

  @RequirePermission('report.dashboard.read') @Get('dashboard/today')
  async today(@Query() query: Record<string, string | undefined>) {
    try {
      const f = parseQuery(DashboardQ, query);
      return await this.db.withTenantTx(async (tx) => {
        await reportTimeout(tx);
        const scope = await branchScope(tx, ctx().userId!, 'report.dashboard.read', f.branchId);
        return { ...(await dashboard(tx, f, scope)), allBranches: scope === null, generatedAt: new Date().toISOString() };
      });
    } catch (e) {
      throw toProblem(e);
    }
  }
}
