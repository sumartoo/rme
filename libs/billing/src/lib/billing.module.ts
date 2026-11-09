import { Module } from '@nestjs/common';
import { InvoiceController } from './invoice.controller';

/** Kasir & tagihan (Stage 11). Butuh Db & CONFIG global (CoreModule). */
@Module({ controllers: [InvoiceController] })
export class BillingModule {}
