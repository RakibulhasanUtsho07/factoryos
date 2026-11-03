import { jest } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  POSTGRES_FINANCE_RETENTION_ADAPTER_KEY,
  POSTGRES_FINANCE_RETENTION_MAX_ROWS,
  POSTGRES_FINANCE_RETENTION_RELATIONS,
  PostgresFinanceRetentionInventoryAdapter,
} from './postgres-finance-retention-inventory.adapter';

const tenant = '16000000-0000-4000-8000-000000000001';
const previousMode = process.env.FACTORYOS_FINANCE_RETENTION_MODE;

function context(mode: 'DRY_RUN' | 'EXECUTE' = 'DRY_RUN') {
  return {
    tenantId: tenant,
    policyVersion: 1,
    retentionDays: 365,
    cutoffAt: '2025-10-20T10:00:00.000Z',
    legalBasis: 'Approved finance retention basis',
    adapterKey: POSTGRES_FINANCE_RETENTION_ADAPTER_KEY,
    idempotencyKey: 'finance-retention-test-v1',
    reason: 'Exercise non-destructive finance retention inventory',
    mode,
  };
}

function createDatabase(options: {
  counts?: Record<string, number>;
  missingTable?: string;
  rlsDisabledTable?: string;
  deleteGuardMissingTable?: string;
} = {}) {
  const query = jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();
  query.mockImplementation(async (...args: unknown[]) => {
    const sql = String(args[0]);
    const values = (args[1] ?? []) as unknown[];
    if (sql.includes('FROM pg_catalog.pg_class c')) {
      const table = String(values[0]);
      if (table === options.missingTable) return { rows: [] };
      return { rows: [{
        rls_enabled: table !== options.rlsDisabledTable,
        rls_forced: true,
        has_tenant_id: true,
        has_cutoff_column: true,
        has_delete_guard: table !== options.deleteGuardMissingTable,
      }] };
    }
    if (sql.includes('bounded_finance_retention_inventory')) {
      const table = POSTGRES_FINANCE_RETENTION_RELATIONS.find((relation) =>
        sql.includes('FROM public.' + relation.table));
      if (!table) throw new Error('unexpected finance inventory relation');
      return { rows: [{ candidate_rows: String(options.counts?.[table.table] ?? 0) }] };
    }
    throw new Error('unexpected finance inventory SQL: ' + sql);
  });
  return { query } as unknown as DatabaseService & { query: typeof query };
}

describe('PostgresFinanceRetentionInventoryAdapter', () => {
  afterEach(() => {
    if (previousMode === undefined) delete process.env.FACTORYOS_FINANCE_RETENTION_MODE;
    else process.env.FACTORYOS_FINANCE_RETENTION_MODE = previousMode;
  });

  it('is not configured until the explicitly non-destructive inventory mode is selected', async () => {
    delete process.env.FACTORYOS_FINANCE_RETENTION_MODE;
    const adapter = new PostgresFinanceRetentionInventoryAdapter(createDatabase());
    await expect(adapter.isConfigured(tenant)).resolves.toBe(false);
    process.env.FACTORYOS_FINANCE_RETENTION_MODE = 'INVENTORY_ONLY';
    await expect(adapter.isConfigured(tenant)).resolves.toBe(true);
    expect(adapter.adapterKey).toBe(POSTGRES_FINANCE_RETENTION_ADAPTER_KEY);
  });

  it('requires forced tenant RLS, an explicit cutoff column and an immutable DELETE guard', async () => {
    process.env.FACTORYOS_FINANCE_RETENTION_MODE = 'INVENTORY_ONLY';
    const missingRls = new PostgresFinanceRetentionInventoryAdapter(
      createDatabase({ rlsDisabledTable: 'saas_usage_events' }));
    await expect(missingRls.dryRun(context())).rejects.toBeInstanceOf(ConflictException);
    const missingGuard = new PostgresFinanceRetentionInventoryAdapter(
      createDatabase({ deleteGuardMissingTable: 'saas_provider_cost_events' }));
    await expect(missingGuard.dryRun(context())).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates a tenant-bound dry-run inventory and independently verifies its digest without deletion', async () => {
    process.env.FACTORYOS_FINANCE_RETENTION_MODE = 'INVENTORY_ONLY';
    const database = createDatabase({ counts: {
      saas_usage_events: 3,
      saas_usage_adjustments: 2,
    } });
    const adapter = new PostgresFinanceRetentionInventoryAdapter(database);
    const result = await adapter.dryRun(context());

    expect(result.plannedRows).toBe('5');
    expect(result.deletedRows).toBe('0');
    expect(result.residualRows).toBe('0');
    expect(result.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.adapterReceiptReference).toMatch(/^pg-finance-retention-preview\./);
    expect(result.tableManifest).toMatchObject({
      inventory: {
        schema: 'factoryos.postgres-finance-retention-inventory/v1',
        tenantId: tenant,
        destructiveDeletePermitted: false,
        candidateRows: '5',
      },
      deletionPermitted: false,
    });
    const verified = await adapter.verify(context(), result);
    expect(verified).toMatchObject({
      verifiedManifestDigest: result.manifestDigest,
      residualRows: '0',
    });
    const countCalls = database.query.mock.calls.filter((call) =>
      String(call[0]).includes('bounded_finance_retention_inventory'));
    expect(countCalls).toHaveLength(POSTGRES_FINANCE_RETENTION_RELATIONS.length * 2);
    expect(countCalls.every((call) => String(call[0]).includes('tenant_id=$1'))).toBe(true);
    expect(countCalls.every((call) => (call[1] as unknown[])[0] === tenant)).toBe(true);
    expect(database.query.mock.calls.some((call) => /\bDELETE\s+FROM\b/i.test(String(call[0])))).toBe(false);
  });

  it('records EXECUTE as blocked with retained residuals when immutable finance rows exist', async () => {
    process.env.FACTORYOS_FINANCE_RETENTION_MODE = 'INVENTORY_ONLY';
    const database = createDatabase({ counts: { saas_usage_events: 4 } });
    const adapter = new PostgresFinanceRetentionInventoryAdapter(database);
    const execution = await adapter.execute(context('EXECUTE'));

    expect(execution.plannedRows).toBe('4');
    expect(execution.deletedRows).toBe('0');
    expect(execution.residualRows).toBe('4');
    expect(execution.failureCode).toBe('FINANCE_LEDGER_IMMUTABLE_REQUIRES_APPROVED_ARCHIVE_PURGE');
    expect(execution.tableManifest).toMatchObject({
      executionDisposition: 'BLOCKED_IMMUTABLE_FINANCE_LEDGER',
      deletionPermitted: false,
    });
    const verification = await adapter.verify(context('EXECUTE'), execution);
    expect(verification.verifiedManifestDigest).toBe(execution.manifestDigest);
    expect(verification.residualRows).toBe('4');
    expect(database.query.mock.calls.some((call) => /\bDELETE\s+FROM\b/i.test(String(call[0])))).toBe(false);
  });

  it('does not claim a complete inventory when the global row bound is exceeded', async () => {
    process.env.FACTORYOS_FINANCE_RETENTION_MODE = 'INVENTORY_ONLY';
    const counts = Object.fromEntries(POSTGRES_FINANCE_RETENTION_RELATIONS.map((relation) => [
      relation.table, POSTGRES_FINANCE_RETENTION_MAX_ROWS + 1,
    ]));
    const adapter = new PostgresFinanceRetentionInventoryAdapter(createDatabase({ counts }));
    const result = await adapter.dryRun(context());
    expect(result.failureCode).toBe('FINANCE_RETENTION_INVENTORY_LIMIT_EXCEEDED');
    expect(result.tableManifest).toMatchObject({ executionDisposition: 'BLOCKED_INVENTORY_BOUND_EXCEEDED' });
  });
});
