import { jest } from '@jest/globals';
import { SaasDeploymentProfile } from './dto/create-saas-subscription-plan.dto';
import { SaasPhysicalFailurePolicy } from './dto/execute-saas-physical-operation.dto';
import { SaasPhysicalProvisioningService } from './saas-physical-provisioning.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const actorUserId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const resourceId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const runId = 'd55101bb-a716-4b2a-9fb4-ff20b1b36ac1';
const profile = {
  id: '456f2b7f-8c46-4d9a-8b44-18eae66a4450',
  profileType: SaasDeploymentProfile.SHARED_SAAS,
  deploymentReference: null,
  regionCode: 'ap-south-1',
  residencyDomain: 'BD',
  edgeSiteCode: null,
};
const currentRelease = {
  id: resourceId,
  tenant_id: tenantId,
  rollout_key: 'ORG-BETA',
  version: 2,
  scope_type: 'ORGANIZATION' as const,
  factory_id: null,
  module_key: null,
  agent_key: null,
  release_channel: 'STABLE',
  stage: 'CANARY',
  artifact_version: '2.0.0',
  artifact_digest: 'b'.repeat(64),
  rollout_percentage: 10,
};
const previousRelease = {
  ...currentRelease,
  id: 'a8402d32-7ad6-4197-a9bb-b3b8dc340d80',
  rollout_key: 'ORG-BASE',
  version: 3,
  stage: 'PRODUCTION',
  artifact_version: '1.8.0',
  artifact_digest: 'a'.repeat(64),
  rollout_percentage: 100,
};

function setup(policy: SaasPhysicalFailurePolicy) {
  const database = {
    query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>().mockResolvedValue({ rows: [] }),
    transaction: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const iam = { authorize: jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined) };
  const audit = { record: jest.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('audit-id') };

  const transition = jest.fn<(...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValue({ rollout: { stage: 'PAUSED', version: 3 } });
  const rollback = jest.fn<(...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValue({ rollout: { stage: 'PRODUCTION', version: 4 } });
  const releaseRolloutService = { transition, rollback };

  const deployedReference = 'deployment:fo-faaab63dc44746ce950ddeeb/release-org-beta';
  const adapter = {
    providerCode: 'kubernetes',
    supports: jest.fn<(...args: unknown[]) => boolean>().mockReturnValue(true),
    provisionSandbox: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    provisionDeploymentProfile: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    deployRelease: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
      providerReference: deployedReference,
      deploymentReference: deployedReference,
      topology: SaasDeploymentProfile.SHARED_SAAS,
      isolationVerified: true,
      artifactDigest: currentRelease.artifact_digest,
      evidenceDigest: 'c'.repeat(64),
    }),
    checkReleaseHealth: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
      healthy: false,
      checkedAt: '2026-10-23T06:00:00.000Z',
      reasonCode: 'READINESS_TIMEOUT',
      evidenceDigest: 'd'.repeat(64),
    }),
    haltRelease: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
      halted: true,
      evidenceDigest: 'e'.repeat(64),
    }),
    rollbackRelease: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
      rolledBack: true,
      healthy: true,
      deploymentReference: deployedReference,
      artifactDigest: previousRelease.artifact_digest,
      topology: SaasDeploymentProfile.SHARED_SAAS,
      evidenceDigest: 'f'.repeat(64),
    }),
  };

  const service = new SaasPhysicalProvisioningService(
    database as never,
    iam as never,
    audit as never,
    [adapter] as never,
    releaseRolloutService as never,
  );
  const internals = service as unknown as Record<string, (...args: unknown[]) => unknown>;
  internals.loadLatestRelease = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(currentRelease);
  internals.activeProfile = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({\n    id: profile.id, profile_type: profile.profileType, deployment_reference: profile.deploymentReference,\n    region_code: profile.regionCode, residency_domain: profile.residencyDomain, edge_site_code: profile.edgeSiteCode,\n  });
  internals.startRun = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
    id: runId, replayed: false, status: 'REQUESTED',
  });
  internals.previousProductionRelease = jest.fn<(...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValue(policy === SaasPhysicalFailurePolicy.ROLLBACK ? previousRelease : null);

  const appendEvent = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
  const appendEventFromRun = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
  const auditRun = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
  const loadRunViewForActor = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
    idempotent: true, run: { id: runId, status: policy === SaasPhysicalFailurePolicy.HALT ? 'HALTED' : 'ROLLED_BACK' }, events: [],
  });
  internals.appendEvent = appendEvent;
  internals.appendEventFromRun = appendEventFromRun;
  internals.auditRun = auditRun;
  internals.loadRunViewForActor = loadRunViewForActor;

  return { service, adapter, transition, rollback, appendEvent, appendEventFromRun, auditRun, iam, loadRunViewForActor };
}

describe('SaaS physical rollout failure policy', () => {
  it('halts an unhealthy deployment, pauses the control-plane rollout, and records durable audit evidence', async () => {
    const test = setup(SaasPhysicalFailurePolicy.HALT);
    await test.service.deployRelease(tenantId, actorUserId, currentRelease.rollout_key, {
      expected_version: currentRelease.version,
      idempotency_key: 'physical-halt-run-1',
      failure_policy: SaasPhysicalFailurePolicy.HALT,
      health_timeout_seconds: 5,
    });

    expect(test.adapter.deployRelease).toHaveBeenCalledTimes(1);
    expect(test.adapter.checkReleaseHealth).toHaveBeenCalledTimes(1);
    expect(test.adapter.haltRelease).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, actorUserId, runId }),
      expect.stringMatching(/^deployment:/),
      'HEALTH_CHECK_FAILED',
      'fo-physical-' + runId + '-halt',
    );
    expect(test.transition).toHaveBeenCalledWith(tenantId, actorUserId, currentRelease.rollout_key,
      expect.objectContaining({
        action: 'PAUSE',
        expected_version: currentRelease.version,
        idempotency_key: 'physical-halt-' + runId,
      }));
    expect(test.rollback).not.toHaveBeenCalled();
    expect(test.appendEvent).toHaveBeenCalledWith(
      tenantId, actorUserId, runId, 'HALTED',
      expect.objectContaining({
        reasonCode: 'HEALTH_CHECK_FAILED',
        evidence: expect.objectContaining({ halted: true, controlPlanePaused: true }),
      }),
    );
    expect(test.auditRun).toHaveBeenCalledWith(
      runId, tenantId, actorUserId, 'PHYSICAL_OPERATION_HALTED',
      expect.objectContaining({ status: 'HALTED', providerCode: 'kubernetes' }),
    );
  });

  it('restores the exact previous production digest, verifies health, and writes a rollback version', async () => {
    const test = setup(SaasPhysicalFailurePolicy.ROLLBACK);
    await test.service.deployRelease(tenantId, actorUserId, currentRelease.rollout_key, {
      expected_version: currentRelease.version,
      idempotency_key: 'physical-rollback-run-1',
      failure_policy: SaasPhysicalFailurePolicy.ROLLBACK,
      health_timeout_seconds: 5,
    });

    expect(test.adapter.haltRelease).not.toHaveBeenCalled();
    expect(test.adapter.rollbackRelease).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, actorUserId, runId }),
      expect.stringMatching(/^deployment:/),
      expect.objectContaining({ artifactDigest: currentRelease.artifact_digest }),
      expect.objectContaining({
        rolloutKey: previousRelease.rollout_key,
        artifactDigest: previousRelease.artifact_digest,
        stage: 'PRODUCTION',
      }),
      5,
      'fo-physical-' + runId + '-rollback',
    );
    expect(test.rollback).toHaveBeenCalledWith(tenantId, actorUserId, currentRelease.rollout_key,
      expect.objectContaining({
        expected_version: currentRelease.version,
        target_rollout_key: previousRelease.rollout_key,
        target_version: previousRelease.version,
        idempotency_key: 'physical-rollback-' + runId,
      }));
    expect(test.appendEvent).toHaveBeenCalledWith(
      tenantId, actorUserId, runId, 'ROLLED_BACK',
      expect.objectContaining({
        evidence: expect.objectContaining({
          failedArtifactDigest: currentRelease.artifact_digest,
          targetArtifactDigest: previousRelease.artifact_digest,
          controlPlaneRollbackApplied: true,
          rolledBack: true,
          healthy: true,
        }),
      }),
    );
    expect(test.auditRun).toHaveBeenCalledWith(
      runId, tenantId, actorUserId, 'PHYSICAL_OPERATION_ROLLED_BACK',
      expect.objectContaining({ status: 'ROLLED_BACK', providerCode: 'kubernetes' }),
    );
  });
});
