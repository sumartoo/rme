import { Module } from '@nestjs/common';
import { AdjustmentsController } from './adjustments.controller';
import { DispenseController } from './dispense.controller';
import { LocationsController } from './locations.controller';
import { PricesController } from './prices.controller';
import { ReceiptsController } from './receipts.controller';
import { OpnameController } from './opname.controller';
import { OtcController } from './otc.controller';
import { StockController } from './stock.controller';
import { SubstitutionController } from './substitution.controller';

/** Farmasi & persediaan (Stage 10). Butuh Db & CONFIG global (CoreModule). */
@Module({ controllers: [AdjustmentsController, DispenseController, LocationsController, OpnameController, OtcController,
  PricesController, ReceiptsController, StockController, SubstitutionController] })
export class PharmacyModule {}
