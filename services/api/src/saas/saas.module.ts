import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { SaasDeploymentProfileController } from './saas-deployment-profile.controller';
import { SaasDeploymentProfileService } from './saas-deployment-profile.service';
import { SaasReleaseRolloutController } from './saas-release-rollout.controller';
import { SaasReleaseRolloutService } from './saas-release-rollout.service';
import { SaasSandboxController } from './saas-sandbox.controller';
import { SaasSandboxService } from './saas-sandbox.service';
import { SaasSubscriptionController } from './saas-subscription.controller';
import { SaasSubscriptionService } from './saas-subscription.service';
import { SaasUsageController } from './saas-usage.controller';
import { SaasUsageService } from './saas-usage.service';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule],
  controllers: [
    SaasUsageController,
    SaasSubscriptionController,
    SaasSandboxController,
    SaasReleaseRolloutController,
    SaasDeploymentProfileController,
  ],
  providers: [
    SaasUsageService,
    SaasSubscriptionService,
    SaasSandboxService,
    SaasReleaseRolloutService,
    SaasDeploymentProfileService,
  ],
  exports: [
    SaasUsageService,
    SaasSubscriptionService,
    SaasSandboxService,
    SaasReleaseRolloutService,
    SaasDeploymentProfileService,
  ],
})
export class SaasModule {}
