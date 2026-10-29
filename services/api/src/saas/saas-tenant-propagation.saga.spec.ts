import { jest } from '@jest/globals';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SaasTenantPropagationService } from './saas-tenant-propagation.service';
import { BackupCopyClassEvidenceArtifactReader } from './backup-copy-class-evidence-artifact-reader';
import { digestSaasExternalPropagationResources, REQUIRED_EXTERNAL_STORE_KINDS } from './saas-tenant-propagation.adapters';
import { REQUIRED_BACKUP_COPY_CLASSES } from './backup-copy-class-coverage.constants';
import { canonicalizeBackupCopyClassEvidenceAttestation, type BackupCopyClassEvidenceAttestationPayload } from './backup-copy-class-evidence-attestation';
import type { SaasExternalPropagationPlan, SaasTenantExternalDataPropagationAdapter } from './saas-tenant-propagation.adapters';

const tenant = '16000000-0000-4000-8000-000000000001';
const requester = '16010000-0000-4000-8000-000000000001';
const reviewer = '16010000-0000-4000-8000-000000000002';
const postgresExecutor = '16010000-0000-4000-8000-000000000003';
const propagationExecutor = '16010000-0000-4000-8000-000000000004';
const independentAttestor = '16010000-0000-4000-8000-000000000005';
const { publicKey: backupEvidencePublicKey, privateKey: backupEvidencePrivateKey } = generateKeyPairSync('ed25519');
const backupEvidenceKeyId = 'copy-owner-ed25519-test-v1';
const backupEvidenceOwner = 'owner.infra.ci';
const priorBackupEvidenceTrust = process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_TRUSTED_KEYS_JSON;
const priorBackupEvidenceRoot = process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR;
const backupEvidenceRoot = mkdtempSync(join(tmpdir(), 'factoryos-saga-evidence-'));
process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR = backupEvidenceRoot;
afterAll(() => {
  if (priorBackupEvidenceTrust === undefined) delete process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_TRUSTED_KEYS_JSON;
  else process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_TRUSTED_KEYS_JSON = priorBackupEvidenceTrust;
  if (priorBackupEvidenceRoot === undefined) delete process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR;
  else process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR = priorBackupEvidenceRoot;
  rmSync(backupEvidenceRoot, { recursive: true, force: true });
});
const backupEvidenceTrust = JSON.stringify([{
  keyId: backupEvidenceKeyId,
  ownerReference: backupEvidenceOwner,
  publicKeyPem: backupEvidencePublicKey.export({ type: 'spki', format: 'pem' }).toString(),
}]);
function signBackupCopyClassRow(row: Record<string, unknown>) {
  const payload: BackupCopyClassEvidenceAttestationPayload = {
    attestationKeyId: String(row.attestation_key_id),
    attestationOwnerReference: String(row.attestation_owner_reference),
    tenantId: String(row.tenant_id),
    categoryCode: String(row.category_code),
    copyClassCode: String(row.copy_class_code),
    disposition: String(row.disposition),
    evidenceReference: String(row.evidence_reference),
    evidenceSha256: String(row.evidence_sha256),
    evidenceAt: new Date(row.evidence_at as string | Date).toISOString(),
    dataOwnerReference: String(row.data_owner_reference),
    infrastructureOwnerReference: String(row.infrastructure_owner_reference),
    policyReference: String(row.policy_reference),
    reason: String(row.reason),
  };
  row.attestation_signature = sign(
    null, Buffer.from(canonicalizeBackupCopyClassEvidenceAttestation(payload), 'utf8'), backupEvidencePrivateKey,
  ).toString('base64url');
}
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
  const storedResourceManifests: Record<string, unknown>[] = [];
  const storedResourceItems: Record<string, unknown>[] = [];
  const storedResourceEvents: Record<string, unknown>[] = [];
  let backupCopyClassRows: Record<string, unknown>[] = [];
  let operationSequence = 0;
  let firstFenceOrder = 0;
  let firstPrepareOrder = 0;
  let firstDeleteIntentOrder = 0;
  let firstEraseOrder = 0;
  let backupFenceCoordinator: { beginPropagationFence: ReturnType<typeof jest.fn>; assertFenceHeld: ReturnType<typeof jest.fn>; recordPropagationVerification: ReturnType<typeof jest.fn> };
  const adapterMocks: ReturnType<typeof createAdapter>[] = [];
  let service: SaasTenantPropagationService;

  function createAdapter(kind: (typeof REQUIRED_EXTERNAL_STORE_KINDS)[number]) {
    const adapter = {
      storeKind: kind,
      adapterKey: kind === 'BACKUP' ? 's3.tenant-backup.v1' : kind.toLowerCase().replaceAll('_', '.') + '.v1',
      adapterVersion: '1.0.0',
      isConfigured: jest.fn<(...args: unknown[]) => Promise<boolean>>(),
      prepare: jest.fn<(...args: unknown[]) => Promise<SaasExternalPropagationPlan>>(),
      erase: jest.fn<(...args: unknown[]) => Promise<{ deletedCopies: string; manifestDigest: string; providerReceiptReference: string }>>(),
      verify: jest.fn<(...args: unknown[]) => Promise<{ verifiedManifestDigest: string; residualCopies: string; residualReferences: string[]; verificationReference: string }>>(),
      recover: jest.fn<(...args: unknown[]) => Promise<void>>(),
    };
    adapter.isConfigured.mockResolvedValue(true);
    adapter.prepare.mockImplementation(async (...args: unknown[]) => {
      operationSequence += 1;
      if (firstPrepareOrder === 0) firstPrepareOrder = operationSequence;
      const input = args[0] as { target: { targetId: string } };
      const resources = [
        { resourceKind: 'OBJECT_COPY', resourceReference: 'resource.' + input.target.targetId + '.1', resourceVersionReference: null },
        { resourceKind: 'OBJECT_COPY', resourceReference: 'resource.' + input.target.targetId + '.2', resourceVersionReference: null },
      ];
      return {
        manifestDigest: digestSaasExternalPropagationResources(resources),
        plannedCopies: String(resources.length),
        planReference: 'plan.' + input.target.targetId,
        adapterVersion: '1.0.0',
        resourceClass: 'OBJECT_COPY',
        maxPageSize: 500,
        maxBatchSize: 500,
        policyVersions: { deletionPolicy: '1.0.0' },
        resources,
      };
    });
    adapter.erase.mockImplementation(async (...args: unknown[]) => {
      operationSequence += 1;
      if (firstEraseOrder === 0) firstEraseOrder = operationSequence;
      const input = args[0] as { target: { targetId: string }; plan: SaasExternalPropagationPlan };
      return { deletedCopies: input.plan.plannedCopies, manifestDigest: input.plan.manifestDigest,
        providerReceiptReference: 'receipt.' + input.target.targetId };
    });
    adapter.verify.mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as { target: { targetId: string }; plan: SaasExternalPropagationPlan };
      return { verifiedManifestDigest: input.plan.manifestDigest, residualCopies: '0',
        residualReferences: [], verificationReference: 'verify.' + input.target.targetId };
    });
    adapter.recover.mockResolvedValue(undefined);
    return adapter;
  }

  beforeEach(() => {
    process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_TRUSTED_KEYS_JSON = backupEvidenceTrust;
    process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR = backupEvidenceRoot;
    jest.resetAllMocks();
    storedReceipts.length = 0;
    storedResourceManifests.length = 0;
    storedResourceItems.length = 0;
    storedResourceEvents.length = 0;
    backupCopyClassRows = [];
    operationSequence = 0;
    firstFenceOrder = 0;
    firstPrepareOrder = 0;
    firstDeleteIntentOrder = 0;
    firstEraseOrder = 0;
    adapterMocks.length = 0;
    iam.authorize.mockResolvedValue(undefined);
    audit.recordWithClient.mockResolvedValue('audit-event');
    const targets = REQUIRED_EXTERNAL_STORE_KINDS.map((kind) => ({
      id: 'target-' + kind, tenant_id: tenant, target_id: 'target-' + kind,
      store_kind: kind, adapter_key: kind === 'BACKUP' ? 's3.tenant-backup.v1' : kind.toLowerCase().replaceAll('_', '.') + '.v1',
      config_reference: 'config.' + kind.toLowerCase().replaceAll('_', '.'),
      registration_reason: 'Reviewed fake adapter target', categories: ['BUSINESS_DATA'], required: true,
      status: 'ACTIVE', registered_by_user_id: requester, reviewed_by_user_id: reviewer,
      reviewed_at: '2026-10-20T10:00:00.000Z', review_reason: 'Approved for integration test',
      created_at: '2026-10-20T09:00:00.000Z', updated_at: '2026-10-20T10:00:00.000Z',
    }));
    const copyCoverageRows = REQUIRED_EXTERNAL_STORE_KINDS.map((kind, index) => ({
      decision_id: `16060000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      tenant_id: tenant,
      category_code: 'BUSINESS_DATA',
      store_kind: kind,
      revision: 1,
      disposition: 'SUPPORTED',
      evidence_reference: `evidence.copy-coverage.${kind.toLowerCase()}`,
      evidence_sha256: 'a'.repeat(64),
      evidence_at: new Date().toISOString(),
      data_owner_reference: `owner.data.${kind.toLowerCase()}`,
      infrastructure_owner_reference: `owner.infra.${kind.toLowerCase()}`,
      policy_reference: `policy.retention.${kind.toLowerCase()}`,
      status: 'ACCEPTED',
      submitted_by_user_id: requester,
      reviewed_by_user_id: reviewer,
      valid_until: '2099-01-01T00:00:00.000Z',
    }));
    backupCopyClassRows = REQUIRED_BACKUP_COPY_CLASSES.map((copyClass, index) => {
      const evidenceReference = `evidence.backup-copy-class.${copyClass.toLowerCase()}`;
      const evidenceBytes = Buffer.from(`Synthetic evidence pack for ${copyClass}; tenant ${tenant}; fixture v1`, 'utf8');
      writeFileSync(join(backupEvidenceRoot, evidenceReference), evidenceBytes);
      const row: Record<string, unknown> = {
        decision_id: `16070000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        tenant_id: tenant, category_code: 'BUSINESS_DATA', copy_class_code: copyClass, revision: 1,
        disposition: copyClass === 'S3_OBJECT_VERSIONS' ? 'SUPPORTED' : 'NOT_APPLICABLE',
        evidence_reference: evidenceReference, evidence_sha256: createHash('sha256').update(evidenceBytes).digest('hex'),
        evidence_at: new Date().toISOString(), data_owner_reference: `owner.data.${copyClass.toLowerCase()}`,
        infrastructure_owner_reference: backupEvidenceOwner,
        attestation_key_id: backupEvidenceKeyId, attestation_owner_reference: backupEvidenceOwner,
        policy_reference: `policy.backup.${copyClass.toLowerCase()}`,
        reason: 'Synthetic signed evidence fixture for policy-gate regression tests',
        status: 'ACCEPTED', submitted_by_user_id: requester, reviewed_by_user_id: reviewer,
        valid_until: '2099-01-01T00:00:00.000Z',
      };
      signBackupCopyClassRow(row);
      return row;
    });
    for (const kind of REQUIRED_EXTERNAL_STORE_KINDS) adapterMocks.push(createAdapter(kind));
    backupFenceCoordinator = {
      beginPropagationFence: jest.fn(async () => {
        operationSequence += 1;
        firstFenceOrder = operationSequence;
        return [];
      }),
      assertFenceHeld: jest.fn(async () => undefined),
      recordPropagationVerification: jest.fn(async () => []),
    };

    database.transaction.mockImplementation(async (...args: unknown[]) => {
      const callback = args.find((value) => typeof value === 'function') as
        ((client: unknown) => Promise<unknown>) | undefined;
      if (!callback) throw new Error('transaction callback is required');
      return callback({ query: clientQuery } as never);
    });
    database.query.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.includes('SELECT DISTINCT ON (target_id) * FROM saas_tenant_external_propagation_receipts')) {
        return { rows: [...storedReceipts] };
      }
      throw new Error('unexpected database.query SQL: ' + sql);
    });
    clientQuery.mockImplementation(async (...args: unknown[]) => {
      const sql = String(args[0]);
      const p = (args[1] ?? []) as unknown[];
      if (sql.includes('FROM tenants')) return { rows: [{ id: tenant }] };
      if (sql.includes('FROM saas_tenant_data_erasure_requests') && sql.includes('FOR UPDATE')) return { rows: [requestRow()] };
      if (sql.includes('FROM saas_tenant_external_propagation_runs') && sql.includes('idempotency_key')) return { rows: [] };
      if (sql.includes('FROM saas_tenant_data_transfers')) {
        return { rows: [{ source_manifest: { tenantId: tenant, categories: ['BUSINESS_DATA'] },
          source_bundle_digest: sourceDigest, actor_user_id: requester }] };
      }
      if (sql.includes('FROM saas_tenant_data_export_preservation_attestations')) return { rows: [{ verified_by_user_id: independentAttestor }] };
      if (sql.includes('FROM saas_tenant_data_legal_holds')) return { rows: [] };
      if (sql.includes('FROM public.saas_tenant_external_copy_coverage_decisions')) return { rows: copyCoverageRows };
      if (sql.includes('FROM public.saas_tenant_backup_copy_class_coverage_decisions')) return { rows: backupCopyClassRows };
      if (sql.includes('FROM saas_tenant_external_data_targets')) return { rows: targets };
      if (sql.includes('INSERT INTO saas_tenant_external_propagation_manifests')) {
        storedResourceManifests.push({
          tenant_id: p[0], id: p[1], request_id: p[2], run_id: p[3], request_version: p[4],
          target_id: p[5], store_kind: p[6], adapter_key: p[7], adapter_version: p[8],
          resource_class: p[9], max_page_size: p[10], max_batch_size: p[11],
          source_export_digest: p[12], manifest_digest: p[13], resource_count: p[14],
          policy_versions: JSON.parse(String(p[15])), created_by_user_id: p[16],
        });
        return { rows: [{ id: p[1] }] };
      }
      if (sql.includes('INSERT INTO saas_tenant_external_propagation_manifest_items')) {
        const manifestId = String(p[1]);
        const rows = JSON.parse(String(p[2])) as Record<string, unknown>[];
        storedResourceItems.push(...rows.map((row) => ({ ...row, tenant_id: p[0], manifest_id: manifestId })));
        return { rows: [] };
      }
      if (sql.includes("UPDATE saas_tenant_external_propagation_manifests SET state='SEALED'")) {
        return { rows: [{ id: p[1] }] };
      }
      if (sql.includes('INSERT INTO saas_tenant_external_propagation_resource_events')) {
        const manifestId = String(p[1]);
        const outcomeCode = String(p[2]);
        if (outcomeCode === 'DELETE_REQUESTED') {
          operationSequence += 1;
          if (firstDeleteIntentOrder === 0) firstDeleteIntentOrder = operationSequence;
        }
        const items = storedResourceItems.filter((item) => item.manifest_id === manifestId);
        storedResourceEvents.push(...items.map((item) => ({
          manifest_id: manifestId,
          resource_ordinal: item.resource_ordinal,
          resource_identity_digest: item.resource_identity_digest,
          outcome_code: outcomeCode,
          provider_receipt_reference: p[3],
          verification_reference: p[4],
          verified_manifest_digest: p[5],
          residual_count: p[6],
          failure_code: p[7],
          residual_reason: p[8],
        })));
        return { rows: [{ inserted_count: items.length }] };
      }
      if (sql.includes('INSERT INTO saas_tenant_external_propagation_runs')) {
        const manifest = JSON.parse(String(p[6])) as Record<string, unknown>;
        return { rows: [{
          run_id: p[1], request_id: p[2], request_version: p[3], status: 'RUNNING', categories: p[4],
          source_export_digest: p[5], external_manifest: manifest, target_count: p[7],
          verified_targets: 0, planned_copies: '0', deleted_copies: '0', residual_copies: '0',
          reason: p[8], idempotency_key: p[9], request_hash: p[10], executor_user_id: p[11],
          failure_code: null, manifest_digest: null, finished_at: null,
        }] };
      }
      if (sql.includes('SELECT DISTINCT ON (target_id) * FROM saas_tenant_external_propagation_receipts')) return { rows: [...storedReceipts] };
      if (sql.includes('UPDATE saas_tenant_external_propagation_runs SET external_manifest')) return { rows: [{ run_id: p[2] }] };
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
        return { rows: [{
          run_id: p[2], status: p[3], external_manifest: manifest, manifest_digest: p[5],
          target_count: p[6], verified_targets: p[7], planned_copies: p[8], deleted_copies: p[9],
          residual_copies: p[10], failure_code: p[11], request_hash: 'd'.repeat(64),
          request_id: requestId, request_version: 1,
        }] };
      }
      if (sql.includes("UPDATE saas_tenant_data_erasure_requests") && sql.includes("status='VERIFIED'")) {
        return { rows: [{
          ...requestRow(), status: 'VERIFIED', row_version: 5, propagation_run_id: p[2],
          propagation_manifest_digest: p[3], propagation_verified_at: '2026-10-20T12:00:00.000Z',
        }] };
      }
      throw new Error('unexpected transaction SQL: ' + sql);
    });
    service = new SaasTenantPropagationService(database as never, iam as never, audit as never, new BackupCopyClassEvidenceArtifactReader(), adapterMocks as never, backupFenceCoordinator as never);
  });

  it('fails closed when a backup copy class is unresolved', async () => {
    const wal = backupCopyClassRows.find((row) => row.copy_class_code === 'POSTGRESQL_WAL_PITR');
    if (!wal) throw new Error('WAL/PITR copy-class fixture is missing');
    wal.disposition = 'UNRESOLVED';
    signBackupCopyClassRow(wal);
    await expect(service.propagateErasure(tenant, propagationExecutor, requestId, {
      expected_version: 4, reason: 'Unresolved WAL/PITR must block whole-tenant erasure',
      idempotency_key: 'external-propagation-wal-unresolved',
    })).rejects.toThrow('Unresolved backup copy class blocks whole-tenant erasure');
    expect(adapterMocks.every((adapter) => adapter.prepare.mock.calls.length === 0)).toBe(true);
    expect(adapterMocks.every((adapter) => adapter.erase.mock.calls.length === 0)).toBe(true);
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes('INSERT INTO saas_tenant_external_propagation_runs'))).toBe(false);
  });

  it('blocks propagation when the previously trusted evidence signing key is removed', async () => {
    process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_TRUSTED_KEYS_JSON = '[]';
    await expect(service.propagateErasure(tenant, propagationExecutor, requestId, {
      expected_version: 4, reason: 'A removed signing key must invalidate accepted evidence',
      idempotency_key: 'external-propagation-revoked-evidence-key',
    })).rejects.toThrow('trusted-key configuration is invalid');
    expect(adapterMocks.every((adapter) => adapter.prepare.mock.calls.length === 0)).toBe(true);
    expect(adapterMocks.every((adapter) => adapter.erase.mock.calls.length === 0)).toBe(true);
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes('INSERT INTO saas_tenant_external_propagation_runs'))).toBe(false);
  });

  it('blocks propagation when an accepted evidence signature has been tampered with', async () => {
    const first = backupCopyClassRows[0];
    const signature = String(first?.attestation_signature ?? '');
    if (!signature) throw new Error('Signed backup copy-class fixture is missing a signature');
    first!.attestation_signature = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    await expect(service.propagateErasure(tenant, propagationExecutor, requestId, {
      expected_version: 4, reason: 'A tampered source-owner signature must block provider execution',
      idempotency_key: 'external-propagation-tampered-evidence-signature',
    })).rejects.toThrow('attestation is invalid or its signer is no longer trusted');
    expect(adapterMocks.every((adapter) => adapter.prepare.mock.calls.length === 0)).toBe(true);
    expect(adapterMocks.every((adapter) => adapter.erase.mock.calls.length === 0)).toBe(true);
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes('INSERT INTO saas_tenant_external_propagation_runs'))).toBe(false);
  });

  it('fails closed when a prepared plan was produced by a different adapter version', async () => {
    adapterMocks[0]!.prepare.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as { target: { targetId: string } };
      const resources = [
        { resourceKind: 'OBJECT_COPY', resourceReference: 'resource.' + input.target.targetId + '.1', resourceVersionReference: null },
        { resourceKind: 'OBJECT_COPY', resourceReference: 'resource.' + input.target.targetId + '.2', resourceVersionReference: null },
      ];
      return {
        manifestDigest: digestSaasExternalPropagationResources(resources),
        plannedCopies: String(resources.length),
        planReference: 'plan.' + input.target.targetId,
        adapterVersion: '2.0.0',
        resourceClass: 'OBJECT_COPY',
        maxPageSize: 500,
        maxBatchSize: 500,
        policyVersions: { deletionPolicy: '1.0.0' },
        resources,
      };
    });

    const result = await service.propagateErasure(tenant, propagationExecutor, requestId, {
      expected_version: 4, reason: 'Reject stale adapter execution contract', idempotency_key: 'external-propagation-version-mismatch',
    });

    expect(result).toMatchObject({ wholeTenantErasureVerified: false, request: { status: 'PROPAGATION_PENDING' },
      run: { status: 'PARTIAL', residualCopies: '2' } });
    expect(adapterMocks[0]!.erase).not.toHaveBeenCalled();
    expect(adapterMocks[0]!.verify).not.toHaveBeenCalled();
    expect(storedResourceManifests.some((manifest) => manifest.target_id === 'target-OBJECT_STORAGE')).toBe(false);
  });

  it('fails closed before any inventory when backup writer-fence acquisition fails', async () => {
    backupFenceCoordinator.beginPropagationFence.mockImplementationOnce(async () => {
      operationSequence += 1;
      firstFenceOrder = operationSequence;
      throw new Error('provider policy read-back unavailable');
    });
    await expect(service.propagateErasure(tenant, propagationExecutor, requestId, {
      expected_version: 4, reason: 'Require backup fence before inventory', idempotency_key: 'external-propagation-fence-fails',
    })).rejects.toThrow('provider policy read-back unavailable');
    expect(firstFenceOrder).toBeGreaterThan(0);
    for (const adapter of adapterMocks) {
      expect(adapter.prepare).not.toHaveBeenCalled();
      expect(adapter.erase).not.toHaveBeenCalled();
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
    expect(storedResourceManifests).toHaveLength(REQUIRED_EXTERNAL_STORE_KINDS.length);
    expect(storedResourceItems).toHaveLength(REQUIRED_EXTERNAL_STORE_KINDS.length * 2);
    expect(storedResourceEvents.filter((event) => event.outcome_code === 'PREPARED')).toHaveLength(REQUIRED_EXTERNAL_STORE_KINDS.length * 2);
    expect(storedResourceEvents.filter((event) => event.outcome_code === 'DELETE_REQUESTED')).toHaveLength(REQUIRED_EXTERNAL_STORE_KINDS.length * 2);
    expect(storedResourceEvents.filter((event) => event.outcome_code === 'DELETED')).toHaveLength(REQUIRED_EXTERNAL_STORE_KINDS.length * 2);
    expect(storedResourceEvents.filter((event) => event.outcome_code === 'VERIFIED')).toHaveLength(REQUIRED_EXTERNAL_STORE_KINDS.length * 2);
    expect(backupFenceCoordinator.beginPropagationFence).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: tenant, requestId, requestVersion: 1, sourceExportDigest: sourceDigest,
      categories: ['BUSINESS_DATA'], actorUserId: propagationExecutor,
    }));
    expect(backupFenceCoordinator.recordPropagationVerification).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: tenant, categories: ['BUSINESS_DATA'], residualCopies: 0,
    }));
    expect(firstFenceOrder).toBeGreaterThan(0);
    expect(firstPrepareOrder).toBeGreaterThan(firstFenceOrder);
    expect(firstDeleteIntentOrder).toBeGreaterThan(0);
    expect(firstEraseOrder).toBeGreaterThan(firstDeleteIntentOrder);
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
