import { Module } from '@nestjs/common';
import { ClinicalReportController } from './clinical-report.controller';
import { FinanceReportController } from './finance-report.controller';

/** Laporan standar (Stage 14). Butuh Db global (CoreModule). */
@Module({ controllers: [ClinicalReportController, FinanceReportController] })
export class ReportingModule {}
