import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { UtilitiesController } from './utilities.controller';
import { UtilitiesClosureController } from './utilities-closure.controller';
import { UtilitiesService } from './utilities.service';
import { UtilitiesClosureService } from './utilities-closure.service';
import { UtilityWorkOrderCostAllocationService } from './utility-work-order-cost-allocation.service';

@Module({
  imports:[DatabaseModule,IamModule,AuditModule],
  controllers:[UtilitiesController,UtilitiesClosureController],
  providers:[UtilitiesService,UtilitiesClosureService,UtilityWorkOrderCostAllocationService],
  exports:[UtilitiesService,UtilitiesClosureService,UtilityWorkOrderCostAllocationService],
})
export class UtilitiesModule {}
