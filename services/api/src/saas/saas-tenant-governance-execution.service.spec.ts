import { jest } from '@jest/globals';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SaasTenantGovernanceExecutionService } from './saas-tenant-governance-execution.service';
import { SaasRetentionRunMode } from './dto/run-saas-retention-policy.dto';

const tenant = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const requester = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const reviewer = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const executor = 'c2b2c2db-e17f-4e71-8d2d-e2f12af68b3a';
const erasureRequestId = 'c0c9f8b5-471e-479a-89dc-6e0f1f660f19';
const runId = 'a4f8f4b8-a72b-4d28-b2f2-9b35ac55c1f0';
const sourceDigest = 'b'.repeat(64);
const manifestDigest = 'c'.repeat(64);

const erasureRow = (extra: Record<string, unknown> = {}) => ({
  id: erasureRequestId,
  tenant_id: tenant,
  request_id: erasureRequestId,
  version: 1,
  status: 'APPROVED',
  categories: ['EVIDENCE'],
  export_transfer_id: 'e0000000-0000-4000-8000-000000000001',
  export_transfer_version: 1,
  export_bundle_digest: sourceDigest,
  reason: 'Customer erasure request',
  requested_by_user_id: requester,
  reviewed_by_user_id: reviewer,
  reviewed_at: '2026-10-19T12:00:00.000Z',
  review_reason: 'Approved after dual-control review',
  row_version: 2,
  created_at: '2026-10-19T11:00:00.000Z',
  updated_at: '2026-10-19T12:00:00.000Z',
  ...extra,
});

const completedRun = (extra: Record<string, unknown> = {}) => ({
  id: runId,
  tenant_id: tenant,
  run_id: runId,
  request_id: erasureRequestId,
  request_version: 1,
  status: 'COMPLETED',
  categories: ['EVIDENCE'],
  deleted_rows: '0',
  table_manifest: { tables: {}, deletedRows: '0' },
  manifest_digest: manifestDigest,
  source_export_digest: sourceDigest,
  executor_user_id: executor,
  failure_code: null,
  reason: 'Execute approved erasure',
  idempotency_key: 'execute-erasure-v1',
  request_hash: 'd'.repeat(64),
  created_at: '2026-10-19T13:00:00.000Z',
  finished_at: '2026-10-19T13:00:00.000Z',
  ...extra,
});

describe('SaasTenantGovernanceExecutionService', () => {
  const clientQuery = jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();
  const database = {
    query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(),
    transaction: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const iam = { authorize: jest.fn<(...args: unknown[]) => Promise<void>>() };
  const audit = { recordWithClient: jest.fn<(...args: unknown[]) => Promise<string>>() };
  let service: SaasTenantGovernanceExecutionService;

  beforeEach(() => {
    jest.resetAllMocks();
    iam.authorize.mockResolvedValue(undefined);
    audit.recordWithClient.mockResolvedValue('audit-event-id');
    database.transaction.mockImplementation(async (...args: unknown[]) => {
      const callback = args.find((value) => typeof value === 'function') as
        ((client: unknown) => Promise<unknown>) | undefined;
      if (!callback) throw new Error('test transaction callback is required');
      return callback({ query: clientQuery } as never);
    });
    service = new SaasTenantGovernanceExecutionService(database as never, iam as never, audit as never);
  });

  it('rejects malformed tenant scope before permission checks or database access', async () => {
    await expect(service.executeErasure('not-a-tenant', executor, erasureRequestId, {
      expected_version: 2,
      reason: 'Execute approved erasure',
      idempotency_key: 'execute-erasure-v1',
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(iam.authorize).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires the dedicated execute permission before opening a destructive transaction', async () => {
    iam.authorize.mockRejectedValueOnce(new ForbiddenException('denied'));
    await expect(service.executeErasure(tenant, executor, erasureRequestId, {
      expected_version: 2,
      reason: 'Execute approved erasure',
      idempotency_key: 'execute-erasure-v1',
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(iam.authorize).toHaveBeenCalledWith(executor, tenant, 'saas.data_retention.execute');
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('uses the verified tenant scope when a requested erasure ID belongs to no row in that tenant', async () => {
    clientQuery.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.includes('FROM tenants')) return { rows: [{ id: tenant }] };
      if (sql.includes('FROM saas_tenant_data_erasure_runs')) return { rows: [] };
      if (sql.includes('FROM saas_tenant_data_erasure_requests')) return { rows: [] };
      throw new Error('unexpected query: ' + sql);
    });

    await expect(service.executeErasure(tenant, executor, erasureRequestId, {
      expected_version: 2,
      reason: 'Execute approved erasure',
      idempotency_key: 'execute-erasure-v1',
    })).rejects.toBeInstanceOf(NotFoundException);

    expect(clientQuery.mock.calls.some((call) =>
      String(call[0]).includes('FROM saas_tenant_data_erasure_requests')
      && (call[1] as unknown[])[0] === tenant
      && (call[1] as unknown[])[1] === erasureRequestId,
    )).toBe(true);
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes('WITH deleted AS'))).toBe(false);
  });

  it('refuses to let the requester execute their own approved deletion', async () => {
    clientQuery.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.includes('FROM tenants')) return { rows: [{ id: tenant }] };
      if (sql.includes('FROM saas_tenant_data_erasure_runs')) return { rows: [] };
      if (sql.includes('FROM saas_tenant_data_erasure_requests')) {
        return { rows: [erasureRow({ requested_by_user_id: executor })] };
      }
      throw new Error('unexpected query: ' + sql);
    });

    await expect(service.executeErasure(tenant, executor, erasureRequestId, {
      expected_version: 2,
      reason: 'Execute approved erasure',
      idempotency_key: 'execute-erasure-v1',
    })).rejects.toBeInstanceOf(ConflictException);
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes('DELETE FROM public.'))).toBe(false);
  });

  it('records an unsupported retention category as BLOCKED instead of running a generic delete', async () => {
    const retentionRunRow = {
      id: runId,
      tenant_id: tenant,
      run_id: runId,
      category_code: 'INTEGRATION_METADATA',
      policy_version: 1,
      mode: SaasRetentionRunMode.DRY_RUN,
      status: 'BLOCKED',
      cutoff_at: '2026-01-01T00:00:00.000Z',
      examined_rows: '0',
      eligible_rows: '0',
      affected_rows: '0',
      held_rows: '0',
      table_manifest: { _blocked: 'NO_REVIEWED_TABLE_MAPPING' },
      manifest_digest: null,
      reason: 'Review unsupported category',
      idempotency_key: 'retention-run-v1',
      request_hash: 'e'.repeat(64),
      initiated_by_user_id: executor,
      created_at: '2026-10-19T13:00:00.000Z',
      finished_at: '2026-10-19T13:00:00.000Z',
    };
    clientQuery.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.includes('FROM tenants')) return { rows: [{ id: tenant }] };
      if (sql.includes('FROM saas_tenant_data_retention_runs')) return { rows: [] };
      if (sql.includes('FROM saas_tenant_data_retention_policies')) {
        return { rows: [{
          id: runId,
          tenant_id: tenant,
          category_code: 'INTEGRATION_METADATA',
          version: 1,
          retention_days: 365,
          disposition: 'REVIEW',
          created_by_user_id: requester,
        }] };
      }
      if (sql.includes('clock_timestamp() -')) return { rows: [{ cutoff_at: '2026-01-01T00:00:00.000Z' }] };
      if (sql.includes('FROM saas_tenant_data_legal_holds')) return { rows: [] };
      if (sql.includes('INSERT INTO saas_tenant_data_retention_runs')) return { rows: [retentionRunRow] };
      throw new Error('unexpected query: ' + sql);
    });

    const result = await service.runRetentionPolicy(tenant, executor, 'INTEGRATION_METADATA', {
      mode: SaasRetentionRunMode.DRY_RUN,
      expected_policy_version: 1,
      reason: 'Review unsupported category',
      idempotency_key: 'retention-run-v1',
    });

    expect(result.run.status).toBe('BLOCKED');
    expect(result.run.tableManifest).toMatchObject({ _blocked: 'NO_REVIEWED_TABLE_MAPPING' });
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes('DELETE FROM'))).toBe(false);
    expect(audit.recordWithClient).toHaveBeenCalledWith(
      expect.objectContaining({ query: clientQuery }),
      expect.objectContaining({
        eventType: 'SAAS_DATA_GOVERNANCE',
        action: 'RETENTION_DRY_RUN_BLOCKED',
      }),
    );
  });

  it('blocks DELETE execution when even one reviewed table has an enabled DELETE trigger', async () => {
    const blockedRun = {
      id: runId,
      tenant_id: tenant,
      run_id: runId,
      category_code: 'BUSINESS_DATA',
      policy_version: 1,
      mode: SaasRetentionRunMode.EXECUTE,
      status: 'BLOCKED',
      cutoff_at: '2026-01-01T00:00:00.000Z',
      examined_rows: '0',
      eligible_rows: '0',
      affected_rows: '0',
      held_rows: '0',
      table_manifest: { _blocked: 'DELETE_GUARD_REQUIRES_REVIEWED_ADAPTER' },
      manifest_digest: null,
      reason: 'Review protected tables before deletion',
      idempotency_key: 'guarded-retention-v1',
      request_hash: 'f'.repeat(64),
      initiated_by_user_id: executor,
      created_at: '2026-10-19T13:00:00.000Z',
      finished_at: '2026-10-19T13:00:00.000Z',
    };
    clientQuery.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.includes('FROM tenants')) return { rows: [{ id: tenant }] };
      if (sql.includes('FROM saas_tenant_data_retention_runs')) return { rows: [] };
      if (sql.includes('FROM saas_tenant_data_retention_policies')) {
        return { rows: [{
          id: runId,
          tenant_id: tenant,
          category_code: 'BUSINESS_DATA',
          version: 1,
          retention_days: 365,
          disposition: 'DELETE',
          created_by_user_id: requester,
        }] };
      }
      if (sql.includes('clock_timestamp() -')) return { rows: [{ cutoff_at: '2026-01-01T00:00:00.000Z' }] };
      if (sql.includes('AS deletion_guarded')) return { rows: [{
        table_exists: true, has_tenant_id: true, has_id: true,
        forced_rls: true, has_tenant_policy: true, deletion_guarded: true, time_column: 'created_at',
      }] };
      if (sql.includes('COUNT(*)::text AS examined')) return { rows: [{ examined: '1', eligible: '1' }] };
      if (sql.includes('FROM saas_tenant_data_legal_holds')) return { rows: [] };
      if (sql.includes('INSERT INTO saas_tenant_data_retention_runs')) return { rows: [blockedRun] };
      throw new Error('unexpected query: ' + sql);
    });

    const result = await service.runRetentionPolicy(tenant, executor, 'BUSINESS_DATA', {
      mode: SaasRetentionRunMode.EXECUTE,
      expected_policy_version: 1,
      reason: 'Review protected tables before deletion',
      idempotency_key: 'guarded-retention-v1',
    });

    expect(result.run.status).toBe('BLOCKED');
    expect(result.run.tableManifest).toMatchObject({ _blocked: 'DELETE_GUARD_REQUIRES_REVIEWED_ADAPTER' });
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes('DELETE FROM public.'))).toBe(false);
  });

  it('writes an immutable FAILED retention receipt when the guarded transaction rolls back', async () => {
    const failedRun = {
      id: runId, tenant_id: tenant, run_id: runId, category_code: 'BUSINESS_DATA',
      policy_version: 1, mode: SaasRetentionRunMode.EXECUTE, status: 'FAILED',
      cutoff_at: '2026-01-01T00:00:00.000Z', examined_rows: '0', eligible_rows: '0',
      affected_rows: '0', held_rows: '0', table_manifest: { failureCode: 'DATABASE_GUARD' },
      manifest_digest: null, reason: 'Exercise failed receipt', idempotency_key: 'retention-fail-v1',
      request_hash: 'a'.repeat(64), initiated_by_user_id: executor,
      created_at: '2026-10-19T13:00:00.000Z', finished_at: '2026-10-19T13:00:00.000Z',
    };
    let deleteAttempts = 0;
    clientQuery.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.includes('FROM tenants')) return { rows: [{ id: tenant }] };
      if (sql.includes('FROM saas_tenant_data_retention_runs')) return { rows: [] };
      if (sql.includes('FROM saas_tenant_data_retention_policies')) {
        return { rows: [{
          id: runId, tenant_id: tenant, category_code: 'BUSINESS_DATA',
          version: 1, retention_days: 365, disposition: 'DELETE', created_by_user_id: requester,
        }] };
      }
      if (sql.includes('clock_timestamp() -')) return { rows: [{ cutoff_at: '2026-01-01T00:00:00.000Z' }] };
      if (sql.includes('AS deletion_guarded')) return { rows: [{
        table_exists: true, has_tenant_id: true, has_id: true,
        forced_rls: true, has_tenant_policy: true, deletion_guarded: false, time_column: 'created_at',
      }] };
      if (sql.includes('COUNT(*)::text AS examined')) return { rows: [{ examined: '1', eligible: '1' }] };
      if (sql.includes('FROM saas_tenant_data_legal_holds')) return { rows: [] };
      if (sql.includes('SELECT c.oid::text AS')) return { rows: [] };
      if (sql.includes('WITH deleted AS')) {
        deleteAttempts += 1;
        throw Object.assign(new Error('delete rejected by a database guard'), { code: '55000' });
      }
      if (sql.includes('INSERT INTO saas_tenant_data_retention_runs')) return { rows: [failedRun] };
      throw new Error('unexpected query: ' + sql);
    });

    await expect(service.runRetentionPolicy(tenant, executor, 'BUSINESS_DATA', {
      mode: SaasRetentionRunMode.EXECUTE,
      expected_policy_version: 1,
      reason: 'Exercise failed receipt',
      idempotency_key: 'retention-fail-v1',
    })).rejects.toThrow('delete rejected by a database guard');

    expect(deleteAttempts).toBe(1);
    expect(clientQuery.mock.calls.some((call) =>
      String(call[0]).includes('INSERT INTO saas_tenant_data_retention_runs')
      && String(call[0]).includes("'FAILED'")
    )).toBe(true);
    expect(audit.recordWithClient).toHaveBeenCalledWith(
      expect.objectContaining({ query: clientQuery }),
      expect.objectContaining({ action: 'RETENTION_EXECUTION_FAILED' }),
    );
  });

  it('executes an approved erasure in one tenant-scoped transaction and binds VERIFIED to its immutable receipt', async () => {
    const verifiedRequest = erasureRow({
      status: 'VERIFIED',
      row_version: 4,
      execution_manifest_digest: manifestDigest,
      execution_completed_at: '2026-10-19T13:00:00.000Z',
    });
    clientQuery.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.includes('FROM tenants')) return { rows: [{ id: tenant }] };
      if (sql.includes('FROM saas_tenant_data_erasure_runs') && sql.includes('idempotency_key')) return { rows: [] };
      if (sql.includes('FROM saas_tenant_data_erasure_requests') && sql.includes('FOR UPDATE')) return { rows: [erasureRow()] };
      if (sql.includes('FROM saas_tenant_data_export_preservation_attestations')) return { rows: [{ id: 'preservation-evidence' }] };
      if (sql.includes('FROM saas_tenant_data_legal_holds')) return { rows: [] };
      if (sql.includes('has_tenant_policy')) {
        return { rows: [{
          table_exists: true, has_tenant_id: true, has_id: true,
          forced_rls: true, has_tenant_policy: true, time_column: null,
        }] };
      }
      if (sql.includes('SELECT c.oid::text AS')) return { rows: [] };
      if (sql.includes('SELECT COUNT(*)::text AS count')) return { rows: [{ count: '0' }] };
      if (sql.includes("SET status='EXECUTING'")) return { rows: [erasureRow({ status: 'EXECUTING', row_version: 3 })] };
      if (sql.includes('WITH deleted AS')) return { rows: [{ deleted: '0' }] };
      if (sql.includes('INSERT INTO saas_tenant_data_erasure_runs')) return { rows: [completedRun()] };
      if (sql.includes("SET status='VERIFIED'")) return { rows: [verifiedRequest] };
      throw new Error('unexpected query: ' + sql);
    });

    const result = await service.executeErasure(tenant, executor, erasureRequestId, {
      expected_version: 2,
      reason: 'Execute approved erasure',
      idempotency_key: 'execute-erasure-v1',
    });

    expect(result).toMatchObject({
      run: { status: 'COMPLETED', manifestDigest },
      request: { status: 'VERIFIED', version: 4, executionManifestDigest: manifestDigest },
      replayed: false,
    });
    expect(database.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ tenantId: tenant, userId: executor }),
    );
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes("SET status='EXECUTING'"))).toBe(true);
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes("SET status='VERIFIED'"))).toBe(true);
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes('DELETE FROM public.'))).toBe(true);
    expect(audit.recordWithClient).toHaveBeenCalledWith(
      expect.objectContaining({ query: clientQuery }),
      expect.objectContaining({
        action: 'TENANT_ERASURE_VERIFIED',
        payload: expect.objectContaining({ deletedRows: '0', manifestDigest }),
      }),
    );
  });
});
