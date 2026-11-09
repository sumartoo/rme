import { Module } from '@nestjs/common';
import { InvoiceController } from './invoice.controller';
import { PaymentController } from './payment.controller';

/** Kasir & tagihan (Stage 11). Butuh Db & CONFIG global (CoreModule). */
@Module({ controllers: [InvoiceController, PaymentController] })
export class BillingModule {}
