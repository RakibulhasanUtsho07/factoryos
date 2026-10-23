import {
  Module,
} from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { SaasModule } from '../saas/saas.module';
import { AiArtifactProvenanceService } from './artifacts/ai.artifact.provenance.service';
import { AiToolRegistryService } from './tools/ai.tool.registry.service';
import { AiToolGatewayService } from './tools/ai.tool.gateway.service';
import { AiModelProviderGatewayService } from './ai.model.provider.gateway.service';





@Module({
  imports: [
    DatabaseModule,

    IamModule,

    SaasModule,
  ],

  providers: [
    AiArtifactProvenanceService,
    AiModelProviderGatewayService,
    AiToolRegistryService,

    AiToolGatewayService,
  ],

  exports: [
    AiArtifactProvenanceService,
    AiModelProviderGatewayService,
    AiToolRegistryService,

    AiToolGatewayService,
  ],
})
export class AiToolModule {}