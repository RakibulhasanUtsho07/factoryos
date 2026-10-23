import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';

import { InventoryController } from './inventory.controller';
import { InventoryCycleCountTaskController } from './inventory.cycle-count-task.controller';
import { InventoryAllocationPolicyController } from './inventory.allocation-policy.controller';
import { InventoryReplenishmentController } from './inventory.replenishment.controller';
import { InventoryLocationController } from './inventory.location.controller';
import { InventoryReservationService } from './inventory.reservation.service';
import { InventoryStockReconciliationService } from './inventory.stock-reconciliation.service';
import { InventoryCycleCountService } from './inventory.cycle-count.service';
import { InventoryCycleCountTaskService } from './inventory.cycle-count-task.service';
import { InventoryService } from './inventory.service';
import { InventoryReplenishmentService } from './inventory.replenishment.service';
import { InventoryLocationService } from './inventory.location.service';
import { TraceabilityController } from './traceability.controller';
import { TraceabilityService } from './traceability.service';
import { WmsMobileController } from './wms.mobile.controller';
import { WmsMobileService } from './wms.mobile.service';
import { UnitOfMeasureController } from './uom.controller';
import { UnitOfMeasureService } from './uom.service';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule],
  controllers: [InventoryController, InventoryCycleCountTaskController, InventoryAllocationPolicyController, InventoryReplenishmentController, InventoryLocationController, TraceabilityController, UnitOfMeasureController, WmsMobileController],
  providers: [InventoryService, InventoryReplenishmentService, InventoryReservationService, InventoryStockReconciliationService, InventoryCycleCountService, InventoryCycleCountTaskService, InventoryLocationService, TraceabilityService, UnitOfMeasureService, WmsMobileService],
  exports: [InventoryService, InventoryReservationService, TraceabilityService, UnitOfMeasureService],
})
export class InventoryModule {}
