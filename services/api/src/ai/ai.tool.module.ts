import {
  Module,
} from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { InventoryModule } from '../inventory/inventory.module';
import { IamModule } from '../iam/iam.module';
import { SaasModule } from '../saas/saas.module';
import { AiArtifactProvenanceService } from './artifacts/ai.artifact.provenance.service';
import { AiToolRegistryService } from './tools/ai.tool.registry.service';
import { AiToolGatewayService } from './tools/ai.tool.gateway.service';
import { AiModelProviderGatewayService } from './ai.model.provider.gateway.service';
import { AiOpenAiCompatibleProviderService } from './ai.openai-compatible.provider.service';





@Module({
  imports: [
    DatabaseModule,

    IamModule,

    SaasModule,
    InventoryModule,
  ],

  providers: [
    AiArtifactProvenanceService,
    AiModelProviderGatewayService,
    AiOpenAiCompatibleProviderService,
    AiToolRegistryService,

    AiToolGatewayService,
  ],

  exports: [
    AiArtifactProvenanceService,
    AiModelProviderGatewayService,
    AiOpenAiCompatibleProviderService,
    AiToolRegistryService,

    AiToolGatewayService,
  ],
})
export class AiToolModule {}