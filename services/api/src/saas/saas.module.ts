import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { SaasSandboxController } from './saas-sandbox.controller';
import { SaasSandboxService } from './saas-sandbox.service';
import { SaasSubscriptionController } from './saas-subscription.controller';
import { SaasSubscriptionService } from './saas-subscription.service';
import { SaasUsageController } from './saas-usage.controller';
import { SaasUsageService } from './saas-usage.service';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule],
  controllers: [SaasUsageController, SaasSubscriptionController, SaasSandboxController],
  providers: [SaasUsageService, SaasSubscriptionService, SaasSandboxService],
  exports: [SaasUsageService, SaasSubscriptionService, SaasSandboxService],
})
export class SaasModule {}
