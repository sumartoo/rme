import { Module } from '@nestjs/common';
import { ChartController } from './chart.controller';
import { PatientClinicalController } from './patient-clinical.controller';
import { DocumentsController } from './documents.controller';
import { LabController } from './lab.controller';
import { PrescriptionController } from './prescription.controller';
import { SignController } from './sign.controller';
import { WorklistController } from './worklist.controller';

/** Rekam medis rawat jalan (Stage 9). Butuh Db & CONFIG global (CoreModule). */
@Module({ controllers: [WorklistController, ChartController, PatientClinicalController, SignController, PrescriptionController, LabController, DocumentsController] })
export class ClinicalModule {}
