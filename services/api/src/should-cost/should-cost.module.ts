import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { ShouldCostProfilesController, ShouldCostAssessmentsController } from './should-cost.controller';
import { ShouldCostService } from './should-cost.service';
@Module({
 imports:[DatabaseModule,AuditModule,IamModule],
 controllers:[ShouldCostProfilesController,ShouldCostAssessmentsController],
 providers:[ShouldCostService],
 exports:[ShouldCostService],
})
export class ShouldCostModule {}
