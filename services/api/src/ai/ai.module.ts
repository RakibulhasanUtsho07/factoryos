import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { CbbModule } from '../cbb/cbb.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { PolicyModule } from '../policy/policy.module';

import { AiAgentCatalogueController } from './agents/ai.agent.catalogue.controller';
import { AiAgentCatalogueService } from './agents/ai.agent.catalogue.service';
import { AiAgentEvaluationController } from './agents/ai.agent.evaluation.controller';
import { AiAgentEvaluationService } from './agents/ai.agent.evaluation.service';
import { AiAgentController } from './agents/ai.agent.controller';
import { AiAgentRuntimeService } from './agents/ai.agent.runtime.service';
import { AiAgentStudioController } from './agents/ai.agent.studio.controller';
import { AiAgentStudioService } from './agents/ai.agent.studio.service';
import { AiAgentStudioPolicySimulationController } from './agents/ai.agent.studio.policy.simulation.controller';
import { AiAgentStudioPolicySimulationService } from './agents/ai.agent.studio.policy.simulation.service';
import { AiAgentStudioPromotionController } from './agents/ai.agent.studio.promotion.controller';
import { AiAgentStudioPromotionService } from './agents/ai.agent.studio.promotion.service';
import { AiAgentStudioRunController } from './agents/ai.agent.studio.run.controller';
import { AiAgentStudioRunService } from './agents/ai.agent.studio.run.service';
import { AiAgentStudioDraftController } from './agents/ai.agent.studio.draft.controller';
import { AiAgentStudioDraftService } from './agents/ai.agent.studio.draft.service';
import { AiAgentStudioTemplateController } from './agents/ai.agent.studio.template.controller';
import { AiAgentStudioTemplateService } from './agents/ai.agent.studio.template.service';
import { AiController } from './ai.controller';
import { AiRuntimeService } from './ai.runtime.service';
import { AiOperationalEvaluationService } from './ai.operational.evaluation.service';
import { AiToolModule } from './ai.tool.module';
import { AiArtifactProvenanceController } from './artifacts/ai.artifact.provenance.controller';

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
    AiArtifactProvenanceController,
    AiController,
    AiAgentController,
    AiAgentCatalogueController,
    AiAgentEvaluationController,
    AiAgentStudioController,
    AiAgentStudioRunController,
    AiAgentStudioPolicySimulationController,
    AiAgentStudioPromotionController,
    AiAgentStudioDraftController,
    AiAgentStudioTemplateController,
  ],
  providers: [
    AiRuntimeService,
    AiOperationalEvaluationService,
    AiAgentRuntimeService,
    AiAgentCatalogueService,
    AiAgentEvaluationService,
    AiAgentStudioService,
    AiAgentStudioRunService,
    AiAgentStudioPolicySimulationService,
    AiAgentStudioPromotionService,
    AiAgentStudioDraftService,
    AiAgentStudioTemplateService,
  ],
  exports: [
    AiRuntimeService,
    AiOperationalEvaluationService,
    AiAgentRuntimeService,
    AiAgentCatalogueService,
    AiAgentEvaluationService,
    AiAgentStudioService,
    AiAgentStudioRunService,
    AiAgentStudioPolicySimulationService,
    AiAgentStudioPromotionService,
    AiAgentStudioDraftService,
    AiAgentStudioTemplateService,
  ],
})
export class AiModule {}
