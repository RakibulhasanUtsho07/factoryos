import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { SaasSandboxDataMode, SaasSandboxPurpose } from './dto/create-saas-sandbox-environment.dto';
import { SaasSandboxTransitionAction } from './dto/transition-saas-sandbox-environment.dto';
import { SaasSandboxService } from './saas-sandbox.service';

const hasPostgres = Boolean(process.env.DATABASE_URL && process.env.TEST_ADMIN_DATABASE_URL);
const describeWithPostgres = hasPostgres ? describe : describe.skip;

describeWithPostgres('SaasSandboxService PostgreSQL integration', () => {
  let adminPool: Pool;
  let database: DatabaseService;
  let service: SaasSandboxService;
  const tenantIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    database = new DatabaseService({
      get: (key: string) => key === 'DATABASE_URL' ? process.env.DATABASE_URL : undefined,
    } as never);
    await database.onModuleInit();

    const iam = { authorize: async () => undefined };
    const audit = { record: async () => 'sandbox-test-audit-id' };
    service = new SaasSandboxService(database, iam as never, audit as never);
  });

  afterAll(async () => {
    if (adminPool) {
      for (const tenantId of tenantIds) {
        await adminPool.query('DELETE FROM saas_sandbox_environment_events WHERE tenant_id = $1', [tenantId]);
        await adminPool.query('DELETE FROM saas_sandbox_environments WHERE tenant_id = $1', [tenantId]);
      }
      if (userIds.length > 0) {
        await adminPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
      }
      if (tenantIds.length > 0) {
        await adminPool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]);
      }
      await adminPool.end();
    }
    if (database) await database.onModuleDestroy();
  }, 60000);

  async function seedTenantAndUsers() {
    const tenantId = randomUUID();
    const requesterId = randomUUID();
    const reviewerId = randomUUID();
    tenantIds.push(tenantId);
    userIds.push(requesterId, reviewerId);

    await adminPool.query(
      `INSERT INTO tenants (id, slug, name, status, timezone, default_locale)
       VALUES ($1, $2, 'Sandbox Integration Tenant', 'ACTIVE', 'Asia/Dhaka', 'en-BD')`,
      [tenantId, 'sandbox-' + tenantId.slice(0, 8)],
    );
    for (const [userId, role] of [[requesterId, 'requester'], [reviewerId, 'reviewer']] as const) {
      await adminPool.query(
        `INSERT INTO users (id, external_subject, email, display_name, status)
         VALUES ($1, $2, $3, $4, 'ACTIVE')`,
        [userId, 'sandbox-' + role + '-' + userId, 'sandbox-' + userId + '@factoryos.test', 'Sandbox ' + role],
      );
    }
    return { tenantId, requesterId, reviewerId };
  }

  it('isolates tenant-owned synthetic environments and enforces the lifecycle event ledger', async () => {
    const { tenantId, requesterId } = await seedTenantAndUsers();
    const created = await service.createEnvironment(tenantId, requesterId, {
      environment_code: 'SYNTH_DEMO',
      display_name: 'Synthetic demo environment',
      purpose: SaasSandboxPurpose.DEMO,
      data_mode: SaasSandboxDataMode.SYNTHETIC,
      dataset_manifest: {
        generator: 'factoryos-fixture-generator',
        generator_version: '1.2.0',
        schema_version: 'factory.v1',
        record_count: 25,
        seed: 'demo-seed-2026',
      },
      idempotency_key: 'synthetic-create-' + tenantId,
    });
    expect(created.environment.status).toBe('ACTIVE');
    expect(created.environment.datasetManifest.record_count).toBe(25);
    await expect(service.assertSandboxUsable(tenantId, created.environment.id)).resolves.toBeUndefined();
    await expect(service.assertSandboxUsable(randomUUID(), created.environment.id)).rejects.toThrow('not active');

    const suspended = await service.transition(tenantId, requesterId, created.environment.id, {
      action: SaasSandboxTransitionAction.SUSPEND,
      expected_version: 1,
      reason: 'Pause the demo while validating the fixture set',
      idempotency_key: 'synthetic-suspend-' + tenantId,
    });
    expect(suspended.environment.status).toBe('SUSPENDED');
    await expect(service.assertSandboxUsable(tenantId, created.environment.id)).rejects.toThrow('not active');

    const resumed = await service.transition(tenantId, requesterId, created.environment.id, {
      action: SaasSandboxTransitionAction.RESUME,
      expected_version: 2,
      reason: 'Fixture validation is complete',
      idempotency_key: 'synthetic-resume-' + tenantId,
    });
    expect(resumed.environment.status).toBe('ACTIVE');

    const retired = await service.transition(tenantId, requesterId, created.environment.id, {
      action: SaasSandboxTransitionAction.RETIRE,
      expected_version: 3,
      reason: 'Demo run has ended',
      idempotency_key: 'synthetic-retire-' + tenantId,
    });
    expect(retired.environment.status).toBe('RETIRED');
    await expect(service.assertSandboxUsable(tenantId, created.environment.id)).rejects.toThrow('not active');

    const history = await service.listEvents(tenantId, requesterId, created.environment.id);
    expect(history.items.map((event) => event.eventType)).toEqual(['RETIRED', 'RESUMED', 'SUSPENDED', 'CREATED']);
    expect(history.items.map((event) => event.environmentVersion)).toEqual([4, 3, 2, 1]);

    await expect(adminPool.query(
      `UPDATE saas_sandbox_environment_events SET reason = 'tampered'
       WHERE environment_id = $1 AND environment_version = 1`,
      [created.environment.id],
    )).rejects.toThrow('Versioned configuration is immutable');
  }, 60000);

  it('keeps masked datasets pending until a distinct reviewer approves a time-bound request', async () => {
    const { tenantId, requesterId, reviewerId } = await seedTenantAndUsers();
    const now = new Date(Date.now() - 1000).toISOString();
    const created = await service.createEnvironment(tenantId, requesterId, {
      environment_code: 'MASKED_EVAL',
      display_name: 'Masked evaluation environment',
      purpose: SaasSandboxPurpose.EVALUATION,
      data_mode: SaasSandboxDataMode.MASKED,
      dataset_manifest: {
        dataset_reference: 'masked-snapshot:batch-17',
        schema_version: 'factory.v1',
        record_count: 120,
        masking_policy_version: 'worker-mask-v3',
        masked_at: now,
        checksum_sha256: 'b'.repeat(64),
      },
      privacy_assessment: {
        data_minimization_status: 'ASSESSED',
        residual_risk: 'LOW',
        reviewed_fields: ['worker_token', 'machine_code', 'work_order_ref'],
        assessed_at: now,
      },
      idempotency_key: 'masked-create-' + tenantId,
    });
    expect(created.environment.status).toBe('PENDING_APPROVAL');
    await expect(service.assertSandboxUsable(tenantId, created.environment.id)).rejects.toThrow('not active');

    await expect(service.approveMaskedData(tenantId, requesterId, created.environment.id, {
      expected_version: 1,
      reason: 'Requester cannot self-approve',
      approval_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      idempotency_key: 'masked-self-approve-' + tenantId,
    })).rejects.toThrow('different from the requester');

    const approved = await service.approveMaskedData(tenantId, reviewerId, created.environment.id, {
      expected_version: 1,
      reason: 'Reviewed the masking manifest and minimized field set',
      approval_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      idempotency_key: 'masked-approve-' + tenantId,
    });
    expect(approved.environment.status).toBe('ACTIVE');
    expect(approved.environment.approvedBy).toBe(reviewerId);
    await expect(service.assertSandboxUsable(tenantId, created.environment.id)).resolves.toBeUndefined();

    const history = await service.listEvents(tenantId, requesterId, created.environment.id);
    expect(history.items.map((event) => event.eventType)).toEqual(['MASKED_DATA_APPROVED', 'MASKED_APPROVAL_REQUESTED']);
  }, 60000);
});
