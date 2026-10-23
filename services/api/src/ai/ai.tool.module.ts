import {
  Module,
} from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { SaasModule } from '../saas/saas.module';
import { AiArtifactProvenanceService } from './artifacts/ai.artifact.provenance.service';
import { AiToolRegistryService } from './tools/ai.tool.registry.service';
import { AiToolGatewayService } from './tools/ai.tool.gateway.service';





@Module({
  imports: [
    DatabaseModule,

    IamModule,

    SaasModule,
  ],

  providers: [
    AiArtifactProvenanceService,
    AiToolRegistryService,

    AiToolGatewayService,
  ],

  exports: [
    AiArtifactProvenanceService,
    AiToolRegistryService,

    AiToolGatewayService,
  ],
})
export class AiToolModule {}