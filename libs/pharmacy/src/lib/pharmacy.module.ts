import { Module } from '@nestjs/common';
import { LocationsController } from './locations.controller';
import { PricesController } from './prices.controller';
import { ReceiptsController } from './receipts.controller';
import { StockController } from './stock.controller';

/** Farmasi & persediaan (Stage 10). Butuh Db & CONFIG global (CoreModule). */
@Module({ controllers: [LocationsController, PricesController, ReceiptsController, StockController] })
export class PharmacyModule {}
