import { Module } from '@nestjs/common';
import { ConsentDocumentsController } from './consent-documents.controller';
import { PatientController } from './patient.controller';

/** Master pasien (Stage 8 batch 1). Butuh CONFIG & Db global (CoreModule). */
@Module({ controllers: [PatientController, ConsentDocumentsController] })
export class PatientModule {}
