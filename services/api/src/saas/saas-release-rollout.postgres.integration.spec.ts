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
        // Production evidence is immutable; disable only the evidence guards while
        // deleting fixtures from the isolated CI database.
        await adminPool.query('ALTER TABLE saas_physical_provisioning_events DISABLE TRIGGER saas_physical_provisioning_events_immutable');
        await adminPool.query('ALTER TABLE saas_physical_provisioning_runs DISABLE TRIGGER saas_physical_provisioning_runs_immutable');
        await adminPool.query('ALTER TABLE saas_release_rollouts DISABLE TRIGGER saas_release_rollouts_immutable');
        for (const tenantId of tenantIds) {
          await adminPool.query('DELETE FROM saas_physical_provisioning_events WHERE tenant_id = $1', [tenantId]);
          await adminPool.query('DELETE FROM saas_physical_provisioning_runs WHERE tenant_id = $1', [tenantId]);
          await adminPool.query('DELETE FROM saas_release_rollouts WHERE tenant_id = $1', [tenantId]);
        }
        if (userIds.length) await adminPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
        if (tenantIds.length) await adminPool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]);
      } finally {
        await adminPool.query('ALTER TABLE saas_release_rollouts ENABLE TRIGGER saas_release_rollouts_immutable');
        await adminPool.query('ALTER TABLE saas_physical_provisioning_runs ENABLE TRIGGER saas_physical_provisioning_runs_immutable');
        await adminPool.query('ALTER TABLE saas_physical_provisioning_events ENABLE TRIGGER saas_physical_provisioning_events_immutable');
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

  async function recordPhysicalDeployment(tenantId: string, userId: string, rollout: {
    id: string; rolloutKey: string; version: number; artifactDigest: string;
  }) {
    const runId = randomUUID();
    const requestHash = digest(JSON.stringify({
      operation: 'RELEASE_DEPLOY', tenantId, rolloutKey: rollout.rolloutKey,
      resourceVersion: rollout.version, artifactDigest: rollout.artifactDigest, runId,
    }));
    const evidenceDigest = digest(JSON.stringify({ runId, provider: 'test-fixture', artifactDigest: rollout.artifactDigest }));
    await adminPool.query(
      `INSERT INTO saas_physical_provisioning_runs
        (id,tenant_id,operation,resource_type,resource_id,resource_key,resource_version,topology,
         deployment_reference,failure_policy,health_timeout_seconds,artifact_digest,dataset_manifest_digest,
         idempotency_key,request_hash,actor_user_id)
       VALUES ($1,$2,'RELEASE_DEPLOY','RELEASE',$3,$4,$5,'SHARED_SAAS',$6,'HALT',60,$7,NULL,$8,$9,$10)`,
      [runId, tenantId, rollout.id, rollout.rolloutKey, rollout.version,
        'ci-target-' + rollout.rolloutKey.toLowerCase(), rollout.artifactDigest,
        'integration-physical-' + runId, requestHash, userId],
    );
    const events = [
      { version: 1, status: 'REQUESTED', evidence: { fixture: 'provider receipt contract' } },
      { version: 2, status: 'IN_PROGRESS', evidence: { providerCode: 'integration-fixture' } },
      { version: 3, status: 'SUCCEEDED', evidence: {
        artifactDigest: rollout.artifactDigest, healthCheck: { healthy: true }, isolationVerified: true,
      } },
    ];
    for (const event of events) {
      await adminPool.query(
        `INSERT INTO saas_physical_provisioning_events
          (tenant_id,run_id,event_version,event_status,provider_code,provider_reference,evidence_digest,
           reason_code,evidence,actor_user_id,idempotency_key)
         VALUES ($1,$2,$3,$4,'integration-fixture',$5,$6,NULL,$7::jsonb,$8,$9)`,
        [tenantId, runId, event.version, event.status,
          'deployment:ci/' + rollout.rolloutKey.toLowerCase(), evidenceDigest,
          JSON.stringify(event.evidence), userId, 'physical:' + runId + ':' + event.status],
      );
    }
    return runId;
  }

  async function recordPhysicalRollbackReceipt(
    tenantId: string,
    userId: string,
    failedRollout: { id: string; rolloutKey: string; version: number; artifactDigest: string },
    restoredRollout: { version: number; artifactDigest: string; rolloutKey: string },
  ) {
    const runId = randomUUID();
    const requestHash = digest(JSON.stringify({
      operation: 'RELEASE_DEPLOY', tenantId, rolloutKey: failedRollout.rolloutKey,
      resourceVersion: failedRollout.version, artifactDigest: failedRollout.artifactDigest, runId,
    }));
    const evidenceDigest = digest(JSON.stringify({
      runId, rolledBack: true, targetArtifactDigest: restoredRollout.artifactDigest,
    }));
    await adminPool.query(
      `INSERT INTO saas_physical_provisioning_runs
        (id,tenant_id,operation,resource_type,resource_id,resource_key,resource_version,topology,
         deployment_reference,failure_policy,health_timeout_seconds,artifact_digest,dataset_manifest_digest,
         idempotency_key,request_hash,actor_user_id)
       VALUES ($1,$2,'RELEASE_DEPLOY','RELEASE',$3,$4,$5,'SHARED_SAAS',$6,'ROLLBACK',60,$7,NULL,$8,$9,$10)`,
      [runId, tenantId, failedRollout.id, failedRollout.rolloutKey, failedRollout.version,
        'ci-target-' + failedRollout.rolloutKey.toLowerCase(), failedRollout.artifactDigest,
        'integration-rollback-' + runId, requestHash, userId],
    );
    const events = [
      { version: 1, status: 'REQUESTED', evidence: { fixture: 'provider receipt contract' } },
      { version: 2, status: 'IN_PROGRESS', evidence: { providerCode: 'integration-fixture' } },
      { version: 3, status: 'ROLLBACK_IN_PROGRESS', evidence: { reasonCode: 'HEALTH_CHECK_FAILED' } },
      { version: 4, status: 'ROLLED_BACK', evidence: {
        rolledBack: true, healthy: true,
        controlPlaneRolloutVersion: String(restoredRollout.version),
        targetRolloutKey: restoredRollout.rolloutKey,
        targetArtifactDigest: restoredRollout.artifactDigest,
      } },
    ];
    for (const event of events) {
      await adminPool.query(
        `INSERT INTO saas_physical_provisioning_events
          (tenant_id,run_id,event_version,event_status,provider_code,provider_reference,evidence_digest,
           reason_code,evidence,actor_user_id,idempotency_key)
         VALUES ($1,$2,$3,$4,'integration-fixture',$5,$6,$7,$8::jsonb,$9,$10)`,
        [tenantId, runId, event.version, event.status,
          'deployment:ci/' + failedRollout.rolloutKey.toLowerCase(), evidenceDigest,
          event.status === 'ROLLBACK_IN_PROGRESS' ? 'HEALTH_CHECK_FAILED' : null,
          JSON.stringify(event.evidence), userId, 'physical:' + runId + ':' + event.status],
      );
    }
  }

  it('routes canary cohorts, promotes safely, rolls back to a prior artifact and retains immutable history', async () => {
    const { tenantId, userId } = await seedTenantAndUser();

    await createOrganizationRelease(tenantId, userId, 'ORG-BASE', '1.0.0');
    const orgCanary = await promote(tenantId, userId, 'ORG-BASE', 1, 'CANARY', 20);
    await recordPhysicalDeployment(tenantId, userId, orgCanary.rollout);
    const orgProduction = await promote(tenantId, userId, 'ORG-BASE', 2, 'PRODUCTION', 100);
    await recordPhysicalDeployment(tenantId, userId, orgProduction.rollout);
    expect(orgProduction.rollout.stage).toBe('PRODUCTION');
    expect(orgProduction.rollout.version).toBe(3);
    expect(orgCanary.rollout.stage).toBe('CANARY');

    const moduleV2 = await createModuleRelease(tenantId, userId, 'MOD-V2', '2.0.0');
    const moduleV2Canary = await promote(tenantId, userId, 'MOD-V2', 1, 'CANARY', 25);
    await recordPhysicalDeployment(tenantId, userId, moduleV2Canary.rollout);
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
    await recordPhysicalDeployment(tenantId, userId, moduleV1Canary.rollout);
    const moduleV1Production = await promote(tenantId, userId, 'MOD-V1', 2, 'PRODUCTION', 100);
    await recordPhysicalDeployment(tenantId, userId, moduleV1Production.rollout);
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
    await recordPhysicalDeployment(tenantId, userId, moduleV2Production.rollout);
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
    await recordPhysicalRollbackReceipt(tenantId, userId, moduleV2Production.rollout, rolledBack.rollout);

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
