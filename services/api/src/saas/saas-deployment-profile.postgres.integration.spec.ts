import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { Pool } from 'pg';
import { DatabaseService } from '../database/database.service';
import { CreateSaasDeploymentProfileDto, SaasDeploymentProfileScopeType } from './dto/create-saas-deployment-profile.dto';
import { SaasDeploymentProfile } from './dto/create-saas-subscription-plan.dto';
import { SaasDeploymentProfileTransitionAction } from './dto/transition-saas-deployment-profile.dto';
import { SaasDeploymentProfileService } from './saas-deployment-profile.service';

const postgresDescribe = process.env.TEST_ADMIN_DATABASE_URL ? describe : describe.skip;

postgresDescribe('SaasDeploymentProfileService PostgreSQL control-plane invariants', () => {
  let adminPool: Pool;
  let database: DatabaseService;
  let service: SaasDeploymentProfileService;
  const tenantIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    const config = {
      get: (key: string) => key === 'DATABASE_URL' ? process.env.DATABASE_URL : undefined,
    } as ConfigService;
    database = new DatabaseService(config);
    await database.onModuleInit();
    service = new SaasDeploymentProfileService(
      database,
      { authorize: async () => undefined } as never,
      { record: async () => undefined } as never,
    );
  }, 60000);

  afterAll(async () => {
    if (adminPool && tenantIds.length) {
      await adminPool.query('ALTER TABLE saas_deployment_profile_versions DISABLE TRIGGER saas_deployment_profile_immutable');
      try {
        await adminPool.query('DELETE FROM saas_deployment_profile_versions WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
        if (userIds.length) {
          await adminPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
        }
        await adminPool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]);
      } finally {
        await adminPool.query('ALTER TABLE saas_deployment_profile_versions ENABLE TRIGGER saas_deployment_profile_immutable');
      }
    }
    if (database) await database.onModuleDestroy();
    if (adminPool) await adminPool.end();
  }, 60000);

  async function createIdentity(label: string) {
    const tenantId = randomUUID();
    const userId = randomUUID();
    tenantIds.push(tenantId);
    userIds.push(userId);
    await adminPool.query(
      `INSERT INTO tenants (id, slug, name, status, timezone, default_locale)
       VALUES ($1, $2, 'Deployment Profile Integration Tenant', 'ACTIVE', 'Asia/Dhaka', 'en-BD')`,
      [tenantId, 'deploy-prof-' + tenantId.slice(0, 8)],
    );
    await adminPool.query(
      `INSERT INTO users (id, external_subject, email, display_name, status)
       VALUES ($1, $2, $3, 'Deployment Profile Test Actor', 'ACTIVE')`,
      [userId, 'deploy-prof-' + userId, 'deploy-prof-' + userId + '@factoryos.test'],
    );
    return { tenantId, userId, label };
  }

  it('versions lifecycle snapshots, resolves an active profile, migrates safely, and preserves tenant isolation', async () => {
    const identity = await createIdentity('primary');
    const createdInput: CreateSaasDeploymentProfileDto = {
      scope_type: SaasDeploymentProfileScopeType.TENANT,
      profile_type: SaasDeploymentProfile.DEDICATED_VPC,
      deployment_reference: 'deploy-vpc-001',
      region_code: 'ap-south-1',
      residency_domain: 'BD',
      reason: 'register deployment target after infrastructure review',
      idempotency_key: 'profile-create-' + identity.tenantId,
    };

    const created = await service.createAssignment(identity.tenantId, identity.userId, createdInput);
    expect(created.profile.version).toBe(1);
    expect(created.profile.status).toBe('PLANNED');
    const replay = await service.createAssignment(identity.tenantId, identity.userId, createdInput);
    expect(replay.replayed).toBe(true);
    expect(replay.profile.id).toBe(created.profile.id);

    const provisioning = await service.transition(
      identity.tenantId,
      identity.userId,
      SaasDeploymentProfileScopeType.TENANT,
      undefined,
      {
        action: SaasDeploymentProfileTransitionAction.START_PROVISIONING,
        expected_version: 1,
        reason: 'external deployment controller accepted provisioning request',
        idempotency_key: 'profile-provision-' + identity.tenantId,
      },
    );
    expect(provisioning.profile.version).toBe(2);
    expect(provisioning.profile.status).toBe('PROVISIONING');

    const active = await service.transition(
      identity.tenantId,
      identity.userId,
      SaasDeploymentProfileScopeType.TENANT,
      undefined,
      {
        action: SaasDeploymentProfileTransitionAction.ACTIVATE,
        expected_version: 2,
        reason: 'external deployment controller confirmed ready',
        idempotency_key: 'profile-activate-' + identity.tenantId,
      },
    );
    expect(active.profile.version).toBe(3);
    expect(active.profile.status).toBe('ACTIVE');
    expect(active.profile.profileType).toBe(SaasDeploymentProfile.DEDICATED_VPC);

    await expect(service.transition(
      identity.tenantId,
      identity.userId,
      SaasDeploymentProfileScopeType.TENANT,
      undefined,
      {
        action: SaasDeploymentProfileTransitionAction.PAUSE,
        expected_version: 1,
        reason: 'verify optimistic concurrency',
        idempotency_key: 'profile-stale-' + identity.tenantId,
      },
    )).rejects.toBeInstanceOf(ConflictException);

    const migrating = await service.transition(
      identity.tenantId,
      identity.userId,
      SaasDeploymentProfileScopeType.TENANT,
      undefined,
      {
        action: SaasDeploymentProfileTransitionAction.START_MIGRATION,
        expected_version: 3,
        target_profile_type: SaasDeploymentProfile.HYBRID_EDGE_CLOUD,
        target_deployment_reference: 'edge-target-001',
        target_region_code: 'ap-south-1',
        target_residency_domain: 'BD',
        target_edge_site_code: 'EDGE-DAC-01',
        reason: 'target edge environment has been prepared by the infrastructure controller',
        idempotency_key: 'profile-migration-' + identity.tenantId,
      },
    );
    expect(migrating.profile.status).toBe('MIGRATING');
    expect(migrating.profile.profileType).toBe(SaasDeploymentProfile.DEDICATED_VPC);
    expect(migrating.profile.targetProfileType).toBe(SaasDeploymentProfile.HYBRID_EDGE_CLOUD);

    const migrated = await service.transition(
      identity.tenantId,
      identity.userId,
      SaasDeploymentProfileScopeType.TENANT,
      undefined,
      {
        action: SaasDeploymentProfileTransitionAction.COMPLETE_MIGRATION,
        expected_version: 4,
        reason: 'migration verification completed by the external controller',
        idempotency_key: 'profile-migration-complete-' + identity.tenantId,
      },
    );
    expect(migrated.profile.version).toBe(5);
    expect(migrated.profile.status).toBe('ACTIVE');
    expect(migrated.profile.profileType).toBe(SaasDeploymentProfile.HYBRID_EDGE_CLOUD);
    expect(migrated.profile.targetProfileType).toBeNull();

    const effective = await service.resolveEffective(identity.tenantId, identity.userId);
    expect(effective.profile?.profileType).toBe(SaasDeploymentProfile.HYBRID_EDGE_CLOUD);
    expect(effective.tenantSemanticsChanged).toBe(false);

    await expect(adminPool.query(
      'UPDATE saas_deployment_profile_versions SET reason = $2 WHERE id = $1',
      [migrated.profile.id, 'attempted tampering'],
    )).rejects.toThrow();

    const other = await createIdentity('other');
    const crossTenant = await database.query(
      'SELECT id::text AS id FROM saas_deployment_profile_versions WHERE tenant_id = $1',
      [identity.tenantId],
      { tenantId: other.tenantId },
    );
    expect(crossTenant.rows).toHaveLength(0);
  }, 60000);
});
