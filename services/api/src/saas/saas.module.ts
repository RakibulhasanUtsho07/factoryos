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
import { SaasTenantRetentionController } from './saas-tenant-retention.controller';
import { SaasTenantBackupWriterInventoryController } from './saas-tenant-backup-writer-inventory.controller';
import { SaasTenantBackupProviderAcceptanceController } from './saas-tenant-backup-provider-acceptance.controller';
import { SaasTenantExternalCopyCoverageController } from './saas-tenant-external-copy-coverage.controller';
import { SaasTenantDataTransferService } from './saas-tenant-data-transfer.service';
import { SaasTenantRetentionService } from './saas-tenant-retention.service';
import { SaasTenantGovernanceExecutionService } from './saas-tenant-governance-execution.service';
import { SaasTenantPropagationService } from './saas-tenant-propagation.service';
import { SAAS_TENANT_EXTERNAL_PROPAGATION_ADAPTERS, SAAS_TENANT_FINANCE_RETENTION_ADAPTER } from './saas-tenant-propagation.adapters';
import { SaasTenantFinanceRetentionService } from './saas-tenant-finance-retention.service';
import { SAAS_ENCRYPTED_TENANT_BUNDLE_STORE, SAAS_TENANT_TRANSFER_DATASET_SOURCE } from './saas-tenant-data-transfer.adapters';
import { SaasTenantPostgresDatasetSource } from './saas-tenant-postgres-dataset-source';
import { SaasEncryptedTenantBundleStore } from './saas-encrypted-tenant-bundle.store';
import { SaasTenantDataTransferWorkerService } from './saas-tenant-data-transfer.worker';
import { SAAS_TENANT_MIGRATION_TARGET_ADAPTER } from './saas-tenant-data-transfer.adapters';
import { SaasTenantPostgresMigrationTargetAdapter } from './saas-tenant-postgres-migration-target.adapter';
import { SaasSubscriptionController } from './saas-subscription.controller';
import { SaasSubscriptionService } from './saas-subscription.service';
import { SaasUsageController } from './saas-usage.controller';
import { SaasUsageService } from './saas-usage.service';
import { SaasBillingController } from './saas-billing.controller';
import { SaasBillingService } from './saas-billing.service';
import { StripeBillingProvider } from './stripe-billing.provider';
import { SaasPhysicalProvisioningController } from './saas-physical-provisioning.controller';
import { SaasPhysicalProvisioningService } from './saas-physical-provisioning.service';
import { SAAS_PHYSICAL_INFRASTRUCTURE_ADAPTERS } from './saas-physical-infrastructure.adapters';
import { KubernetesSaasPhysicalInfrastructureAdapter } from './kubernetes-saas-physical-infrastructure.adapter';
import { WmsPodS3ErasureAdapter } from './wms-pod-s3-erasure.adapter';
import { RedisCacheErasureAdapter } from './redis-cache-erasure.adapter';
import { S3TenantBackupErasureAdapter } from './s3-tenant-backup-erasure.adapter';
import { SaasTenantBackupWriterFenceService } from './saas-tenant-backup-writer-fence.service';
import { SaasTenantBackupWriterInventoryService } from './saas-tenant-backup-writer-inventory.service';
import { SaasTenantBackupProviderAcceptanceService } from './saas-tenant-backup-provider-acceptance.service';
import { SaasTenantExternalCopyCoverageService } from './saas-tenant-external-copy-coverage.service';
import { S3TenantBackupWriterFenceProvider } from './s3-tenant-backup-writer-fence.provider';
import { S3TenantBackupWriterFenceCoordinator } from './s3-tenant-backup-writer-fence.coordinator';
import { TenantCacheModule } from './tenant-cache.module';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule, TenantCacheModule],
  controllers: [
    SaasUsageController,
    SaasBillingController,
    SaasPhysicalProvisioningController,
    SaasSubscriptionController,
    SaasSandboxController,
    SaasReleaseRolloutController,
    SaasDeploymentProfileController,
    SaasTenantDataTransferController,
    SaasTenantRetentionController,
    SaasTenantBackupWriterInventoryController,
    SaasTenantBackupProviderAcceptanceController,
    SaasTenantExternalCopyCoverageController,
  ],
  providers: [
    SaasUsageService,
    SaasBillingService,
    StripeBillingProvider,
    SaasPhysicalProvisioningService,
    KubernetesSaasPhysicalInfrastructureAdapter,
    {
      provide: SAAS_PHYSICAL_INFRASTRUCTURE_ADAPTERS,
      useFactory: (adapter: KubernetesSaasPhysicalInfrastructureAdapter) => [adapter],
      inject: [KubernetesSaasPhysicalInfrastructureAdapter],
    },
    SaasSubscriptionService,
    SaasSandboxService,
    SaasReleaseRolloutService,
    SaasDeploymentProfileService,
    SaasTenantDataTransferService,
    SaasTenantRetentionService,
    SaasTenantGovernanceExecutionService,
    SaasTenantPropagationService,
    SaasTenantFinanceRetentionService,
    WmsPodS3ErasureAdapter,
    S3TenantBackupErasureAdapter,
    SaasTenantBackupWriterFenceService,
    SaasTenantBackupWriterInventoryService,
    SaasTenantBackupProviderAcceptanceService,
    SaasTenantExternalCopyCoverageService,
    S3TenantBackupWriterFenceProvider,
    S3TenantBackupWriterFenceCoordinator,
    {
      provide: SAAS_TENANT_EXTERNAL_PROPAGATION_ADAPTERS,
      useFactory: (podAdapter: WmsPodS3ErasureAdapter, cacheAdapter: RedisCacheErasureAdapter, backupAdapter: S3TenantBackupErasureAdapter) => [
        podAdapter,
        cacheAdapter,
        backupAdapter,
      ],
      inject: [WmsPodS3ErasureAdapter, RedisCacheErasureAdapter, S3TenantBackupErasureAdapter],
    },
    { provide: SAAS_TENANT_FINANCE_RETENTION_ADAPTER, useValue: null },
    SaasTenantPostgresDatasetSource,
    { provide: SAAS_TENANT_TRANSFER_DATASET_SOURCE, useExisting: SaasTenantPostgresDatasetSource },
    SaasTenantPostgresMigrationTargetAdapter,
    { provide: SAAS_TENANT_MIGRATION_TARGET_ADAPTER, useExisting: SaasTenantPostgresMigrationTargetAdapter },
    SaasEncryptedTenantBundleStore,
    { provide: SAAS_ENCRYPTED_TENANT_BUNDLE_STORE, useExisting: SaasEncryptedTenantBundleStore },
    SaasTenantDataTransferWorkerService,
  ],
  exports: [
    SaasUsageService,
    SaasBillingService,
    SaasSubscriptionService,
    SaasSandboxService,
    SaasReleaseRolloutService,
    SaasDeploymentProfileService,
    SaasTenantDataTransferService,
    SaasTenantRetentionService,
    SaasTenantGovernanceExecutionService,
    SaasTenantPropagationService,
    SaasTenantFinanceRetentionService,
    SaasTenantDataTransferWorkerService,
    SaasTenantBackupWriterFenceService,
    SaasTenantBackupWriterInventoryService,
    SaasTenantBackupProviderAcceptanceService,
    S3TenantBackupWriterFenceCoordinator,
  ],
})
export class SaasModule {}
