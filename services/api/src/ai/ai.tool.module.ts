import {
  Module,
} from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { AiToolRegistryService } from './tools/ai.tool.registry.service';
import { AiToolGatewayService } from './tools/ai.tool.gateway.service';





@Module({
  imports: [
    DatabaseModule,

    IamModule,
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