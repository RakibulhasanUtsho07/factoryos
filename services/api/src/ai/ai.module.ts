import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { CbbModule } from '../cbb/cbb.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { PolicyModule } from '../policy/policy.module';

import { AiAgentCatalogueController } from './agents/ai.agent.catalogue.controller';
import { AiAgentCatalogueService } from './agents/ai.agent.catalogue.service';
import { AiAgentController } from './agents/ai.agent.controller';
import { AiAgentRuntimeService } from './agents/ai.agent.runtime.service';
import { AiAgentStudioController } from './agents/ai.agent.studio.controller';
import { AiAgentStudioService } from './agents/ai.agent.studio.service';
import { AiController } from './ai.controller';
import { AiRuntimeService } from './ai.runtime.service';
import { AiToolModule } from './ai.tool.module';

@Module({
  imports: [
    AuditModule,
    CbbModule,
    DatabaseModule,
    IamModule,
    PolicyModule,
    AiToolModule,
  ],
  controllers: [
    AiController,
    AiAgentController,
    AiAgentCatalogueController,
    AiAgentStudioController,
  ],
  providers: [
    AiRuntimeService,
    AiAgentRuntimeService,
    AiAgentCatalogueService,
    AiAgentStudioService,
  ],
  exports: [
    AiRuntimeService,
    AiAgentRuntimeService,
    AiAgentCatalogueService,
    AiAgentStudioService,
  ],
})
export class AiModule {}