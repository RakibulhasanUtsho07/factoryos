import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';

const CATEGORIES = new Set(Object.values(SaasTransferDatasetCategory));
const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SAFE_PRODUCER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export type BackupWriterOperationStatus = 'ACTIVE' | 'COMPLETED' | 'FAILED';
export type BackupWriterFenceState =
  | 'DRAINING' | 'FENCING' | 'FENCED' | 'ERASING'
  | 'ERASURE_VERIFIED' | 'RECOVERY_REQUIRED' | 'RELEASED';

interface WriterOperationRow extends QueryResultRow {
  tenant_id: string; operation_id: string; category_code: SaasTransferDatasetCategory;
  producer_id: string; writer_epoch: string | number; status: BackupWriterOperationStatus;
  provider_operation_reference: string | null; failure_code: string | null;
}
interface WriterFenceRow extends QueryResultRow {
  fence_id: string; tenant_id: string; category_code: SaasTransferDatasetCategory;
  request_id: string; request_version: string | number; run_id: string; source_export_digest: string;
  state: BackupWriterFenceState; writer_epoch: string | number; created_by_user_id: string;
  provider_fence_reference: string | null; provider_policy_digest: string | null;
  writer_inventory_digest: string | null; fenced_writer_count: string | number | null;
  erasure_manifest_digest: string | null; verification_reference: string | null;
  verified_residual_count: string | number | null; tombstone_replay_reference: string | null;
  release_policy_digest: string | null; release_reference: string | null;
  release_writer_inventory_digest: string | null; release_writer_count: string | number | null;
  next_writer_epoch: string | number | null; reviewed_by_user_id: string | null;
  recovery_from_state: BackupWriterFenceState | null; recovery_reason: string | null;
  recovery_attestation_reference: string | null; created_at: string; updated_at: string; released_at: string | null;
}

export interface BeginBackupWriterOperationInput {
  tenantId: string; category: SaasTransferDatasetCategory; operationId: string;
  producerId: string; writerEpoch: number;
}
export interface FinalizeBackupWriterOperationInput {
  tenantId: string; operationId: string; outcome: 'COMPLETED' | 'FAILED';
  providerOperationReference: string; failureCode?: string;
}
export interface BeginBackupWriterFenceInput {
  tenantId: string; requestId: string; requestVersion: number; runId: string;
  sourceExportDigest: string; categories: SaasTransferDatasetCategory[]; actorUserId: string;
}
export interface ProviderWriterFenceEvidence {
  tenantId: string; fenceId: string; providerFenceReference: string;
  providerPolicyDigest: string; writerInventoryDigest: string; fencedWriterCount: number;
}
export interface BackupWriterFenceView {
  fenceId: string; tenantId: string; category: SaasTransferDatasetCategory;
  requestId: string; requestVersion: number; runId: string; state: BackupWriterFenceState;
  writerEpoch: number; providerFenceReference: string | null; providerPolicyDigest: string | null;
  writerInventoryDigest: string | null; fencedWriterCount: number | null;
  erasureManifestDigest: string | null; verificationReference: string | null;
  verifiedResidualCount: number | null; tombstoneReplayReference: string | null;
  nextWriterEpoch: number | null; recoveryReason: string | null;
}

/**
 * Durable tenant/category gate for backup writers.
 * This ledger does not control arbitrary S3 credentials. A reviewed provider
 * control-plane integration must enforce and read back the deny policy, then
 * submit its independently verified evidence through recordProviderFenceInstalled.
 * Unknown upload outcomes remain ACTIVE; no TTL may let erasure overtake a write.
 */
@Injectable()
export class SaasTenantBackupWriterFenceService {
  constructor(private readonly database: DatabaseService) {}

  async beginWriteOperation(input: BeginBackupWriterOperationInput) {
    const tenantId = this.uuid(input?.tenantId, 'tenantId');
    const operationId = this.uuid(input?.operationId, 'operationId');
    const category = this.category(input?.category);
    const producerId = this.producer(input?.producerId);
    const writerEpoch = this.integer(input?.writerEpoch, 'writerEpoch', 1, Number.MAX_SAFE_INTEGER);
    const row = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const previous = await client.query<WriterOperationRow>(
        'SELECT * FROM saas_tenant_backup_writer_operations WHERE tenant_id=$1 AND operation_id=$2 FOR UPDATE',
        [tenantId, operationId],
      );
      if (previous.rows[0]) {
        const prior = previous.rows[0];
        if (prior.category_code !== category || prior.producer_id !== producerId || Number(prior.writer_epoch) !== writerEpoch) {
          throw new ConflictException('Backup writer operation ID is bound to a different immutable operation');
        }
        if (prior.status !== 'ACTIVE') throw new ConflictException('A terminal writer operation cannot be replayed as a new upload');
        const replayFence = await client.query<{ fence_id: string }>(
          "SELECT fence_id FROM saas_tenant_backup_writer_fences WHERE tenant_id=$1 AND category_code=$2 AND state<>'RELEASED' FOR SHARE",
          [tenantId, category],
        );
        if (replayFence.rows[0]) {
          throw new ConflictException('An active writer operation under a fence must be provider-reconciled, not retried as a fresh upload');
        }
        return prior;
      }
      const blocked = await client.query<{ fence_id: string }>(
        "SELECT fence_id FROM saas_tenant_backup_writer_fences WHERE tenant_id=$1 AND category_code=$2 AND state<>'RELEASED' FOR SHARE",
        [tenantId, category],
      );
      if (blocked.rows[0]) throw new ConflictException('Backup writes are fenced for this tenant/category');
      const latest = await client.query<{ next_writer_epoch: string | number }>(
        "SELECT next_writer_epoch FROM saas_tenant_backup_writer_fences WHERE tenant_id=$1 AND category_code=$2 AND state='RELEASED' ORDER BY released_at DESC,fence_id DESC LIMIT 1",
        [tenantId, category],
      );
      const expectedEpoch = latest.rows[0] ? Number(latest.rows[0].next_writer_epoch) : 1;
      if (writerEpoch !== expectedEpoch) throw new ConflictException('Backup writer epoch is stale; use the current tombstone-reconciled generation');
      const inserted = await client.query<WriterOperationRow>(
        "INSERT INTO saas_tenant_backup_writer_operations (tenant_id,operation_id,category_code,producer_id,writer_epoch,status) VALUES ($1,$2,$3,$4,$5,'ACTIVE') RETURNING *",
        [tenantId, operationId, category, producerId, writerEpoch],
      );
      return inserted.rows[0]!;
    }, { tenantId, advisoryLockKey: 'saas-backup-writer:' + tenantId + ':' + category });
    return { operationId: row.operation_id, category: row.category_code, producerId: row.producer_id,
      writerEpoch: Number(row.writer_epoch), status: row.status };
  }

  /** Call only after the provider confirms the upload outcome; timeout means leave ACTIVE and reconcile. */
  async finalizeWriteOperation(input: FinalizeBackupWriterOperationInput) {
    const tenantId = this.uuid(input?.tenantId, 'tenantId');
    const operationId = this.uuid(input?.operationId, 'operationId');
    if (input?.outcome !== 'COMPLETED' && input?.outcome !== 'FAILED') {
      throw new BadRequestException('outcome must be COMPLETED or FAILED');
    }
    const providerReference = this.reference(input?.providerOperationReference, 'providerOperationReference');
    const failureCode = input.outcome === 'FAILED' ? this.failureCode(input.failureCode) : null;
    if (input.outcome === 'COMPLETED' && input.failureCode !== undefined) {
      throw new BadRequestException('failureCode is only allowed for a confirmed failed provider outcome');
    }
    const row = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const found = await client.query<WriterOperationRow>(
        'SELECT * FROM saas_tenant_backup_writer_operations WHERE tenant_id=$1 AND operation_id=$2 FOR UPDATE',
        [tenantId, operationId],
      );
      const current = found.rows[0];
      if (!current) throw new NotFoundException('Backup writer operation not found');
      if (current.status !== 'ACTIVE') {
        if (current.status === input.outcome && current.provider_operation_reference === providerReference
          && current.failure_code === failureCode) return current;
        throw new ConflictException('Writer operation already has a different terminal provider outcome');
      }
      const updated = await client.query<WriterOperationRow>(
        'UPDATE saas_tenant_backup_writer_operations SET status=$3,provider_operation_reference=$4,failure_code=$5,completed_at=clock_timestamp() WHERE tenant_id=$1 AND operation_id=$2 AND status=\'ACTIVE\' RETURNING *',
        [tenantId, operationId, input.outcome, providerReference, failureCode],
      );
      if (!updated.rows[0]) throw new ConflictException('Writer operation changed while it was being finalized');
      return updated.rows[0];
    }, { tenantId, advisoryLockKey: 'saas-backup-writer-op:' + tenantId + ':' + operationId });
    return { operationId: row.operation_id, status: row.status };
  }

  async beginErasureFence(input: BeginBackupWriterFenceInput): Promise<BackupWriterFenceView[]> {
    const tenantId = this.uuid(input?.tenantId, 'tenantId');
    const requestId = this.uuid(input?.requestId, 'requestId');
    const runId = this.uuid(input?.runId, 'runId');
    const actorUserId = this.uuid(input?.actorUserId, 'actorUserId');
    const requestVersion = this.integer(input?.requestVersion, 'requestVersion', 1, Number.MAX_SAFE_INTEGER);
    const sourceExportDigest = this.digest(input?.sourceExportDigest, 'sourceExportDigest');
    if (!Array.isArray(input?.categories) || input.categories.length === 0 || input.categories.length > CATEGORIES.size) {
      throw new BadRequestException('categories must be a non-empty list of supported dataset categories');
    }
    const categories = input.categories.map((value) => this.category(value)).sort();
    if (new Set(categories).size !== categories.length) throw new BadRequestException('categories must be unique');
    const fences: BackupWriterFenceView[] = [];
    for (const category of categories) {
      const row = await this.database.transaction(async (client) => {
        await this.lockTenant(client, tenantId);
        const runResult = await client.query<{ source_export_digest: string; status: string; categories: SaasTransferDatasetCategory[] | string }>(
          'SELECT source_export_digest,status,categories FROM saas_tenant_external_propagation_runs WHERE tenant_id=$1 AND request_id=$2 AND request_version=$3 AND run_id=$4 FOR SHARE',
          [tenantId, requestId, requestVersion, runId],
        );
        const run = runResult.rows[0];
        if (!run || run.status !== 'RUNNING' || run.source_export_digest !== sourceExportDigest
          || !this.parseCategories(run.categories).includes(category)) {
          throw new ConflictException('Writer fence must bind to the exact RUNNING erasure run, category and export digest');
        }
        const existing = await client.query<WriterFenceRow>(
          "SELECT * FROM saas_tenant_backup_writer_fences WHERE tenant_id=$1 AND category_code=$2 AND state<>'RELEASED' FOR UPDATE",
          [tenantId, category],
        );
        if (existing.rows[0]) {
          const prior = existing.rows[0];
          if (prior.request_id !== requestId || prior.run_id !== runId || Number(prior.request_version) !== requestVersion
            || prior.source_export_digest !== sourceExportDigest) {
            throw new ConflictException('Another erasure run owns the tenant/category backup writer fence');
          }
          return prior;
        }
        const latest = await client.query<{ next_writer_epoch: string | number }>(
          "SELECT next_writer_epoch FROM saas_tenant_backup_writer_fences WHERE tenant_id=$1 AND category_code=$2 AND state='RELEASED' ORDER BY released_at DESC,fence_id DESC LIMIT 1",
          [tenantId, category],
        );
        const writerEpoch = latest.rows[0] ? Number(latest.rows[0].next_writer_epoch) : 1;
        const inserted = await client.query<WriterFenceRow>(
          "INSERT INTO saas_tenant_backup_writer_fences (tenant_id,category_code,request_id,request_version,run_id,source_export_digest,state,writer_epoch,created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,'DRAINING',$7,$8) RETURNING *",
          [tenantId, category, requestId, requestVersion, runId, sourceExportDigest, writerEpoch, actorUserId],
        );
        return inserted.rows[0]!;
      }, { tenantId, advisoryLockKey: 'saas-backup-writer:' + tenantId + ':' + category });
      fences.push(this.mapFence(row));
    }
    return fences;
  }

  async advanceAfterDrain(tenantValue: string, fenceValue: string) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const fenceId = this.uuid(fenceValue, 'fenceId');
    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const found = await client.query<WriterFenceRow>(
        'SELECT * FROM saas_tenant_backup_writer_fences WHERE tenant_id=$1 AND fence_id=$2 FOR UPDATE',
        [tenantId, fenceId],
      );
      const fence = found.rows[0];
      if (!fence) throw new NotFoundException('Backup writer fence not found');
      if (['FENCED', 'ERASING', 'ERASURE_VERIFIED'].includes(fence.state)) return { fence, ready: true, active: 0 };
      if (fence.state !== 'DRAINING' && fence.state !== 'FENCING') {
        throw new ConflictException('Backup writer fence is not in a drainable lifecycle state');
      }
      const active = await this.activeWriterCount(client, tenantId, fence.category_code);
      if (active > 0) return { fence, ready: false, active };
      if (fence.state === 'DRAINING') {
        const updated = await client.query<WriterFenceRow>(
          "UPDATE saas_tenant_backup_writer_fences SET state='FENCING',updated_at=clock_timestamp() WHERE tenant_id=$1 AND fence_id=$2 AND state='DRAINING' RETURNING *",
          [tenantId, fenceId],
        );
        return { fence: updated.rows[0]!, ready: true, active: 0 };
      }
      return { fence, ready: true, active: 0 };
    }, { tenantId, advisoryLockKey: 'saas-backup-writer-fence:' + tenantId + ':' + fenceId });
    return { fence: this.mapFence(result.fence), readyForProviderFence: result.ready, activeWriterOperations: result.active };
  }

  async recordProviderFenceInstalled(input: ProviderWriterFenceEvidence): Promise<BackupWriterFenceView> {
    const tenantId = this.uuid(input?.tenantId, 'tenantId');
    const fenceId = this.uuid(input?.fenceId, 'fenceId');
    const providerReference = this.reference(input?.providerFenceReference, 'providerFenceReference');
    const policyDigest = this.digest(input?.providerPolicyDigest, 'providerPolicyDigest');
    const inventoryDigest = this.digest(input?.writerInventoryDigest, 'writerInventoryDigest');
    const writerCount = this.integer(input?.fencedWriterCount, 'fencedWriterCount', 1, 100000);
    const row = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const found = await client.query<WriterFenceRow>(
        'SELECT * FROM saas_tenant_backup_writer_fences WHERE tenant_id=$1 AND fence_id=$2 FOR UPDATE',
        [tenantId, fenceId],
      );
      const current = found.rows[0];
      if (!current) throw new NotFoundException('Backup writer fence not found');
      if (current.state === 'FENCED') {
        if (current.provider_fence_reference === providerReference && current.provider_policy_digest === policyDigest
          && current.writer_inventory_digest === inventoryDigest && Number(current.fenced_writer_count) === writerCount) return current;
        throw new ConflictException('Different provider fence evidence is already sealed');
      }
      if (current.state !== 'FENCING') throw new ConflictException('Provider fence evidence requires FENCING state');
      if (await this.activeWriterCount(client, tenantId, current.category_code) !== 0) {
        throw new ConflictException('Cannot seal provider freeze while any upload outcome is unresolved');
      }
      const updated = await client.query<WriterFenceRow>(
        "UPDATE saas_tenant_backup_writer_fences SET state='FENCED',provider_fence_reference=$3,provider_policy_digest=$4,writer_inventory_digest=$5,fenced_writer_count=$6,updated_at=clock_timestamp() WHERE tenant_id=$1 AND fence_id=$2 AND state='FENCING' RETURNING *",
        [tenantId, fenceId, providerReference, policyDigest, inventoryDigest, writerCount],
      );
      return updated.rows[0]!;
    }, { tenantId, advisoryLockKey: 'saas-backup-writer-fence:' + tenantId + ':' + fenceId });
    return this.mapFence(row);
  }

  async markErasureStarted(tenantValue: string, fenceValue: string): Promise<BackupWriterFenceView> {
    return this.transitionFence(tenantValue, fenceValue, 'FENCED', 'ERASING');
  }

  async markErasureVerified(input: { tenantId: string; fenceId: string; manifestDigest: string; verificationReference: string; residualCopies: number }) {
    const tenantId = this.uuid(input?.tenantId, 'tenantId');
    const fenceId = this.uuid(input?.fenceId, 'fenceId');
    const manifestDigest = this.digest(input?.manifestDigest, 'manifestDigest');
    const verificationReference = this.reference(input?.verificationReference, 'verificationReference');
    const residuals = this.integer(input?.residualCopies, 'residualCopies', 0, Number.MAX_SAFE_INTEGER);
    if (residuals !== 0) throw new ConflictException('Backup erasure cannot be verified while residual copies remain');
    const row = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const found = await client.query<WriterFenceRow>(
        'SELECT * FROM saas_tenant_backup_writer_fences WHERE tenant_id=$1 AND fence_id=$2 FOR UPDATE',
        [tenantId, fenceId],
      );
      const current = found.rows[0];
      if (!current) throw new NotFoundException('Backup writer fence not found');
      if (current.state === 'ERASURE_VERIFIED' && current.erasure_manifest_digest === manifestDigest
        && current.verification_reference === verificationReference && Number(current.verified_residual_count) === 0) return current;
      if (current.state !== 'ERASING') throw new ConflictException('Backup verification requires ERASING state');
      if (await this.activeWriterCount(client, tenantId, current.category_code) !== 0) {
        throw new ConflictException('Writer outcome is unresolved; erasure cannot be verified');
      }
      const updated = await client.query<WriterFenceRow>(
        "UPDATE saas_tenant_backup_writer_fences SET state='ERASURE_VERIFIED',erasure_manifest_digest=$3,verification_reference=$4,verified_residual_count=0,updated_at=clock_timestamp() WHERE tenant_id=$1 AND fence_id=$2 AND state='ERASING' RETURNING *",
        [tenantId, fenceId, manifestDigest, verificationReference],
      );
      return updated.rows[0]!;
    }, { tenantId, advisoryLockKey: 'saas-backup-writer-fence:' + tenantId + ':' + fenceId });
    return this.mapFence(row);
  }

  async requireRecovery(tenantValue: string, fenceValue: string, reasonValue: string): Promise<BackupWriterFenceView> {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const fenceId = this.uuid(fenceValue, 'fenceId');
    const reason = this.failureCode(reasonValue);
    const row = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const found = await client.query<WriterFenceRow>(
        'SELECT * FROM saas_tenant_backup_writer_fences WHERE tenant_id=$1 AND fence_id=$2 FOR UPDATE',
        [tenantId, fenceId],
      );
      const current = found.rows[0];
      if (!current) throw new NotFoundException('Backup writer fence not found');
      if (current.state === 'RELEASED') throw new ConflictException('A released fence cannot be put into recovery');
      if (current.state === 'RECOVERY_REQUIRED' && current.recovery_reason === reason) return current;
      const updated = await client.query<WriterFenceRow>(
        "UPDATE saas_tenant_backup_writer_fences SET state='RECOVERY_REQUIRED',recovery_from_state=$3,recovery_reason=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND fence_id=$2 RETURNING *",
        [tenantId, fenceId, current.state, reason],
      );
      return updated.rows[0]!;
    }, { tenantId, advisoryLockKey: 'saas-backup-writer-fence:' + tenantId + ':' + fenceId });
    return this.mapFence(row);
  }

  async resumeAfterRecovery(input: {
    tenantId: string; fenceId: string; providerFenceReference: string; providerPolicyDigest: string;
    writerInventoryDigest: string; fencedWriterCount: number; recoveryAttestationReference: string;
  }): Promise<BackupWriterFenceView> {
    const tenantId = this.uuid(input?.tenantId, 'tenantId');
    const fenceId = this.uuid(input?.fenceId, 'fenceId');
    const providerReference = this.reference(input?.providerFenceReference, 'providerFenceReference');
    const policyDigest = this.digest(input?.providerPolicyDigest, 'providerPolicyDigest');
    const inventoryDigest = this.digest(input?.writerInventoryDigest, 'writerInventoryDigest');
    const writerCount = this.integer(input?.fencedWriterCount, 'fencedWriterCount', 1, 100000);
    const attestation = this.reference(input?.recoveryAttestationReference, 'recoveryAttestationReference');
    const row = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const found = await client.query<WriterFenceRow>(
        'SELECT * FROM saas_tenant_backup_writer_fences WHERE tenant_id=$1 AND fence_id=$2 FOR UPDATE',
        [tenantId, fenceId],
      );
      const current = found.rows[0];
      if (!current) throw new NotFoundException('Backup writer fence not found');
      if (current.state !== 'RECOVERY_REQUIRED') throw new ConflictException('Fence must be RECOVERY_REQUIRED before resume');
      if (await this.activeWriterCount(client, tenantId, current.category_code) !== 0) {
        throw new ConflictException('Recovery is blocked while any upload outcome is unresolved');
      }
      const next: BackupWriterFenceState = current.erasure_manifest_digest
        && current.verification_reference && Number(current.verified_residual_count) === 0 ? 'ERASURE_VERIFIED' : 'FENCED';
      const updated = await client.query<WriterFenceRow>(
        'UPDATE saas_tenant_backup_writer_fences SET state=$3,provider_fence_reference=$4,provider_policy_digest=$5,writer_inventory_digest=$6,fenced_writer_count=$7,recovery_attestation_reference=$8,recovery_from_state=NULL,recovery_reason=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND fence_id=$2 AND state=\'RECOVERY_REQUIRED\' RETURNING *',
        [tenantId, fenceId, next, providerReference, policyDigest, inventoryDigest, writerCount, attestation],
      );
      return updated.rows[0]!;
    }, { tenantId, advisoryLockKey: 'saas-backup-writer-fence:' + tenantId + ':' + fenceId });
    return this.mapFence(row);
  }

  async releaseAfterTombstoneReplay(input: {
    tenantId: string; fenceId: string; reviewedByUserId: string; providerReleaseReference: string;
    releasePolicyDigest: string; releaseWriterInventoryDigest: string; releaseWriterCount: number;
    tombstoneReplayReference: string; nextWriterEpoch: number;
  }): Promise<BackupWriterFenceView> {
    const tenantId = this.uuid(input?.tenantId, 'tenantId');
    const fenceId = this.uuid(input?.fenceId, 'fenceId');
    const reviewer = this.uuid(input?.reviewedByUserId, 'reviewedByUserId');
    const releaseReference = this.reference(input?.providerReleaseReference, 'providerReleaseReference');
    const policyDigest = this.digest(input?.releasePolicyDigest, 'releasePolicyDigest');
    const inventoryDigest = this.digest(input?.releaseWriterInventoryDigest, 'releaseWriterInventoryDigest');
    const writerCount = this.integer(input?.releaseWriterCount, 'releaseWriterCount', 1, 100000);
    const tombstoneReplay = this.reference(input?.tombstoneReplayReference, 'tombstoneReplayReference');
    const nextEpoch = this.integer(input?.nextWriterEpoch, 'nextWriterEpoch', 2, Number.MAX_SAFE_INTEGER);
    const row = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const found = await client.query<WriterFenceRow>(
        'SELECT * FROM saas_tenant_backup_writer_fences WHERE tenant_id=$1 AND fence_id=$2 FOR UPDATE',
        [tenantId, fenceId],
      );
      const current = found.rows[0];
      if (!current) throw new NotFoundException('Backup writer fence not found');
      if (current.state !== 'ERASURE_VERIFIED') throw new ConflictException('Writer gate remains closed until zero-residual verification');
      if (reviewer === current.created_by_user_id) throw new ConflictException('Fence creation and release require independent actors');
      if (nextEpoch <= Number(current.writer_epoch)) throw new ConflictException('New writer epoch must advance beyond the fenced generation');
      if (await this.activeWriterCount(client, tenantId, current.category_code) !== 0) {
        throw new ConflictException('Writer fence cannot release with unresolved writer operations');
      }
      const updated = await client.query<WriterFenceRow>(
        "UPDATE saas_tenant_backup_writer_fences SET state='RELEASED',tombstone_replay_reference=$3,release_policy_digest=$4,release_reference=$5,release_writer_inventory_digest=$6,release_writer_count=$7,next_writer_epoch=$8,reviewed_by_user_id=$9,released_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$1 AND fence_id=$2 AND state='ERASURE_VERIFIED' RETURNING *",
        [tenantId, fenceId, tombstoneReplay, policyDigest, releaseReference, inventoryDigest, writerCount, nextEpoch, reviewer],
      );
      return updated.rows[0]!;
    }, { tenantId, advisoryLockKey: 'saas-backup-writer-fence:' + tenantId + ':' + fenceId });
    return this.mapFence(row);
  }

  async getFence(tenantValue: string, categoryValue: SaasTransferDatasetCategory): Promise<BackupWriterFenceView | null> {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const category = this.category(categoryValue);
    const result = await this.database.query<WriterFenceRow>(
      'SELECT * FROM saas_tenant_backup_writer_fences WHERE tenant_id=$1 AND category_code=$2 ORDER BY created_at DESC,fence_id DESC LIMIT 1',
      [tenantId, category], { tenantId },
    );
    return result.rows[0] ? this.mapFence(result.rows[0]) : null;
  }

  private async transitionFence(tenantValue: string, fenceValue: string, expected: BackupWriterFenceState, next: BackupWriterFenceState): Promise<BackupWriterFenceView> {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const fenceId = this.uuid(fenceValue, 'fenceId');
    const row = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const found = await client.query<WriterFenceRow>(
        'SELECT * FROM saas_tenant_backup_writer_fences WHERE tenant_id=$1 AND fence_id=$2 FOR UPDATE', [tenantId, fenceId],
      );
      const current = found.rows[0];
      if (!current) throw new NotFoundException('Backup writer fence not found');
      if (current.state === next) return current;
      if (current.state !== expected) throw new ConflictException('Backup writer fence state changed; reconcile before retry');
      const updated = await client.query<WriterFenceRow>(
        'UPDATE saas_tenant_backup_writer_fences SET state=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND fence_id=$2 AND state=$4 RETURNING *',
        [tenantId, fenceId, next, expected],
      );
      return updated.rows[0]!;
    }, { tenantId, advisoryLockKey: 'saas-backup-writer-fence:' + tenantId + ':' + fenceId });
    return this.mapFence(row);
  }

  private async activeWriterCount(client: PoolClient, tenantId: string, category: SaasTransferDatasetCategory): Promise<number> {
    const result = await client.query<{ active_count: string | number }>(
      "SELECT count(*)::integer AS active_count FROM saas_tenant_backup_writer_operations WHERE tenant_id=$1 AND category_code=$2 AND status='ACTIVE'",
      [tenantId, category],
    );
    return Number(result.rows[0]?.active_count ?? 0);
  }
  private async lockTenant(client: PoolClient, tenantId: string): Promise<void> {
    const result = await client.query<{ id: string }>('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenantId]);
    if (!result.rows[0]) throw new NotFoundException('Tenant not found');
  }
  private mapFence(row: WriterFenceRow): BackupWriterFenceView {
    return {
      fenceId: row.fence_id, tenantId: row.tenant_id, category: row.category_code,
      requestId: row.request_id, requestVersion: Number(row.request_version), runId: row.run_id,
      state: row.state, writerEpoch: Number(row.writer_epoch), providerFenceReference: row.provider_fence_reference,
      providerPolicyDigest: row.provider_policy_digest, writerInventoryDigest: row.writer_inventory_digest,
      fencedWriterCount: row.fenced_writer_count === null ? null : Number(row.fenced_writer_count),
      erasureManifestDigest: row.erasure_manifest_digest, verificationReference: row.verification_reference,
      verifiedResidualCount: row.verified_residual_count === null ? null : Number(row.verified_residual_count),
      tombstoneReplayReference: row.tombstone_replay_reference,
      nextWriterEpoch: row.next_writer_epoch === null ? null : Number(row.next_writer_epoch), recoveryReason: row.recovery_reason,
    };
  }
  private parseCategories(value: SaasTransferDatasetCategory[] | string): SaasTransferDatasetCategory[] {
    let parsed: unknown = value;
    if (typeof value === 'string') {
      try { parsed = JSON.parse(value) as unknown; } catch { throw new ConflictException('Erasure run categories are malformed'); }
    }
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string' || !CATEGORIES.has(value as SaasTransferDatasetCategory))) {
      throw new ConflictException('Erasure run categories are malformed');
    }
    return parsed as SaasTransferDatasetCategory[];
  }
  private uuid(value: unknown, field: string): string {
    if (typeof value !== 'string' || !isUUID(value)) throw new BadRequestException(field + ' must be a UUID');
    return value.toLowerCase();
  }
  private category(value: unknown): SaasTransferDatasetCategory {
    if (typeof value !== 'string' || !CATEGORIES.has(value as SaasTransferDatasetCategory)) {
      throw new BadRequestException('Unsupported dataset category');
    }
    return value as SaasTransferDatasetCategory;
  }
  private producer(value: unknown): string {
    if (typeof value !== 'string' || !SAFE_PRODUCER.test(value)) throw new BadRequestException('producerId has invalid characters');
    return value;
  }
  private reference(value: unknown, field: string): string {
    if (typeof value !== 'string' || !SAFE_REFERENCE.test(value) || value.includes('://')
      || /(secret|password|credential|access[-_]?key|token)/i.test(value)) {
      throw new BadRequestException(field + ' must be a non-secret opaque provider reference');
    }
    return value;
  }
  private digest(value: unknown, field: string): string {
    if (typeof value !== 'string' || !DIGEST.test(value)) throw new BadRequestException(field + ' must be a lowercase SHA-256 digest');
    return value;
  }
  private failureCode(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(value)) throw new BadRequestException('failure code must be a stable uppercase identifier');
    return value;
  }
  private integer(value: unknown, field: string, min: number, max: number): number {
    if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
      throw new BadRequestException(field + ' is outside supported integer bounds');
    }
    return value as number;
  }
}
