import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { SaasTenantRetentionService } from './saas-tenant-retention.service';

const tenant = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const actor = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const reviewer = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const exportId = 'a4f8f4b8-a72b-4d28-b2f2-9b35ac55c1f0';

const policyInput = (extra: Record<string, unknown> = {}) => ({
  category_code: 'BUSINESS_DATA',
  retention_days: 365,
  disposition: 'DELETE',
  legal_basis: 'Contractual basis',
  reason: 'Approved retention schedule',
  idempotency_key: 'retention-policy-v1',
  ...extra,
});

function hashPolicyRequest(input: ReturnType<typeof policyInput>) {
  const canonical = {
    operation: 'RETENTION_POLICY',
    category: input.category_code,
    retentionDays: input.retention_days,
    disposition: input.disposition,
    legalBasis: input.legal_basis,
    reason: input.reason,
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

const policyRow = (extra: Record<string, unknown> = {}) => ({
  id: 'c0c9f8b5-471e-479a-89dc-6e0f1f660f19',
  tenant_id: tenant,
  category_code: 'BUSINESS_DATA',
  version: 1,
  retention_days: 365,
  disposition: 'DELETE',
  legal_basis: 'Contractual basis',
  reason: 'Approved retention schedule',
  idempotency_key: 'retention-policy-v1',
  request_hash: hashPolicyRequest(policyInput()),
  created_by_user_id: actor,
  created_at: '2026-10-19T10:00:00.000Z',
  ...extra,
});

describe('SaasTenantRetentionService', () => {
  const clientQuery = jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();
  const database = {
    query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(),
    transaction: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const iam = { authorize: jest.fn<(...args: unknown[]) => Promise<void>>() };
  const audit = { recordWithClient: jest.fn<(...args: unknown[]) => Promise<string>>() };
  let service: SaasTenantRetentionService;

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
    service = new SaasTenantRetentionService(database as never, iam as never, audit as never);
  });

  it('rejects malformed tenant scope before authorization or storage access', async () => {
    await expect(service.listPolicies('spoofed-tenant', actor)).rejects.toBeInstanceOf(BadRequestException);
    expect(iam.authorize).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires permission before querying or writing retention data', async () => {
    iam.authorize.mockRejectedValueOnce(new ForbiddenException('denied'));
    await expect(service.createPolicy(tenant, actor, policyInput() as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects invalid retention durations before opening a transaction', async () => {
    await expect(service.createPolicy(tenant, actor, policyInput({ retention_days: 0 }) as never))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('creates an immutable, versioned policy and writes audit evidence on the same transaction client', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: tenant }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [policyRow()] });

    const result = await service.createPolicy(tenant, actor, policyInput() as never);

    expect(result).toMatchObject({
      policy: { categoryCode: 'BUSINESS_DATA', version: 1, retentionDays: 365, disposition: 'DELETE' },
      replayed: false,
    });
    expect(iam.authorize).toHaveBeenCalledWith(actor, tenant, 'saas.data_retention.write');
    expect(audit.recordWithClient).toHaveBeenCalledWith(
      expect.objectContaining({ query: clientQuery }),
      expect.objectContaining({
        tenantId: tenant,
        actorUserId: actor,
        eventType: 'SAAS_DATA_RETENTION',
        action: 'RETENTION_POLICY_VERSION_CREATED',
      }),
    );
    expect(database.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      tenantId: tenant,
      userId: actor,
      advisoryLockKey: 'saas-retention:' + tenant,
    }));
  });

  it('replays the same idempotent policy request without creating a second audit event', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: tenant }] })
      .mockResolvedValueOnce({ rows: [policyRow()] });

    const result = await service.createPolicy(tenant, actor, policyInput() as never);

    expect(result.replayed).toBe(true);
    expect(result.policy.version).toBe(1);
    expect(clientQuery).toHaveBeenCalledTimes(2);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('rejects reuse of a policy idempotency key with a different fingerprint', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: tenant }] })
      .mockResolvedValueOnce({ rows: [policyRow({ request_hash: '0'.repeat(64) })] });

    await expect(service.createPolicy(tenant, actor, policyInput() as never))
      .rejects.toBeInstanceOf(ConflictException);
    expect(clientQuery).toHaveBeenCalledTimes(2);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('rejects an overlapping legal hold while external erasure propagation is running', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: tenant }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ categories: ['BUSINESS_DATA'] }] });

    await expect(service.createLegalHold(tenant, actor, {
      categories: ['BUSINESS_DATA'],
      case_reference: 'CASE-BLOCKED-160',
      reason: 'Preserve records for a new case',
      idempotency_key: 'hold-blocked-running-v1',
    } as never)).rejects.toBeInstanceOf(ConflictException);

    expect(clientQuery.mock.calls.some((call) =>
      String(call[0]).includes('INSERT INTO saas_tenant_data_legal_holds'))).toBe(false);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('allows a non-overlapping legal hold while another category is propagating', async () => {
    const hold = {
      id: 'a4f8f4b8-a72b-4d28-b2f2-9b35ac55c1f1',
      tenant_id: tenant,
      categories: ['EVIDENCE'],
      status: 'ACTIVE',
      case_reference: 'CASE-EVIDENCE-160',
      reason: 'Preserve independent evidence',
      idempotency_key: 'hold-evidence-running-v1',
      request_hash: 'a'.repeat(64),
      created_by_user_id: actor,
      created_at: '2026-10-28T10:00:00.000Z',
      released_by_user_id: null,
      released_at: null,
      release_reason: null,
      row_version: 1,
      updated_at: '2026-10-28T10:00:00.000Z',
    };
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: tenant }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ categories: ['BUSINESS_DATA'] }] })
      .mockResolvedValueOnce({ rows: [hold] });

    const result = await service.createLegalHold(tenant, actor, {
      categories: ['EVIDENCE'],
      case_reference: 'CASE-EVIDENCE-160',
      reason: 'Preserve independent evidence',
      idempotency_key: 'hold-evidence-running-v1',
    } as never);

    expect(result).toMatchObject({ hold: { categories: ['EVIDENCE'], status: 'ACTIVE' }, replayed: false });
    expect(audit.recordWithClient).toHaveBeenCalledWith(
      expect.objectContaining({ query: clientQuery }),
      expect.objectContaining({ action: 'LEGAL_HOLD_CREATED' }),
    );
  });

  it('requires a distinct reviewer to release an active legal hold', async () => {
    const hold = {
      id: exportId,
      tenant_id: tenant,
      categories: ['BUSINESS_DATA'],
      status: 'ACTIVE',
      case_reference: 'CASE-42',
      reason: 'Preserve records for review',
      idempotency_key: 'hold-1',
      request_hash: 'a'.repeat(64),
      created_by_user_id: actor,
      created_at: '2026-10-19T10:00:00.000Z',
      released_by_user_id: null,
      released_at: null,
      release_reason: null,
      row_version: 1,
      updated_at: '2026-10-19T10:00:00.000Z',
    };
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: tenant }] })
      .mockResolvedValueOnce({ rows: [hold] });

    await expect(service.releaseLegalHold(tenant, actor, exportId, {
      expected_version: 1,
      reason: 'Release after review',
    } as never)).rejects.toBeInstanceOf(ConflictException);
    expect(clientQuery).toHaveBeenCalledTimes(2);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('fails closed when a requested erasure overlaps an active legal hold', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: tenant }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        transfer_id: exportId,
        version: 1,
        operation_type: 'EXPORT',
        status: 'COMPLETED',
        source_bundle_reference: 'bundle-export-001',
        preservation_verified: true,
        source_bundle_digest: 'b'.repeat(64),
        required_categories: ['BUSINESS_DATA', 'AUDIT_LOG'],
      }] })
      .mockResolvedValueOnce({ rows: [{ categories: ['BUSINESS_DATA'] }] });

    await expect(service.createErasureRequest(tenant, actor, {
      categories: ['BUSINESS_DATA'],
      export_transfer_id: exportId,
      export_transfer_version: 1,
      export_bundle_digest: 'b'.repeat(64),
      reason: 'Customer privacy request',
      idempotency_key: 'erase-request-1',
    } as never)).rejects.toBeInstanceOf(ConflictException);
    expect(clientQuery).toHaveBeenCalledTimes(4);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('requires the preserved export to belong to the same tenant and match its digest', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: tenant }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        transfer_id: exportId,
        version: 1,
        operation_type: 'EXPORT',
        status: 'COMPLETED',
        preservation_verified: true,
        source_bundle_digest: 'c'.repeat(64),
        required_categories: ['BUSINESS_DATA'],
      }] });

    await expect(service.createErasureRequest(tenant, actor, {
      categories: ['BUSINESS_DATA'],
      export_transfer_id: exportId,
      export_transfer_version: 1,
      export_bundle_digest: 'b'.repeat(64),
      reason: 'Customer privacy request',
      idempotency_key: 'erase-request-2',
    } as never)).rejects.toBeInstanceOf(ConflictException);
    expect(clientQuery).toHaveBeenCalledTimes(3);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('fails closed when the audit insert fails inside a policy transaction', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: tenant }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [policyRow()] });
    audit.recordWithClient.mockRejectedValueOnce(new Error('audit storage unavailable'));

    await expect(service.createPolicy(tenant, actor, policyInput() as never)).rejects.toThrow('audit storage unavailable');
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
  });
});
