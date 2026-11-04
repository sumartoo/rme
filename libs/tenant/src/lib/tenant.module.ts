import { Module } from '@nestjs/common';
import { TenantExportController } from './export.controller';
import { TenantProfileController } from './profile.controller';

/** Administrasi klinik oleh tenant admin (Stage 5): profil & kop (PLT-FR-007), ekspor data (PLT-FR-008). Butuh CONFIG, Db, STORAGE global. */
@Module({ controllers: [TenantProfileController, TenantExportController] })
export class TenantModule {}
