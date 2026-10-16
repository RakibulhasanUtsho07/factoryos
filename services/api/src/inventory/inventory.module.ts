import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';

import { InventoryController } from './inventory.controller';
import { InventoryReservationService } from './inventory.reservation.service';
import { InventoryStockReconciliationService } from './inventory.stock-reconciliation.service';
import { InventoryService } from './inventory.service';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule],
  controllers: [InventoryController],
  providers: [InventoryService, InventoryReservationService, InventoryStockReconciliationService],
  exports: [InventoryService, InventoryReservationService],
})
export class InventoryModule {}
