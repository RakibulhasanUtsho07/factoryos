import { jest } from '@jest/globals';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { CreateSaasSchemaCompatibilityRuleDto, REQUIRED_TRANSFER_CATEGORIES, SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';
import { SaasTransferDatasetDigest } from './dto/attest-saas-tenant-export.dto';
import { SaasTenantMigrationAction, TransitionSaasTenantMigrationDto } from './dto/transition-saas-tenant-migration.dto';
import { SaasTenantDataTransferService } from './saas-tenant-data-transfer.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const actorUserId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const transferId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const bundleDigest = 'a'.repeat(64);
const datasetManifest = Object.fromEntries(REQUIRED_TRANSFER_CATEGORIES.map((category) => [
  category,
  { record_count: 4, sha256: bundleDigest },
])) as Record<string, SaasTransferDatasetDigest>;

function transferRow(overrides: Record<string, unknown> = {}) {
  return {
    id: transferId,
    tenant_id: tenantId,
    transfer_id: transferId,
    version: '2',
    operation_type: 'EXPORT',
    status: 'COMPLETED',
    source_schema_version: '1.0.0',
    target_schema_version: null,
    compatibility_rule_key: null,
    compatibility_rule_version: null,
    compatibility_decision: null,
    required_categories: [...REQUIRED_TRANSFER_CATEGORIES],
    source_transfer_id: null,
    source_transfer_version: null,
    source_bundle_reference: 'bundle-export-001',
    source_bundle_digest: bundleDigest,
    source_manifest: datasetManifest,
    target_bundle_reference: null,
    target_bundle_digest: null,
    target_manifest: {},
    preservation_verified: false,
    reason: 'unit test transfer',
    idempotency_key: 'transfer-idempotency',
    request_hash: 'b'.repeat(64),
    actor_user_id: actorUserId,
    created_at: '2026-10-11T12:00:00.000Z',
    ...overrides,
  };
}

describe('SaasTenantDataTransferService', () => {
  const clientQuery = jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();
  const database = {
    query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(),
    transaction: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const iam = { authorize: jest.fn<(...args: unknown[]) => Promise<void>>() };
  const audit = { record: jest.fn<(...args: unknown[]) => Promise<unknown>>() };
  let service: SaasTenantDataTransferService;

  beforeEach(() => {
    jest.resetAllMocks();
    iam.authorize.mockResolvedValue(undefined);
    audit.record.mockResolvedValue(undefined);
    database.transaction.mockImplementation(async (...args: unknown[]) => {
      const callback = args.find((item) => typeof item === 'function') as (client: unknown) => Promise<unknown>;
      return callback({ query: clientQuery });
    });
    service = new SaasTenantDataTransferService(database as never, iam as never, audit as never);
  });

  it('rejects a malformed source schema version before touching the database', async () => {
    await expect(service.createExport(tenantId, actorUserId, {
      source_schema_version: 'latest',
      reason: 'bad source schema version',
      idempotency_key: 'bad-schema-version',
    } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('fails closed if IAM denies schema compatibility administration', async () => {
    iam.authorize.mockRejectedValueOnce(new ForbiddenException('permission denied'));
    await expect(service.registerCompatibilityRule(tenantId, actorUserId, {
      source_schema_version: '1.0.0',
      target_schema_version: '2.0.0',
      decision: 'COMPATIBLE',
      required_categories: [...REQUIRED_TRANSFER_CATEGORIES],
      reason: 'unauthorized rule',
      idempotency_key: 'rule-denied',
    } as CreateSaasSchemaCompatibilityRuleDto)).rejects.toBeInstanceOf(ForbiddenException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires a mapping reference when a schema rule requires transformation', async () => {
    await expect(service.registerCompatibilityRule(tenantId, actorUserId, {
      source_schema_version: '1.0.0',
      target_schema_version: '2.0.0',
      decision: 'TRANSFORM_REQUIRED',
      required_categories: [...REQUIRED_TRANSFER_CATEGORIES],
      reason: 'missing mapping',
      idempotency_key: 'transform-mapping-missing',
    } as CreateSaasSchemaCompatibilityRuleDto)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('forces core business, audit, evidence, approval, and effective-dated data into export scopes', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [{ id: tenantId }] });
    clientQuery.mockResolvedValueOnce({ rows: [] });
    clientQuery.mockResolvedValueOnce({ rows: [{ id: transferId }] });
    clientQuery.mockResolvedValueOnce({ rows: [transferRow({
      version: '1',
      status: 'REQUESTED',
      source_bundle_reference: null,
      source_bundle_digest: null,
      source_manifest: {},
      idempotency_key: 'tenant-export-request',
    })] });
    const result = await service.createExport(tenantId, actorUserId, {
      source_schema_version: '1.0.0',
      reason: 'approved tenant export',
      idempotency_key: 'tenant-export-request',
    });
    expect(result.transfer.operationType).toBe('EXPORT');
    expect(result.transfer.requiredCategories).toEqual([...REQUIRED_TRANSFER_CATEGORIES].sort());
    expect(result.transfer.status).toBe('REQUESTED');
  });

  it('rejects an export manifest that omits an approval or evidence category', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [{ id: tenantId }] });
    clientQuery.mockResolvedValueOnce({ rows: [] });
    clientQuery.mockResolvedValueOnce({ rows: [transferRow({
      version: '1',
      status: 'REQUESTED',
      source_bundle_reference: null,
      source_bundle_digest: null,
      source_manifest: {},
    })] });
    const incompleteManifest = { ...datasetManifest };
    delete incompleteManifest[ SaasTransferDatasetCategory.APPROVALS ];
    await expect(service.attestExport(tenantId, actorUserId, transferId, {
      expected_version: 1,
      bundle_reference: 'bundle-export-001',
      bundle_digest: bundleDigest,
      dataset_manifest: incompleteManifest,
      reason: 'incomplete export',
      idempotency_key: 'export-attest-incomplete',
    } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(clientQuery).toHaveBeenCalledTimes(3);
  });

  it('creates a durable BLOCKED migration when no exact schema compatibility rule exists', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [{ id: tenantId }] });
    clientQuery.mockResolvedValueOnce({ rows: [] });
    clientQuery.mockResolvedValueOnce({ rows: [transferRow()] });
    clientQuery.mockResolvedValueOnce({ rows: [] });
    clientQuery.mockResolvedValueOnce({ rows: [{ id: transferId }] });
    clientQuery.mockResolvedValueOnce({ rows: [transferRow({
      transfer_id: '34f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
      operation_type: 'MIGRATION',
      status: 'BLOCKED',
      target_schema_version: '2.0.0',
      compatibility_decision: 'INCOMPATIBLE',
      source_transfer_id: transferId,
      source_transfer_version: '2',
      idempotency_key: 'migration-validation',
    })] });
    const result = await service.validateMigration(tenantId, actorUserId, {
      source_transfer_id: transferId,
      target_schema_version: '2.0.0',
      reason: 'no rule should fail closed',
      idempotency_key: 'migration-validation',
    });
    expect(result.transfer.status).toBe('BLOCKED');
    expect(result.transfer.compatibilityDecision).toBe('INCOMPATIBLE');
  });

  it('rejects stale migration versions before attaching target artifacts', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [{ id: tenantId }] });
    clientQuery.mockResolvedValueOnce({ rows: [] });
    clientQuery.mockResolvedValueOnce({ rows: [transferRow({
      operation_type: 'MIGRATION',
      status: 'IN_PROGRESS',
      target_schema_version: '2.0.0',
      compatibility_decision: 'COMPATIBLE',
      source_transfer_id: '34f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
      source_transfer_version: '2',
      version: '2',
    })] });
    await expect(service.transitionMigration(tenantId, actorUserId, transferId, {
      action: SaasTenantMigrationAction.COMPLETE,
      expected_version: 1,
      target_bundle_reference: 'bundle-target-001',
      target_bundle_digest: bundleDigest,
      target_manifest: datasetManifest,
      preservation_verified: true,
      reason: 'stale version',
      idempotency_key: 'migration-complete-stale',
    } as TransitionSaasTenantMigrationDto)).rejects.toBeInstanceOf(ConflictException);
    expect(clientQuery).toHaveBeenCalledTimes(3);
  });

  it('does not complete a migration if audit, evidence, approvals, or effective-dated counts differ', async () => {
    const targetManifest = Object.fromEntries(REQUIRED_TRANSFER_CATEGORIES.map((category) => [
      category,
      { record_count: category === SaasTransferDatasetCategory.AUDIT_LOG ? 3 : 4, sha256: 'c'.repeat(64) },
    ])) as Record<string, SaasTransferDatasetDigest>;
    clientQuery.mockResolvedValueOnce({ rows: [{ id: tenantId }] });
    clientQuery.mockResolvedValueOnce({ rows: [] });
    clientQuery.mockResolvedValueOnce({ rows: [transferRow({
      operation_type: 'MIGRATION',
      status: 'IN_PROGRESS',
      target_schema_version: '2.0.0',
      compatibility_decision: 'COMPATIBLE',
      source_transfer_id: '34f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
      source_transfer_version: '2',
      version: '2',
    })] });
    await expect(service.transitionMigration(tenantId, actorUserId, transferId, {
      action: SaasTenantMigrationAction.COMPLETE,
      expected_version: 2,
      target_bundle_reference: 'bundle-target-001',
      target_bundle_digest: 'c'.repeat(64),
      target_manifest: targetManifest,
      preservation_verified: true,
      reason: 'audit count changed',
      idempotency_key: 'migration-complete-count-mismatch',
    } as TransitionSaasTenantMigrationDto)).rejects.toBeInstanceOf(ConflictException);
    expect(clientQuery).toHaveBeenCalledTimes(3);
  });

  it('requires all requested dataset categories in every worker-attested manifest', async () => {
    const manifest = { ...datasetManifest, unsupported: { record_count: 1, sha256: 'd'.repeat(64) } };
    clientQuery.mockResolvedValueOnce({ rows: [{ id: tenantId }] });
    clientQuery.mockResolvedValueOnce({ rows: [] });
    clientQuery.mockResolvedValueOnce({ rows: [transferRow({
      version: '1',
      status: 'REQUESTED',
      source_bundle_reference: null,
      source_bundle_digest: null,
      source_manifest: {},
    })] });
    await expect(service.attestExport(tenantId, actorUserId, transferId, {
      expected_version: 1,
      bundle_reference: 'bundle-export-001',
      bundle_digest: bundleDigest,
      dataset_manifest: manifest,
      reason: 'unsupported category',
      idempotency_key: 'export-attest-invalid-category',
    } as never)).rejects.toBeInstanceOf(BadRequestException);
  });
});
