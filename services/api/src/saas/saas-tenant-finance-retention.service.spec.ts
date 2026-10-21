import { jest } from '@jest/globals';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { SaasTenantFinanceRetentionService } from './saas-tenant-finance-retention.service';

const tenant = '16000000-0000-4000-8000-000000000001';
const policyMaker = '16010000-0000-4000-8000-000000000001';
const policyReviewer = '16010000-0000-4000-8000-000000000002';
const executor = '16010000-0000-4000-8000-000000000003';
const policyId = '16020000-0000-4000-8000-000000000001';
const runId = '16030000-0000-4000-8000-000000000001';
const manifestDigest = 'f'.repeat(64);

const policyRow = () => ({
  id: policyId, tenant_id: tenant, version: 1, retention_days: 365,
  legal_basis: 'Contractual finance record basis', finance_adapter_key: 'finance.adapter.v1',
  status: 'APPROVED', created_by_user_id: policyMaker, reviewed_by_user_id: policyReviewer,
  reviewed_at: '2026-10-20T10:00:00.000Z', review_reason: 'Approved by independent finance reviewer',
  reason: 'Retention schedule reviewed', idempotency_key: 'finance-policy-v1',
  request_hash: 'a'.repeat(64), created_at: '2026-10-20T09:00:00.000Z',
});

describe('SaasTenantFinanceRetentionService', () => {
  const clientQuery = jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();
  const database = {
    query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(),
    transaction: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const iam = { authorize: jest.fn<(...args: unknown[]) => Promise<void>>() };
  const audit = { recordWithClient: jest.fn<(...args: unknown[]) => Promise<string>>() };
  const adapter = {
    adapterKey: 'finance.adapter.v1',
    isConfigured: jest.fn<(...args: unknown[]) => Promise<boolean>>(),
    dryRun: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    execute: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    verify: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  let service: SaasTenantFinanceRetentionService;

  beforeEach(() => {
    jest.resetAllMocks();
    iam.authorize.mockResolvedValue(undefined);
    audit.recordWithClient.mockResolvedValue('audit-event');
    adapter.isConfigured.mockResolvedValue(true);
    adapter.execute.mockResolvedValue({
      plannedRows: '4', deletedRows: '4', residualRows: '0',
      tableManifest: { saas_usage_events: '4' }, manifestDigest,
      adapterReceiptReference: 'provider.finance.receipt.1',
    });
    adapter.dryRun.mockResolvedValue({
      plannedRows: '4', deletedRows: '0', residualRows: '0',
      tableManifest: { saas_usage_events: '4' }, manifestDigest,
      adapterReceiptReference: 'provider.finance.dryrun.1',
    });
    adapter.verify.mockResolvedValue({
      verifiedManifestDigest: manifestDigest, residualRows: '0', verificationReference: 'verify.finance.1',
    });
    database.query.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.includes('FROM saas_tenant_finance_retention_runs')) return { rows: [] };
      if (sql.includes('FROM saas_tenant_finance_retention_policies')) return { rows: [policyRow()] };
      if (sql.includes('FROM saas_tenant_data_legal_holds')) return { rows: [] };
      if (sql.includes('clock_timestamp() -')) return { rows: [{ cutoff_at: '2025-10-20T10:00:00.000Z' }] };
      throw new Error('unexpected database query: ' + sql);
    });
    database.transaction.mockImplementation(async (...args: unknown[]) => {
      const callback = args.find((value) => typeof value === 'function') as
        ((client: unknown) => Promise<unknown>) | undefined;
      if (!callback) throw new Error('transaction callback is required');
      return callback({ query: clientQuery } as never);
    });
    clientQuery.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.includes('FROM tenants')) return { rows: [{ id: tenant }] };
      if (sql.includes('FROM saas_tenant_finance_retention_runs') && sql.includes('FOR UPDATE')) return { rows: [] };
      if (sql.includes('INSERT INTO saas_tenant_finance_retention_runs')) {
        const p = args[1] as unknown[];
        return { rows: [{
          run_id: runId, policy_version: p[1], mode: p[2], status: p[3], cutoff_at: p[4],
          planned_rows: p[5], deleted_rows: p[6], residual_rows: p[7],
          table_manifest: JSON.parse(String(p[8])) as Record<string, unknown>, manifest_digest: p[9],
          adapter_receipt_reference: p[10], failure_code: p[11], reason: p[12],
          idempotency_key: p[13], request_hash: p[14], approved_by_user_id: p[15], executor_user_id: p[16],
          created_at: '2026-10-20T11:00:00.000Z', finished_at: '2026-10-20T11:00:01.000Z',
        }] };
      }
      throw new Error('unexpected transaction SQL: ' + sql);
    });
    service = new SaasTenantFinanceRetentionService(database as never, iam as never, audit as never);
  });

  const input = {
    mode: 'EXECUTE' as const, expected_policy_version: 1,
    reason: 'Apply approved statutory finance retention', idempotency_key: 'finance-run-v1',
  };

  it('fails closed when the dedicated finance adapter is not registered', async () => {
    await expect(service.runPolicy(tenant, executor, 1, input)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(database.transaction).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes('DELETE FROM public.'))).toBe(false);
  });

  it('uses only the separately approved finance adapter and requires exact digest/count verification', async () => {
    service = new SaasTenantFinanceRetentionService(database as never, iam as never, audit as never, adapter as never);
    const result = await service.runPolicy(tenant, executor, 1, input);

    expect(result).toMatchObject({
      run: {
        runId, policyVersion: 1, mode: 'EXECUTE', status: 'COMPLETED',
        plannedRows: '4', deletedRows: '4', residualRows: '0',
        receiptScope: 'FINANCE_USAGE_LEDGER_ONLY', adapterReceiptReference: 'provider.finance.receipt.1',
      },
      replayed: false,
    });
    expect(adapter.execute).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: tenant, policyVersion: 1, adapterKey: 'finance.adapter.v1',
      retentionDays: 365, idempotencyKey: 'finance-run-v1',
    }));
    expect(adapter.verify).toHaveBeenCalled();
    expect(audit.recordWithClient).toHaveBeenCalledWith(
      expect.objectContaining({ query: clientQuery }),
      expect.objectContaining({ action: 'FINANCE_RETENTION_COMPLETED' }),
    );
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes('DELETE FROM public.'))).toBe(false);
  });

  it('blocks finance deletion when a matching business-data legal hold is active', async () => {
    service = new SaasTenantFinanceRetentionService(database as never, iam as never, audit as never, adapter as never);
    database.query.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.includes('FROM saas_tenant_finance_retention_runs')) return { rows: [] };
      if (sql.includes('FROM saas_tenant_finance_retention_policies')) return { rows: [policyRow()] };
      if (sql.includes('FROM saas_tenant_data_legal_holds')) return { rows: [{ categories: ['BUSINESS_DATA'] }] };
      if (sql.includes('clock_timestamp() -')) return { rows: [{ cutoff_at: '2025-10-20T10:00:00.000Z' }] };
      throw new Error('unexpected database query: ' + sql);
    });
    await expect(service.runPolicy(tenant, executor, 1, input)).rejects.toBeInstanceOf(ConflictException);
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
