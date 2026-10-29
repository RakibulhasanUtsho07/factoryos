import { jest } from '@jest/globals';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { S3TenantBackupWriterFenceCoordinator } from './s3-tenant-backup-writer-fence.coordinator';
import { SaasTransferDatasetCategory as Category } from './dto/create-saas-schema-compatibility-rule.dto';

const tenant = 'c1000000-0000-4000-8000-000000000001';
const fenceId = 'c5000000-0000-4000-8000-000000000005';
const actor = 'c4000000-0000-4000-8000-000000000004';
const digest = 'a'.repeat(64);
const reference = 's3-bucket-policy-fence.' + fenceId.replace(/-/g, '');

function view(state: string, overrides: Record<string, unknown> = {}) {
  return {
    fenceId, tenantId: tenant, category: Category.BUSINESS_DATA, requestId: 'c2000000-0000-4000-8000-000000000002',
    requestVersion: 1, runId: 'c3000000-0000-4000-8000-000000000003', state, writerEpoch: 1,
    providerFenceReference: null, providerPolicyDigest: null, writerInventoryDigest: null, fencedWriterCount: null,
    erasureManifestDigest: null, verificationReference: null, verifiedResidualCount: null, tombstoneReplayReference: null,
    nextWriterEpoch: null, recoveryReason: null, releasePolicyDigest: null, releaseReference: null,
    releaseWriterInventoryDigest: null, releaseWriterCount: null, reviewedByUserId: null, releasedAt: null,
    ...overrides,
  };
}

describe('S3TenantBackupWriterFenceCoordinator', () => {
  function setup(initialState = 'DRAINING', evidence: Record<string, unknown> = {}) {
    const current = view(initialState);
    const lifecycle = {
      getFence: jest.fn(async () => current),
      advanceAfterDrain: jest.fn(async () => ({
        fence: view('FENCING'), readyForProviderFence: true, activeWriterOperations: 0,
      })),
      recordProviderFenceInstalled: jest.fn(async () => view('FENCED', {
        providerFenceReference: reference, providerPolicyDigest: digest,
        writerInventoryDigest: digest, fencedWriterCount: 3,
      })),
      requireRecovery: jest.fn(async () => view('RECOVERY_REQUIRED')),
      releaseAfterTombstoneReplay: jest.fn(async () => view('RELEASED', {
        state: 'RELEASED', reviewedByUserId: actor, releaseReference: reference,
        releasePolicyDigest: digest, releaseWriterInventoryDigest: digest, releaseWriterCount: 3,
        tombstoneReplayReference: 'restore-tombstone-replay-001', nextWriterEpoch: 2,
      })),
    };
    const provider = {
      installFence: jest.fn(async () => ({
        providerFenceReference: reference, providerPolicyDigest: digest, scopePrefixDigest: digest,
        multipartInventoryDigest: digest, pendingMultipartUploads: 0, ...evidence,
      })),
      planFenceRemoval: jest.fn(async () => ({
        providerFenceReference: reference, currentPolicyDigest: 'b'.repeat(64),
        releasePolicyDigest: digest, policyPresent: true,
      })),
      removeFence: jest.fn(async () => ({
        providerFenceReference: reference, providerPolicyDigest: digest,
        policyAbsent: true as const, alreadyAbsent: false,
      })),
    };
    return { coordinator: new S3TenantBackupWriterFenceCoordinator(lifecycle as never, provider as never), lifecycle, provider, current };
  }

  it('records FENCED only after the application drain and provider policy read-back complete', async () => {
    const { coordinator, lifecycle, provider } = setup();
    const result = await coordinator.installAndRecordFence({
      tenantId: tenant, category: Category.BUSINESS_DATA, fenceId,
      writerInventoryDigest: digest, fencedWriterCount: 3,
    });
    expect(lifecycle.advanceAfterDrain).toHaveBeenCalledWith(tenant, fenceId);
    expect(provider.installFence).toHaveBeenCalledWith({ tenantId: tenant, category: Category.BUSINESS_DATA, fenceId });
    expect(lifecycle.recordProviderFenceInstalled).toHaveBeenCalledWith({
      tenantId: tenant, fenceId, providerFenceReference: reference,
      providerPolicyDigest: digest, writerInventoryDigest: digest, fencedWriterCount: 3,
    });
    expect(result.state).toBe('FENCED');
  });

  it('does not mark FENCED while any multipart upload remains', async () => {
    const { coordinator, lifecycle } = setup('FENCING', { pendingMultipartUploads: 2 });
    await expect(coordinator.installAndRecordFence({
      tenantId: tenant, category: Category.BUSINESS_DATA, fenceId,
      writerInventoryDigest: digest, fencedWriterCount: 3,
    })).rejects.toBeInstanceOf(ConflictException);
    expect(lifecycle.recordProviderFenceInstalled).not.toHaveBeenCalled();
  });

  it('does not call S3 while an application writer operation remains active', async () => {
    const { coordinator, lifecycle, provider } = setup();
    lifecycle.advanceAfterDrain.mockResolvedValue({
      fence: view('DRAINING'), readyForProviderFence: false, activeWriterOperations: 1,
    } as never);
    await expect(coordinator.installAndRecordFence({
      tenantId: tenant, category: Category.BUSINESS_DATA, fenceId,
      writerInventoryDigest: digest, fencedWriterCount: 3,
    })).rejects.toBeInstanceOf(ConflictException);
    expect(provider.installFence).not.toHaveBeenCalled();
    expect(lifecycle.recordProviderFenceInstalled).not.toHaveBeenCalled();
  });

  it('durably seals release before removing the provider deny statement', async () => {
    const { coordinator, lifecycle, provider } = setup('ERASURE_VERIFIED');
    const sequence: string[] = [];
    lifecycle.releaseAfterTombstoneReplay.mockImplementation(async () => {
      sequence.push('database-release');
      return view('RELEASED', {
        reviewedByUserId: actor, releaseReference: reference, releasePolicyDigest: digest,
        releaseWriterInventoryDigest: digest, releaseWriterCount: 3,
        tombstoneReplayReference: 'restore-tombstone-replay-001', nextWriterEpoch: 2,
      }) as never;
    });
    provider.removeFence.mockImplementation(async () => {
      sequence.push('provider-policy-remove');
      return { providerFenceReference: reference, providerPolicyDigest: digest, policyAbsent: true as const, alreadyAbsent: false };
    });
    const result = await coordinator.releaseAfterTombstoneReplay({
      tenantId: tenant, category: Category.BUSINESS_DATA, fenceId, reviewedByUserId: actor,
      releaseWriterInventoryDigest: digest, releaseWriterCount: 3,
      tombstoneReplayReference: 'restore-tombstone-replay-001', nextWriterEpoch: 2,
    });
    expect(sequence).toEqual(['database-release', 'provider-policy-remove']);
    expect(lifecycle.releaseAfterTombstoneReplay).toHaveBeenCalledWith(expect.objectContaining({
      providerReleaseReference: reference, releasePolicyDigest: digest,
      nextWriterEpoch: 2, reviewedByUserId: actor,
    }));
    expect(result.fence.state).toBe('RELEASED');
  });

  it('allows a retry after the durable release if provider policy removal previously failed', async () => {
    const released = view('RELEASED', {
      reviewedByUserId: actor, releaseReference: reference, releasePolicyDigest: digest,
      releaseWriterInventoryDigest: digest, releaseWriterCount: 3,
      tombstoneReplayReference: 'restore-tombstone-replay-001', nextWriterEpoch: 2,
    });
    const { coordinator, lifecycle, provider } = setup('RELEASED');
    lifecycle.getFence.mockResolvedValue(released as never);
    const result = await coordinator.releaseAfterTombstoneReplay({
      tenantId: tenant, category: Category.BUSINESS_DATA, fenceId, reviewedByUserId: actor,
      releaseWriterInventoryDigest: digest, releaseWriterCount: 3,
      tombstoneReplayReference: 'restore-tombstone-replay-001', nextWriterEpoch: 2,
    });
    expect(lifecycle.releaseAfterTombstoneReplay).not.toHaveBeenCalled();
    expect(provider.removeFence).toHaveBeenCalled();
    expect(result.providerRelease.policyAbsent).toBe(true);
  });

  it('leaves the deny policy in place if provider removal cannot be confirmed', async () => {
    const { coordinator, lifecycle, provider } = setup('ERASURE_VERIFIED');
    provider.removeFence.mockRejectedValue(new Error('provider timeout'));
    await expect(coordinator.releaseAfterTombstoneReplay({
      tenantId: tenant, category: Category.BUSINESS_DATA, fenceId, reviewedByUserId: actor,
      releaseWriterInventoryDigest: digest, releaseWriterCount: 3,
      tombstoneReplayReference: 'restore-tombstone-replay-001', nextWriterEpoch: 2,
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(lifecycle.releaseAfterTombstoneReplay).toHaveBeenCalled();
  });
});
