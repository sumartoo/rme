import { Module } from '@nestjs/common';
import { ClinicalReportController } from './clinical-report.controller';

/** Laporan standar (Stage 14). Butuh Db global (CoreModule). */
@Module({ controllers: [ClinicalReportController] })
export class ReportingModule {}
