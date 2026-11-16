import { Module } from '@nestjs/common';
import { SatuSehatController } from './satusehat.controller';

/** Integrasi luar (Stage 12): SATUSEHAT. Butuh Db & CONFIG global (CoreModule). */
@Module({ controllers: [SatuSehatController] })
export class IntegrationModule {}
