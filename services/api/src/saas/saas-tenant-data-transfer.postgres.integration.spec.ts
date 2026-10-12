import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  CreateSaasSchemaCompatibilityRuleDto,
  REQUIRED_TRANSFER_CATEGORIES,
} from './dto/create-saas-schema-compatibility-rule.dto';
import { CreateSaasTenantExportDto } from './dto/create-saas-tenant-export.dto';
import { AttestSaasTenantExportDto, SaasTransferDatasetDigest } from './dto/attest-saas-tenant-export.dto';
import { SaasTenantMigrationAction } from './dto/transition-saas-tenant-migration.dto';
import { SaasTenantDataTransferService } from './saas-tenant-data-transfer.service';

const postgresDescribe = process.env.TEST_ADMIN_DATABASE_URL ? describe : describe.skip;
const digest = 'a'.repeat(64);

postgresDescribe('SaasTenantDataTransferService PostgreSQL control-plane invariants', () => {
  let adminPool: Pool;
  let database: DatabaseService;
  let service: SaasTenantDataTransferService;
  const tenantIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    const config = {
      get: (key: string) => key === 'DATABASE_URL' ? process.env.DATABASE_URL : undefined,
    } as ConfigService;
    database = new DatabaseService(config);
    await database.onModuleInit();
    service = new SaasTenantDataTransferService(
      database,
      { authorize: async () => undefined } as never,
      { record: async () => undefined } as never,
    );
  }, 60000);

  afterAll(async () => {
    if (adminPool && tenantIds.length) {
      await adminPool.query('ALTER TABLE saas_tenant_data_transfers DISABLE TRIGGER saas_tenant_data_transfer_immutable');
      await adminPool.query('ALTER TABLE saas_schema_compatibility_rules DISABLE TRIGGER saas_schema_compatibility_immutable');
      try {
        await adminPool.query('DELETE FROM saas_tenant_data_transfers WHERE tenant_id = ANY($1::uuid[]) AND operation_type = $2', [tenantIds, 'MIGRATION']);
        await adminPool.query('DELETE FROM saas_tenant_data_transfers WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
        await adminPool.query('DELETE FROM saas_schema_compatibility_rules WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
        if (userIds.length) await adminPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
        await adminPool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]);
      } finally {
        await adminPool.query('ALTER TABLE saas_tenant_data_transfers ENABLE TRIGGER saas_tenant_data_transfer_immutable');
        await adminPool.query('ALTER TABLE saas_schema_compatibility_rules ENABLE TRIGGER saas_schema_compatibility_immutable');
      }
    }
    if (database) await database.onModuleDestroy();
    if (adminPool) await adminPool.end();
  }, 60000);

  async function createIdentity(prefix: string) {
    const tenantId = randomUUID();
    const userId = randomUUID();
    tenantIds.push(tenantId);
    userIds.push(userId);
    await adminPool.query(
      'INSERT INTO tenants (id, slug, name, status, timezone, default_locale) VALUES ($1,$2,$3,\'ACTIVE\',\'Asia/Dhaka\',\'en-BD\')',
      [tenantId, 'data-xfer-' + tenantId.slice(0, 8), 'Data Transfer Test Tenant ' + prefix],
    );
    await adminPool.query(
      'INSERT INTO users (id, external_subject, email, display_name, status) VALUES ($1,$2,$3,$4,\'ACTIVE\')',
      [userId, 'data-xfer-' + userId, 'data-xfer-' + userId + '@factoryos.test', 'Data Transfer Test Actor'],
    );
    return { tenantId, userId };
  }

  function manifest(recordCount: number): Record<string, SaasTransferDatasetDigest> {
    return Object.fromEntries(REQUIRED_TRANSFER_CATEGORIES.map((category) => [
      category,
      { record_count: recordCount, sha256: digest },
    ])) as Record<string, SaasTransferDatasetDigest>;
  }

  it('attests an export, validates compatibility, preserves critical manifests and isolates tenants', async () => {
    const source = await createIdentity('source');
    const targetTenant = await createIdentity('other');

    const rule = await service.registerCompatibilityRule(source.tenantId, source.userId, {
      source_schema_version: '1.0.0',
      target_schema_version: '2.0.0',
      decision: 'COMPATIBLE',
      required_categories: [...REQUIRED_TRANSFER_CATEGORIES],
      reason: 'target schema was reviewed for compatibility',
      idempotency_key: 'compatibility-rule-' + source.tenantId,
    } as CreateSaasSchemaCompatibilityRuleDto);
    expect(rule.rule.version).toBe(1);
    expect(rule.rule.decision).toBe('COMPATIBLE');

    const exportInput: CreateSaasTenantExportDto = {
      source_schema_version: '1.0.0',
      reason: 'tenant-approved export snapshot',
      idempotency_key: 'export-create-' + source.tenantId,
    };
    const created = await service.createExport(source.tenantId, source.userId, exportInput);
    expect(created.transfer.status).toBe('REQUESTED');
    const replay = await service.createExport(source.tenantId, source.userId, exportInput);
    expect(replay.replayed).toBe(true);
    expect(replay.transfer.transferId).toBe(created.transfer.transferId);

    const completedExport = await service.attestExport(source.tenantId, source.userId, created.transfer.transferId, {
      expected_version: 1,
      bundle_reference: 'bundle-export-' + source.tenantId.slice(0, 8),
      bundle_digest: digest,
      dataset_manifest: manifest(12),
      reason: 'export worker verified signed bundle and category hashes',
      idempotency_key: 'export-attest-' + source.tenantId,
    } as AttestSaasTenantExportDto);
    expect(completedExport.transfer.version).toBe(2);
    expect(completedExport.transfer.status).toBe('COMPLETED');
    expect(Object.keys(completedExport.transfer.sourceManifest)).toHaveLength(REQUIRED_TRANSFER_CATEGORIES.length);

    const validation = await service.validateMigration(source.tenantId, source.userId, {
      source_transfer_id: created.transfer.transferId,
      target_schema_version: '2.0.0',
      reason: 'validate migration before execution',
      idempotency_key: 'migration-validate-' + source.tenantId,
    });
    expect(validation.transfer.status).toBe('VALIDATED');
    expect(validation.transfer.compatibilityDecision).toBe('COMPATIBLE');
    expect(validation.transfer.sourceBundleDigest).toBe(digest);

    const started = await service.transitionMigration(source.tenantId, source.userId, validation.transfer.transferId, {
      action: SaasTenantMigrationAction.START,
      expected_version: 1,
      reason: 'target adapter confirmed its maintenance window',
      idempotency_key: 'migration-start-' + source.tenantId,
    });
    expect(started.transfer.status).toBe('IN_PROGRESS');

    const migratedManifest = manifest(12);
    for (const item of Object.values(migratedManifest)) item.sha256 = 'c'.repeat(64);
    const completed = await service.transitionMigration(source.tenantId, source.userId, validation.transfer.transferId, {
      action: SaasTenantMigrationAction.COMPLETE,
      expected_version: 2,
      target_bundle_reference: 'bundle-target-' + source.tenantId.slice(0, 8),
      target_bundle_digest: 'c'.repeat(64),
      target_manifest: migratedManifest,
      preservation_verified: true,
      reason: 'target verification confirmed all required data classes',
      idempotency_key: 'migration-complete-' + source.tenantId,
    });
    expect(completed.transfer.status).toBe('COMPLETED');
    expect(completed.transfer.preservationVerified).toBe(true);

    const history = await service.history(source.tenantId, source.userId, validation.transfer.transferId);
    expect(history.map((entry) => entry.version)).toEqual([3, 2, 1]);
    expect((await service.listLatest(source.tenantId, source.userId, 'MIGRATION'))[0]?.status).toBe('COMPLETED');

    await expect(adminPool.query(
      'UPDATE saas_tenant_data_transfers SET reason = $2 WHERE id = $1',
      [completed.transfer.id, 'attempted mutation'],
    )).rejects.toThrow();

    const hidden = await database.query(
      'SELECT id FROM saas_tenant_data_transfers WHERE transfer_id = $1',
      [validation.transfer.transferId],
      { tenantId: targetTenant.tenantId },
    );
    expect(hidden.rows).toHaveLength(0);
  }, 60000);

  it('blocks migration completion when evidence-preservation counts differ', async () => {
    const identity = await createIdentity('count-mismatch');
    const created = await service.createExport(identity.tenantId, identity.userId, {
      source_schema_version: '1.0.0',
      reason: 'export for count mismatch test',
      idempotency_key: 'count-export-' + identity.tenantId,
    });
    await service.attestExport(identity.tenantId, identity.userId, created.transfer.transferId, {
      expected_version: 1,
      bundle_reference: 'bundle-count-' + identity.tenantId.slice(0, 8),
      bundle_digest: digest,
      dataset_manifest: manifest(12),
      reason: 'attested source dataset',
      idempotency_key: 'count-attest-' + identity.tenantId,
    } as AttestSaasTenantExportDto);
    const validation = await service.validateMigration(identity.tenantId, identity.userId, {
      source_transfer_id: created.transfer.transferId,
      target_schema_version: '1.0.0',
      reason: 'exact schema migration baseline',
      idempotency_key: 'count-validate-' + identity.tenantId,
    });
    const started = await service.transitionMigration(identity.tenantId, identity.userId, validation.transfer.transferId, {
      action: SaasTenantMigrationAction.START,
      expected_version: 1,
      reason: 'start baseline copy',
      idempotency_key: 'count-start-' + identity.tenantId,
    });
    const changed = manifest(12);
    changed.AUDIT_LOG.record_count = 11;
    await expect(service.transitionMigration(identity.tenantId, identity.userId, validation.transfer.transferId, {
      action: SaasTenantMigrationAction.COMPLETE,
      expected_version: started.transfer.version,
      target_bundle_reference: 'bundle-count-target-' + identity.tenantId.slice(0, 8),
      target_bundle_digest: 'c'.repeat(64),
      target_manifest: changed,
      preservation_verified: true,
      reason: 'audit count mismatch must block completion',
      idempotency_key: 'count-complete-' + identity.tenantId,
    })).rejects.toThrow(/preservation counts changed/i);
  }, 60000);
});
