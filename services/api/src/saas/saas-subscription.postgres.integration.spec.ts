import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DatabaseService } from '../database/database.service';
import { SaasSubscriptionService } from './saas-subscription.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { FeatureFlagService } from '../entitlements/feature-flag.service';

const postgresDescribe = process.env.TEST_ADMIN_DATABASE_URL ? describe : describe.skip;

postgresDescribe('SaasSubscriptionService PostgreSQL lifecycle invariants', () => {
  let adminPool: Pool;
  let database: DatabaseService;
  let service: SaasSubscriptionService;
  let entitlementService: EntitlementService;
  let featureFlagService: FeatureFlagService;
  const tenantIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    const config = {
      get: (key: string) => key === 'DATABASE_URL' ? process.env.DATABASE_URL : undefined,
    } as ConfigService;
    database = new DatabaseService(config);
    await database.onModuleInit();
    const iam = { authorize: async () => undefined };
    const audit = { record: async () => undefined };
    service = new SaasSubscriptionService(database, iam as never, audit as never);
    entitlementService = new EntitlementService(database, audit as never);
    featureFlagService = new FeatureFlagService(database, audit as never);
  }, 60000);

  afterAll(async () => {
    if (adminPool && tenantIds.length) {
      await adminPool.query('ALTER TABLE saas_subscription_events DISABLE TRIGGER saas_subscription_events_immutable');
      await adminPool.query('ALTER TABLE saas_subscriptions DISABLE TRIGGER saas_subscription_no_delete');
      await adminPool.query('ALTER TABLE saas_subscription_plans DISABLE TRIGGER saas_subscription_plan_immutable');
      await adminPool.query('ALTER TABLE entitlements DISABLE TRIGGER entitlements_immutable_version');
      await adminPool.query('ALTER TABLE feature_flags DISABLE TRIGGER feature_flags_immutable_version');
      try {
        await adminPool.query('DELETE FROM entitlements WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
        await adminPool.query('DELETE FROM feature_flags WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
        await adminPool.query('DELETE FROM saas_subscription_events WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
        await adminPool.query('DELETE FROM saas_subscriptions WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
        await adminPool.query('DELETE FROM saas_subscription_plans WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
        if (userIds.length) await adminPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
        await adminPool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]);
      } finally {
        await adminPool.query('ALTER TABLE saas_subscription_plans ENABLE TRIGGER saas_subscription_plan_immutable');
        await adminPool.query('ALTER TABLE entitlements ENABLE TRIGGER entitlements_immutable_version');
        await adminPool.query('ALTER TABLE feature_flags ENABLE TRIGGER feature_flags_immutable_version');
        await adminPool.query('ALTER TABLE saas_subscriptions ENABLE TRIGGER saas_subscription_no_delete');
        await adminPool.query('ALTER TABLE saas_subscription_events ENABLE TRIGGER saas_subscription_events_immutable');
      }
    }
    if (database) await database.onModuleDestroy();
    if (adminPool) await adminPool.end();
  }, 60000);

  it('enforces versioned plans, ordered transitions, idempotency, and immutable event history', async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    tenantIds.push(tenantId);
    userIds.push(userId);

    await adminPool.query(
      `INSERT INTO tenants (id, slug, name, status, timezone, default_locale)
       VALUES ($1, $2, 'SaaS Lifecycle Integration Tenant', 'ACTIVE', 'Asia/Dhaka', 'en-BD')`,
      [tenantId, 'saas-life-' + tenantId.slice(0, 8)],
    );
    await adminPool.query(
      `INSERT INTO users (id, external_subject, email, display_name, status)
       VALUES ($1, $2, $3, 'SaaS Lifecycle Actor', 'ACTIVE')`,
      [userId, 'saas-life-' + userId, 'saas-life-' + userId + '@factoryos.test'],
    );

    // Existing premium entitlements/flags are resolved through the live
    // subscription state, not just their own ACTIVE/enabled columns.
    await adminPool.query(
      `INSERT INTO entitlements
        (tenant_id, package, feature_key, limit_value, period, version, status, effective_from, config, created_by)
       VALUES ($1, 'FACTORYOS_AI', 'ai.runtime.execute', NULL, NULL, 1, 'ACTIVE',
               clock_timestamp() - interval '1 minute', '{}'::jsonb, $2)`,
      [tenantId, userId],
    );
    await adminPool.query(
      `INSERT INTO feature_flags
        (tenant_id, key, version, enabled, config, owner, security_critical, effective_from, created_by)
       VALUES ($1, 'ai.runtime.enabled', 1, true, '{}'::jsonb, 'SaaS Lifecycle Integration', false,
               clock_timestamp() - interval '1 minute', $2)`,
      [tenantId, userId],
    );

    const starter = await service.createPlan(tenantId, userId, {
      plan_code: 'STARTER', display_name: 'Starter', tier_rank: 10, idempotency_key: 'starter-' + tenantId,
    });
    const growth = await service.createPlan(tenantId, userId, {
      plan_code: 'GROWTH', display_name: 'Growth', tier_rank: 20, idempotency_key: 'growth-' + tenantId,
    });
    expect(starter.plan.version).toBe(1);
    expect(growth.plan.tierRank).toBe(20);

    const trialEndsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const trial = await service.startTrial(tenantId, userId, {
      plan_code: 'STARTER', trial_ends_at: trialEndsAt, idempotency_key: 'trial-' + tenantId,
    });
    expect(trial.subscription.status).toBe('TRIAL');
    expect(await entitlementService.resolveEntitlement(tenantId, 'FACTORYOS_AI', 'ai.runtime.execute')).not.toBeNull();
    expect((await featureFlagService.resolveFeatureFlag(tenantId, 'ai.runtime.enabled')).enabled).toBe(true);
    const replay = await service.startTrial(tenantId, userId, {
      plan_code: 'STARTER', trial_ends_at: trialEndsAt, idempotency_key: 'trial-' + tenantId,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.event.id).toBe(trial.event.id);

    const periodStart = new Date(Date.now() - 60_000).toISOString();
    const periodEnd = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const activated = await service.transition(tenantId, userId, trial.subscription.id, {
      action: 'ACTIVATE', expected_version: 1, period_start: periodStart, period_end: periodEnd,
      idempotency_key: 'activate-' + tenantId,
    });
    expect(activated.subscription.status).toBe('ACTIVE');
    expect(activated.subscription.version).toBe(2);

    const upgraded = await service.transition(tenantId, userId, trial.subscription.id, {
      action: 'UPGRADE', expected_version: 2, target_plan_code: 'GROWTH',
      idempotency_key: 'upgrade-' + tenantId,
    });
    expect(upgraded.subscription.planCode).toBe('GROWTH');
    expect(upgraded.event.eventType).toBe('UPGRADED');
    expect(upgraded.subscription.version).toBe(3);

    const suspended = await service.transition(tenantId, userId, trial.subscription.id, {
      action: 'SUSPEND', expected_version: 3, reason: 'Contract review',
      idempotency_key: 'suspend-' + tenantId,
    });
    expect(suspended.subscription.status).toBe('SUSPENDED');
    expect(await entitlementService.resolveEntitlement(tenantId, 'FACTORYOS_AI', 'ai.runtime.execute')).toBeNull();
    expect((await featureFlagService.resolveFeatureFlag(tenantId, 'ai.runtime.enabled')).enabled).toBe(false);
    expect((await featureFlagService.resolveFeatureFlag(tenantId, 'ai.runtime.enabled')).safeDefault).toBe(true);

    const terminated = await service.transition(tenantId, userId, trial.subscription.id, {
      action: 'TERMINATE', expected_version: 4, reason: 'Customer contract ended',
      idempotency_key: 'terminate-' + tenantId,
    });
    expect(terminated.subscription.status).toBe('TERMINATED');
    expect(terminated.subscription.terminatedAt).toBeTruthy();

    const history = await adminPool.query(
      'SELECT event_type, subscription_version FROM saas_subscription_events WHERE tenant_id = $1 AND subscription_id = $2 ORDER BY subscription_version',
      [tenantId, trial.subscription.id],
    );
    expect(history.rows.map((row) => row.event_type)).toEqual([
      'TRIAL_STARTED', 'ACTIVATED', 'UPGRADED', 'SUSPENDED', 'TERMINATED',
    ]);
    expect(history.rows.map((row) => Number(row.subscription_version))).toEqual([1, 2, 3, 4, 5]);

    const secondTrial = await service.startTrial(tenantId, userId, {
      plan_code: 'STARTER', trial_ends_at: trialEndsAt, idempotency_key: 'trial-after-termination-' + tenantId,
    });
    expect(secondTrial.subscription.status).toBe('TRIAL');

    const eventClient = await adminPool.connect();
    try {
      await eventClient.query('BEGIN');
      await eventClient.query('SAVEPOINT immutable_lifecycle_event');
      await expect(eventClient.query(
        `UPDATE saas_subscription_events SET reason = 'tampered'
         WHERE tenant_id = $1 AND subscription_id = $2 AND subscription_version = 1`,
        [tenantId, trial.subscription.id],
      )).rejects.toThrow('Versioned configuration is immutable');
      await eventClient.query('ROLLBACK TO SAVEPOINT immutable_lifecycle_event');
      await eventClient.query('ROLLBACK');
    } finally {
      eventClient.release();
    }
  }, 60000);
});
