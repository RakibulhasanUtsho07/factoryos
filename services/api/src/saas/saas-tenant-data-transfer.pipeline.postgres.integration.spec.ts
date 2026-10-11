import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest, describe, expect, it } from '@jest/globals';
import { Pool } from 'pg';
import { DatabaseService } from '../database/database.service';
import { REQUIRED_TRANSFER_CATEGORIES } from './dto/create-saas-schema-compatibility-rule.dto';
import { SaasEncryptedTenantBundleStore } from './saas-encrypted-tenant-bundle.store';
import type { SaasTenantMigrationTargetAdapter, SaasTenantTransferExportManifest } from './saas-tenant-data-transfer.adapters';
import { SaasTenantPostgresDatasetSource } from './saas-tenant-postgres-dataset-source';
import { SaasTenantDataTransferWorkerService } from './saas-tenant-data-transfer.worker';

const postgresDescribe = process.env.TEST_ADMIN_DATABASE_URL && process.env.DATABASE_URL ? describe : describe.skip;

interface ParsedExportBundle {
  format: string;
  tenantId: string;
  datasets: Record<string, Array<Record<string, unknown>>>;
  manifest: SaasTenantTransferExportManifest;
}

describe('SaaS tenant export/import pipeline PostgreSQL integration', () => {
  postgresDescribe('live PostgreSQL source plus encrypted artifact and target-adapter contract', () => {
    let adminPool: Pool;
    let database: DatabaseService;
    let bundleStore: SaasEncryptedTenantBundleStore;
    let bundleDirectory: string;
    let encryptionKey: string;
    const tenantIds: string[] = [];
    const userIds: string[] = [];
    const factoryIds: string[] = [];
    const legalEntityIds: string[] = [];

    beforeAll(async () => {
      adminPool = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
      database = new DatabaseService({
        get: (key: string) => key === 'DATABASE_URL' ? process.env.DATABASE_URL : undefined,
      } as never);
      await database.onModuleInit();
      bundleDirectory = await mkdtemp(join(tmpdir(), 'factoryos-transfer-pipeline-'));
      encryptionKey = randomBytes(32).toString('base64');
      bundleStore = new SaasEncryptedTenantBundleStore({
        get: (key: string) => {
          if (key === 'SAAS_TRANSFER_BUNDLE_DIR') return bundleDirectory;
          if (key === 'SAAS_TRANSFER_ENCRYPTION_KEY_BASE64') return encryptionKey;
          return undefined;
        },
      } as never);
    }, 60000);

    afterAll(async () => {
      if (adminPool && tenantIds.length > 0) {
        try {
          // Immutable metering records may only be removed by test cleanup on this disposable CI database.
          await adminPool.query('ALTER TABLE saas_usage_rate_cards DISABLE TRIGGER trg_saas_rate_cards_immutable');
          await adminPool.query('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await adminPool.query('DELETE FROM business_evidence_links WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await adminPool.query('DELETE FROM business_evidence WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await adminPool.query('DELETE FROM saas_usage_rate_cards WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await adminPool.query('DELETE FROM factories WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await adminPool.query('DELETE FROM legal_entities WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          if (userIds.length > 0) await adminPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
          await adminPool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]);
        } finally {
          await adminPool.query('ALTER TABLE saas_usage_rate_cards ENABLE TRIGGER trg_saas_rate_cards_immutable');
          await adminPool.end();
        }
      } else if (adminPool) {
        await adminPool.end();
      }
      if (database) await database.onModuleDestroy();
      if (bundleDirectory) await rm(bundleDirectory, { recursive: true, force: true });
    }, 60000);

    it('exports real tenant rows, verifies every required category, then decrypts and imports the bundle', async () => {
      const tenantId = randomUUID();
      const userId = randomUUID();
      const legalEntityId = randomUUID();
      const factoryId = randomUUID();
      const exportId = randomUUID();
      const migrationId = randomUUID();
      tenantIds.push(tenantId);
      userIds.push(userId);
      legalEntityIds.push(legalEntityId);
      factoryIds.push(factoryId);

      await adminPool.query(
        'INSERT INTO tenants (id, slug, name, status, timezone, default_locale) VALUES ($1, $2, $3, $4, $5, $6)',
        [tenantId, 'xfer-' + tenantId.slice(0, 8), 'Transfer Integration Tenant', 'ACTIVE', 'Asia/Dhaka', 'en-BD'],
      );
      await adminPool.query(
        'INSERT INTO users (id, external_subject, email, display_name, status) VALUES ($1, $2, $3, $4, $5)',
        [userId, 'xfer-' + userId, 'xfer-' + userId + '@factoryos.test', 'Transfer integration actor', 'ACTIVE'],
      );
      await adminPool.query(
        'INSERT INTO legal_entities (id, tenant_id, code, name, country_code, status) VALUES ($1, $2, $3, $4, $5, $6)',
        [legalEntityId, tenantId, 'XFER-' + tenantId.slice(0, 8), 'Transfer Legal Entity', 'BD', 'ACTIVE'],
      );
      await adminPool.query(
        'INSERT INTO factories (id, tenant_id, legal_entity_id, code, name, status, timezone) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [factoryId, tenantId, legalEntityId, 'XFER-' + factoryId.slice(0, 8), 'Transfer Test Factory', 'ACTIVE', 'Asia/Dhaka'],
      );
      await adminPool.query(
        'INSERT INTO audit_events (tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)',
        [tenantId, factoryId, userId, 'TENANT_TRANSFER_TEST', 'EXPORT_PIPELINE_INTEGRATION', 'FACTORY', factoryId, JSON.stringify({ origin: 'postgres-integration-test' })],
      );
      await adminPool.query(
        'INSERT INTO business_evidence (tenant_id, factory_id, source_type, source_ref, state, visibility, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [tenantId, factoryId, 'TEST_FIXTURE', 'tenant-transfer-fixture', 'VERIFIED', 'INTERNAL', userId],
      );
      await adminPool.query(
        'INSERT INTO saas_usage_rate_cards (tenant_id, metric_code, rate_version, rate_minor_per_block, block_quantity, currency, effective_from, idempotency_key, request_hash, created_by) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8, $9)',
        [tenantId, 'ACTIVE_USER', 1, 175, '1.000000', 'BDT', 'transfer-rate-' + tenantId, 'a'.repeat(64), userId],
      );

      let exportSnapshot: Record<string, unknown> = {
        transferId: exportId,
        tenantId,
        version: 1,
        operationType: 'EXPORT',
        status: 'REQUESTED',
        sourceSchemaVersion: '1.0.0',
        targetSchemaVersion: null,
        requiredCategories: [...REQUIRED_TRANSFER_CATEGORIES],
        sourceTransferId: null,
        sourceBundleReference: null,
        sourceBundleDigest: null,
        sourceManifest: {},
      };
      let migrationSnapshot: Record<string, unknown> = {
        transferId: migrationId,
        tenantId,
        version: 1,
        operationType: 'MIGRATION',
        status: 'VALIDATED',
        sourceSchemaVersion: '1.0.0',
        targetSchemaVersion: '1.0.0',
        requiredCategories: [...REQUIRED_TRANSFER_CATEGORIES],
        sourceTransferId: exportId,
      };

      const transferLedger = {
        history: jest.fn(async (_tenant: string, _actor: string, id: string) => {
          return [{ ...(id === exportId ? exportSnapshot : migrationSnapshot) }];
        }),
        attestExport: jest.fn(async (
          _tenant: string,
          _actor: string,
          _id: string,
          input: Record<string, unknown>,
        ) => {
          exportSnapshot = {
            ...exportSnapshot,
            version: 2,
            status: 'COMPLETED',
            sourceBundleReference: input.bundle_reference,
            sourceBundleDigest: input.bundle_digest,
            sourceManifest: input.dataset_manifest,
          };
          return { transfer: { ...exportSnapshot } };
        }),
        transitionMigration: jest.fn(async (
          _tenant: string,
          _actor: string,
          _id: string,
          input: Record<string, unknown>,
        ) => {
          const nextVersion = Number(input.expected_version) + 1;
          if (input.action === 'START') {
            migrationSnapshot = { ...migrationSnapshot, version: nextVersion, status: 'IN_PROGRESS' };
          } else if (input.action === 'COMPLETE') {
            migrationSnapshot = {
              ...migrationSnapshot,
              version: nextVersion,
              status: 'COMPLETED',
              targetBundleReference: input.target_bundle_reference,
              targetBundleDigest: input.target_bundle_digest,
              targetManifest: input.target_manifest,
              preservationVerified: input.preservation_verified,
            };
          } else if (input.action === 'FAIL') {
            migrationSnapshot = { ...migrationSnapshot, version: nextVersion, status: 'FAILED' };
          }
          return { transfer: { ...migrationSnapshot } };
        }),
      };

      const source = new SaasTenantPostgresDatasetSource(database);
      const target: SaasTenantMigrationTargetAdapter = {
        async importBundle(input) {
          const chunks: Buffer[] = [];
          for await (const chunk of input.sourceBundle) chunks.push(Buffer.from(chunk));
          const bytes = Buffer.concat(chunks);
          const parsed = JSON.parse(bytes.toString('utf8')) as ParsedExportBundle;
          expect(parsed.format).toBe('FACTORYOS_TENANT_EXPORT');
          expect(parsed.tenantId).toBe(tenantId);

          for (const category of input.requiredCategories) {
            const rows = parsed.datasets[category];
            expect(Array.isArray(rows)).toBe(true);
            const hash = createHash('sha256');
            for (const row of rows) {
              hash.update(JSON.stringify(row), 'utf8');
              hash.update('\n', 'utf8');
            }
            expect(input.sourceManifest[category]?.record_count).toBe(rows.length);
            expect(input.sourceManifest[category]?.sha256).toBe(hash.digest('hex'));
          }

          const targetArtifact = await bundleStore.put((async function* () {
            yield bytes;
          })());
          return {
            targetBundleReference: targetArtifact.reference,
            targetBundleDigest: targetArtifact.digest,
            targetManifest: input.sourceManifest,
          };
        },
      };

      const worker = new SaasTenantDataTransferWorkerService(
        transferLedger as never,
        bundleStore as never,
        source,
        target,
      );
      const exported = await worker.processExport(tenantId, userId, exportId) as {
        transfer: { status: string };
        artifact: { reference: string; digest: string };
      };
      expect(exported.transfer.status).toBe('COMPLETED');

      const plaintextChunks: Buffer[] = [];
      for await (const chunk of bundleStore.read(exported.artifact.reference, exported.artifact.digest)) {
        plaintextChunks.push(Buffer.from(chunk));
      }
      const payload = JSON.parse(Buffer.concat(plaintextChunks).toString('utf8')) as ParsedExportBundle;
      expect(payload.datasets.BUSINESS_DATA.some((row) => row.__factoryos_table === 'factories' && row.id === factoryId)).toBe(true);
      expect(payload.datasets.BUSINESS_DATA.some((row) => row.__factoryos_table === 'legal_entities' && row.id === legalEntityId)).toBe(true);
      expect(payload.datasets.AUDIT_LOG.some((row) => row.action === 'EXPORT_PIPELINE_INTEGRATION')).toBe(true);
      expect(payload.datasets.EVIDENCE.some((row) => row.__factoryos_table === 'business_evidence')).toBe(true);
      expect(payload.datasets.EFFECTIVE_DATED_MASTER_DATA.some((row) => row.__factoryos_table === 'saas_usage_rate_cards')).toBe(true);

      const imported = await worker.processMigration(tenantId, userId, migrationId) as {
        transfer: { status: string; preservationVerified: boolean; targetBundleReference: string };
      };
      expect(imported.transfer.status).toBe('COMPLETED');
      expect(imported.transfer.preservationVerified).toBe(true);
      expect(imported.transfer.targetBundleReference).toMatch(/^bundle-/);
      expect(transferLedger.transitionMigration).toHaveBeenCalledTimes(2);
    }, 60000);
  });
});
