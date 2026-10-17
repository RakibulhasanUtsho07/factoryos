import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { ProductionWorkOrdersController } from './production-work-orders.controller';
import { ProductionWorkOrdersService } from './production-work-orders.service';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule],
  controllers: [ProductionWorkOrdersController],
  providers: [ProductionWorkOrdersService],
  exports: [ProductionWorkOrdersService],
})
export class ProductionWorkOrdersModule {}
