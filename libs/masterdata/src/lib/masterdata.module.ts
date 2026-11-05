import { Module } from '@nestjs/common';
import { OrganizationController } from './organization.controller';
import { PayersController } from './payers.controller';
import { PractitionersController } from './practitioners.controller';
import { ServicesController } from './services.controller';
import { SuppliesController } from './supplies.controller';

/** Master data klinik (Stage 7, MST-FR-*). Butuh CONFIG & Db global (CoreModule). */
@Module({ controllers: [OrganizationController, PractitionersController, ServicesController, PayersController, SuppliesController] })
export class MasterdataModule {}
