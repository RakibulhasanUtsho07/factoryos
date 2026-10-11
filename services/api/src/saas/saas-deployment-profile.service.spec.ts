import { jest } from '@jest/globals';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { CreateSaasDeploymentProfileDto, SaasDeploymentProfileScopeType } from './dto/create-saas-deployment-profile.dto';
import { SaasDeploymentProfile } from './dto/create-saas-subscription-plan.dto';
import { SaasDeploymentProfileTransitionAction, TransitionSaasDeploymentProfileDto } from './dto/transition-saas-deployment-profile.dto';
import { SaasDeploymentProfileService } from './saas-deployment-profile.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const actorUserId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const factoryId = 'c49be1f0-3ab7-43c5-91b8-38b1c82faba0';
const profileId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: profileId,
    tenant_id: tenantId,
    scope_type: 'TENANT',
    scope_key: 'TENANT',
    factory_id: null,
    version: '2',
    profile_type: SaasDeploymentProfile.SINGLE_TENANT,
    status: 'PROVISIONING',
    action: 'START_PROVISIONING',
    deployment_reference: 'deploy-tenant-001',
    region_code: 'ap-south-1',
    residency_domain: 'BD',
    edge_site_code: null,
    target_profile_type: null,
    target_deployment_reference: null,
    target_region_code: null,
    target_residency_domain: null,
    target_edge_site_code: null,
    previous_version: '1',
    reason: 'test deployment profile',
    idempotency_key: 'profile-op-2',
    request_hash: 'a'.repeat(64),
    actor_user_id: actorUserId,
    created_at: '2026-10-11T12:00:00.000Z',
    ...overrides,
  };
}

describe('SaasDeploymentProfileService', () => {
  const clientQuery = jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();
  const database = {
    query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(),
    transaction: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const iam = { authorize: jest.fn<(...args: unknown[]) => Promise<void>>() };
  const audit = { record: jest.fn<(...args: unknown[]) => Promise<unknown>>() };
  let service: SaasDeploymentProfileService;

  beforeEach(() => {
    jest.resetAllMocks();
    iam.authorize.mockResolvedValue(undefined);
    audit.record.mockResolvedValue(undefined);
    database.transaction.mockImplementation(async (...args: unknown[]) => {
      const callback = args.find((value) => typeof value === 'function') as (client: unknown) => Promise<unknown>;
      return callback({ query: clientQuery });
    });
    service = new SaasDeploymentProfileService(database as never, iam as never, audit as never);
  });

  it('requires a valid verified tenant and actor before touching storage', async () => {
    await expect(service.listLatest('spoofed-tenant', actorUserId)).rejects.toBeInstanceOf(BadRequestException);
    expect(iam.authorize).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('fails closed when IAM denies deployment profile administration', async () => {
    iam.authorize.mockRejectedValueOnce(new ForbiddenException('permission denied'));
    await expect(service.createAssignment(tenantId, actorUserId, {
      scope_type: SaasDeploymentProfileScopeType.TENANT,
      profile_type: SaasDeploymentProfile.SHARED_SAAS,
      reason: 'test unauthorized profile',
      idempotency_key: 'unauthorized-profile',
    } as CreateSaasDeploymentProfileDto)).rejects.toBeInstanceOf(ForbiddenException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects mismatched tenant/factory scope before opening a transaction', async () => {
    await expect(service.createAssignment(tenantId, actorUserId, {
      scope_type: SaasDeploymentProfileScopeType.TENANT,
      factory_id: factoryId,
      profile_type: SaasDeploymentProfile.SHARED_SAAS,
      reason: 'invalid scope',
      idempotency_key: 'scope-invalid',
    } as CreateSaasDeploymentProfileDto)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects URL or path-like deployment references rather than storing credentials or endpoints', async () => {
    await expect(service.createAssignment(tenantId, actorUserId, {
      scope_type: SaasDeploymentProfileScopeType.TENANT,
      profile_type: SaasDeploymentProfile.DEDICATED_VPC,
      deployment_reference: 'https://cloud.example.com/account/secret',
      reason: 'test untrusted reference',
      idempotency_key: 'unsafe-deployment-reference',
    } as CreateSaasDeploymentProfileDto)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires expected_version to be a positive safe integer', async () => {
    await expect(service.transition(tenantId, actorUserId, SaasDeploymentProfileScopeType.TENANT, undefined, {
      action: SaasDeploymentProfileTransitionAction.PAUSE,
      expected_version: 0,
      reason: 'invalid version',
      idempotency_key: 'bad-expected-version',
    } as TransitionSaasDeploymentProfileDto)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('accepts target profile fields only when beginning a migration', async () => {
    await expect(service.transition(tenantId, actorUserId, SaasDeploymentProfileScopeType.TENANT, undefined, {
      action: SaasDeploymentProfileTransitionAction.PAUSE,
      expected_version: 2,
      target_profile_type: SaasDeploymentProfile.HYBRID_EDGE_CLOUD,
      reason: 'target fields on pause are unsafe',
      idempotency_key: 'target-fields-on-pause',
    } as TransitionSaasDeploymentProfileDto)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects a stale version before inserting a new lifecycle snapshot', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [{ id: tenantId }] });
    clientQuery.mockResolvedValueOnce({ rows: [] });
    clientQuery.mockResolvedValueOnce({ rows: [profileRow({ version: '2', status: 'ACTIVE', action: 'ACTIVATE' })] });
    await expect(service.transition(tenantId, actorUserId, SaasDeploymentProfileScopeType.TENANT, undefined, {
      action: SaasDeploymentProfileTransitionAction.PAUSE,
      expected_version: 1,
      reason: 'stale lifecycle version',
      idempotency_key: 'stale-profile-transition',
    } as TransitionSaasDeploymentProfileDto)).rejects.toBeInstanceOf(ConflictException);
    expect(clientQuery).toHaveBeenCalledTimes(3);
  });

  it('requires an edge-site reference before activating a hybrid edge-cloud profile', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [{ id: tenantId }] });
    clientQuery.mockResolvedValueOnce({ rows: [] });
    clientQuery.mockResolvedValueOnce({ rows: [profileRow({
      version: '2',
      status: 'PROVISIONING',
      profile_type: SaasDeploymentProfile.HYBRID_EDGE_CLOUD,
      deployment_reference: 'edge-deploy-01',
      edge_site_code: null,
    })] });
    await expect(service.transition(tenantId, actorUserId, SaasDeploymentProfileScopeType.TENANT, undefined, {
      action: SaasDeploymentProfileTransitionAction.ACTIVATE,
      expected_version: 2,
      reason: 'activate without edge site',
      idempotency_key: 'hybrid-without-edge-site',
    } as TransitionSaasDeploymentProfileDto)).rejects.toBeInstanceOf(BadRequestException);
    expect(clientQuery).toHaveBeenCalledTimes(3);
  });

  it('resolves only an active profile and exposes that tenant semantics remain unchanged', async () => {
    database.query.mockResolvedValueOnce({ rows: [profileRow({
      scope_type: SaasDeploymentProfileScopeType.FACTORY,
      scope_key: 'FACTORY:' + factoryId,
      factory_id: factoryId,
      profile_type: SaasDeploymentProfile.HYBRID_EDGE_CLOUD,
      status: 'ACTIVE',
      edge_site_code: 'EDGE-DAC-01',
    })] });
    const result = await service.resolveEffective(tenantId, actorUserId, factoryId);
    expect(result.profile?.scopeType).toBe(SaasDeploymentProfileScopeType.FACTORY);
    expect(result.profile?.profileType).toBe(SaasDeploymentProfile.HYBRID_EDGE_CLOUD);
    expect(result.fallbackToTenant).toBe(false);
    expect(result.tenantSemanticsChanged).toBe(false);
    expect(iam.authorize).toHaveBeenCalledWith(actorUserId, tenantId, 'saas.deployment_profiles.read');
  });
});
