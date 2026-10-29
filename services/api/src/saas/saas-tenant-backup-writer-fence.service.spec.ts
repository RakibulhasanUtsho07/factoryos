import { jest } from '@jest/globals';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { SaasTenantBackupWriterFenceService } from './saas-tenant-backup-writer-fence.service';
import { SaasTransferDatasetCategory as Category } from './dto/create-saas-schema-compatibility-rule.dto';

const tenant = 'c1000000-0000-4000-8000-000000000001';
const requestId = 'c2000000-0000-4000-8000-000000000002';
const runId = 'c3000000-0000-4000-8000-000000000003';
const actor = 'c4000000-0000-4000-8000-000000000004';
const digest = 'a'.repeat(64);

function mockDatabase(handler: (sql: string, values: unknown[]) => unknown) {
  const client = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => ({ rows: handler(sql, values) as never[], rowCount: 0 })),
  };
  const database = {
    transaction: jest.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(client)),
    query: jest.fn(async (sql: string, values: unknown[] = []) => ({ rows: handler(sql, values) as never[], rowCount: 0 })),
  };
  return { database, client };
}

describe('SaasTenantBackupWriterFenceService', () => {
  it('rejects malformed operation identity before touching the database', async () => {
    const { database } = mockDatabase(() => []);
    const service = new SaasTenantBackupWriterFenceService(database as never);
    await expect(service.beginWriteOperation({
      tenantId: tenant, category: 'NOT_A_CATEGORY' as Category, operationId: 'bad-uuid',
      producerId: 'backup-worker', writerEpoch: 1,
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('refuses new writer permits while a non-released fence exists', async () => {
    const { database, client } = mockDatabase((sql) => {
      if (sql.includes('FROM tenants')) return [{ id: tenant }];
      if (sql.includes('FROM saas_tenant_backup_writer_operations')) return [];
      if (sql.includes('FROM saas_tenant_backup_writer_fences') && sql.includes("state<>'RELEASED'")) return [{ fence_id: runId }];
      return [];
    });
    const service = new SaasTenantBackupWriterFenceService(database as never);
    await expect(service.beginWriteOperation({
      tenantId: tenant, category: Category.BUSINESS_DATA,
      operationId: 'c5000000-0000-4000-8000-000000000005', producerId: 'backup-worker', writerEpoch: 1,
    })).rejects.toBeInstanceOf(ConflictException);
    expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO saas_tenant_backup_writer_operations'))).toBe(false);
  });

  it('rejects stale writer epochs after a previous erasure release', async () => {
    const { database } = mockDatabase((sql) => {
      if (sql.includes('FROM tenants')) return [{ id: tenant }];
      if (sql.includes('FROM saas_tenant_backup_writer_operations')) return [];
      if (sql.includes('FROM saas_tenant_backup_writer_fences') && sql.includes("state<>'RELEASED'")) return [];
      if (sql.includes('SELECT next_writer_epoch')) return [{ next_writer_epoch: 3 }];
      return [];
    });
    const service = new SaasTenantBackupWriterFenceService(database as never);
    await expect(service.beginWriteOperation({
      tenantId: tenant, category: Category.BUSINESS_DATA,
      operationId: 'c5000000-0000-4000-8000-000000000005', producerId: 'backup-worker', writerEpoch: 2,
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not leave DRAINING while a provider write outcome remains unresolved', async () => {
    const fence = {
      fence_id: runId, tenant_id: tenant, category_code: Category.BUSINESS_DATA, request_id: requestId,
      request_version: 1, run_id: runId, source_export_digest: digest, state: 'DRAINING', writer_epoch: 1,
      created_by_user_id: actor, provider_fence_reference: null, provider_policy_digest: null,
      writer_inventory_digest: null, fenced_writer_count: null, erasure_manifest_digest: null,
      verification_reference: null, verified_residual_count: null, tombstone_replay_reference: null,
      release_policy_digest: null, release_reference: null, release_writer_inventory_digest: null,
      release_writer_count: null, next_writer_epoch: null, reviewed_by_user_id: null,
      recovery_from_state: null, recovery_reason: null, recovery_attestation_reference: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), released_at: null,
    };
    const { database } = mockDatabase((sql) => {
      if (sql.includes('FROM tenants')) return [{ id: tenant }];
      if (sql.includes('FROM saas_tenant_backup_writer_fences WHERE tenant_id=$1 AND fence_id=$2')) return [fence];
      if (sql.includes('count(*)::integer AS active_count')) return [{ active_count: 1 }];
      return [];
    });
    const service = new SaasTenantBackupWriterFenceService(database as never);
    const result = await service.advanceAfterDrain(tenant, runId);
    expect(result.readyForProviderFence).toBe(false);
    expect(result.activeWriterOperations).toBe(1);
    expect(result.fence.state).toBe('DRAINING');
  });

  it('rejects zero-residual verification when one copy remains', async () => {
    const { database } = mockDatabase(() => []);
    const service = new SaasTenantBackupWriterFenceService(database as never);
    await expect(service.markErasureVerified({
      tenantId: tenant, fenceId: runId, manifestDigest: digest,
      verificationReference: 'backup-verify-001', residualCopies: 1,
    })).rejects.toBeInstanceOf(ConflictException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires a safe provider reference before release can begin', async () => {
    const { database } = mockDatabase(() => []);
    const service = new SaasTenantBackupWriterFenceService(database as never);
    await expect(service.releaseAfterTombstoneReplay({
      tenantId: tenant, fenceId: runId, reviewedByUserId: actor, providerReleaseReference: '',
      releasePolicyDigest: digest, releaseWriterInventoryDigest: digest, releaseWriterCount: 1,
      tombstoneReplayReference: 'tombstone-replay-01', nextWriterEpoch: 2,
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });
  it('blocks the next writer epoch until provider policy removal is confirmed', async () => {
    const { database, client } = mockDatabase((sql) => {
      if (sql.includes('FROM tenants')) return [{ id: tenant }];
      if (sql.includes('FROM saas_tenant_backup_writer_operations')) return [];
      if (sql.includes('FROM saas_tenant_backup_writer_fences') && sql.includes("state<>'RELEASED'")) return [];
      if (sql.includes('SELECT next_writer_epoch,provider_release_confirmed_at')) {
        return [{ next_writer_epoch: 2, provider_release_confirmed_at: null }];
      }
      return [];
    });
    const service = new SaasTenantBackupWriterFenceService(database as never);
    await expect(service.beginWriteOperation({
      tenantId: tenant, category: Category.BUSINESS_DATA,
      operationId: 'c5000000-0000-4000-8000-000000000006', producerId: 'backup-worker', writerEpoch: 2,
    })).rejects.toBeInstanceOf(ConflictException);
    expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO saas_tenant_backup_writer_operations'))).toBe(false);
  });

  it('records provider policy read-back before unblocking the released writer epoch', async () => {
    const released = {
      fence_id: runId, tenant_id: tenant, category_code: Category.BUSINESS_DATA,
      request_id: requestId, request_version: 1, run_id: runId, source_export_digest: digest,
      state: 'RELEASED', writer_epoch: 1, created_by_user_id: actor,
      provider_fence_reference: 's3-bucket-policy-fence-001', provider_policy_digest: digest,
      writer_inventory_digest: digest, writer_inventory_reference: 'writer-inventory-160',
      writer_inventory_snapshot_id: 'c6000000-0000-4000-8000-000000000006',
      policy_ownership_review_reference: 'policy-ownership-review-160',
      staging_acceptance_reference: 'staging-acceptance-160', restore_replay_reference: 'restore-replay-160',
      fenced_writer_count: 1, erasure_manifest_digest: digest, verification_reference: 'backup-verify-160',
      verified_residual_count: 0, tombstone_replay_reference: 'restore-tombstone-replay-160',
      release_policy_digest: digest, release_reference: 's3-release-policy-160',
      release_writer_inventory_digest: digest, release_writer_count: 1, next_writer_epoch: 2,
      reviewed_by_user_id: 'c4000000-0000-4000-8000-000000000005',
      recovery_from_state: null, recovery_reason: null, recovery_attestation_reference: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      released_at: new Date().toISOString(), provider_release_confirmed_at: null,
    };
    const { database, client } = mockDatabase((sql) => {
      if (sql.includes('FROM tenants')) return [{ id: tenant }];
      if (sql.includes('SELECT * FROM saas_tenant_backup_writer_fences WHERE tenant_id=$1 AND fence_id=$2 FOR UPDATE')) return [released];
      if (sql.includes('UPDATE saas_tenant_backup_writer_fences SET provider_release_confirmed_at')) {
        return [{ ...released, provider_release_confirmed_at: new Date().toISOString() }];
      }
      return [];
    });
    const service = new SaasTenantBackupWriterFenceService(database as never);
    const result = await service.confirmProviderFenceReleased({
      tenantId: tenant, fenceId: runId, providerReleaseReference: 's3-release-policy-160', providerPolicyDigest: digest,
    });
    expect(result).toMatchObject({ state: 'RELEASED', nextWriterEpoch: 2 });
    expect(result.providerReleaseConfirmedAt).toBeTruthy();
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('SET provider_release_confirmed_at=clock_timestamp()'))).toBe(true);
  });
});

  it('blocks replay of a still-active operation after a fence starts', async () => {
    const operation = {
      operation_id: 'c5000000-0000-4000-8000-000000000005',
      category_code: Category.BUSINESS_DATA,
      producer_id: 'backup-worker',
      writer_epoch: 1,
      status: 'ACTIVE',
      provider_operation_reference: null,
      failure_code: null,
    };
    const { database, client } = mockDatabase((sql) => {
      if (sql.includes('FROM tenants')) return [{ id: tenant }];
      if (sql.includes('FROM saas_tenant_backup_writer_operations WHERE tenant_id=$1 AND operation_id=$2')) return [operation];
      if (sql.includes('FROM saas_tenant_backup_writer_fences') && sql.includes("state<>'RELEASED'")) return [{ fence_id: runId }];
      return [];
    });
    const service = new SaasTenantBackupWriterFenceService(database as never);
    await expect(service.beginWriteOperation({
      tenantId: tenant, category: Category.BUSINESS_DATA, operationId: operation.operation_id,
      producerId: operation.producer_id, writerEpoch: 1,
    })).rejects.toBeInstanceOf(ConflictException);
    expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO saas_tenant_backup_writer_operations'))).toBe(false);
  });
