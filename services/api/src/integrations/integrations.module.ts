import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationService } from './integration.service';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule],
  controllers: [IntegrationsController],
  providers: [IntegrationService],
  exports: [IntegrationService],
})
export class IntegrationsModule {}
