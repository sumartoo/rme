import { Module } from '@nestjs/common';
import { ReportExportController } from './report-export.controller';
import { ReportController } from './report.controller';

/** Laporan standar & ekspor (Stage 14). Butuh Db & STORAGE global (CoreModule). */
@Module({ controllers: [ReportController, ReportExportController] })
export class ReportingModule {}
