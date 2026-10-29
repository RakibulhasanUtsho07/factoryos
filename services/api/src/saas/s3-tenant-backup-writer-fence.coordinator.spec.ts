import { jest } from '@jest/globals';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { S3TenantBackupWriterFenceCoordinator } from './s3-tenant-backup-writer-fence.coordinator';
import { SaasTransferDatasetCategory as Category } from './dto/create-saas-schema-compatibility-rule.dto';

const tenant = 'c1000000-0000-4000-8000-000000000001';
const fenceId = 'c5000000-0000-4000-8000-000000000005';
const actor = 'c4000000-0000-4000-8000-000000000004';
const reviewer = 'c7000000-0000-4000-8000-000000000007';
const snapshotId = 'c6000000-0000-4000-8000-000000000006';
const digest = 'a'.repeat(64);
const reference = 's3-bucket-policy-fence.' + fenceId.replace(/-/g, '');
const acceptanceBinding = { configReference: 'backup-storage-erasure.v1', adapterKey: 's3.tenant-backup.v1', adapterVersion: '1.0.0' };
const providerAcceptance = {
  policyOwnershipReviewReference: 'policy-owner.review.2026-10-29',
  stagingAcceptanceReference: 'staging.s3-fence.accepted.2026-10-29',
  restoreReplayReference: 'restore.tombstone-replay.accepted.2026-10-29',
};

function view(state: string, overrides: Record<string, unknown> = {}) {
  return {
    fenceId, tenantId: tenant, category: Category.BUSINESS_DATA,
    requestId: 'c2000000-0000-4000-8000-000000000002', requestVersion: 1,
    runId: 'c3000000-0000-4000-8000-000000000003', state, writerEpoch: 1,
    createdByUserId: actor, writerInventorySnapshotId: null,
    providerFenceReference: null, providerPolicyDigest: null, writerInventoryDigest: null, fencedWriterCount: null,
    writerInventoryReference: null, policyOwnershipReviewReference: null, stagingAcceptanceReference: null,
    restoreReplayReference: null, erasureManifestDigest: null, verificationReference: null,
    verifiedResidualCount: null, tombstoneReplayReference: null, nextWriterEpoch: null, recoveryReason: null,
    releasePolicyDigest: null, releaseReference: null, releaseWriterInventoryDigest: null,
    releaseWriterCount: null, reviewedByUserId: null, releasedAt: null,
    ...overrides,
  };
}
function acceptedInventory(overrides: Record<string, unknown> = {}) {
  return {
    snapshotId, tenantId: tenant, category: Category.BUSINESS_DATA, revision: 1,
    inventoryReference: 'backup-writers.inventory.2026-10-29', manifestDigest: digest, entryCount: 3,
    status: 'ACCEPTED' as const,
    registeredByUserId: 'c8000000-0000-4000-8000-000000000008',
    reviewedByUserId: reviewer, reviewedAt: new Date(0).toISOString(), entries: [],
    ...overrides,
  };
}

describe('S3TenantBackupWriterFenceCoordinator', () => {
  function setup(initialState = 'DRAINING', evidence: Record<string, unknown> = {}) {
    const current = view(initialState);
    const lifecycle = {
      getFence: jest.fn(async () => current),
      beginErasureFence: jest.fn(async () => [current]),
      markErasureStarted: jest.fn(async () => view('ERASING', {
        providerFenceReference: reference, providerPolicyDigest: digest, writerInventorySnapshotId: snapshotId,
        writerInventoryDigest: digest, fencedWriterCount: 3, createdByUserId: actor,
      })),
      markErasureVerified: jest.fn(async () => view('ERASURE_VERIFIED')),
      advanceAfterDrain: jest.fn(async () => ({
        fence: view('FENCING'), readyForProviderFence: true, activeWriterOperations: 0,
      })),
      recordProviderFenceInstalled: jest.fn(async () => view('FENCED', {
        writerInventorySnapshotId: snapshotId, writerInventoryReference: acceptedInventory().inventoryReference,
        providerFenceReference: reference, providerPolicyDigest: digest, writerInventoryDigest: digest, fencedWriterCount: 3,
        policyOwnershipReviewReference: providerAcceptance.policyOwnershipReviewReference,
        stagingAcceptanceReference: providerAcceptance.stagingAcceptanceReference,
        restoreReplayReference: providerAcceptance.restoreReplayReference,
      })),
      requireRecovery: jest.fn(async () => view('RECOVERY_REQUIRED')),
      releaseAfterTombstoneReplay: jest.fn(async () => view('RELEASED', {
        state: 'RELEASED', reviewedByUserId: reviewer, releaseReference: reference,
        releasePolicyDigest: digest, releaseWriterInventoryDigest: digest, releaseWriterCount: 3,
        tombstoneReplayReference: 'restore-tombstone-replay-001', nextWriterEpoch: 2,
      })),
    };
    const provider = {
      getProviderAcceptanceReferences: jest.fn(() => providerAcceptance),
      inspectFence: jest.fn(async () => ({
        providerFenceReference: reference, providerPolicyDigest: digest, scopePrefixDigest: digest,
        multipartInventoryDigest: digest, pendingMultipartUploads: 0, installed: true,
      })),
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
    const writerInventory = { requireCurrentAcceptedSnapshot: jest.fn(async () => acceptedInventory()) };
    const providerAcceptanceService = {
      requireCurrentAcceptedProviderAcceptance: jest.fn(async () => ({ acceptanceId: 'provider-acceptance-001', status: 'ACCEPTED' })),
    };
    return {
      coordinator: new S3TenantBackupWriterFenceCoordinator(lifecycle as never, provider as never, writerInventory as never, providerAcceptanceService as never),
      lifecycle, provider, writerInventory, providerAcceptanceService, current,
    };
  }

  it('acquires the durable/provider fence before entering ERASING and verifies it before inventory begins', async () => {
    const { coordinator, lifecycle, provider, writerInventory } = setup();
    const result = await coordinator.beginPropagationFence({
      ...acceptanceBinding,
      tenantId: tenant, requestId: 'c2000000-0000-4000-8000-000000000002',
      requestVersion: 1, runId: 'c3000000-0000-4000-8000-000000000003',
      sourceExportDigest: digest, categories: [Category.BUSINESS_DATA], actorUserId: actor,
    });
    expect(result).toEqual([expect.objectContaining({ state: 'ERASING' })]);
    expect(provider.getProviderAcceptanceReferences).toHaveBeenCalledTimes(4);
    expect(writerInventory.requireCurrentAcceptedSnapshot).toHaveBeenCalledTimes(4);
    expect(lifecycle.beginErasureFence).toHaveBeenCalledTimes(1);
    expect(provider.installFence).toHaveBeenCalledTimes(1);
    expect(provider.inspectFence).toHaveBeenCalledTimes(1);
    expect(lifecycle.markErasureStarted).toHaveBeenCalledWith(tenant, fenceId);
    expect(provider.installFence.mock.invocationCallOrder[0]).toBeLessThan(lifecycle.markErasureStarted.mock.invocationCallOrder[0]!);
  });

  it('requires recovery when the exact provider fence statement is missing before inventory begins', async () => {
    const { coordinator, lifecycle, provider } = setup();
    provider.inspectFence.mockResolvedValueOnce({
      providerFenceReference: reference, providerPolicyDigest: digest, scopePrefixDigest: digest,
      multipartInventoryDigest: digest, pendingMultipartUploads: 0, installed: false,
    } as never);
    await expect(coordinator.beginPropagationFence({
      ...acceptanceBinding,
      tenantId:   tenant, requestId: 'c2000000-0000-4000-8000-000000000002',
      requestVersion: 1, runId: 'c3000000-0000-4000-8000-000000000003',
      sourceExportDigest: digest, categories: [Category.BUSINESS_DATA], actorUserId: actor,
    })).rejects.toBeInstanceOf(ConflictException);
    expect(lifecycle.requireRecovery).toHaveBeenCalledWith(tenant, fenceId, 'PROVIDER_FENCE_POLICY_DRIFT');
  });

  it('requires zero-residual verification before marking each backup category verified', async () => {
    const { coordinator, lifecycle } = setup('ERASING');
    lifecycle.getFence.mockResolvedValue(view('ERASING', {
      providerFenceReference: reference, providerPolicyDigest: digest, writerInventorySnapshotId: snapshotId,
      writerInventoryDigest: digest, fencedWriterCount: 3, createdByUserId: actor,
    }) as never);
    const result = await coordinator.recordPropagationVerification({
      ...acceptanceBinding,
      tenantId: tenant, categories: [Category.BUSINESS_DATA],
      manifestDigest: digest, verificationReference: 'backup.verify.receipt.001', residualCopies: 0,
    });
    expect(lifecycle.markErasureVerified).toHaveBeenCalledWith({
      tenantId: tenant, fenceId, manifestDigest: digest,
      verificationReference: 'backup.verify.receipt.001', residualCopies: 0,
    });
    expect(result).toEqual([expect.objectContaining({ state: 'ERASURE_VERIFIED' })]);
    await expect(coordinator.recordPropagationVerification({
      ...acceptanceBinding,
      tenantId:   tenant, categories: [Category.BUSINESS_DATA],
      manifestDigest: digest, verificationReference: 'backup.verify.receipt.002', residualCopies: 1,
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it('seals FENCED only after current accepted inventory and provider read-back', async () => {
    const { coordinator, lifecycle, provider, writerInventory } = setup();
    const result = await coordinator.installAndRecordFence({ ...acceptanceBinding, tenantId: tenant, category: Category.BUSINESS_DATA, fenceId });
    expect(lifecycle.advanceAfterDrain).toHaveBeenCalledWith(tenant, fenceId);
    expect(writerInventory.requireCurrentAcceptedSnapshot).toHaveBeenCalledTimes(2);
    expect(provider.installFence).toHaveBeenCalledWith({ tenantId: tenant, category: Category.BUSINESS_DATA, fenceId });
    expect(lifecycle.recordProviderFenceInstalled).toHaveBeenCalledWith({
      tenantId: tenant, fenceId, providerFenceReference: reference, providerPolicyDigest: digest,
      writerInventoryDigest: digest, fencedWriterCount: 3, writerInventorySnapshotId: snapshotId,
      writerInventoryReference: acceptedInventory().inventoryReference,
      policyOwnershipReviewReference: providerAcceptance.policyOwnershipReviewReference,
      stagingAcceptanceReference: providerAcceptance.stagingAcceptanceReference,
      restoreReplayReference: providerAcceptance.restoreReplayReference,
    });
    expect(result.state).toBe('FENCED');
  });

  it('moves to recovery if provider acceptance is revoked after the Deny is installed', async () => {
    const { coordinator, lifecycle, provider, providerAcceptanceService } = setup();
    let checks = 0;
    providerAcceptanceService.requireCurrentAcceptedProviderAcceptance.mockImplementation(async () => {
      checks += 1;
      if (checks === 2) throw new ServiceUnavailableException('revoked after install');
      return { acceptanceId: 'provider-acceptance-001', status: 'ACCEPTED' } as never;
    });

    await expect(coordinator.installAndRecordFence({
      ...acceptanceBinding, tenantId: tenant, category: Category.BUSINESS_DATA, fenceId,
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(provider.installFence).toHaveBeenCalled();
    expect(lifecycle.requireRecovery).toHaveBeenCalledWith(tenant, fenceId, 'PROVIDER_ACCEPTANCE_REVOKED');
    expect(lifecycle.recordProviderFenceInstalled).not.toHaveBeenCalled();
  });

  it('blocks backup mutation if current provider acceptance is revoked before a destructive step', async () => {
    const { coordinator, lifecycle, provider, providerAcceptanceService } = setup('ERASING');
    lifecycle.getFence.mockResolvedValue(view('ERASING', {
      providerFenceReference: reference, providerPolicyDigest: digest, writerInventorySnapshotId: snapshotId,
      writerInventoryDigest: digest, fencedWriterCount: 3, createdByUserId: actor,
    }) as never);
    providerAcceptanceService.requireCurrentAcceptedProviderAcceptance.mockRejectedValue(
      new ServiceUnavailableException('revoked'),
    );

    await expect(coordinator.assertFenceHeld({
      ...acceptanceBinding, tenantId: tenant, categories: [Category.BUSINESS_DATA],
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(lifecycle.requireRecovery).toHaveBeenCalledWith(tenant, fenceId, 'PROVIDER_ACCEPTANCE_REVOKED');
    expect(provider.inspectFence).not.toHaveBeenCalled();
  });

  it('fails closed before S3 when the latest inventory is not accepted', async () => {
    const { coordinator, provider, lifecycle, writerInventory } = setup();
    writerInventory.requireCurrentAcceptedSnapshot.mockRejectedValue(new ServiceUnavailableException('not reviewed'));
    await expect(coordinator.installAndRecordFence({ ...acceptanceBinding, tenantId: tenant, category: Category.BUSINESS_DATA, fenceId }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(provider.installFence).not.toHaveBeenCalled();
    expect(lifecycle.recordProviderFenceInstalled).not.toHaveBeenCalled();
  });

  it('requires the reviewer to be independent from the fence creator', async () => {
    const { coordinator, provider, writerInventory } = setup();
    writerInventory.requireCurrentAcceptedSnapshot.mockResolvedValue(acceptedInventory({ reviewedByUserId: actor }) as never);
    await expect(coordinator.installAndRecordFence({ ...acceptanceBinding, tenantId: tenant, category: Category.BUSINESS_DATA, fenceId }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(provider.installFence).not.toHaveBeenCalled();
  });

  it('keeps the provider deny closed if the accepted inventory changes during installation', async () => {
    const { coordinator, lifecycle, provider, writerInventory } = setup();
    writerInventory.requireCurrentAcceptedSnapshot
      .mockResolvedValueOnce(acceptedInventory() as never)
      .mockResolvedValueOnce(acceptedInventory({ snapshotId: 'c6000000-0000-4000-8000-000000000009' }) as never);
    await expect(coordinator.installAndRecordFence({ ...acceptanceBinding, tenantId: tenant, category: Category.BUSINESS_DATA, fenceId }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(provider.installFence).toHaveBeenCalled();
    expect(lifecycle.requireRecovery).toHaveBeenCalledWith(tenant, fenceId, 'WRITER_INVENTORY_CHANGED');
    expect(lifecycle.recordProviderFenceInstalled).not.toHaveBeenCalled();
  });

  it('does not mark FENCED while any multipart upload remains', async () => {
    const { coordinator, lifecycle } = setup('FENCING', { pendingMultipartUploads: 2 });
    await expect(coordinator.installAndRecordFence({ ...acceptanceBinding, tenantId: tenant, category: Category.BUSINESS_DATA, fenceId }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(lifecycle.recordProviderFenceInstalled).not.toHaveBeenCalled();
  });

  it('does not call S3 while an application writer operation remains active', async () => {
    const { coordinator, lifecycle, provider } = setup();
    lifecycle.advanceAfterDrain.mockResolvedValue({
      fence: view('DRAINING'), readyForProviderFence: false, activeWriterOperations: 1,
    } as never);
    await expect(coordinator.installAndRecordFence({ ...acceptanceBinding, tenantId: tenant, category: Category.BUSINESS_DATA, fenceId }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(provider.installFence).not.toHaveBeenCalled();
    expect(lifecycle.recordProviderFenceInstalled).not.toHaveBeenCalled();
  });

  it('durably seals release before removing the provider deny statement', async () => {
    const { coordinator, lifecycle, provider } = setup('ERASURE_VERIFIED');
    lifecycle.getFence.mockResolvedValue(view('ERASURE_VERIFIED', {
      writerInventorySnapshotId: snapshotId, writerInventoryDigest: digest, fencedWriterCount: 3,
    }) as never);
    const sequence: string[] = [];
    lifecycle.releaseAfterTombstoneReplay.mockImplementation(async () => {
      sequence.push('database-release');
      return view('RELEASED', {
        reviewedByUserId: reviewer, releaseReference: reference, releasePolicyDigest: digest,
        releaseWriterInventoryDigest: digest, releaseWriterCount: 3,
        tombstoneReplayReference: 'restore-tombstone-replay-001', nextWriterEpoch: 2,
      }) as never;
    });
    provider.removeFence.mockImplementation(async () => {
      sequence.push('provider-policy-remove');
      return { providerFenceReference: reference, providerPolicyDigest: digest, policyAbsent: true as const, alreadyAbsent: false };
    });
    const result = await coordinator.releaseAfterTombstoneReplay({
      ...acceptanceBinding,
      tenantId: tenant, category: Category.BUSINESS_DATA, fenceId, reviewedByUserId: reviewer,
      releaseWriterInventoryDigest: digest, releaseWriterCount: 3,
      tombstoneReplayReference: 'restore-tombstone-replay-001', nextWriterEpoch: 2,
    });
    expect(sequence).toEqual(['database-release', 'provider-policy-remove']);
    expect(lifecycle.releaseAfterTombstoneReplay).toHaveBeenCalledWith(expect.objectContaining({
      providerReleaseReference: reference, releasePolicyDigest: digest,
      nextWriterEpoch: 2, reviewedByUserId: reviewer,
    }));
    expect(result.fence.state).toBe('RELEASED');
  });

  it('keeps the provider Deny installed if acceptance is revoked after epoch release but before policy removal', async () => {
    const { coordinator, lifecycle, provider, providerAcceptanceService } = setup('ERASURE_VERIFIED');
    lifecycle.getFence.mockResolvedValue(view('ERASURE_VERIFIED', {
      writerInventorySnapshotId: snapshotId, writerInventoryDigest: digest, fencedWriterCount: 3,
    }) as never);
    lifecycle.releaseAfterTombstoneReplay.mockResolvedValue(view('RELEASED', {
      reviewedByUserId: reviewer, releaseReference: reference, releasePolicyDigest: digest,
      releaseWriterInventoryDigest: digest, releaseWriterCount: 3,
      tombstoneReplayReference: 'restore-tombstone-replay-001', nextWriterEpoch: 2,
    }) as never);
    let checks = 0;
    providerAcceptanceService.requireCurrentAcceptedProviderAcceptance.mockImplementation(async () => {
      checks += 1;
      if (checks === 3) throw new ServiceUnavailableException('revoked immediately before policy removal');
      return { acceptanceId: 'provider-acceptance-001', status: 'ACCEPTED' } as never;
    });

    await expect(coordinator.releaseAfterTombstoneReplay({
      ...acceptanceBinding, tenantId: tenant, category: Category.BUSINESS_DATA, fenceId,
      reviewedByUserId: reviewer, releaseWriterInventoryDigest: digest, releaseWriterCount: 3,
      tombstoneReplayReference: 'restore-tombstone-replay-001', nextWriterEpoch: 2,
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(lifecycle.releaseAfterTombstoneReplay).toHaveBeenCalled();
    expect(provider.removeFence).not.toHaveBeenCalled();
    expect(checks).toBe(3);
  });

  it('allows retry after durable release when provider policy removal previously failed', async () => {
    const released = view('RELEASED', {
      reviewedByUserId: reviewer, releaseReference: reference, releasePolicyDigest: digest,
      releaseWriterInventoryDigest: digest, releaseWriterCount: 3,
      tombstoneReplayReference: 'restore-tombstone-replay-001', nextWriterEpoch: 2,
    });
    const { coordinator, lifecycle, provider } = setup('RELEASED');
    lifecycle.getFence.mockResolvedValue(released as never);
    const result = await coordinator.releaseAfterTombstoneReplay({
      ...acceptanceBinding,
      tenantId: tenant, category: Category.BUSINESS_DATA, fenceId, reviewedByUserId: reviewer,
      releaseWriterInventoryDigest: digest, releaseWriterCount: 3,
      tombstoneReplayReference: 'restore-tombstone-replay-001', nextWriterEpoch: 2,
    });
    expect(lifecycle.releaseAfterTombstoneReplay).not.toHaveBeenCalled();
    expect(provider.removeFence).toHaveBeenCalled();
    expect(result.providerRelease.policyAbsent).toBe(true);
  });

  it('refuses provider release when the acceptance has been revoked', async () => {
    const { coordinator, lifecycle, provider, providerAcceptanceService } = setup('ERASURE_VERIFIED');
    lifecycle.getFence.mockResolvedValue(view('ERASURE_VERIFIED', {
      writerInventorySnapshotId: snapshotId, writerInventoryDigest: digest, fencedWriterCount: 3,
    }) as never);
    providerAcceptanceService.requireCurrentAcceptedProviderAcceptance.mockRejectedValue(
      new ServiceUnavailableException('revoked'),
    );

    await expect(coordinator.releaseAfterTombstoneReplay({
      ...acceptanceBinding, tenantId: tenant, category: Category.BUSINESS_DATA, fenceId,
      reviewedByUserId: reviewer, releaseWriterInventoryDigest: digest, releaseWriterCount: 3,
      tombstoneReplayReference: 'restore-tombstone-replay-001', nextWriterEpoch: 2,
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(lifecycle.releaseAfterTombstoneReplay).not.toHaveBeenCalled();
    expect(provider.planFenceRemoval).not.toHaveBeenCalled();
    expect(provider.removeFence).not.toHaveBeenCalled();
    expect(lifecycle.requireRecovery).toHaveBeenCalledWith(tenant, fenceId, 'PROVIDER_ACCEPTANCE_REVOKED');
  });

  it('leaves the deny policy in place if provider removal cannot be confirmed', async () => {
    const { coordinator, lifecycle, provider } = setup('ERASURE_VERIFIED');
    lifecycle.getFence.mockResolvedValue(view('ERASURE_VERIFIED', {
      writerInventorySnapshotId: snapshotId, writerInventoryDigest: digest, fencedWriterCount: 3,
    }) as never);
    provider.removeFence.mockRejectedValue(new Error('provider timeout'));
    await expect(coordinator.releaseAfterTombstoneReplay({
      ...acceptanceBinding,
      tenantId: tenant, category: Category.BUSINESS_DATA, fenceId, reviewedByUserId: reviewer,
      releaseWriterInventoryDigest: digest, releaseWriterCount: 3,
      tombstoneReplayReference: 'restore-tombstone-replay-001', nextWriterEpoch: 2,
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(lifecycle.releaseAfterTombstoneReplay).toHaveBeenCalled();
  });
});
