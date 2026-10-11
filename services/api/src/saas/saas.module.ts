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
import { SaasTenantDataTransferController } from './saas-tenant-data-transfer.controller';
import { SaasTenantDataTransferService } from './saas-tenant-data-transfer.service';
import { SAAS_ENCRYPTED_TENANT_BUNDLE_STORE } from './saas-tenant-data-transfer.adapters';
import { SaasEncryptedTenantBundleStore } from './saas-encrypted-tenant-bundle.store';
import { SaasTenantDataTransferWorkerService } from './saas-tenant-data-transfer.worker';
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
    SaasTenantDataTransferController,
  ],
  providers: [
    SaasUsageService,
    SaasSubscriptionService,
    SaasSandboxService,
    SaasReleaseRolloutService,
    SaasDeploymentProfileService,
    SaasTenantDataTransferService,
    SaasEncryptedTenantBundleStore,
    { provide: SAAS_ENCRYPTED_TENANT_BUNDLE_STORE, useExisting: SaasEncryptedTenantBundleStore },
    SaasTenantDataTransferWorkerService,
  ],
  exports: [
    SaasUsageService,
    SaasSubscriptionService,
    SaasSandboxService,
    SaasReleaseRolloutService,
    SaasDeploymentProfileService,
    SaasTenantDataTransferService,
    SaasTenantDataTransferWorkerService,
  ],
})
export class SaasModule {}
