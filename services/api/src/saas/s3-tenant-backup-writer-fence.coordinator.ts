import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { SaasTenantBackupWriterFenceService, BackupWriterFenceView } from './saas-tenant-backup-writer-fence.service';
import {
  S3TenantBackupWriterFenceProvider,
  S3TenantBackupWriterFenceRemovalEvidence,
} from './s3-tenant-backup-writer-fence.provider';
import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';

/**
 * Binds the provider bucket-policy mutation to the durable application ledger.
 * The policy statement is read back before FENCED is recorded. Unfinished
 * multipart uploads keep FENCING closed until they have been reconciled.
 */
@Injectable()
export class S3TenantBackupWriterFenceCoordinator {
  constructor(
    private readonly lifecycle: SaasTenantBackupWriterFenceService,
    private readonly provider: S3TenantBackupWriterFenceProvider,
  ) {}

  async installAndRecordFence(input: {
    tenantId: string;
    category: SaasTransferDatasetCategory;
    fenceId: string;
    writerInventoryDigest: string;
    fencedWriterCount: number;
  }): Promise<BackupWriterFenceView> {
    const current = await this.requireMatchingFence(input.tenantId, input.category, input.fenceId);
    if (current.state !== 'DRAINING' && current.state !== 'FENCING' && current.state !== 'FENCED') {
      throw new ConflictException('Provider writer fencing cannot run from the current lifecycle state');
    }

    if (current.state !== 'FENCED') {
      const drain = await this.lifecycle.advanceAfterDrain(input.tenantId, input.fenceId);
      if (!drain.readyForProviderFence || drain.activeWriterOperations !== 0 || drain.fence.state !== 'FENCING') {
        throw new ConflictException('Backup provider freeze is blocked until every registered writer operation has a confirmed terminal outcome');
      }
    }

    // The provider mutation is idempotent and may have succeeded even if the
    // prior process timed out. It reads the policy before and after each write.
    const evidence = await this.provider.installFence({
      tenantId: input.tenantId,
      category: input.category,
      fenceId: input.fenceId,
    });
    if (evidence.pendingMultipartUploads !== 0) {
      if (current.state === 'FENCED') {
        await this.lifecycle.requireRecovery(input.tenantId, input.fenceId, 'MULTIPART_UPLOADS_REMAINING');
      }
      throw new ConflictException('S3 write-deny policy is installed and read back, but unfinished multipart uploads remain; keep the fence closed and reconcile those uploads');
    }

    return this.lifecycle.recordProviderFenceInstalled({
      tenantId: input.tenantId,
      fenceId: input.fenceId,
      providerFenceReference: evidence.providerFenceReference,
      providerPolicyDigest: evidence.providerPolicyDigest,
      writerInventoryDigest: input.writerInventoryDigest,
      fencedWriterCount: input.fencedWriterCount,
    });
  }

  /**
   * Commit the next writer epoch in the durable ledger before removing the
   * provider deny. If the process crashes or policy removal is uncertain,
   * application writes remain gated until retry; the provider policy may
   * continue denying writes, causing temporary unavailability rather than
   * allowing erasure to overtake a writer.
   */
  async releaseAfterTombstoneReplay(input: {
    tenantId: string;
    category: SaasTransferDatasetCategory;
    fenceId: string;
    reviewedByUserId: string;
    releaseWriterInventoryDigest: string;
    releaseWriterCount: number;
    tombstoneReplayReference: string;
    nextWriterEpoch: number;
  }): Promise<{ fence: BackupWriterFenceView; providerRelease: S3TenantBackupWriterFenceRemovalEvidence }> {
    const current = await this.requireMatchingFence(input.tenantId, input.category, input.fenceId);
    if (current.state !== 'ERASURE_VERIFIED' && current.state !== 'RELEASED') {
      throw new ConflictException('Provider write-deny policy cannot be released before zero-residual erasure verification');
    }

    const plan = await this.provider.planFenceRemoval({
      tenantId: input.tenantId,
      category: input.category,
      fenceId: input.fenceId,
    });
    if (current.state === 'ERASURE_VERIFIED' && !plan.policyPresent) {
      await this.lifecycle.requireRecovery(input.tenantId, input.fenceId, 'PROVIDER_FENCE_POLICY_MISSING');
      throw new ConflictException('The expected S3 deny statement is absent before durable release; recovery is required');
    }

    let released = current;
    if (current.state === 'ERASURE_VERIFIED') {
      released = await this.lifecycle.releaseAfterTombstoneReplay({
        tenantId: input.tenantId,
        fenceId: input.fenceId,
        reviewedByUserId: input.reviewedByUserId,
        providerReleaseReference: plan.providerFenceReference,
        releasePolicyDigest: plan.releasePolicyDigest,
        releaseWriterInventoryDigest: input.releaseWriterInventoryDigest,
        releaseWriterCount: input.releaseWriterCount,
        tombstoneReplayReference: input.tombstoneReplayReference,
        nextWriterEpoch: input.nextWriterEpoch,
      });
    } else {
      // Idempotent crash-recovery path: only retry the release sealed in the
      // database; new or substituted release evidence is never accepted.
      if (current.reviewedByUserId !== input.reviewedByUserId
        || current.releaseReference !== plan.providerFenceReference
        || current.releasePolicyDigest !== plan.releasePolicyDigest
        || current.releaseWriterInventoryDigest !== input.releaseWriterInventoryDigest
        || current.releaseWriterCount !== input.releaseWriterCount
        || current.tombstoneReplayReference !== input.tombstoneReplayReference
        || current.nextWriterEpoch !== input.nextWriterEpoch) {
        throw new ConflictException('Release retry does not match the durable provider-release evidence');
      }
    }

    try {
      const providerRelease = await this.provider.removeFence({
        tenantId: input.tenantId,
        category: input.category,
        fenceId: input.fenceId,
        expectedCurrentPolicyDigest: plan.currentPolicyDigest,
        expectedReleasePolicyDigest: plan.releasePolicyDigest,
      });
      return { fence: released, providerRelease };
    } catch {
      throw new ServiceUnavailableException('Writer epoch and reviewed release are durable, but S3 policy removal is not yet confirmed; retry release reconciliation while keeping producer activation gated');
    }
  }

  private async requireMatchingFence(
    tenantId: string,
    category: SaasTransferDatasetCategory,
    fenceId: string,
  ): Promise<BackupWriterFenceView> {
    const fence = await this.lifecycle.getFence(tenantId, category);
    if (!fence || fence.fenceId !== fenceId) throw new NotFoundException('Backup writer fence not found for tenant/category');
    return fence;
  }
}
