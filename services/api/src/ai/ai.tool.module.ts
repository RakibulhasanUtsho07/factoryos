import {
  Module,
} from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { SaasModule } from '../saas/saas.module';
import { AiToolRegistryService } from './tools/ai.tool.registry.service';
import { AiToolGatewayService } from './tools/ai.tool.gateway.service';





@Module({
  imports: [
    DatabaseModule,

    IamModule,
    SaasModule,
  ],

  providers: [
    AiToolRegistryService,

    AiToolGatewayService,
  ],

  exports: [
    AiToolRegistryService,

    AiToolGatewayService,
  ],
})
export class AiToolModule {}