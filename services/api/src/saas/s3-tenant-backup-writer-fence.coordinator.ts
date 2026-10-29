import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { SaasTenantBackupWriterFenceService, BackupWriterFenceView, BeginBackupWriterFenceInput } from './saas-tenant-backup-writer-fence.service';
import { SaasTenantBackupWriterInventoryService } from './saas-tenant-backup-writer-inventory.service';
import { SaasTenantBackupProviderAcceptanceService } from './saas-tenant-backup-provider-acceptance.service';
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
interface BackupProviderAcceptanceBinding {
  configReference: string;
  adapterKey: string;
  adapterVersion: string;
}

@Injectable()
export class S3TenantBackupWriterFenceCoordinator {
  constructor(
    private readonly lifecycle: SaasTenantBackupWriterFenceService,
    private readonly provider: S3TenantBackupWriterFenceProvider,
    private readonly writerInventory: SaasTenantBackupWriterInventoryService,
    private readonly providerAcceptance: SaasTenantBackupProviderAcceptanceService,
  ) {}

  /**
   * Acquire provider and durable writer fences for a reviewed propagation run.
   * This method must complete before a BACKUP adapter performs its inventory.
   */
  async beginPropagationFence(input: BeginBackupWriterFenceInput & BackupProviderAcceptanceBinding): Promise<BackupWriterFenceView[]> {
    this.provider.getProviderAcceptanceReferences();
    // Validate both provider acceptance and writer inventory before creating DRAINING
    // fences so a missing/revoked review cannot unnecessarily pause tenant writers.
    for (const category of input.categories) {
      await this.providerAcceptance.requireCurrentAcceptedProviderAcceptance(
        input.tenantId, category, input.configReference, input.adapterKey, input.adapterVersion,
      );
      await this.writerInventory.requireCurrentAcceptedSnapshot(input.tenantId, category);
    }
    const fences = await this.lifecycle.beginErasureFence(input);
    const active: BackupWriterFenceView[] = [];
    for (const original of fences) {
      let fence = original;
      if (fence.state === 'RECOVERY_REQUIRED') {
        throw new ConflictException('Backup writer fence requires provider-attested recovery before this propagation may resume');
      }
      if (fence.state === 'DRAINING' || fence.state === 'FENCING') {
        fence = await this.installAndRecordFence({
          tenantId: input.tenantId, category: fence.category, fenceId: fence.fenceId,
          configReference: input.configReference, adapterKey: input.adapterKey, adapterVersion: input.adapterVersion,
        });
      }
      if (fence.state === 'FENCED') {
        fence = await this.lifecycle.markErasureStarted(input.tenantId, fence.fenceId);
      } else if (fence.state !== 'ERASING' && fence.state !== 'ERASURE_VERIFIED') {
        throw new ConflictException('Backup writer fence cannot enter propagation from its current lifecycle state');
      }
      await this.assertProviderAcceptanceCurrent(fence, input);
      await this.assertInventoryMatchesFence(fence);
      await this.assertProviderFenceMatches(fence);
      active.push(fence);
    }
    return active;
  }

  /** Recheck the exact provider policy before inventory or destructive adapter steps. */
  async assertFenceHeld(input: {
    tenantId: string; categories: SaasTransferDatasetCategory[];
  } & BackupProviderAcceptanceBinding): Promise<void> {
    for (const category of input.categories) {
      const fence = await this.lifecycle.getFence(input.tenantId, category);
      if (!fence) throw new NotFoundException('Backup writer fence not found for propagation category');
      if (fence.state !== 'ERASING' && fence.state !== 'ERASURE_VERIFIED') {
        throw new ConflictException('Backup writer fence is not held in an erasure lifecycle state');
      }
      await this.assertProviderAcceptanceCurrent(fence, input);
      await this.assertInventoryMatchesFence(fence);
      await this.assertProviderFenceMatches(fence);
    }
  }

  private async assertProviderAcceptanceCurrent(
    fence: BackupWriterFenceView,
    binding: BackupProviderAcceptanceBinding,
  ): Promise<void> {
    try {
      // Re-read deployment gates and the current accepted/unrevoked record before
      // inventory, deletion and verification; a revoked gate must preserve the deny.
      this.provider.getProviderAcceptanceReferences();
      await this.providerAcceptance.requireCurrentAcceptedProviderAcceptance(
        fence.tenantId, fence.category, binding.configReference, binding.adapterKey, binding.adapterVersion,
      );
    } catch {
      if (fence.state !== 'RELEASED') {
        try {
          await this.lifecycle.requireRecovery(fence.tenantId, fence.fenceId, 'PROVIDER_ACCEPTANCE_REVOKED');
        } catch {
          throw new ServiceUnavailableException('Provider acceptance is invalid and the recovery state could not be durably recorded; no further backup mutation is allowed');
        }
      }
      throw new ServiceUnavailableException('Current provider acceptance is missing, expired or revoked; backup mutation/release is blocked and any installed provider deny is retained');
    }
  }

  private async assertInventoryMatchesFence(fence: BackupWriterFenceView): Promise<void> {
    if (!fence.writerInventorySnapshotId || !fence.writerInventoryDigest
      || !Number.isSafeInteger(fence.fencedWriterCount) || (fence.fencedWriterCount ?? 0) < 1) {
      await this.lifecycle.requireRecovery(fence.tenantId, fence.fenceId, 'WRITER_INVENTORY_EVIDENCE_MISSING');
      throw new ConflictException('A durable reviewed writer inventory binding is required before backup copies can be touched');
    }
    let latest: Awaited<ReturnType<SaasTenantBackupWriterInventoryService['requireCurrentAcceptedSnapshot']>>;
    try {
      latest = await this.writerInventory.requireCurrentAcceptedSnapshot(fence.tenantId, fence.category);
    } catch {
      await this.lifecycle.requireRecovery(fence.tenantId, fence.fenceId, 'WRITER_INVENTORY_CHANGED');
      throw new ServiceUnavailableException('The latest reviewed writer inventory is unavailable; backup mutation/release is blocked and the provider deny remains');
    }
    if (latest.snapshotId !== fence.writerInventorySnapshotId
      || latest.manifestDigest !== fence.writerInventoryDigest
      || latest.entryCount !== fence.fencedWriterCount
      || latest.reviewedByUserId === fence.createdByUserId) {
      await this.lifecycle.requireRecovery(fence.tenantId, fence.fenceId, 'WRITER_INVENTORY_CHANGED');
      throw new ConflictException('The reviewed writer inventory no longer matches the durable provider fence; recovery is required while the deny remains');
    }
  }

  private async assertProviderFenceMatches(fence: BackupWriterFenceView): Promise<void> {
    if (!fence.providerFenceReference || !fence.providerPolicyDigest) {
      await this.lifecycle.requireRecovery(fence.tenantId, fence.fenceId, 'PROVIDER_FENCE_EVIDENCE_MISSING');
      throw new ConflictException('Backup provider-fence evidence is missing; recovery is required before touching copies');
    }
    let evidence: Awaited<ReturnType<S3TenantBackupWriterFenceProvider['inspectFence']>>;
    try {
      evidence = await this.provider.inspectFence({
        tenantId: fence.tenantId, category: fence.category, fenceId: fence.fenceId,
      });
    } catch {
      await this.lifecycle.requireRecovery(fence.tenantId, fence.fenceId, 'PROVIDER_FENCE_READBACK_FAILED');
      throw new ServiceUnavailableException('Provider fence read-back failed; backup inventory/deletion is blocked');
    }
    // providerPolicyDigest records the complete policy at installation time.
    // Sibling category fences in the same run legitimately change that digest;
    // the provider independently checks full digests during install/removal.
    // While held, verify the exact deny statement and unresolved multipart list.
    if (!evidence.installed || evidence.pendingMultipartUploads !== 0
      || evidence.providerFenceReference !== fence.providerFenceReference) {
      await this.lifecycle.requireRecovery(fence.tenantId, fence.fenceId,
        evidence.pendingMultipartUploads > 0 ? 'MULTIPART_UPLOADS_REMAINING' : 'PROVIDER_FENCE_POLICY_DRIFT');
      throw new ConflictException('Provider fence drift or unfinished multipart uploads detected; backup mutation is blocked for recovery');
    }
  }

  /** Persist verified zero-residual evidence without releasing the provider deny. */
  async recordPropagationVerification(input: {
    tenantId: string; categories: SaasTransferDatasetCategory[]; manifestDigest: string;
    verificationReference: string; residualCopies: number;
  } & BackupProviderAcceptanceBinding): Promise<BackupWriterFenceView[]> {
    if (input.residualCopies !== 0) {
      throw new ConflictException('Backup writer fence cannot be verified while residual copies remain');
    }
    const results: BackupWriterFenceView[] = [];
    for (const category of input.categories) {
      const current = await this.lifecycle.getFence(input.tenantId, category);
      if (!current) throw new NotFoundException('Backup writer fence not found for verified propagation category');
      if (current.state !== 'ERASING' && current.state !== 'ERASURE_VERIFIED') {
        throw new ConflictException('Backup writer fence must be ERASING before verification can be persisted');
      }
      await this.assertProviderAcceptanceCurrent(current, input);
      await this.assertInventoryMatchesFence(current);
      await this.assertProviderFenceMatches(current);
      results.push(await this.lifecycle.markErasureVerified({
        tenantId: input.tenantId, fenceId: current.fenceId, manifestDigest: input.manifestDigest,
        verificationReference: input.verificationReference, residualCopies: input.residualCopies,
      }));
    }
    return results;
  }

  async installAndRecordFence(input: {
    tenantId: string;
    category: SaasTransferDatasetCategory;
    fenceId: string;
  } & BackupProviderAcceptanceBinding): Promise<BackupWriterFenceView> {
    const current = await this.requireMatchingFence(input.tenantId, input.category, input.fenceId);
    await this.assertProviderAcceptanceCurrent(current, input);
    const inventory = await this.writerInventory.requireCurrentAcceptedSnapshot(input.tenantId, input.category);
    const providerAcceptance = this.provider.getProviderAcceptanceReferences();
    if (inventory.reviewedByUserId === current.createdByUserId) {
      throw new ConflictException('Writer inventory reviewer must be independent of the propagation/fence creator');
    }
    if (current.state === 'FENCED' && !current.writerInventorySnapshotId) {
      await this.lifecycle.requireRecovery(input.tenantId, input.fenceId, 'WRITER_INVENTORY_EVIDENCE_MISSING');
      throw new ConflictException('Existing provider fence has no reviewed inventory binding; recovery is required');
    }
    if (current.writerInventorySnapshotId && (
      current.writerInventorySnapshotId !== inventory.snapshotId
      || current.writerInventoryDigest !== inventory.manifestDigest
      || current.fencedWriterCount !== inventory.entryCount
    )) {
      await this.lifecycle.requireRecovery(input.tenantId, input.fenceId, 'WRITER_INVENTORY_CHANGED');
      throw new ConflictException('The writer inventory changed after the fence was sealed; recovery is required while the provider deny remains');
    }
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

    let confirmedInventory: Awaited<ReturnType<SaasTenantBackupWriterInventoryService['requireCurrentAcceptedSnapshot']>>;
    try {
      confirmedInventory = await this.writerInventory.requireCurrentAcceptedSnapshot(input.tenantId, input.category);
    } catch {
      await this.lifecycle.requireRecovery(input.tenantId, input.fenceId, 'WRITER_INVENTORY_CHANGED');
      throw new ServiceUnavailableException('Writer inventory could not be re-confirmed after provider fencing; the deny policy remains installed and recovery is required');
    }
    if (confirmedInventory.snapshotId !== inventory.snapshotId
      || confirmedInventory.manifestDigest !== inventory.manifestDigest
      || confirmedInventory.entryCount !== inventory.entryCount
      || confirmedInventory.reviewedByUserId !== inventory.reviewedByUserId) {
      await this.lifecycle.requireRecovery(input.tenantId, input.fenceId, 'WRITER_INVENTORY_CHANGED');
      throw new ConflictException('Writer inventory changed during provider fencing; the deny policy remains installed and recovery is required');
    }
    await this.assertProviderAcceptanceCurrent(current, input);

    return this.lifecycle.recordProviderFenceInstalled({
      tenantId: input.tenantId,
      fenceId: input.fenceId,
      providerFenceReference: evidence.providerFenceReference,
      providerPolicyDigest: evidence.providerPolicyDigest,
      writerInventoryDigest: inventory.manifestDigest,
      fencedWriterCount: inventory.entryCount,
      writerInventoryReference: inventory.inventoryReference,
      writerInventorySnapshotId: inventory.snapshotId,
      policyOwnershipReviewReference: providerAcceptance.policyOwnershipReviewReference,
      stagingAcceptanceReference: providerAcceptance.stagingAcceptanceReference,
      restoreReplayReference: providerAcceptance.restoreReplayReference,
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
  } & BackupProviderAcceptanceBinding): Promise<{ fence: BackupWriterFenceView; providerRelease: S3TenantBackupWriterFenceRemovalEvidence }> {
    const current = await this.requireMatchingFence(input.tenantId, input.category, input.fenceId);
    if (current.state !== 'ERASURE_VERIFIED' && current.state !== 'RELEASED') {
      throw new ConflictException('Provider write-deny policy cannot be released before zero-residual erasure verification');
    }
    await this.assertProviderAcceptanceCurrent(current, input);
    if (current.state === 'ERASURE_VERIFIED') await this.assertInventoryMatchesFence(current);

    const plan = await this.provider.planFenceRemoval({
      tenantId: input.tenantId,
      category: input.category,
      fenceId: input.fenceId,
    });
    if (current.state === 'ERASURE_VERIFIED' && !plan.policyPresent) {
      await this.lifecycle.requireRecovery(input.tenantId, input.fenceId, 'PROVIDER_FENCE_POLICY_MISSING');
      throw new ConflictException('The expected S3 deny statement is absent before durable release; recovery is required');
    }

    // Revalidate immediately before sealing the next epoch. A revoked/expired
    // acceptance keeps release blocked and the provider Deny installed.
    await this.assertProviderAcceptanceCurrent(current, input);
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

    // Revalidate again after the durable epoch release and immediately before
    // removing the provider Deny. If acceptance was revoked during the database
    // transition, leave the provider policy installed; availability may pause.
    await this.assertProviderAcceptanceCurrent(released, input);
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
