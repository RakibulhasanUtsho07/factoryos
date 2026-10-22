import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { MrpLiteController } from './mrp-lite.controller';
import { CapacityPlanningController } from './capacity-planning.controller';
import { CapacityPlanningService } from './capacity-planning.service';
import { MrpLiteService } from './mrp-lite.service';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule],
  controllers: [MrpLiteController, CapacityPlanningController],
  providers: [MrpLiteService, CapacityPlanningService],
  exports: [MrpLiteService],
})
export class MrpLiteModule {}
