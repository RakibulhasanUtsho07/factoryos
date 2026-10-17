import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { ProcurementService } from './procurement.service';
import { GoodsReceiptService } from './goods-receipt.service';
import { GoodsReceiptsController } from './goods-receipt.controller';
import { PurchaseOrdersController, SuppliersController } from './procurement.controller';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule],
  controllers: [SuppliersController, PurchaseOrdersController, GoodsReceiptsController],
  providers: [ProcurementService, GoodsReceiptService],
  exports: [ProcurementService],
})
export class ProcurementModule {}
