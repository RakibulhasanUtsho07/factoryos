import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';

import { InventoryController } from './inventory.controller';
import { InventoryLocationController } from './inventory.location.controller';
import { InventoryReservationService } from './inventory.reservation.service';
import { InventoryStockReconciliationService } from './inventory.stock-reconciliation.service';
import { InventoryCycleCountService } from './inventory.cycle-count.service';
import { InventoryService } from './inventory.service';
import { InventoryLocationService } from './inventory.location.service';
import { TraceabilityController } from './traceability.controller';
import { TraceabilityService } from './traceability.service';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule],
  controllers: [InventoryController, InventoryLocationController, TraceabilityController],
  providers: [InventoryService, InventoryReservationService, InventoryStockReconciliationService, InventoryCycleCountService, InventoryLocationService, TraceabilityService],
  exports: [InventoryService, InventoryReservationService, TraceabilityService],
})
export class InventoryModule {}
