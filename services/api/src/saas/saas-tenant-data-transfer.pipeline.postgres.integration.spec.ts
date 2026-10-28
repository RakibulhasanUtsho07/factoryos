import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest, describe, expect, it } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import { Pool } from 'pg';
import { DatabaseService } from '../database/database.service';
import { REQUIRED_TRANSFER_CATEGORIES } from './dto/create-saas-schema-compatibility-rule.dto';
import { SaasEncryptedTenantBundleStore } from './saas-encrypted-tenant-bundle.store';
import type { SaasTenantTransferExportManifest } from './saas-tenant-data-transfer.adapters';
import { SaasTenantPostgresMigrationTargetAdapter } from './saas-tenant-postgres-migration-target.adapter';
import { SaasTenantPostgresDatasetSource } from './saas-tenant-postgres-dataset-source';
import { SaasTenantDataTransferWorkerService } from './saas-tenant-data-transfer.worker';

const postgresDescribe = process.env.TEST_ADMIN_DATABASE_URL && process.env.DATABASE_URL && process.env.SAAS_TRANSFER_TARGET_DATABASE_URL ? describe : describe.skip;

interface ParsedExportBundle {
  format: string;
  tenantId: string;
  datasets: Record<string, Array<Record<string, unknown>>>;
  manifest: SaasTenantTransferExportManifest;
}

describe('SaaS tenant export/import pipeline PostgreSQL integration', () => {
  postgresDescribe('live PostgreSQL source plus encrypted artifact and target-adapter contract', () => {
    let adminPool: Pool;
    let targetAdminPool: Pool;
    let database: DatabaseService;
    let targetAdapter: SaasTenantPostgresMigrationTargetAdapter;
    let bundleStore: SaasEncryptedTenantBundleStore;
    let bundleDirectory: string;
    let encryptionKey: string;
    const tenantIds: string[] = [];
    const userIds: string[] = [];
    const factoryIds: string[] = [];
    const legalEntityIds: string[] = [];

    beforeAll(async () => {
      adminPool = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
      targetAdminPool = new Pool({ connectionString: process.env.SAAS_TRANSFER_TARGET_DATABASE_URL });
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
      const immutableTriggers = [
        ['saas_usage_rate_cards', 'trg_saas_rate_cards_immutable'],
        ['saas_usage_events', 'trg_saas_usage_events_immutable'],
        ['saas_usage_adjustments', 'trg_saas_usage_adjustments_immutable'],
        ['saas_usage_reconciliations', 'trg_saas_usage_reconciliations_immutable'],
        ['saas_usage_budgets', 'trg_saas_usage_budgets_immutable'],
        ['saas_budget_evaluations', 'trg_saas_budget_evaluations_immutable'],
        ['saas_workload_control_events', 'trg_saas_workload_controls_immutable'],
        ['saas_budget_alerts', 'trg_saas_budget_alerts_immutable'],
        ['saas_budget_alert_acknowledgements', 'trg_saas_budget_alert_ack_immutable'],
        ['saas_provider_cost_events', 'trg_saas_provider_cost_events_immutable'],
        ['saas_provider_cost_reconciliations', 'trg_saas_provider_cost_recon_immutable'],
        ['saas_tenant_import_receipts', 'saas_tenant_import_receipts_immutable'],
        ['business_evidence', 'business_evidence_immutable'],
        ['business_evidence_links', 'business_evidence_links_immutable'],
      ] as const;

      const cleanupDatabase = async (pool: Pool, isTarget: boolean) => {
        for (const [table, trigger] of immutableTriggers) {
          await pool.query('ALTER TABLE ' + table + ' DISABLE TRIGGER ' + trigger);
        }
        await pool.query('ALTER TABLE inventory_locations DISABLE TRIGGER USER');
        try {
          if (isTarget) {
            await pool.query('DELETE FROM saas_tenant_import_receipts WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          }
          await pool.query('DELETE FROM saas_budget_alert_acknowledgements WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await pool.query('DELETE FROM saas_budget_alerts WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await pool.query('DELETE FROM saas_workload_control_events WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await pool.query('DELETE FROM saas_provider_cost_reconciliations WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await pool.query('DELETE FROM saas_provider_cost_events WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await pool.query('DELETE FROM saas_usage_reconciliations WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await pool.query('DELETE FROM saas_usage_adjustments WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await pool.query('DELETE FROM saas_usage_events WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await pool.query('DELETE FROM saas_budget_evaluations WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await pool.query('DELETE FROM saas_usage_budgets WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await pool.query('DELETE FROM saas_usage_rate_cards WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await pool.query('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await pool.query('DELETE FROM business_evidence_links WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await pool.query('DELETE FROM business_evidence WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await pool.query('DELETE FROM inventory_locations WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await pool.query('DELETE FROM factories WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          await pool.query('DELETE FROM legal_entities WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
          if (userIds.length > 0) await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
          await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]);
        } finally {
          await pool.query('ALTER TABLE inventory_locations ENABLE TRIGGER USER');
          for (const [table, trigger] of immutableTriggers.slice().reverse()) {
            await pool.query('ALTER TABLE ' + table + ' ENABLE TRIGGER ' + trigger);
          }
        }
      };

      if (adminPool && tenantIds.length > 0) {
        try {
          await cleanupDatabase(adminPool, false);
          if (targetAdminPool) await cleanupDatabase(targetAdminPool, true);
        } finally {
          await adminPool.end();
        }
      } else if (adminPool) {
        await adminPool.end();
      }
      if (targetAdapter) await targetAdapter.onModuleDestroy();
      if (targetAdminPool) await targetAdminPool.end();
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
      const rateCardId = randomUUID();
      const budgetId = randomUUID();
      const evaluationId = randomUUID();
      const alertId = randomUUID();
      const usageEventId = randomUUID();
      const adjustmentId = randomUUID();
      const usageReconciliationId = randomUUID();
      const workloadControlId = randomUUID();
      const alertAcknowledgementId = randomUUID();
      const providerCostEventId = randomUUID();
      const providerCostReconciliationId = randomUUID();
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
        'INSERT INTO tenant_memberships (tenant_id, user_id, status) VALUES ($1, $2, $3)',
        [tenantId, userId, 'ACTIVE'],
      );
      await adminPool.query(
        'INSERT INTO permissions (code, description) VALUES ($1, $2) ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description',
        ['transfer.integration.orders.read', 'Transfer integration IAM permission'],
      );

      // The target is a separate database. Pre-provision only tenant and identity rows;
      // all selected tenant domain data must be imported by the production adapter.
      await targetAdminPool.query(
        'INSERT INTO tenants (id, slug, name, status, timezone, default_locale) VALUES ($1, $2, $3, $4, $5, $6)',
        [tenantId, 'xfer-' + tenantId.slice(0, 8), 'Transfer Integration Tenant', 'ACTIVE', 'Asia/Dhaka', 'en-BD'],
      );
      await targetAdminPool.query(
        'INSERT INTO users (id, external_subject, email, display_name, status) VALUES ($1, $2, $3, $4, $5)',
        [userId, 'xfer-' + userId, 'xfer-' + userId + '@factoryos.test', 'Transfer integration actor', 'ACTIVE'],
      );

      await targetAdminPool.query(
        'INSERT INTO permissions (code, description) VALUES ($1, $2) ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description',
        ['transfer.integration.orders.read', 'Transfer integration IAM permission'],
      );
      await adminPool.query(
        'INSERT INTO legal_entities (id, tenant_id, code, name, country_code, status) VALUES ($1, $2, $3, $4, $5, $6)',
        [legalEntityId, tenantId, 'XFER-' + tenantId.slice(0, 8), 'Transfer Legal Entity', 'BD', 'ACTIVE'],
      );
      await adminPool.query(
        'INSERT INTO factories (id, tenant_id, legal_entity_id, code, name, status, timezone) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [factoryId, tenantId, legalEntityId, 'XFER-' + factoryId.slice(0, 8), 'Transfer Test Factory', 'ACTIVE', 'Asia/Dhaka'],
      );

      // The factory trigger seeds a default virtual location. Its source identity
      // must survive export/import because inventory movements may bind to it.
      const defaultLocationResult = await adminPool.query<{ id: string }>(
        'SELECT id::text AS id FROM inventory_locations WHERE tenant_id = $1::uuid AND factory_id = $2::uuid AND is_default = TRUE',
        [tenantId, factoryId],
      );
      if (defaultLocationResult.rows.length !== 1 || !defaultLocationResult.rows[0]) {
        throw new Error('Expected exactly one source default inventory location');
      }
      const defaultLocationId = defaultLocationResult.rows[0].id;

      await adminPool.query(
        'INSERT INTO roles (tenant_id, code, name, description, is_system) VALUES ($1, $2, $3, $4, $5)',
        [tenantId, 'transfer.integration.operator', 'Transfer Integration Operator', null, false],
      );
      await adminPool.query(
        'INSERT INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.tenant_id = $1::uuid AND r.code = $2 AND p.code = $3',
        [tenantId, 'transfer.integration.operator', 'transfer.integration.orders.read'],
      );
      await adminPool.query(
        'INSERT INTO user_roles (membership_id, role_id, factory_id) SELECT tm.id, r.id, f.id FROM tenant_memberships tm CROSS JOIN roles r CROSS JOIN factories f WHERE tm.tenant_id = $1::uuid AND tm.user_id = $2::uuid AND r.tenant_id = $1::uuid AND r.code = $3 AND f.tenant_id = $1::uuid AND f.id = $4::uuid',
        [tenantId, userId, 'transfer.integration.operator', factoryId],
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
        'INSERT INTO saas_usage_rate_cards (id, tenant_id, metric_code, rate_version, rate_minor_per_block, block_quantity, currency, effective_from, idempotency_key, request_hash, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, $10)',
        [rateCardId, tenantId, 'ACTIVE_USER', 1, 175, '1.000000', 'BDT', 'transfer-rate-' + tenantId, 'a'.repeat(64), userId],
      );
      await adminPool.query(
        'INSERT INTO saas_usage_budgets (id, tenant_id, factory_id, budget_code, policy_version, period_kind, currency, soft_limit_minor, hard_limit_minor, effective_from, idempotency_key, request_hash, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() - INTERVAL \'1 day\', $10, $11, $12)',
        [budgetId, tenantId, factoryId, 'transfer-budget', 1, 'MONTHLY', 'BDT', 10000, 20000, 'transfer-budget-' + tenantId, 'b'.repeat(64), userId],
      );
      await adminPool.query(
        'INSERT INTO saas_usage_events (id, tenant_id, factory_id, metric_code, capability_code, workload_class, quantity, occurred_at, source_system, source_event_ref, rate_card_id, rate_version_snapshot, rate_minor_per_block_snapshot, rate_block_quantity_snapshot, currency, estimated_cost_minor, request_hash, idempotency_key, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)',
        [usageEventId, tenantId, factoryId, 'ACTIVE_USER', 'users.active', 'NON_AI', '1.000000', 'API', 'transfer-usage-' + tenantId, rateCardId, 1, 175, '1.000000', 'BDT', 175, 'c'.repeat(64), 'usage-' + tenantId, userId],
      );
      await adminPool.query(
        'INSERT INTO saas_usage_adjustments (id, tenant_id, factory_id, period_start, period_end, quantity_delta, cost_delta_minor, currency, reason_code, reason, reference_ref, request_hash, idempotency_key, created_by) VALUES ($1, $2, $3, NOW() - INTERVAL \'1 day\', NOW(), 0, -175, $4, $5, $6, $7, $8, $9, $10)',
        [adjustmentId, tenantId, factoryId, 'BDT', 'CUSTOMER_CREDIT', 'Transfer fixture adjustment', 'transfer-adjustment-' + tenantId, 'd'.repeat(64), 'adjustment-' + tenantId, userId],
      );
      await adminPool.query(
        'INSERT INTO saas_usage_reconciliations (id, tenant_id, factory_id, invoice_reference, reconciliation_version, period_start, period_end, currency, event_count, unpriced_event_count, ledger_estimated_amount_minor, adjustment_amount_minor, expected_amount_minor, invoiced_amount_minor, variance_minor, status, report_hash, request_hash, idempotency_key, recorded_by) VALUES ($1, $2, $3, $4, $5, NOW() - INTERVAL \'1 day\', NOW(), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)',
        [usageReconciliationId, tenantId, factoryId, 'transfer-invoice-' + tenantId, 1, 'BDT', 1, 0, 175, -175, 0, 0, 0, 'MATCHED', 'e'.repeat(64), 'f'.repeat(64), 'usage-reconciliation-' + tenantId, userId],
      );
      await adminPool.query(
        'INSERT INTO saas_budget_evaluations (id, tenant_id, factory_id, budget_id, period_start, period_end, event_count, unpriced_event_count, usage_cost_minor, soft_limit_minor, hard_limit_minor, status, report_hash, idempotency_key, request_hash, evaluated_by) VALUES ($1, $2, $3, $4, NOW() - INTERVAL \'1 day\', NOW(), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
        [evaluationId, tenantId, factoryId, budgetId, 1, 0, 9000, 10000, 20000, 'WARNING', '1'.repeat(64), 'budget-evaluation-' + tenantId, '2'.repeat(64), userId],
      );
      await adminPool.query(
        'INSERT INTO saas_workload_control_events (id, tenant_id, factory_id, workload_class, control_state, source, reason_code, reason_hash, budget_id, budget_evaluation_id, idempotency_key, request_hash, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
        [workloadControlId, tenantId, factoryId, 'EVALUATION', 'PAUSED', 'MANUAL', 'ADMIN_PAUSE', '3'.repeat(64), budgetId, evaluationId, 'workload-control-' + tenantId, '4'.repeat(64), userId],
      );
      await adminPool.query(
        'INSERT INTO saas_budget_alerts (id, tenant_id, factory_id, budget_id, budget_evaluation_id, alert_type, severity, title, message_code, payload, payload_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)',
        [alertId, tenantId, factoryId, budgetId, evaluationId, 'WARNING', 'WARNING', 'Transfer fixture alert', 'BUDGET_SOFT_LIMIT', '{}', '5'.repeat(64)],
      );
      await adminPool.query(
        'INSERT INTO saas_budget_alert_acknowledgements (id, tenant_id, alert_id, acknowledged_by, idempotency_key, request_hash) VALUES ($1, $2, $3, $4, $5, $6)',
        [alertAcknowledgementId, tenantId, alertId, userId, 'alert-ack-' + tenantId, '6'.repeat(64)],
      );
      await adminPool.query(
        'INSERT INTO saas_provider_cost_events (id, tenant_id, factory_id, provider_code, model_code, metric_code, workload_class, quantity, currency, provider_cost_minor, occurred_at, source_system, source_event_ref, request_hash, idempotency_key, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11, $12, $13, $14, $15)',
        [providerCostEventId, tenantId, factoryId, 'openai', 'gpt-6', 'AI_TOOL_CALL', 'EVALUATION', '1.000000', 'USD', 25, 'PROVIDER_API', 'transfer-provider-cost-' + tenantId, '7'.repeat(64), 'provider-cost-' + tenantId, userId],
      );
      await adminPool.query(
        'INSERT INTO saas_provider_cost_reconciliations (id, tenant_id, factory_id, provider_code, invoice_reference, reconciliation_version, period_start, period_end, currency, event_count, ledger_provider_cost_minor, invoiced_provider_cost_minor, variance_minor, status, report_hash, request_hash, idempotency_key, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, NOW() - INTERVAL \'1 day\', NOW(), $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)',
        [providerCostReconciliationId, tenantId, factoryId, 'openai', 'transfer-provider-invoice-' + tenantId, 1, 'USD', 1, 25, 25, 0, 'MATCHED', '8'.repeat(64), '9'.repeat(64), 'provider-reconciliation-' + tenantId, userId],
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
      targetAdapter = new SaasTenantPostgresMigrationTargetAdapter({
        get: (key: string) => key === 'SAAS_TRANSFER_TARGET_DATABASE_URL'
          ? process.env.SAAS_TRANSFER_TARGET_DATABASE_URL
          : undefined,
      } as never, database);
      const target = targetAdapter;

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
      expect(payload.datasets.BUSINESS_DATA.some((row) =>
        row.__factoryos_table === 'inventory_locations' && row.id === defaultLocationId
          && row.is_default === true && row.location_code === 'UNASSIGNED',
      )).toBe(true);
      expect(payload.datasets.AUDIT_LOG.some((row) => row.action === 'EXPORT_PIPELINE_INTEGRATION')).toBe(true);
      expect(payload.datasets.EVIDENCE.some((row) => row.__factoryos_table === 'business_evidence')).toBe(true);
      expect(payload.datasets.EFFECTIVE_DATED_MASTER_DATA.some((row) => row.__factoryos_table === 'saas_usage_rate_cards')).toBe(true);
      expect(payload.datasets.EFFECTIVE_DATED_MASTER_DATA.some((row) => row.__factoryos_table === 'saas_usage_budgets' && row.id === budgetId)).toBe(true);
      expect(payload.datasets.BUSINESS_DATA.some((row) => row.__factoryos_table === 'saas_usage_events' && row.id === usageEventId)).toBe(true);
      expect(payload.datasets.BUSINESS_DATA.some((row) => row.__factoryos_table === 'saas_usage_adjustments' && row.id === adjustmentId)).toBe(true);
      expect(payload.datasets.BUSINESS_DATA.some((row) => row.__factoryos_table === 'saas_usage_reconciliations' && row.id === usageReconciliationId)).toBe(true);
      expect(payload.datasets.BUSINESS_DATA.some((row) => row.__factoryos_table === 'saas_budget_evaluations' && row.id === evaluationId)).toBe(true);
      expect(payload.datasets.BUSINESS_DATA.some((row) => row.__factoryos_table === 'saas_workload_control_events' && row.id === workloadControlId)).toBe(true);
      expect(payload.datasets.BUSINESS_DATA.some((row) => row.__factoryos_table === 'saas_budget_alerts' && row.id === alertId)).toBe(true);
      expect(payload.datasets.BUSINESS_DATA.some((row) => row.__factoryos_table === 'saas_budget_alert_acknowledgements' && row.id === alertAcknowledgementId)).toBe(true);
      expect(payload.datasets.BUSINESS_DATA.some((row) => row.__factoryos_table === 'saas_provider_cost_events' && row.id === providerCostEventId)).toBe(true);
      expect(payload.datasets.BUSINESS_DATA.some((row) => row.__factoryos_table === 'saas_provider_cost_reconciliations' && row.id === providerCostReconciliationId)).toBe(true);

      const imported = await worker.processMigration(tenantId, userId, migrationId) as {
        transfer: { status: string; preservationVerified: boolean; targetBundleReference: string };
      };
      expect(imported.transfer.status).toBe('COMPLETED');
      expect(imported.transfer.preservationVerified).toBe(true);
      expect(imported.transfer.targetBundleReference).toMatch(/^pgimport:/);

      const importedDefaultLocation = await targetAdminPool.query<{ id: string; location_code: string }>(
        'SELECT id::text AS id, location_code FROM inventory_locations WHERE tenant_id = $1::uuid AND factory_id = $2::uuid AND is_default = TRUE',
        [tenantId, factoryId],
      );
      expect(importedDefaultLocation.rows).toHaveLength(1);
      expect(importedDefaultLocation.rows[0]).toMatchObject({
        id: defaultLocationId,
        location_code: 'UNASSIGNED',
      });
      const mappedAccess = await targetAdminPool.query<{
        membership_status: string; role_code: string; permission_code: string; factory_code: string | null;
      }>(
        'SELECT tm.status AS membership_status, r.code AS role_code, p.code AS permission_code, f.code AS factory_code ' +
          'FROM tenant_memberships tm JOIN user_roles ur ON ur.membership_id = tm.id ' +
          'JOIN roles r ON r.id = ur.role_id JOIN role_permissions rp ON rp.role_id = r.id ' +
          'JOIN permissions p ON p.id = rp.permission_id LEFT JOIN factories f ON f.id = ur.factory_id ' +
          'WHERE tm.tenant_id = $1::uuid AND tm.user_id = $2::uuid',
        [tenantId, userId],
      );
      expect(mappedAccess.rows).toEqual([{
        membership_status: 'ACTIVE',
        role_code: 'transfer.integration.operator',
        permission_code: 'transfer.integration.orders.read',
        factory_code: 'XFER-' + factoryId.slice(0, 8),
      }]);

      expect(transferLedger.transitionMigration).toHaveBeenCalledTimes(2);
      const targetFactory = await targetAdminPool.query(
        'SELECT id FROM factories WHERE tenant_id = $1::uuid AND id = $2::uuid',
        [tenantId, factoryId],
      );
      const targetEvidence = await targetAdminPool.query(
        'SELECT id FROM business_evidence WHERE tenant_id = $1::uuid',
        [tenantId],
      );
      const targetAudit = await targetAdminPool.query(
        'SELECT id FROM audit_events WHERE tenant_id = $1::uuid AND action = $2',
        [tenantId, 'EXPORT_PIPELINE_INTEGRATION'],
      );
      const receipt = await targetAdminPool.query(
        'SELECT tenant_id, transfer_id, source_manifest, target_manifest, target_snapshot_digest ' +
          'FROM saas_tenant_import_receipts WHERE tenant_id = $1::uuid AND transfer_id = $2::uuid',
        [tenantId, migrationId],
      );
      const targetUsage = await targetAdminPool.query(
        'SELECT id FROM saas_usage_events WHERE tenant_id = $1::uuid AND id = $2::uuid',
        [tenantId, usageEventId],
      );
      const targetAlertAck = await targetAdminPool.query(
        'SELECT id FROM saas_budget_alert_acknowledgements WHERE tenant_id = $1::uuid AND id = $2::uuid',
        [tenantId, alertAcknowledgementId],
      );
      const targetProviderReconciliation = await targetAdminPool.query(
        'SELECT id FROM saas_provider_cost_reconciliations WHERE tenant_id = $1::uuid AND id = $2::uuid',
        [tenantId, providerCostReconciliationId],
      );
      const targetControl = await targetAdminPool.query(
        'SELECT id FROM saas_workload_control_events WHERE tenant_id = $1::uuid AND id = $2::uuid',
        [tenantId, workloadControlId],
      );
      expect(targetFactory.rowCount).toBe(1);
      expect(targetEvidence.rowCount).toBe(1);
      expect(targetAudit.rowCount).toBe(1);
      expect(targetUsage.rowCount).toBe(1);
      expect(targetAlertAck.rowCount).toBe(1);
      expect(targetProviderReconciliation.rowCount).toBe(1);
      expect(targetControl.rowCount).toBe(1);
      expect(receipt.rowCount).toBe(1);
      expect(receipt.rows[0].source_manifest).toEqual(payload.manifest);
      expect(receipt.rows[0].target_manifest).toEqual(payload.manifest);
      expect(receipt.rows[0].target_manifest).toEqual(receipt.rows[0].source_manifest);
      expect(receipt.rows[0].target_snapshot_digest).toMatch(/^[a-f0-9]{64}$/);

      // A retry after a successful import must return the existing immutable receipt,
      // rather than trying to insert the same tenant rows again.
      const replayed = await target.importBundle({
        tenantId,
        transferId: migrationId,
        sourceSchemaVersion: '1.0.0',
        targetSchemaVersion: '1.0.0',
        sourceBundle: bundleStore.read(exported.artifact.reference, exported.artifact.digest),
        sourceManifest: payload.manifest,
        requiredCategories: [...REQUIRED_TRANSFER_CATEGORIES],
      });
      expect(replayed.targetBundleReference).toBe(imported.transfer.targetBundleReference);
      expect(replayed.targetBundleDigest).toBe(receipt.rows[0].target_snapshot_digest);
      expect(replayed.targetManifest).toEqual(receipt.rows[0].target_manifest);

      // IAM is part of the logical target manifest too: a replay after an
      // assignment's factory scope drifts must not return the old receipt as success.
      const targetAssignment = await targetAdminPool.query<{
        id: string;
        factory_id: string;
      }>(
        'SELECT ur.id::text AS id, ur.factory_id::text AS factory_id ' +
          'FROM user_roles ur JOIN tenant_memberships tm ON tm.id = ur.membership_id ' +
          'JOIN roles r ON r.id = ur.role_id ' +
          'WHERE tm.tenant_id = $1::uuid AND tm.user_id = $2::uuid AND r.code = $3',
        [tenantId, userId, 'transfer.integration.operator'],
      );
      expect(targetAssignment.rowCount).toBe(1);
      const mappedAssignment = targetAssignment.rows[0];
      expect(mappedAssignment?.factory_id).toBe(factoryId);
      if (!mappedAssignment) throw new Error('Expected the mapped IAM assignment to exist');

      try {
        await targetAdminPool.query(
          'UPDATE user_roles SET factory_id = NULL WHERE id = $1::uuid',
          [mappedAssignment.id],
        );
        await expect(target.importBundle({
          tenantId,
          transferId: migrationId,
          sourceSchemaVersion: '1.0.0',
          targetSchemaVersion: '1.0.0',
          sourceBundle: bundleStore.read(exported.artifact.reference, exported.artifact.digest),
          sourceManifest: payload.manifest,
          requiredCategories: [...REQUIRED_TRANSFER_CATEGORIES],
        })).rejects.toBeInstanceOf(ConflictException);
      } finally {
        await targetAdminPool.query(
          'UPDATE user_roles SET factory_id = $2::uuid WHERE id = $1::uuid',
          [mappedAssignment.id, mappedAssignment.factory_id],
        );
      }

      const changedManifest = {
        ...payload.manifest,
        BUSINESS_DATA: {
          ...payload.manifest.BUSINESS_DATA,
          record_count: payload.manifest.BUSINESS_DATA.record_count + 1,
        },
      };
      await expect(target.importBundle({
        tenantId,
        transferId: migrationId,
        sourceSchemaVersion: '1.0.0',
        targetSchemaVersion: '1.0.0',
        sourceBundle: bundleStore.read(exported.artifact.reference, exported.artifact.digest),
        sourceManifest: changedManifest,
        requiredCategories: [...REQUIRED_TRANSFER_CATEGORIES],
      })).rejects.toBeInstanceOf(ConflictException);

      const replayedUsageCount = await targetAdminPool.query(
        'SELECT COUNT(*)::int AS count FROM saas_usage_events WHERE tenant_id = $1::uuid AND id = $2::uuid',
        [tenantId, usageEventId],
      );
      expect(replayedUsageCount.rows[0]?.count).toBe(1);

      // Simulate out-of-band target drift on the disposable test database.
      // The normal immutable ledger trigger remains enabled outside this fixture.
      await targetAdminPool.query('ALTER TABLE saas_usage_events DISABLE TRIGGER trg_saas_usage_events_immutable');
      try {
        await targetAdminPool.query(
          'UPDATE saas_usage_events SET quantity = quantity + 1 WHERE tenant_id = $1::uuid AND id = $2::uuid',
          [tenantId, usageEventId],
        );
      } finally {
        await targetAdminPool.query('ALTER TABLE saas_usage_events ENABLE TRIGGER trg_saas_usage_events_immutable');
      }

      await expect(target.importBundle({
        tenantId,
        transferId: migrationId,
        sourceSchemaVersion: '1.0.0',
        targetSchemaVersion: '1.0.0',
        sourceBundle: bundleStore.read(exported.artifact.reference, exported.artifact.digest),
        sourceManifest: payload.manifest,
        requiredCategories: [...REQUIRED_TRANSFER_CATEGORIES],
      })).rejects.toBeInstanceOf(ConflictException);
    }, 60000);
  });
});
