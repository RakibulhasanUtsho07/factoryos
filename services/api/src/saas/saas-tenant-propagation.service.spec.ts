import { jest } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import { SaasTenantPropagationService } from './saas-tenant-propagation.service';

const tenant = '16000000-0000-4000-8000-000000000001';
const requester = '16010000-0000-4000-8000-000000000001';
const reviewer = '16010000-0000-4000-8000-000000000002';
const postgresExecutor = '16010000-0000-4000-8000-000000000003';
const propagationExecutor = '16010000-0000-4000-8000-000000000004';
const independentAttestor = '16010000-0000-4000-8000-000000000005';
const requestId = '16020000-0000-4000-8000-000000000001';
const sourceDigest = 'a'.repeat(64);

describe('SaasTenantPropagationService', () => {
  const clientQuery = jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();
  const database = {
    query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(),
    transaction: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const iam = { authorize: jest.fn<(...args: unknown[]) => Promise<void>>() };
  const audit = { recordWithClient: jest.fn<(...args: unknown[]) => Promise<string>>() };
  const adapter = {
    storeKind: 'OBJECT_STORAGE' as const,
    adapterKey: 'object-store.v1',
    isConfigured: jest.fn<(...args: unknown[]) => Promise<boolean>>(),
    prepare: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    erase: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    verify: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    recover: jest.fn<(...args: unknown[]) => Promise<void>>(),
  };
  let service: SaasTenantPropagationService;

  beforeEach(() => {
    jest.resetAllMocks();
    iam.authorize.mockResolvedValue(undefined);
    audit.recordWithClient.mockResolvedValue('audit-event');
    adapter.isConfigured.mockResolvedValue(true);
    database.transaction.mockImplementation(async (...args: unknown[]) => {
      const callback = args.find((value) => typeof value === 'function') as
        ((client: unknown) => Promise<unknown>) | undefined;
      if (!callback) throw new Error('transaction callback is required');
      return callback({ query: clientQuery } as never);
    });
    clientQuery.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.includes('FROM tenants')) return { rows: [{ id: tenant }] };
      if (sql.includes('FROM saas_tenant_data_erasure_requests') && sql.includes('FOR UPDATE')) {
        return { rows: [{
          tenant_id: tenant, request_id: requestId, version: 1, row_version: 4,
          status: 'PROPAGATION_PENDING', categories: ['BUSINESS_DATA'],
          export_transfer_id: '16030000-0000-4000-8000-000000000001', export_transfer_version: 1,
          export_bundle_digest: sourceDigest, requested_by_user_id: requester,
          reviewed_by_user_id: reviewer, execution_started_by_user_id: postgresExecutor,
          execution_run_id: '16040000-0000-4000-8000-000000000001',
          execution_manifest_digest: 'b'.repeat(64),
        }] };
      }
      if (sql.includes('FROM saas_tenant_external_propagation_runs') && sql.includes('idempotency_key')) return { rows: [] };
      if (sql.includes('FROM saas_tenant_data_transfers')) {
        return { rows: [{ source_manifest: { categories: ['BUSINESS_DATA'] }, source_bundle_digest: sourceDigest, actor_user_id: requester }] };
      }
      if (sql.includes('FROM saas_tenant_data_export_preservation_attestations')) {
        return { rows: [{ verified_by_user_id: independentAttestor }] };
      }
      if (sql.includes('FROM saas_tenant_data_legal_holds')) return { rows: [] };
      if (sql.includes('FROM saas_tenant_external_data_targets')) return { rows: [] };
      throw new Error('unexpected SQL in no-target closure test: ' + sql);
    });
    service = new SaasTenantPropagationService(database as never, iam as never, audit as never, [adapter as never]);
  });

  it('does not call a provider or complete erasure when a required external-copy class has no reviewed target', async () => {
    await expect(service.propagateErasure(tenant, propagationExecutor, requestId, {
      expected_version: 4,
      reason: 'Verify all external copies after PostgreSQL erasure',
      idempotency_key: 'propagate-run-160-v1',
    })).rejects.toBeInstanceOf(ConflictException);

    expect(iam.authorize).toHaveBeenCalledWith(propagationExecutor, tenant, 'saas.data_retention.propagate');
    expect(adapter.prepare).not.toHaveBeenCalled();
    expect(adapter.erase).not.toHaveBeenCalled();
    expect(adapter.verify).not.toHaveBeenCalled();
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes('INSERT INTO saas_tenant_external_propagation_runs'))).toBe(false);
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes("SET status='VERIFIED'"))).toBe(false);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('requires a propagation actor distinct from the requester, reviewer and PostgreSQL executor', async () => {
    await expect(service.propagateErasure(tenant, reviewer, requestId, {
      expected_version: 4,
      reason: 'Separate executor check',
      idempotency_key: 'propagate-separation-v1',
    })).rejects.toBeInstanceOf(ConflictException);
    expect(adapter.prepare).not.toHaveBeenCalled();
    expect(adapter.erase).not.toHaveBeenCalled();
  });
});
