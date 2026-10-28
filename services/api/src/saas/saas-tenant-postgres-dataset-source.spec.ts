import { jest } from '@jest/globals';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';
import { SAAS_TENANT_DATASET_TABLES, SaasTenantPostgresDatasetSource } from './saas-tenant-postgres-dataset-source';
import { DatabaseService } from '../database/database.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const otherTenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const orderId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';

describe('SaasTenantPostgresDatasetSource', () => {
  function createSource(
    rowTenantId?: string,
    iamCounts = {
      membership_count: '0',
      role_count: '0',
      user_role_count: '0',
      role_permission_count: '0',
    },
    excludedCategoryHasRows = false,
  ) {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: jest.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes('tenant_export_category_has_excluded_rows')) {
          return { rows: [{ has_excluded_rows: excludedCategoryHasRows }], rowCount: 1 };
        }
        if (sql.includes('AS membership_count')) {
          return { rows: [iamCounts], rowCount: 1 };
        }
        if (sql.includes('FROM public.orders AS dataset_row')) {
          return {
            rows: rowTenantId
              ? [{
                  id: orderId,
                  tenant_id: rowTenantId,
                  order_number: 'ORD-TRANSFER-001',
                  version: '2',
                  notes: null,
                }]
              : [],
          };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const database = {
      getClient: jest.fn(async () => client),
    } as unknown as DatabaseService;
    return { source: new SaasTenantPostgresDatasetSource(database), client, calls, database };
  }

  it('runs tenant-scoped IAM preflight in a read-only repeatable-read transaction', async () => {
    const { source, client, calls } = createSource();
    await source.assertIamMigrationReady(tenantId);
    expect(calls[0]?.sql).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(calls[1]?.sql).toContain("set_config('app.tenant_id', $1, true)");
    expect(calls.find((item) => item.sql.includes('AS membership_count'))?.values).toEqual([tenantId]);
    expect(calls.some((item) => item.sql === 'COMMIT')).toBe(true);
    expect(calls.some((item) => item.sql === 'ROLLBACK')).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('allows non-empty tenant IAM because stable-code remapping is registered', async () => {
    const { source, client, calls } = createSource(undefined, {
      membership_count: '2', role_count: '3', user_role_count: '2', role_permission_count: '4',
    });
    await expect(source.assertIamMigrationReady(tenantId)).resolves.toBeUndefined();
    expect(calls.some((item) => item.sql === 'COMMIT')).toBe(true);
    expect(calls.some((item) => item.sql === 'ROLLBACK')).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed tenant identifiers before opening an IAM preflight connection', async () => {
    const { source, database } = createSource();
    await expect(source.assertIamMigrationReady('not-a-uuid'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(database.getClient).not.toHaveBeenCalled();
  });

  it('uses a read-only repeatable-read transaction, tenant RLS context and explicit keyset predicates', async () => {
    const { source, client, calls } = createSource(tenantId);
    const rows: unknown[] = [];
    await source.withSnapshot(tenantId, '1.0.0', async (snapshot) => {
      for await (const row of snapshot.readDataset(SaasTransferDatasetCategory.BUSINESS_DATA)) {
        rows.push(row);
      }
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: orderId,
      tenant_id: tenantId,
      order_number: 'ORD-TRANSFER-001',
      version: '2',
      notes: null,
      __factoryos_table: 'orders',
    });
    expect(calls[0]?.sql).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(calls[1]?.sql).toContain("set_config('app.tenant_id', $1, true)");
    expect(calls[1]?.values).toEqual([tenantId, '']);
    const query = calls.find((item) => item.sql.includes('FROM public.orders AS dataset_row'));
    expect(query?.sql).toContain('dataset_row.tenant_id = $1::uuid');
    expect(query?.sql).toContain('dataset_row.id > $2::uuid');
    expect(query?.values).toEqual([tenantId, null, 500]);
    expect(calls.some((item) => item.sql === 'COMMIT')).toBe(true);
    expect(calls.some((item) => item.sql === 'ROLLBACK')).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('includes SaaS usage and budget governance records in the reviewed business-data allowlist', () => {
    expect(SAAS_TENANT_DATASET_TABLES[SaasTransferDatasetCategory.BUSINESS_DATA]).toEqual(
      expect.arrayContaining([
        'saas_usage_events',
        'saas_usage_adjustments',
        'saas_usage_reconciliations',
        'saas_budget_evaluations',
        'saas_workload_control_events',
        'saas_budget_alerts',
        'saas_budget_alert_acknowledgements',
        'saas_provider_cost_events',
        'saas_provider_cost_reconciliations',
      ]),
    );
    expect(SAAS_TENANT_DATASET_TABLES[SaasTransferDatasetCategory.EFFECTIVE_DATED_MASTER_DATA])
      .toEqual(expect.arrayContaining(['saas_usage_rate_cards', 'saas_usage_budgets']));
  });

  it('blocks a category export when tenant rows exist in an excluded direct-tenant relation', async () => {
    const { source, client, calls, database } = createSource(undefined, undefined, true);

    await expect(source.withSnapshot(tenantId, '1.0.0', async (snapshot) => {
      for await (const _row of snapshot.readDataset(SaasTransferDatasetCategory.AI_CONTEXT)) {
        // This loop must never receive records from a partial category.
      }
    })).rejects.toBeInstanceOf(ServiceUnavailableException);

    const coverageCheck = calls.findIndex((item) => item.sql.includes('tenant_export_category_has_excluded_rows'));
    const categoryRead = calls.findIndex((item) => item.sql.includes('FROM public.ai_decision_envelopes AS dataset_row'));
    expect(coverageCheck).toBeGreaterThan(-1);
    expect(categoryRead).toBe(-1);
    expect(calls[coverageCheck]?.values).toEqual([
      SaasTransferDatasetCategory.AI_CONTEXT,
      [
        'ai_decision_envelopes',
        'ai_context_packages',
        'ai_verification_runs',
        'research_sources',
        'research_claims',
        'research_claim_links',
        'research_knowledge_releases',
        'research_relevance_mappings',
      ],
    ]);
    expect(calls.some((item) => item.sql === 'ROLLBACK')).toBe(true);
    expect(calls.some((item) => item.sql === 'COMMIT')).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(database.getClient).toHaveBeenCalledTimes(1);
  });

  it('fails closed for integration metadata and file references until those schemas have explicit adapters', async () => {
    const { source, database } = createSource();
    await expect(source.withSnapshot(tenantId, '1.0.0', async (snapshot) => {
      for await (const _row of snapshot.readDataset(SaasTransferDatasetCategory.FILE_REFERENCES)) {
        // The unsupported category must fail before producing records.
      }
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(database.getClient).toHaveBeenCalledTimes(1);
  });

  it('rejects a row whose tenant scope violates the explicit query scope', async () => {
    const { source, client } = createSource(otherTenantId);
    await expect(source.withSnapshot(tenantId, '1.0.0', async (snapshot) => {
      for await (const _row of snapshot.readDataset(SaasTransferDatasetCategory.BUSINESS_DATA)) {
        // The mocked database simulates a broken RLS/query invariant.
      }
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });


  it('reads multiple categories through exactly one PostgreSQL connection and transaction', async () => {
    const { source, client, calls, database } = createSource(tenantId);
    const categories: SaasTransferDatasetCategory[] = [];
    await source.withSnapshot(tenantId, '1.0.0', async (snapshot) => {
      for await (const _row of snapshot.readDataset(SaasTransferDatasetCategory.BUSINESS_DATA)) {
        // Drain the business category.
      }
      categories.push(SaasTransferDatasetCategory.BUSINESS_DATA);
      for await (const _row of snapshot.readDataset(SaasTransferDatasetCategory.AUDIT_LOG)) {
        // Drain the audit category on the same transaction snapshot.
      }
      categories.push(SaasTransferDatasetCategory.AUDIT_LOG);
    });
    expect(categories).toEqual([
      SaasTransferDatasetCategory.BUSINESS_DATA,
      SaasTransferDatasetCategory.AUDIT_LOG,
    ]);
    expect(database.getClient).toHaveBeenCalledTimes(1);
    expect(calls.filter((item) => item.sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')).toHaveLength(1);
    expect(calls.filter((item) => item.sql === 'COMMIT')).toHaveLength(1);
    expect(calls.filter((item) => item.sql === 'ROLLBACK')).toHaveLength(0);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases the snapshot when a category reader is cancelled early', async () => {
    const { source, client, calls } = createSource(tenantId);
    await expect(source.withSnapshot(tenantId, '1.0.0', async (snapshot) => {
      for await (const _row of snapshot.readDataset(SaasTransferDatasetCategory.BUSINESS_DATA)) {
        break;
      }
      return 'incomplete';
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(calls.some((item) => item.sql === 'COMMIT')).toBe(false);
    expect(calls.some((item) => item.sql === 'ROLLBACK')).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed tenant and schema identifiers before opening a connection', async () => {
    const { source, database } = createSource();
    await expect(source.withSnapshot('not-a-uuid', '1.0.0', async () => undefined))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(source.withSnapshot(tenantId, 'latest', async () => undefined))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(database.getClient).not.toHaveBeenCalled();
  });
});
