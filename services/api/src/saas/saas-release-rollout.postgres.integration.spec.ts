import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DatabaseService } from '../database/database.service';
import { SaasReleaseChannel, SaasReleaseScopeType } from './dto/create-saas-release-rollout.dto';
import { SaasReleaseRolloutService } from './saas-release-rollout.service';

const hasPostgres = Boolean(process.env.DATABASE_URL && process.env.TEST_ADMIN_DATABASE_URL);
const describeWithPostgres = hasPostgres ? describe : describe.skip;

function digest(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function bucket(rolloutKey: string, subjectKey: string) {
  return Number.parseInt(digest(`${rolloutKey}:${subjectKey}`).slice(0, 8), 16) % 100;
}

describeWithPostgres('SaasReleaseRolloutService PostgreSQL integration', () => {
  let adminPool: Pool;
  let database: DatabaseService;
  let service: SaasReleaseRolloutService;
  const tenantIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    database = new DatabaseService({
      get: (key: string) => key === 'DATABASE_URL' ? process.env.DATABASE_URL : undefined,
    } as never);
    await database.onModuleInit();
    service = new SaasReleaseRolloutService(
      database,
      { authorize: async () => undefined } as never,
      { record: async () => 'release-test-audit-id' } as never,
    );
  });

  afterAll(async () => {
    if (adminPool) {
      try {
        // The registry is immutable in production; disable only its mutation
        // trigger while cleaning fixtures from the dedicated CI database.
        await adminPool.query('ALTER TABLE saas_release_rollouts DISABLE TRIGGER saas_release_rollouts_immutable');
        for (const tenantId of tenantIds) {
          await adminPool.query('DELETE FROM saas_release_rollouts WHERE tenant_id = $1', [tenantId]);
        }
        if (userIds.length) await adminPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
        if (tenantIds.length) await adminPool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]);
      } finally {
        await adminPool.query('ALTER TABLE saas_release_rollouts ENABLE TRIGGER saas_release_rollouts_immutable');
        await adminPool.end();
      }
    }
    if (database) await database.onModuleDestroy();
  }, 60000);

  async function seedTenantAndUser() {
    const tenantId = randomUUID();
    const userId = randomUUID();
    tenantIds.push(tenantId);
    userIds.push(userId);
    await adminPool.query(
      `INSERT INTO tenants (id, slug, name, status, timezone, default_locale)
       VALUES ($1, $2, 'Release Rollout Integration Tenant', 'ACTIVE', 'Asia/Dhaka', 'en-BD')`,
      [tenantId, 'release-' + tenantId.slice(0, 8)],
    );
    await adminPool.query(
      `INSERT INTO users (id, external_subject, email, display_name, status)
       VALUES ($1, $2, $3, 'Release Rollout Actor', 'ACTIVE')`,
      [userId, 'release-rollout-' + userId, 'release-' + userId + '@factoryos.test'],
    );
    return { tenantId, userId };
  }

  async function createOrganizationRelease(tenantId: string, userId: string, key: string, artifactVersion: string) {
    return service.createRollout(tenantId, userId, {
      rollout_key: key,
      scope_type: SaasReleaseScopeType.ORGANIZATION,
      release_channel: SaasReleaseChannel.STABLE,
      artifact_version: artifactVersion,
      artifact_digest: digest(key + ':' + artifactVersion),
      evaluation_reference: 'eval:' + key.toLowerCase(),
      reason: 'Register a versioned release candidate',
      idempotency_key: 'register-' + key,
    });
  }

  async function createModuleRelease(tenantId: string, userId: string, key: string, artifactVersion: string) {
    return service.createRollout(tenantId, userId, {
      rollout_key: key,
      scope_type: SaasReleaseScopeType.MODULE,
      module_key: 'maintenance',
      release_channel: SaasReleaseChannel.STABLE,
      artifact_version: artifactVersion,
      artifact_digest: digest(key + ':' + artifactVersion),
      evaluation_reference: 'eval:' + key.toLowerCase(),
      reason: 'Register the maintenance module release candidate',
      idempotency_key: 'register-' + key,
    });
  }

  async function promote(tenantId: string, userId: string, key: string, expectedVersion: number, stage: 'CANARY' | 'PRODUCTION', percentage: number) {
    return service.promoteRollout(tenantId, userId, key, {
      expected_version: expectedVersion,
      stage,
      rollout_percentage: percentage,
      reason: 'Promote after pinned evaluation passed',
      idempotency_key: `promote-${key}-v${expectedVersion}-${stage}`,
    });
  }

  it('routes canary cohorts, promotes safely, rolls back to a prior artifact and retains immutable history', async () => {
    const { tenantId, userId } = await seedTenantAndUser();

    const org = await createOrganizationRelease(tenantId, userId, 'ORG-BASE', '1.0.0');
    const orgCanary = await promote(tenantId, userId, 'ORG-BASE', 1, 'CANARY', 20);
    const orgProduction = await promote(tenantId, userId, 'ORG-BASE', 2, 'PRODUCTION', 100);
    expect(orgProduction.rollout.stage).toBe('PRODUCTION');
    expect(orgProduction.rollout.version).toBe(3);
    expect(orgCanary.rollout.stage).toBe('CANARY');

    const moduleV2 = await createModuleRelease(tenantId, userId, 'MOD-V2', '2.0.0');
    const moduleV2Canary = await promote(tenantId, userId, 'MOD-V2', 1, 'CANARY', 25);
    expect(moduleV2.rollout.stage).toBe('DRAFT');
    expect(moduleV2Canary.rollout.version).toBe(2);

    let includedSubject = 'canary-subject-0';
    while (bucket('MOD-V2', includedSubject) >= 25) includedSubject += '-n';
    const canaryResolution = await service.resolveEffectiveRelease(tenantId, userId, {
      channel: SaasReleaseChannel.STABLE,
      moduleKey: 'maintenance',
      subjectKey: includedSubject,
    });
    expect(canaryResolution.release?.rolloutKey).toBe('MOD-V2');
    expect(canaryResolution.release?.stage).toBe('CANARY');
    expect(canaryResolution.rolloutBucket).toBeLessThan(25);

    let excludedSubject = 'production-subject-0';
    while (bucket('MOD-V2', excludedSubject) < 25) excludedSubject += '-n';
    const fallbackBeforeScopedProduction = await service.resolveEffectiveRelease(tenantId, userId, {
      channel: SaasReleaseChannel.STABLE,
      moduleKey: 'maintenance',
      subjectKey: excludedSubject,
    });
    expect(fallbackBeforeScopedProduction.release?.rolloutKey).toBe('ORG-BASE');
    expect(fallbackBeforeScopedProduction.release?.stage).toBe('PRODUCTION');

    const moduleV1 = await createModuleRelease(tenantId, userId, 'MOD-V1', '1.0.0');
    const moduleV1Canary = await promote(tenantId, userId, 'MOD-V1', 1, 'CANARY', 10);
    const moduleV1Production = await promote(tenantId, userId, 'MOD-V1', 2, 'PRODUCTION', 100);
    expect(moduleV1.rollout.artifactVersion).toBe('1.0.0');
    expect(moduleV1Canary.rollout.stage).toBe('CANARY');
    expect(moduleV1Production.rollout.stage).toBe('PRODUCTION');

    const fallbackAtModuleScope = await service.resolveEffectiveRelease(tenantId, userId, {
      channel: SaasReleaseChannel.STABLE,
      moduleKey: 'maintenance',
      subjectKey: excludedSubject,
    });
    expect(fallbackAtModuleScope.release?.rolloutKey).toBe('MOD-V1');
    expect(fallbackAtModuleScope.matchedScope).toBe('MODULE');

    const moduleV2Production = await promote(tenantId, userId, 'MOD-V2', 2, 'PRODUCTION', 100);
    expect(moduleV2Production.rollout.artifactVersion).toBe('2.0.0');
    expect(moduleV2Production.rollout.version).toBe(3);

    const productionResolution = await service.resolveEffectiveRelease(tenantId, userId, {
      channel: SaasReleaseChannel.STABLE,
      moduleKey: 'maintenance',
      subjectKey: excludedSubject,
    });
    expect(productionResolution.release?.rolloutKey).toBe('MOD-V2');
    expect(productionResolution.release?.artifactVersion).toBe('2.0.0');

    const rolledBack = await service.rollback(tenantId, userId, 'MOD-V2', {
      expected_version: 3,
      target_rollout_key: 'MOD-V1',
      target_version: 3,
      reason: 'Regression detected in the newly promoted artifact',
      idempotency_key: 'rollback-mod-v2',
    });
    expect(rolledBack.rollout.action).toBe('ROLLBACK');
    expect(rolledBack.rollout.stage).toBe('PRODUCTION');
    expect(rolledBack.rollout.artifactVersion).toBe('1.0.0');
    expect(rolledBack.rollout.rollbackTargetKey).toBe('MOD-V1');

    const safeResolution = await service.resolveEffectiveRelease(tenantId, userId, {
      channel: SaasReleaseChannel.STABLE,
      moduleKey: 'maintenance',
      subjectKey: excludedSubject,
    });
    expect(safeResolution.release?.rolloutKey).toBe('MOD-V2');
    expect(safeResolution.release?.artifactVersion).toBe('1.0.0');

    const paused = await service.transition(tenantId, userId, 'MOD-V2', {
      action: 'PAUSE',
      expected_version: 4,
      reason: 'Pause after incident triage',
      idempotency_key: 'pause-mod-v2',
    });
    expect(paused.rollout.stage).toBe('PAUSED');
    const pauseFallback = await service.resolveEffectiveRelease(tenantId, userId, {
      channel: SaasReleaseChannel.STABLE,
      moduleKey: 'maintenance',
      subjectKey: excludedSubject,
    });
    expect(pauseFallback.release?.rolloutKey).toBe('MOD-V1');

    const resumed = await service.transition(tenantId, userId, 'MOD-V2', {
      action: 'RESUME',
      expected_version: 5,
      reason: 'Resume the previously verified rollback artifact',
      idempotency_key: 'resume-mod-v2',
    });
    expect(resumed.rollout.stage).toBe('PRODUCTION');
    expect(resumed.rollout.artifactVersion).toBe('1.0.0');

    const retired = await service.transition(tenantId, userId, 'MOD-V2', {
      action: 'RETIRE',
      expected_version: 6,
      reason: 'Rollout retired after the comparison window',
      idempotency_key: 'retire-mod-v2',
    });
    expect(retired.rollout.stage).toBe('RETIRED');

    const history = await service.listHistory(tenantId, userId, 'MOD-V2');
    expect(history.items.map((item) => item.version)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(history.items.map((item) => item.action)).toEqual([
      'RETIRE', 'RESUME', 'PAUSE', 'ROLLBACK', 'PROMOTE', 'PROMOTE', 'REGISTER',
    ]);

    await expect(adminPool.query(
      `UPDATE saas_release_rollouts SET reason = 'tampered'
       WHERE tenant_id = $1 AND rollout_key = 'MOD-V2' AND version = 1`,
      [tenantId],
    )).rejects.toThrow('Versioned configuration is immutable');
    await expect(service.resolveEffectiveRelease(randomUUID(), userId, {
      channel: SaasReleaseChannel.STABLE,
      moduleKey: 'maintenance',
      subjectKey: excludedSubject,
    })).resolves.toEqual({ release: null, rolloutBucket: null, matchedScope: null });
  }, 60000);
});
