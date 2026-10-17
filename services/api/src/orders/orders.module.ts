import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { InventoryModule } from '../inventory/inventory.module';

import { OrderIdempotencyService } from './order-idempotency.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderProductionReportService } from './order-production-report.service';

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    IamModule,
    InventoryModule,
  ],

  controllers: [
    OrdersController,
  ],

  providers: [
    OrderIdempotencyService,
    OrdersService,
    OrderProductionReportService,
  ],

  exports: [
    OrderIdempotencyService,
    OrdersService,
    OrderProductionReportService,
  ],
})
export class OrdersModule {}