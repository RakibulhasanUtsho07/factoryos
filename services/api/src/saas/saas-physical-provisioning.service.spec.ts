import { jest } from '@jest/globals';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { SaasDeploymentProfile } from './dto/create-saas-subscription-plan.dto';
import { SaasPhysicalFailurePolicy } from './dto/execute-saas-physical-operation.dto';
import { SaasPhysicalProvisioningService } from './saas-physical-provisioning.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const actorUserId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const resourceId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';

function createService(adapters: unknown[] = [], releaseRolloutService?: unknown) {
  const database = {
    query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(),
    transaction: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const iam = { authorize: jest.fn<(...args: unknown[]) => Promise<void>>() };
  const audit = { record: jest.fn<(...args: unknown[]) => Promise<string>>() };
  const service = new SaasPhysicalProvisioningService(
    database as never, iam as never, audit as never, adapters as never, releaseRolloutService as never,
  );
  return { service, database, iam, audit };
}

const profile = {
  id: '456f2b7f-8c46-4d9a-8b44-18eae66a4450',
  profileType: SaasDeploymentProfile.SHARED_SAAS,
  deploymentReference: null,
  regionCode: 'ap-south-1',
  residencyDomain: 'BD',
  edgeSiteCode: null,
};


type RecoveryHealthReceipt = {
  healthy: boolean;
  evidenceDigest: string;
  checkedAt: string;
  reasonCode?: string;
};

function prepareDeployRecoveryHarness(
  failurePolicy: SaasPhysicalFailurePolicy,
  health: RecoveryHealthReceipt,
  options: { pauseFails?: boolean; rollbackHealthy?: boolean; rollbackSyncFails?: boolean } = {},
) {
  const current = {
    id: resourceId,
    tenant_id: tenantId,
    rollout_key: 'ORG-BASE',
    version: 2,
    scope_type: 'ORGANIZATION' as const,
    factory_id: null,
    module_key: null,
    agent_key: null,
    release_channel: 'STABLE',
    stage: 'PRODUCTION',
    rollout_percentage: 100,
    artifact_version: '2.0.0',
    artifact_digest: 'b'.repeat(64),
  };
  const previous = {
    ...current,
    id: '3f86a4f0-8a74-4a08-89da-805500fdc018',
    version: 1,
    artifact_version: '1.0.0',
    artifact_digest: 'a'.repeat(64),
  };
  const order: string[] = [];
  const events: Array<{ status: string; input: Record<string, unknown> }> = [];
  const deployedReference = 'deployment:fo-tenant-1234/org-base';
  const adapter = {
    providerCode: 'kubernetes',
    supports: jest.fn(() => true),
    deployRelease: jest.fn(async () => ({
      providerReference: deployedReference,
      deploymentReference: deployedReference,
      artifactDigest: current.artifact_digest,
      topology: SaasDeploymentProfile.SHARED_SAAS,
      isolationVerified: true,
      evidenceDigest: 'c'.repeat(64),
    })),
    checkReleaseHealth: jest.fn(async () => health),
    haltRelease: jest.fn(async () => {
      order.push('provider-halt');
      return { halted: true, evidenceDigest: 'd'.repeat(64) };
    }),
    rollbackRelease: jest.fn(async () => {
      order.push('provider-rollback');
      return {
        rolledBack: true,
        healthy: options.rollbackHealthy ?? true,
        deploymentReference: deployedReference,
        artifactDigest: previous.artifact_digest,
        topology: SaasDeploymentProfile.SHARED_SAAS,
        evidenceDigest: 'e'.repeat(64),
      };
    }),
  };
  const lifecycle = {
    transition: jest.fn(async (..._args: unknown[]) => {
      order.push('control-plane-pause');
      if (options.pauseFails) throw new Error('simulated control-plane pause failure');
      return { rollout: { stage: 'PAUSED', version: 3 } };
    }),
    rollback: jest.fn(async (..._args: unknown[]) => {
      order.push('control-plane-rollback');
      if (options.rollbackSyncFails) throw new Error('simulated control-plane rollback sync failure');
      return { rollout: { version: 3 } };
    }),
  };
  const { service } = createService([adapter], lifecycle);
  const internal = service as unknown as {
    loadLatestRelease: (...args: unknown[]) => Promise<unknown>;
    activeProfile: (...args: unknown[]) => Promise<unknown>;
    mapProfile: (row: unknown) => typeof profile;
    previousProductionRelease: (...args: unknown[]) => Promise<unknown>;
    startRun: (...args: unknown[]) => Promise<unknown>;
    executePreparedRun: (
      run: unknown,
      physicalProfile: unknown,
      actorUserId: string,
      action: (physicalAdapter: unknown, context: unknown) => Promise<unknown>,
      contextFactory: (runId: string) => unknown,
    ) => Promise<unknown>;
    appendEvent: (...args: unknown[]) => Promise<void>;
  };
  internal.loadLatestRelease = async () => current;
  internal.activeProfile = async () => profile;
  internal.mapProfile = () => profile;
  internal.previousProductionRelease = async () => failurePolicy === SaasPhysicalFailurePolicy.ROLLBACK ? previous : null;
  internal.startRun = async () => ({ id: 'physical-run-001', replayed: false, status: null });
  internal.executePreparedRun = async (
    _run,
    _physicalProfile,
    _actorUserId,
    action,
    contextFactory,
  ) => action(adapter, contextFactory('physical-run-001'));
  internal.appendEvent = async (...args: unknown[]) => {
    events.push({
      status: String(args[3]),
      input: (args[4] ?? {}) as Record<string, unknown>,
    });
  };
  return {
    service,
    adapter,
    lifecycle,
    order,
    events,
    current,
    previous,
    failurePolicy,
  };
}

function deployInput(failurePolicy: SaasPhysicalFailurePolicy) {
  return {
    expected_version: 2,
    health_timeout_seconds: 5,
    failure_policy: failurePolicy,
    idempotency_key: failurePolicy === SaasPhysicalFailurePolicy.HALT
      ? 'physical-halt-recovery-test'
      : 'physical-rollback-recovery-test',
  };
}

describe('SaasPhysicalProvisioningService', () => {
  it('fails closed when no approved infrastructure adapter exists for the topology', async () => {
    const { service } = createService();
    const internal = service as unknown as {
      appendEventFromRun: (...args: unknown[]) => Promise<void>;
      auditRun: (...args: unknown[]) => Promise<void>;
      executePreparedRun: (...args: unknown[]) => Promise<unknown>;
    };
    const append = jest.spyOn(internal, 'appendEventFromRun').mockResolvedValue(undefined);
    const audit = jest.spyOn(internal, 'auditRun').mockResolvedValue(undefined);
    const action = jest.fn<(...args: unknown[]) => Promise<unknown>>();

    await expect(internal.executePreparedRun(
      { id: resourceId, replayed: false, status: 'REQUESTED' },
      profile,
      actorUserId,
      action as never,
      (runId: string) => ({
        tenantId, actorUserId, runId, resourceId, resourceVersion: 1, profile,
      }),
    )).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(append).toHaveBeenCalledWith(
      resourceId,
      actorUserId,
      'FAILED',
      expect.objectContaining({ reasonCode: 'NO_APPROVED_PHYSICAL_ADAPTER' }),
      tenantId,
    );
    expect(audit).toHaveBeenCalledWith(
      resourceId, tenantId, actorUserId, 'PHYSICAL_OPERATION_BLOCKED',
      expect.objectContaining({ status: 'FAILED' }),
    );
    expect(action).not.toHaveBeenCalled();
  });

  it('rejects provider receipts that cannot attest topology isolation and tamper-evident evidence', () => {
    const { service } = createService();
    const valid = {
      providerReference: 'namespace:fo-tenant-1234',
      topology: SaasDeploymentProfile.SHARED_SAAS,
      isolationVerified: true,
      evidenceDigest: 'a'.repeat(64),
    };
    expect(() => (service as never as {
      assertProvisioningReceipt: (receipt: unknown, topology: unknown, provider: string) => void
    }).assertProvisioningReceipt(valid, profile, 'kubernetes')).not.toThrow();

    expect(() => (service as never as {
      assertProvisioningReceipt: (receipt: unknown, topology: unknown, provider: string) => void
    }).assertProvisioningReceipt({ ...valid, isolationVerified: false }, profile, 'kubernetes'))
      .toThrow(ConflictException);
    expect(() => (service as never as {
      assertProvisioningReceipt: (receipt: unknown, topology: unknown, provider: string) => void
    }).assertProvisioningReceipt({ ...valid, topology: SaasDeploymentProfile.DEDICATED_VPC }, profile, 'kubernetes'))
      .toThrow(ConflictException);
    expect(() => (service as never as {
      assertProvisioningReceipt: (receipt: unknown, topology: unknown, provider: string) => void
    }).assertProvisioningReceipt({ ...valid, evidenceDigest: 'unverified' }, profile, 'kubernetes'))
      .toThrow(ConflictException);
  });

  it('accepts only exact artifact and topology evidence for a release', () => {
    const { service } = createService();
    const release = {
      rolloutKey: 'ORG-BASE',
      scopeType: 'ORGANIZATION' as const,
      factoryId: null,
      moduleKey: null,
      agentKey: null,
      releaseChannel: 'STABLE',
      stage: 'PRODUCTION' as const,
      rolloutPercentage: 100,
      artifactVersion: '1.0.0',
      artifactDigest: 'b'.repeat(64),
    };
    const receipt = {
      providerReference: 'deployment:fo-org-base',
      deploymentReference: 'deployment:fo-org-base',
      artifactDigest: release.artifactDigest,
      topology: SaasDeploymentProfile.SHARED_SAAS,
      isolationVerified: true,
      evidenceDigest: 'c'.repeat(64),
    };
    expect(() => (service as never as {
      assertReleaseReceipt: (receipt: unknown, release: unknown, profile: unknown, provider: string) => void
    }).assertReleaseReceipt(receipt, release, profile, 'kubernetes')).not.toThrow();
    expect(() => (service as never as {
      assertReleaseReceipt: (receipt: unknown, release: unknown, profile: unknown, provider: string) => void
    }).assertReleaseReceipt({ ...receipt, artifactDigest: 'd'.repeat(64) }, release, profile, 'kubernetes'))
      .toThrow(ConflictException);
  });

  it('requires health-check receipts and verified rollback targets rather than trusting provider status alone', () => {
    const { service } = createService();
    expect(() => (service as never as {
      assertHealthReceipt: (receipt: unknown) => void
    }).assertHealthReceipt({
      healthy: false, evidenceDigest: 'e'.repeat(64), checkedAt: '2026-10-23T00:00:00.000Z',
      reasonCode: 'READINESS_TIMEOUT',
    })).not.toThrow();
    expect(() => (service as never as {
      assertHealthReceipt: (receipt: unknown) => void
    }).assertHealthReceipt({ healthy: true, evidenceDigest: 'bad', checkedAt: 'not-a-date' }))
      .toThrow(ConflictException);

    const target = {
      rolloutKey: 'ORG-BASE', scopeType: 'ORGANIZATION' as const, factoryId: null,
      moduleKey: null, agentKey: null, releaseChannel: 'STABLE', stage: 'PRODUCTION' as const,
      rolloutPercentage: 100, artifactVersion: '1.0.0', artifactDigest: 'f'.repeat(64),
    };
    const rollback = {
      rolledBack: true, healthy: true, deploymentReference: 'deployment:org-base',
      artifactDigest: target.artifactDigest, topology: SaasDeploymentProfile.SHARED_SAAS,
      evidenceDigest: '1'.repeat(64),
    };
    expect(() => (service as never as {
      assertRollbackReceipt: (receipt: unknown, target: unknown, profile: unknown) => void
    }).assertRollbackReceipt(rollback, target, profile)).not.toThrow();
    expect(() => (service as never as {
      assertRollbackReceipt: (receipt: unknown, target: unknown, profile: unknown) => void
    }).assertRollbackReceipt({ ...rollback, artifactDigest: '0'.repeat(64) }, target, profile))
      .toThrow(ConflictException);
  });

  it('halts the failed provider deployment before pausing its control-plane release', async () => {
    const harness = prepareDeployRecoveryHarness(SaasPhysicalFailurePolicy.HALT, {
      healthy: false,
      evidenceDigest: 'f'.repeat(64),
      checkedAt: '2026-10-23T00:00:00.000Z',
      reasonCode: 'READINESS_TIMEOUT',
    });

    const result = await harness.service.deployRelease(
      tenantId, actorUserId, 'ORG-BASE', deployInput(SaasPhysicalFailurePolicy.HALT) as never,
    );

    expect(result).toMatchObject({ status: 'HALTED', providerCode: 'kubernetes' });
    expect(harness.order).toEqual(['provider-halt', 'control-plane-pause']);
    expect(harness.lifecycle.transition).toHaveBeenCalledWith(
      tenantId,
      actorUserId,
      'ORG-BASE',
      expect.objectContaining({ action: 'PAUSE', expected_version: 2 }),
    );
    expect(harness.events).toContainEqual(expect.objectContaining({
      status: 'HALTED',
      input: expect.objectContaining({
        reasonCode: 'HEALTH_CHECK_FAILED',
        evidence: expect.objectContaining({ halted: true, controlPlanePaused: true }),
      }),
    }));
    expect(harness.adapter.rollbackRelease).not.toHaveBeenCalled();
  });

  it('records a physical halt as recovery-required when control-plane pause cannot be confirmed', async () => {
    const harness = prepareDeployRecoveryHarness(
      SaasPhysicalFailurePolicy.HALT,
      {
        healthy: false,
        evidenceDigest: 'f'.repeat(64),
        checkedAt: '2026-10-23T00:00:00.000Z',
        reasonCode: 'READINESS_TIMEOUT',
      },
      { pauseFails: true },
    );

    await expect(harness.service.deployRelease(
      tenantId, actorUserId, 'ORG-BASE', deployInput(SaasPhysicalFailurePolicy.HALT) as never,
    )).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(harness.order).toEqual(['provider-halt', 'control-plane-pause']);
    expect(harness.events).toContainEqual(expect.objectContaining({
      status: 'HALTED',
      input: expect.objectContaining({
        reasonCode: 'CONTROL_PLANE_PAUSE_FAILED',
        evidence: expect.objectContaining({ halted: true, controlPlanePaused: false }),
      }),
    }));
  });

  it('does not mark a provider rollback successful until the restored artifact is healthy', async () => {
    const harness = prepareDeployRecoveryHarness(
      SaasPhysicalFailurePolicy.ROLLBACK,
      {
        healthy: false,
        evidenceDigest: 'f'.repeat(64),
        checkedAt: '2026-10-23T00:00:00.000Z',
        reasonCode: 'READINESS_TIMEOUT',
      },
      { rollbackHealthy: false },
    );

    const result = await harness.service.deployRelease(
      tenantId, actorUserId, 'ORG-BASE', deployInput(SaasPhysicalFailurePolicy.ROLLBACK) as never,
    );

    expect(result).toMatchObject({ status: 'ROLLBACK_FAILED', providerCode: 'kubernetes' });
    expect(harness.order).toEqual(['provider-rollback']);
    expect(harness.lifecycle.rollback).not.toHaveBeenCalled();
    expect(harness.events).toContainEqual(expect.objectContaining({
      status: 'ROLLBACK_FAILED',
      input: expect.objectContaining({
        reasonCode: 'ROLLBACK_NOT_HEALTHY',
        evidence: expect.objectContaining({ rolledBack: true, healthy: false, controlPlaneRollbackApplied: false }),
      }),
    }));
  });

  it('keeps rollback failed when provider recovery succeeds but control-plane version sync fails', async () => {
    const harness = prepareDeployRecoveryHarness(
      SaasPhysicalFailurePolicy.ROLLBACK,
      {
        healthy: false,
        evidenceDigest: 'f'.repeat(64),
        checkedAt: '2026-10-23T00:00:00.000Z',
        reasonCode: 'READINESS_TIMEOUT',
      },
      { rollbackSyncFails: true },
    );

    const result = await harness.service.deployRelease(
      tenantId, actorUserId, 'ORG-BASE', deployInput(SaasPhysicalFailurePolicy.ROLLBACK) as never,
    );

    expect(result).toMatchObject({ status: 'ROLLBACK_FAILED', providerCode: 'kubernetes' });
    expect(harness.order).toEqual(['provider-rollback', 'control-plane-rollback']);
    expect(harness.events).toContainEqual(expect.objectContaining({
      status: 'ROLLBACK_FAILED',
      input: expect.objectContaining({
        reasonCode: 'CONTROL_PLANE_ROLLBACK_SYNC_FAILED',
        evidence: expect.objectContaining({
          rolledBack: true,
          healthy: true,
          controlPlaneRollbackApplied: false,
        }),
      }),
    }));
    expect(harness.events.some((event) => event.status === 'ROLLED_BACK')).toBe(false);
  });

  it('marks rollback complete only after provider health and control-plane rollback are both verified', async () => {
    const harness = prepareDeployRecoveryHarness(
      SaasPhysicalFailurePolicy.ROLLBACK,
      {
        healthy: false,
        evidenceDigest: 'f'.repeat(64),
        checkedAt: '2026-10-23T00:00:00.000Z',
        reasonCode: 'READINESS_TIMEOUT',
      },
    );

    const result = await harness.service.deployRelease(
      tenantId, actorUserId, 'ORG-BASE', deployInput(SaasPhysicalFailurePolicy.ROLLBACK) as never,
    );

    expect(result).toMatchObject({ status: 'ROLLED_BACK', providerCode: 'kubernetes' });
    expect(harness.order).toEqual(['provider-rollback', 'control-plane-rollback']);
    expect(harness.events).toContainEqual(expect.objectContaining({
      status: 'ROLLED_BACK',
      input: expect.objectContaining({
        evidence: expect.objectContaining({
          rolledBack: true,
          healthy: true,
          controlPlaneRollbackApplied: true,
          controlPlaneRolloutVersion: 3,
          targetArtifactDigest: harness.previous.artifact_digest,
        }),
      }),
    }));
  });

});
