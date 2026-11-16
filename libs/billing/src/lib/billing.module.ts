import { Module } from '@nestjs/common';
import { CONFIG, type AppConfig } from '@clinicrme/shared';
import { CorrectionController } from './correction.controller';
import { PAYMENT_GATEWAY, SimulatorGateway } from './gateway';
import { InvoiceController } from './invoice.controller';
import { OversightController } from './oversight.controller';
import { PaymentController } from './payment.controller';
import { QrisController } from './qris.controller';

/** Kasir & tagihan (Stage 11). Butuh Db & CONFIG global (CoreModule). Adapter QRIS dipilih dari konfigurasi (OD-039). */
@Module({
  controllers: [InvoiceController, PaymentController, QrisController, CorrectionController, OversightController],
  providers: [{ provide: PAYMENT_GATEWAY, inject: [CONFIG], useFactory: (cfg: AppConfig) => new SimulatorGateway(cfg.paymentGateway.secret) }],
})
export class BillingModule {}
