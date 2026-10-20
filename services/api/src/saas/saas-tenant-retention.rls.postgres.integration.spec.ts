import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  REQUIRED_TRANSFER_CATEGORIES,
  SaasTransferDatasetCategory,
} from './dto/create-saas-schema-compatibility-rule.dto';
import { SaasTenantDataTransferService } from './saas-tenant-data-transfer.service';
import { SaasTenantRetentionService } from './saas-tenant-retention.service';
import { SaasTenantGovernanceExecutionService } from './saas-tenant-governance-execution.service';
import { SaasRetentionRunMode } from './dto/run-saas-retention-policy.dto';

const postgresDescribe = process.env.TEST_APP_DATABASE_URL && process.env.TEST_ADMIN_DATABASE_URL
  ? describe
  : describe.skip;
const digest = 'd'.repeat(64);

postgresDescribe('SaaS tenant retention RLS (PostgreSQL integration)', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let database: DatabaseService;
  let transfers: SaasTenantDataTransferService;
  let retention: SaasTenantRetentionService;
  let governance: SaasTenantGovernanceExecutionService;
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const exportIds: Array<{ tenantId: string; transferId: string }> = [];
  const policyIds: string[] = [];
  const holdIds: string[] = [];
  const erasureRequestIds: string[] = [];
  const retentionRunIds: string[] = [];
  const erasureRunRowIds: string[] = [];

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    appPool = new Pool({ connectionString: process.env.TEST_APP_DATABASE_URL, max: 2, connectionTimeoutMillis: 5000 });
    const role = await appPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user',
    );
    if (!role.rows[0] || role.rows[0].rolsuper || role.rows[0].rolbypassrls) {
      throw new Error('TEST_APP_DATABASE_URL must use a non-superuser role without BYPASSRLS');
    }

    const config = { get: (key: string) => key === 'DATABASE_URL' ? process.env.TEST_APP_DATABASE_URL : undefined } as ConfigService;
    database = new DatabaseService(config);
    await database.onModuleInit();
    const iam = { authorize: async () => undefined } as never;
    const transferAudit = { record: async () => undefined } as never;
    transfers = new SaasTenantDataTransferService(database, iam, transferAudit);
    const retentionAudit = { recordWithClient: async () => 'test-audit-id' } as never;
    retention = new SaasTenantRetentionService(database, iam, retentionAudit);
    governance = new SaasTenantGovernanceExecutionService(database, iam, retentionAudit);
  }, 60000);

  afterAll(async () => {
    try {
      if (adminPool && tenantIds.length) {
        await adminPool.query('ALTER TABLE saas_tenant_data_erasure_requests DISABLE TRIGGER saas_tenant_data_erasure_request_guard');
        await adminPool.query('ALTER TABLE saas_tenant_data_export_preservation_attestations DISABLE TRIGGER saas_export_preservation_attestation_guard');
        await adminPool.query('ALTER TABLE saas_tenant_data_retention_runs DISABLE TRIGGER saas_tenant_data_retention_runs_immutable');
        await adminPool.query('ALTER TABLE saas_tenant_data_erasure_runs DISABLE TRIGGER saas_tenant_data_erasure_runs_immutable');
        await adminPool.query('ALTER TABLE saas_tenant_data_legal_holds DISABLE TRIGGER saas_tenant_data_legal_hold_guard');
        await adminPool.query('ALTER TABLE saas_tenant_data_retention_policies DISABLE TRIGGER saas_retention_policy_immutable');
        await adminPool.query('ALTER TABLE saas_tenant_data_transfers DISABLE TRIGGER saas_tenant_data_transfer_immutable');
        await adminPool.query('ALTER TABLE saas_schema_compatibility_rules DISABLE TRIGGER saas_schema_compatibility_immutable');
        try {
          if (erasureRunRowIds.length) await adminPool.query('DELETE FROM saas_tenant_data_erasure_runs WHERE id = ANY($1::uuid[])', [erasureRunRowIds]);
          if (retentionRunIds.length) await adminPool.query('DELETE FROM saas_tenant_data_retention_runs WHERE id = ANY($1::uuid[])', [retentionRunIds]);
          if (erasureRequestIds.length) await adminPool.query('DELETE FROM saas_tenant_data_erasure_requests WHERE id = ANY($1::uuid[])', [erasureRequestIds]);
          if (holdIds.length) await adminPool.query('DELETE FROM saas_tenant_data_legal_holds WHERE id = ANY($1::uuid[])', [holdIds]);
          if (policyIds.length) await adminPool.query('DELETE FROM saas_tenant_data_retention_policies WHERE id = ANY($1::uuid[])', [policyIds]);
          if (exportIds.length) {
            for (const entry of exportIds) {
              await adminPool.query('DELETE FROM saas_tenant_data_export_preservation_attestations WHERE tenant_id=$1 AND transfer_id=$2', [entry.tenantId, entry.transferId]);
            }
          }
          if (exportIds.length) {
            for (const entry of exportIds) {
              await adminPool.query('DELETE FROM saas_tenant_data_transfers WHERE tenant_id=$1 AND transfer_id=$2', [entry.tenantId, entry.transferId]);
            }
          }
          await adminPool.query('DELETE FROM saas_schema_compatibility_rules WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          if (userIds.length) await adminPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
          await adminPool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]);
        } finally {
          await adminPool.query('ALTER TABLE saas_tenant_data_erasure_requests ENABLE TRIGGER saas_tenant_data_erasure_request_guard');
          await adminPool.query('ALTER TABLE saas_tenant_data_export_preservation_attestations ENABLE TRIGGER saas_export_preservation_attestation_guard');
          await adminPool.query('ALTER TABLE saas_tenant_data_retention_runs ENABLE TRIGGER saas_tenant_data_retention_runs_immutable');
          await adminPool.query('ALTER TABLE saas_tenant_data_erasure_runs ENABLE TRIGGER saas_tenant_data_erasure_runs_immutable');
          await adminPool.query('ALTER TABLE saas_tenant_data_legal_holds ENABLE TRIGGER saas_tenant_data_legal_hold_guard');
          await adminPool.query('ALTER TABLE saas_tenant_data_retention_policies ENABLE TRIGGER saas_retention_policy_immutable');
          await adminPool.query('ALTER TABLE saas_tenant_data_transfers ENABLE TRIGGER saas_tenant_data_transfer_immutable');
          await adminPool.query('ALTER TABLE saas_schema_compatibility_rules ENABLE TRIGGER saas_schema_compatibility_immutable');
        }
      }
    } finally {
      if (database) await database.onModuleDestroy();
      if (appPool) await appPool.end();
      if (adminPool) await adminPool.end();
    }
  }, 60000);

  async function createIdentity(label: string) {
    const tenantId = randomUUID();
    const userId = randomUUID();
    tenantIds.push(tenantId);
    userIds.push(userId);
    await adminPool.query(
      'INSERT INTO tenants (id, slug, name, status, timezone, default_locale) VALUES ($1,$2,$3,\'ACTIVE\',\'Asia/Dhaka\',\'en-BD\')',
      [tenantId, 'retention-' + tenantId.slice(0, 8), 'Retention RLS ' + label],
    );
    await adminPool.query(
      'INSERT INTO users (id, external_subject, email, display_name, status) VALUES ($1,$2,$3,$4,\'ACTIVE\')',
      [userId, 'retention-' + userId, 'retention-' + userId + '@factoryos.test', 'Retention RLS Actor'],
    );
    return { tenantId, userId };
  }

  function manifest(recordCount: number) {
    return Object.fromEntries(REQUIRED_TRANSFER_CATEGORIES.map((category) => [
      category,
      { record_count: recordCount, sha256: digest },
    ]));
  }

  async function seedTenantControls(identity: { tenantId: string; userId: string }, label: string) {
    const policy = await retention.createPolicy(identity.tenantId, identity.userId, {
      category_code: 'BUSINESS_DATA',
      retention_days: 365,
      disposition: 'REVIEW',
      legal_basis: 'Approved privacy schedule',
      reason: 'RLS fixture policy ' + label,
      idempotency_key: 'rls-policy-' + label + '-' + identity.tenantId,
    } as never);
    policyIds.push(policy.policy.id);

    const hold = await retention.createLegalHold(identity.tenantId, identity.userId, {
      categories: ['AUDIT_LOG'],
      case_reference: 'RLS-HOLD-' + label,
      reason: 'RLS fixture legal hold',
      idempotency_key: 'rls-hold-' + label + '-' + identity.tenantId,
    } as never);
    holdIds.push(hold.hold.id);

    const createdExport = await transfers.createExport(identity.tenantId, identity.userId, {
      source_schema_version: '1.0.0',
      reason: 'RLS fixture export',
      idempotency_key: 'rls-export-create-' + label + '-' + identity.tenantId,
    } as never);
    exportIds.push({ tenantId: identity.tenantId, transferId: createdExport.transfer.transferId });
    const completedExport = await transfers.attestExport(identity.tenantId, identity.userId, createdExport.transfer.transferId, {
      expected_version: 1,
      bundle_reference: 'rls-bundle-' + identity.tenantId.slice(0, 8),
      bundle_digest: digest,
      dataset_manifest: manifest(1),
      reason: 'RLS fixture export preservation verification',
      idempotency_key: 'rls-export-attest-' + label + '-' + identity.tenantId,
    } as never);
    // A separate same-tenant principal proves that preservation approval is independent.
    const preservationVerifierUserId = randomUUID();
    userIds.push(preservationVerifierUserId);
    await adminPool.query(
      'INSERT INTO users (id, external_subject, email, display_name, status) VALUES ($1,$2,$3,$4,\'ACTIVE\')',
      [preservationVerifierUserId, 'retention-verifier-' + preservationVerifierUserId,
        'retention-verifier-' + preservationVerifierUserId + '@factoryos.test', 'Retention RLS Preservation Verifier'],
    );
    const preserved = await retention.attestExportPreservation(identity.tenantId, preservationVerifierUserId,
      createdExport.transfer.transferId, {
        expected_version: completedExport.transfer.version,
        bundle_digest: digest,
        verification_method: 'READ_BACK_HASH',
        verification_reference: 'rls-preservation-' + label + '-' + identity.tenantId.slice(0, 8),
        reason: 'Independently verify exported bundle before RLS erasure fixture',
        idempotency_key: 'rls-preservation-' + label + '-' + identity.tenantId,
      } as never);
    const category = SaasTransferDatasetCategory.BUSINESS_DATA;
    const retentionRun = await governance.runRetentionPolicy(identity.tenantId, identity.userId, category, {
      mode: SaasRetentionRunMode.DRY_RUN,
      expected_policy_version: 1,
      reason: 'RLS fixture verifies tenant isolation for immutable retention receipts',
      idempotency_key: 'rls-retention-run-' + label + '-' + identity.tenantId,
    });
    retentionRunIds.push(retentionRun.run.id);
    const erasure = await retention.createErasureRequest(identity.tenantId, identity.userId, {
      categories: [category],
      export_transfer_id: createdExport.transfer.transferId,
      export_transfer_version: completedExport.transfer.version,
      export_bundle_digest: digest,
      reason: 'RLS fixture erasure review',
      idempotency_key: 'rls-erasure-' + label + '-' + identity.tenantId,
    } as never);
    erasureRequestIds.push(erasure.request.id);
    const erasureRun = await adminPool.query<{ id: string }>(
      `INSERT INTO saas_tenant_data_erasure_runs
       (tenant_id, run_id, request_id, request_version, status, categories, deleted_rows,
        table_manifest, source_export_digest, executor_user_id, failure_code, reason,
        idempotency_key, request_hash)
       VALUES ($1,$2,$3,1,'FAILED',$4::jsonb,0,'{"fixture":"RLS isolation"}'::jsonb,$5,$6,
         'RLS_FIXTURE','RLS fixture failure receipt','rls-erasure-run-' || $7 || '-' || $1::text,$5)
       RETURNING id::text AS id`,
      [identity.tenantId, randomUUID(), erasure.request.requestId, JSON.stringify([category]),
        digest, identity.userId, label],
    );
    erasureRunRowIds.push(erasureRun.rows[0].id);
    return {
      policy, hold, erasure,
      preservationAttestationId: preserved.attestation.id,
      retentionRunId: retentionRun.run.id,
      erasureRunRowId: erasureRun.rows[0].id,
    };
  }

  it('isolates retention policies, legal holds and erasure requests at the non-superuser RLS boundary', async () => {
    const first = await createIdentity('tenant-a');
    const second = await createIdentity('tenant-b');
    const firstRows = await seedTenantControls(first, 'a');
    const secondRows = await seedTenantControls(second, 'b');

    for (const [table, ownId, otherId] of [
      ['saas_tenant_data_retention_policies', firstRows.policy.policy.id, secondRows.policy.policy.id],
      ['saas_tenant_data_legal_holds', firstRows.hold.hold.id, secondRows.hold.hold.id],
      ['saas_tenant_data_erasure_requests', firstRows.erasure.request.id, secondRows.erasure.request.id],
      ['saas_tenant_data_export_preservation_attestations', firstRows.preservationAttestationId, secondRows.preservationAttestationId],
      ['saas_tenant_data_retention_runs', firstRows.retentionRunId, secondRows.retentionRunId],
      ['saas_tenant_data_erasure_runs', firstRows.erasureRunRowId, secondRows.erasureRunRowId],
    ] as const) {
      const visible = await database.query<{ id: string; tenant_id: string }>(
        `SELECT id::text AS id, tenant_id::text AS tenant_id FROM ${table}
         WHERE tenant_id = ANY($1::uuid[]) AND id = ANY($2::uuid[])`,
        [[first.tenantId, second.tenantId], [ownId, otherId]],
        { tenantId: first.tenantId, userId: first.userId },
      );
      expect(visible.rows).toEqual([{ id: ownId, tenant_id: first.tenantId }]);
    }

    await expect(database.query(
      `INSERT INTO saas_tenant_data_retention_policies
       (tenant_id, category_code, version, retention_days, disposition, legal_basis, reason,
        idempotency_key, request_hash, created_by_user_id)
       VALUES ($1,'AI_CONTEXT',1,30,'REVIEW','Approved privacy schedule',
         'Cross tenant insert attempt','rls-cross-tenant-' || $2, $3, $4)`,
      [second.tenantId, randomUUID(), 'f'.repeat(64), second.userId],
      { tenantId: first.tenantId, userId: first.userId },
    )).rejects.toMatchObject({ code: '42501' });
  }, 60000);

  it('does not expose tenant records when no tenant context is established', async () => {
    const identity = await createIdentity('no-context');
    await seedTenantControls(identity, 'noctx');
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        'SELECT id FROM saas_tenant_data_retention_policies WHERE tenant_id=$1',
        [identity.tenantId],
      );
      expect(result.rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }, 60000);
});
