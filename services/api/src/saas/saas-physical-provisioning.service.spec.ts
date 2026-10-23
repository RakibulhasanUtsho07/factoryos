import { jest } from '@jest/globals';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { SaasDeploymentProfile } from './dto/create-saas-subscription-plan.dto';
import { SaasPhysicalProvisioningService } from './saas-physical-provisioning.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const actorUserId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const resourceId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';

function createService(adapters: unknown[] = []) {
  const database = {
    query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(),
    transaction: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const iam = { authorize: jest.fn<(...args: unknown[]) => Promise<void>>() };
  const audit = { record: jest.fn<(...args: unknown[]) => Promise<string>>() };
  const service = new SaasPhysicalProvisioningService(
    database as never, iam as never, audit as never, adapters as never,
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
});
