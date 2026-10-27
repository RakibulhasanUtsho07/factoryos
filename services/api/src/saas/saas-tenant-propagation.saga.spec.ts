import { jest } from '@jest/globals';
import { SaasTenantPropagationService } from './saas-tenant-propagation.service';
import { REQUIRED_EXTERNAL_STORE_KINDS } from './saas-tenant-propagation.adapters';
import type { SaasExternalPropagationPlan, SaasTenantExternalDataPropagationAdapter } from './saas-tenant-propagation.adapters';

const tenant = '16000000-0000-4000-8000-000000000001';
const requester = '16010000-0000-4000-8000-000000000001';
const reviewer = '16010000-0000-4000-8000-000000000002';
const postgresExecutor = '16010000-0000-4000-8000-000000000003';
const propagationExecutor = '16010000-0000-4000-8000-000000000004';
const independentAttestor = '16010000-0000-4000-8000-000000000005';
const requestId = '16020000-0000-4000-8000-000000000001';
const sourceDigest = 'b'.repeat(64);
const sqlDigest = 'c'.repeat(64);
const requestRow = () => ({
  tenant_id: tenant, request_id: requestId, version: 1, row_version: 4, status: 'PROPAGATION_PENDING',
  categories: ['BUSINESS_DATA'], export_transfer_id: '16030000-0000-4000-8000-000000000001',
  export_transfer_version: 1, export_bundle_digest: sourceDigest, requested_by_user_id: requester,
  reviewed_by_user_id: reviewer, execution_started_by_user_id: postgresExecutor,
  execution_run_id: '16040000-0000-4000-8000-000000000001',
  execution_manifest_digest: sqlDigest,
});

describe('SaasTenantPropagationService external saga', () => {
  const clientQuery = jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();
  const database = {
    query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(),
    transaction: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const iam = { authorize: jest.fn<(...args: unknown[]) => Promise<void>>() };
  const audit = { recordWithClient: jest.fn<(...args: unknown[]) => Promise<string>>() };
  const storedReceipts: Record<string, unknown>[] = [];
  const adapterMocks: ReturnType<typeof createAdapter>[] = [];
  let activeRun: Record<string, unknown> | null;
  let activateHoldAfterPrepare = false;
  let legalHoldActivated = false;
  let residualOnFirstVerificationTarget: string | null = null;
  let mismatchedDeletionTarget: string | null = null;
  const verifyCallsByTarget = new Map<string, number>();
  let service: SaasTenantPropagationService;

  function latestReceiptRows(): Record<string, unknown>[] {
    const latest = new Map<string, Record<string, unknown>>();
    const ordered = [...storedReceipts].sort((a, b) => Number(b.attempt_no) - Number(a.attempt_no));
    for (const receipt of ordered) {
      const targetId = String(receipt.target_id);
      if (!latest.has(targetId)) latest.set(targetId, receipt);
    }
    return [...latest.values()];
  }

  function createAdapter(kind: (typeof REQUIRED_EXTERNAL_STORE_KINDS)[number]) {
    const adapter = {
      storeKind: kind,
      adapterKey: kind.toLowerCase().replaceAll('_', '.') + '.v1',
      isConfigured: jest.fn<(...args: unknown[]) => Promise<boolean>>(),
      prepare: jest.fn<(...args: unknown[]) => Promise<SaasExternalPropagationPlan>>(),
      erase: jest.fn<(...args: unknown[]) => Promise<{ deletedCopies: string; manifestDigest: string; providerReceiptReference: string }>>(),
      verify: jest.fn<(...args: unknown[]) => Promise<{ verifiedManifestDigest: string; residualCopies: string; residualReferences: string[]; verificationReference: string }>>(),
      recover: jest.fn<(...args: unknown[]) => Promise<void>>(),
    };
    adapter.isConfigured.mockResolvedValue(true);
    adapter.prepare.mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as { target: { targetId: string } };
      if (activateHoldAfterPrepare) legalHoldActivated = true;
      return { manifestDigest: 'a'.repeat(64), plannedCopies: '2', planReference: 'plan.' + input.target.targetId };
    });
    adapter.erase.mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as { target: { targetId: string }; plan: SaasExternalPropagationPlan };
      return {
        deletedCopies: input.plan.plannedCopies,
        manifestDigest: mismatchedDeletionTarget === input.target.targetId ? 'f'.repeat(64) : input.plan.manifestDigest,
        providerReceiptReference: 'receipt.' + input.target.targetId,
      };
    });
    adapter.verify.mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as { target: { targetId: string }; plan: SaasExternalPropagationPlan };
      const targetId = input.target.targetId;
      const verifyCount = (verifyCallsByTarget.get(targetId) ?? 0) + 1;
      verifyCallsByTarget.set(targetId, verifyCount);
      const leaveResidual = residualOnFirstVerificationTarget === targetId && verifyCount === 1;
      return {
        verifiedManifestDigest: input.plan.manifestDigest,
        residualCopies: leaveResidual ? '1' : '0',
        residualReferences: leaveResidual ? ['residual.' + targetId] : [],
        verificationReference: 'verify.' + targetId + '.' + verifyCount,
      };
    });
    adapter.recover.mockResolvedValue(undefined);
    return adapter;
  }

  beforeEach(() => {
    jest.resetAllMocks();
    storedReceipts.length = 0;
    adapterMocks.length = 0;
    activeRun = null;
    activateHoldAfterPrepare = false;
    legalHoldActivated = false;
    residualOnFirstVerificationTarget = null;
    mismatchedDeletionTarget = null;
    verifyCallsByTarget.clear();
    iam.authorize.mockResolvedValue(undefined);
    audit.recordWithClient.mockResolvedValue('audit-event');
    const targets = REQUIRED_EXTERNAL_STORE_KINDS.map((kind) => ({
      id: 'target-' + kind, tenant_id: tenant, target_id: 'target-' + kind,
      store_kind: kind, adapter_key: kind.toLowerCase().replaceAll('_', '.') + '.v1',
      config_reference: 'config.' + kind.toLowerCase().replaceAll('_', '.'),
      registration_reason: 'Reviewed fake adapter target', categories: ['BUSINESS_DATA'], required: true,
      status: 'ACTIVE', registered_by_user_id: requester, reviewed_by_user_id: reviewer,
      reviewed_at: '2026-10-20T10:00:00.000Z', review_reason: 'Approved for integration test',
      created_at: '2026-10-20T09:00:00.000Z', updated_at: '2026-10-20T10:00:00.000Z',
    }));
    for (const kind of REQUIRED_EXTERNAL_STORE_KINDS) adapterMocks.push(createAdapter(kind));

    database.transaction.mockImplementation(async (...args: unknown[]) => {
      const callback = args.find((value) => typeof value === 'function') as
        ((client: unknown) => Promise<unknown>) | undefined;
      if (!callback) throw new Error('transaction callback is required');
      return callback({ query: clientQuery } as never);
    });
    database.query.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.includes('SELECT DISTINCT ON (target_id) * FROM saas_tenant_external_propagation_receipts')) {
        return { rows: latestReceiptRows() };
      }
      throw new Error('unexpected database.query SQL: ' + sql);
    });
    clientQuery.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      const p = (args[1] ?? []) as unknown[];
      if (sql.includes('FROM tenants')) return { rows: [{ id: tenant }] };
      if (sql.includes('FROM saas_tenant_data_erasure_requests') && sql.includes('FOR UPDATE')) return { rows: [requestRow()] };
      if (sql.includes('FROM saas_tenant_external_propagation_runs') && sql.includes('run_id=$3') && sql.includes('FOR UPDATE')) {
        return { rows: activeRun ? [{ ...activeRun }] : [] };
      }
      if (sql.includes('FROM saas_tenant_external_propagation_runs') && sql.includes('idempotency_key')) {
        return { rows: activeRun ? [{ ...activeRun }] : [] };
      }
      if (sql.includes('FROM saas_tenant_data_transfers')) {
        return { rows: [{ source_manifest: { tenantId: tenant, categories: ['BUSINESS_DATA'] },
          source_bundle_digest: sourceDigest, actor_user_id: requester }] };
      }
      if (sql.includes('FROM saas_tenant_data_export_preservation_attestations')) return { rows: [{ verified_by_user_id: independentAttestor }] };
      if (sql.includes('FROM saas_tenant_data_legal_holds')) {
        return { rows: legalHoldActivated ? [{ categories: ['BUSINESS_DATA'] }] : [] };
      }
      if (sql.includes('FROM saas_tenant_external_data_targets')) return { rows: targets };
      if (sql.includes('INSERT INTO saas_tenant_external_propagation_runs')) {
        const manifest = JSON.parse(String(p[6])) as Record<string, unknown>;
        activeRun = {
          run_id: p[1], request_id: p[2], request_version: p[3], status: 'RUNNING', categories: p[4],
          source_export_digest: p[5], external_manifest: manifest, target_count: p[7],
          verified_targets: 0, planned_copies: '0', deleted_copies: '0', residual_copies: '0',
          reason: p[8], idempotency_key: p[9], request_hash: p[10], executor_user_id: p[11],
          failure_code: null, manifest_digest: null, finished_at: null,
        };
        return { rows: [{ ...activeRun }] };
      }
      if (sql.includes('SELECT DISTINCT ON (target_id) * FROM saas_tenant_external_propagation_receipts')) return { rows: latestReceiptRows() };
      if (sql.includes('UPDATE saas_tenant_external_propagation_runs') && sql.includes("SET status='RUNNING'") && sql.includes('RETURNING *')) {
        activeRun = {
          ...(activeRun ?? {}),
          status: 'RUNNING', failure_code: null, finished_at: null, manifest_digest: null,
          verified_targets: 0, planned_copies: '0', deleted_copies: '0', residual_copies: '0',
        };
        return { rows: [{ ...activeRun }] };
      }
      if (sql.includes('UPDATE saas_tenant_external_propagation_runs SET external_manifest')) {
        if (activeRun) activeRun.external_manifest = JSON.parse(String(p[3])) as Record<string, unknown>;
        return { rows: [] };
      }
      if (sql.includes('SELECT COALESCE(MAX(attempt_no),0)+1 AS attempt_no')) {
        const targetId = String(p[3]);
        return { rows: [{ attempt_no: storedReceipts.filter((row) => row.target_id === targetId).length + 1 }] };
      }
      if (sql.includes('INSERT INTO saas_tenant_external_propagation_receipts')) {
        storedReceipts.push({
          tenant_id: p[0], request_id: p[1], run_id: p[2], target_id: p[3], store_kind: p[4],
          attempt_no: p[5], status: p[6], planned_copies: p[7], deleted_copies: p[8],
          residual_copies: p[9], manifest_digest: p[10], verified_manifest_digest: p[11],
          verification_reference: p[12], residual_manifest: p[13], failure_code: p[14],
          provider_receipt_reference: p[15],
        });
        return { rows: [] };
      }
      if (sql.includes('UPDATE saas_tenant_external_propagation_runs') && sql.includes('RETURNING *')) {
        const manifest = JSON.parse(String(p[4])) as Record<string, unknown>;
        activeRun = {
          ...(activeRun ?? {}),
          run_id: p[2], status: p[3], external_manifest: manifest, manifest_digest: p[5],
          target_count: p[6], verified_targets: p[7], planned_copies: p[8], deleted_copies: p[9],
          residual_copies: p[10], failure_code: p[11], request_hash: 'd'.repeat(64),
          request_id: requestId, request_version: 1, source_export_digest: sourceDigest,
        };
        return { rows: [{ ...activeRun }] };
      }
      if (sql.includes("UPDATE saas_tenant_data_erasure_requests") && sql.includes("status='VERIFIED'")) {
        return { rows: [{
          ...requestRow(), status: 'VERIFIED', row_version: 5, propagation_run_id: p[2],
          propagation_manifest_digest: p[3], propagation_verified_at: '2026-10-20T12:00:00.000Z',
        }] };
      }
      throw new Error('unexpected transaction SQL: ' + sql);
    });
    service = new SaasTenantPropagationService(database as never, iam as never, audit as never, adapterMocks as never);
  });

  it('rechecks active legal holds after preparing a provider plan and never erases after a new hold appears', async () => {
    activateHoldAfterPrepare = true;

    const result = await service.propagateErasure(tenant, propagationExecutor, requestId, {
      expected_version: 4,
      reason: 'Block deletion when a legal hold is activated during planning',
      idempotency_key: 'legal-hold-race-saga-v1',
    });

    expect(result.wholeTenantErasureVerified).toBe(false);
    expect(result.request).toMatchObject({ requestId, status: 'PROPAGATION_PENDING', version: 4 });
    expect(adapterMocks).toHaveLength(REQUIRED_EXTERNAL_STORE_KINDS.length);
    for (const adapter of adapterMocks) {
      expect(adapter.prepare).toHaveBeenCalledTimes(1);
      expect(adapter.erase).not.toHaveBeenCalled();
    }
    expect(storedReceipts).toHaveLength(REQUIRED_EXTERNAL_STORE_KINDS.length);
    expect(storedReceipts.every((receipt) => receipt.status === 'FAILED')).toBe(true);
    expect(audit.recordWithClient).toHaveBeenCalledWith(
      expect.objectContaining({ query: clientQuery }),
      expect.objectContaining({
        action: 'TENANT_ERASURE_PROPAGATION_PARTIAL',
        payload: expect.objectContaining({ postgresqlReceiptScope: 'POSTGRESQL_ONLY' }),
      }),
    );
    expect(audit.recordWithClient).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'TENANT_ERASURE_PROPAGATION_VERIFIED' }),
    );
  });

  it('keeps the request pending when a provider deletion receipt has a different manifest digest', async () => {
    mismatchedDeletionTarget = 'target-OBJECT_STORAGE';

    const result = await service.propagateErasure(tenant, propagationExecutor, requestId, {
      expected_version: 4,
      reason: 'Reject a provider receipt that does not match its prepared scope',
      idempotency_key: 'manifest-mismatch-saga-v1',
    });

    expect(result.wholeTenantErasureVerified).toBe(false);
    expect(result.request).toMatchObject({ requestId, status: 'PROPAGATION_PENDING', version: 4 });
    const mismatchedReceipt = storedReceipts.find((receipt) => receipt.target_id === mismatchedDeletionTarget);
    expect(mismatchedReceipt).toMatchObject({ status: 'FAILED', failure_code: 'VERIFICATION_MISMATCH' });
    expect(adapterMocks[0]?.erase).toHaveBeenCalledTimes(1);
    expect(adapterMocks[0]?.verify).not.toHaveBeenCalled();
    expect(audit.recordWithClient).toHaveBeenCalledWith(
      expect.objectContaining({ query: clientQuery }),
      expect.objectContaining({ action: 'TENANT_ERASURE_PROPAGATION_PARTIAL' }),
    );
    expect(audit.recordWithClient).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'TENANT_ERASURE_PROPAGATION_VERIFIED' }),
    );
  });

  it('recovers a partial provider result idempotently without re-erasing targets already verified', async () => {
    const retryTarget = 'target-OBJECT_STORAGE';
    residualOnFirstVerificationTarget = retryTarget;
    const input = {
      expected_version: 4,
      reason: 'Retry an explicitly residual external store after reconciliation',
      idempotency_key: 'partial-recovery-saga-v1',
    };

    const first = await service.propagateErasure(tenant, propagationExecutor, requestId, input);
    expect(first.wholeTenantErasureVerified).toBe(false);
    expect(first.run.status).toBe('PARTIAL');
    expect(first.request).toMatchObject({ requestId, status: 'PROPAGATION_PENDING', version: 4 });
    expect(storedReceipts).toHaveLength(REQUIRED_EXTERNAL_STORE_KINDS.length);
    expect(storedReceipts.find((receipt) => receipt.target_id === retryTarget)).toMatchObject({ status: 'RESIDUALS' });

    const second = await service.propagateErasure(tenant, propagationExecutor, requestId, input);
    expect(second.wholeTenantErasureVerified).toBe(true);
    expect(second.run.status).toBe('VERIFIED');
    expect(second.request).toMatchObject({ requestId, status: 'VERIFIED', version: 5 });
    expect(storedReceipts).toHaveLength(REQUIRED_EXTERNAL_STORE_KINDS.length + 1);

    const recoveryAdapter = adapterMocks.find((adapter) => adapter.storeKind === 'OBJECT_STORAGE');
    expect(recoveryAdapter?.recover).toHaveBeenCalledTimes(1);
    expect(recoveryAdapter?.prepare).toHaveBeenCalledTimes(1);
    expect(recoveryAdapter?.erase).toHaveBeenCalledTimes(2);
    expect(recoveryAdapter?.verify).toHaveBeenCalledTimes(2);
    for (const adapter of adapterMocks.filter((candidate) => candidate.storeKind !== 'OBJECT_STORAGE')) {
      expect(adapter.erase).toHaveBeenCalledTimes(1);
    }
  });

  it('verifies every configured storage class before promoting request status to whole-tenant VERIFIED', async () => {
    const result = await service.propagateErasure(tenant, propagationExecutor, requestId, {
      expected_version: 4, reason: 'Verify every external copy', idempotency_key: 'external-propagation-saga-v1',
    });

    expect(result).toMatchObject({
      wholeTenantErasureVerified: true,
      request: { status: 'VERIFIED', version: 5, postgresqlManifestDigest: sqlDigest },
      run: { status: 'VERIFIED', targetCount: REQUIRED_EXTERNAL_STORE_KINDS.length,
        verifiedTargets: REQUIRED_EXTERNAL_STORE_KINDS.length, plannedCopies: '16', deletedCopies: '16', residualCopies: '0' },
    });
    expect(storedReceipts).toHaveLength(REQUIRED_EXTERNAL_STORE_KINDS.length);
    for (const adapter of adapterMocks) {
      expect(adapter.prepare).toHaveBeenCalledTimes(1);
      expect(adapter.erase).toHaveBeenCalledTimes(1);
      expect(adapter.verify).toHaveBeenCalledTimes(1);
    }
    expect(audit.recordWithClient).toHaveBeenCalledWith(
      expect.objectContaining({ query: clientQuery }),
      expect.objectContaining({ action: 'TENANT_ERASURE_PROPAGATION_VERIFIED',
        payload: expect.objectContaining({ postgresqlReceiptScope: 'POSTGRESQL_ONLY', residualCopies: '0' }) }),
    );
  });
});
