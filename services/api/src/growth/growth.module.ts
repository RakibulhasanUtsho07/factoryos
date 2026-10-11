import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';

import { GrowthOpportunityController } from './growth-opportunity.controller';
import { GrowthOpportunityService } from './growth-opportunity.service';
import { GrowthScenarioExperimentController } from './growth-scenario-experiment.controller';
import { GrowthScenarioExperimentService } from './growth-scenario-experiment.service';

@Module({
  imports: [AuditModule, DatabaseModule, IamModule],
  controllers: [GrowthOpportunityController, GrowthScenarioExperimentController],
  providers: [GrowthOpportunityService, GrowthScenarioExperimentService],
  exports: [GrowthOpportunityService, GrowthScenarioExperimentService],
})
export class GrowthModule {}
