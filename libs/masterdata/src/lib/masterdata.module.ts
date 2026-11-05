import { Module } from '@nestjs/common';
import { OrganizationController } from './organization.controller';
import { PractitionersController } from './practitioners.controller';

/** Master data klinik (Stage 7, MST-FR-*). Butuh CONFIG & Db global (CoreModule). */
@Module({ controllers: [OrganizationController, PractitionersController] })
export class MasterdataModule {}
