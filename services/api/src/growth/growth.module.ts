import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';

import { GrowthOpportunityController } from './growth-opportunity.controller';
import { GrowthOpportunityService } from './growth-opportunity.service';

@Module({
  imports: [AuditModule, DatabaseModule, IamModule],
  controllers: [GrowthOpportunityController],
  providers: [GrowthOpportunityService],
  exports: [GrowthOpportunityService],
})
export class GrowthModule {}
