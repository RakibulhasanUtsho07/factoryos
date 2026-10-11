import { jest } from '@jest/globals';
import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { REQUIRED_TRANSFER_CATEGORIES, SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';
import { SaasTenantDataTransferWorkerService } from './saas-tenant-data-transfer.worker';
import { SaasTenantTransferDatasetSource, SaasTenantMigrationTargetAdapter } from './saas-tenant-data-transfer.adapters';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const actorUserId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const exportId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const migrationId = '34f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const digest = 'a'.repeat(64);
const manifest = Object.fromEntries(REQUIRED_TRANSFER_CATEGORIES.map((category) => [
  category, { record_count: 1, sha256: digest },
]));

function migrationSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: migrationId,
    transferId: migrationId,
    tenantId,
    version: 1,
    operationType: 'MIGRATION',
    status: 'VALIDATED',
    sourceSchemaVersion: '1.0.0',
    targetSchemaVersion: '2.0.0',
    compatibilityRuleKey: 'SCHEMA-001',
    compatibilityRuleVersion: 1,
    compatibilityDecision: 'COMPATIBLE',
    requiredCategories: [...REQUIRED_TRANSFER_CATEGORIES],
    sourceTransferId: exportId,
    sourceTransferVersion: 2,
    sourceBundleReference: null,
    sourceBundleDigest: null,
    sourceManifest: {},
    targetBundleReference: null,
    targetBundleDigest: null,
    targetManifest: {},
    preservationVerified: false,
    versionIdempotencyKey: 'migration-create',
    reason: 'test migration',
    ...overrides,
  };
}

function sourceSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: exportId,
    transferId: exportId,
    tenantId,
    version: 2,
    operationType: 'EXPORT',
    status: 'COMPLETED',
    sourceSchemaVersion: '1.0.0',
    targetSchemaVersion: null,
    compatibilityRuleKey: null,
    compatibilityRuleVersion: null,
    compatibilityDecision: null,
    requiredCategories: [...REQUIRED_TRANSFER_CATEGORIES],
    sourceTransferId: null,
    sourceTransferVersion: null,
    sourceBundleReference: 'bundle-11111111-1111-4111-8111-111111111111.fosx',
    sourceBundleDigest: digest,
    sourceManifest: manifest,
    targetBundleReference: null,
    targetBundleDigest: null,
    targetManifest: {},
    preservationVerified: false,
    versionIdempotencyKey: 'export-attest',
    reason: 'test export',
    ...overrides,
  };
}


function createSnapshotSource(
  readDataset: (category: SaasTransferDatasetCategory) => AsyncIterable<unknown>,
): SaasTenantTransferDatasetSource {
  return {
    async withSnapshot<T>(
      _tenantId: string,
      _schemaVersion: string,
      callback: (snapshot: { readDataset(category: SaasTransferDatasetCategory): AsyncIterable<unknown> }) => Promise<T>,
    ): Promise<T> {
      return callback({ readDataset });
    },
  };
}

describe('SaasTenantDataTransferWorkerService', () => {
  const transfers = {
    history: jest.fn<(...args: unknown[]) => Promise<unknown[]>>(),
    attestExport: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    transitionMigration: jest.fn<(...args: unknown[]) => Promise<{ transfer: Record<string, unknown> }>>(),
  };
  const bundles = {
    put: jest.fn<(...args: unknown[]) => Promise<{ reference: string; digest: string; bytes: number }>>(),
    read: jest.fn<(...args: unknown[]) => AsyncIterable<Buffer>>(),
    remove: jest.fn<(...args: unknown[]) => Promise<void>>(),
  };
  let worker: SaasTenantDataTransferWorkerService;

  beforeEach(() => {
    jest.resetAllMocks();
    bundles.put.mockImplementation(async (chunks: unknown) => {
      let content = '';
      for await (const chunk of chunks as AsyncIterable<Buffer | string>) {
        content += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      }
      capturedExport = content;
      return { reference: 'bundle-22222222-2222-4222-8222-222222222222.fosx', digest, bytes: Buffer.byteLength(content) };
    });
    bundles.read.mockImplementation(async function* () {
      yield Buffer.from('{"format":"FACTORYOS_TENANT_EXPORT"}');
    });
    bundles.remove.mockResolvedValue(undefined);
    transfers.history.mockResolvedValue([]);
    transfers.attestExport.mockResolvedValue({ transfer: { status: 'COMPLETED', version: 2 } });
    transfers.transitionMigration.mockResolvedValue({ transfer: { ...migrationSnapshot({ status: 'IN_PROGRESS', version: 2 }) } });
    capturedExport = '';
    worker = new SaasTenantDataTransferWorkerService(transfers as never, bundles as never);
  });

  let capturedExport = '';

  it('fails closed when there are no category source adapters', async () => {
    await expect(worker.processExport(tenantId, actorUserId, exportId))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(transfers.history).not.toHaveBeenCalled();
    expect(bundles.put).not.toHaveBeenCalled();
  });

  it('writes a streamed deterministic manifest then attests only the encrypted bundle', async () => {
    const source = createSnapshotSource(async function* (category) {
      yield { b: 2, a: 1, category };
    });
    worker = new SaasTenantDataTransferWorkerService(
      transfers as never,
      bundles as never,
      source,
    );
    transfers.history.mockResolvedValueOnce([sourceSnapshot({
      version: 1,
      status: 'REQUESTED',
      sourceBundleReference: null,
      sourceBundleDigest: null,
      sourceManifest: {},
    })]);

    const result = await worker.processExport(tenantId, actorUserId, exportId) as {
      transfer: { status: string };
      artifact: { reference: string; digest: string; encryption: string };
    };
    const payload = JSON.parse(capturedExport) as {
      tenantId: string;
      format: string;
      datasets: Record<string, Array<Record<string, unknown>>>;
      manifest: Record<string, { record_count: number; sha256: string }>;
    };
    expect(payload.tenantId).toBe(tenantId);
    expect(payload.format).toBe('FACTORYOS_TENANT_EXPORT');
    expect(Object.keys(payload.datasets)).toHaveLength(REQUIRED_TRANSFER_CATEGORIES.length);
    expect(payload.datasets.AUDIT_LOG[0]).toEqual({
      a: 1,
      b: 2,
      category: SaasTransferDatasetCategory.AUDIT_LOG,
    });
    expect(payload.manifest.AUDIT_LOG.record_count).toBe(1);
    expect(payload.manifest.AUDIT_LOG.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.transfer.status).toBe('COMPLETED');
    expect(result.artifact.encryption).toBe('AES-256-GCM');
    expect(transfers.attestExport).toHaveBeenCalledWith(
      tenantId,
      actorUserId,
      exportId,
      expect.objectContaining({
        expected_version: 1,
        bundle_reference: result.artifact.reference,
        bundle_digest: digest,
      }),
    );
  });

  it('removes a newly written bundle if the transfer ledger refuses to attest it', async () => {
    const source = createSnapshotSource(async function* () { yield { id: 'safe' }; });
    worker = new SaasTenantDataTransferWorkerService(transfers as never, bundles as never, source);
    transfers.history.mockResolvedValueOnce([sourceSnapshot({
      version: 1, status: 'REQUESTED', sourceBundleReference: null, sourceBundleDigest: null, sourceManifest: {},
    })]);
    transfers.attestExport.mockRejectedValueOnce(new ConflictException('stale transfer version'));
    await expect(worker.processExport(tenantId, actorUserId, exportId)).rejects.toBeInstanceOf(ConflictException);
    expect(bundles.remove).toHaveBeenCalledWith('bundle-22222222-2222-4222-8222-222222222222.fosx');
  });

  it('fails closed when no tenant migration target adapter is registered', async () => {
    await expect(worker.processMigration(tenantId, actorUserId, migrationId))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(transfers.history).not.toHaveBeenCalled();
  });

  it('streams a verified source bundle to the target adapter and records migration completion', async () => {
    const importedText: string[] = [];
    const target: SaasTenantMigrationTargetAdapter = {
      async importBundle(input) {
        for await (const chunk of input.sourceBundle) importedText.push(chunk.toString('utf8'));
        return {
          targetBundleReference: 'target-snapshot-001',
          targetBundleDigest: 'c'.repeat(64),
          targetManifest: manifest,
        };
      },
    };
    worker = new SaasTenantDataTransferWorkerService(
      transfers as never,
      bundles as never,
      undefined,
      target,
    );
    transfers.history.mockResolvedValueOnce([migrationSnapshot()]).mockResolvedValueOnce([sourceSnapshot()]);
    transfers.transitionMigration
      .mockResolvedValueOnce({ transfer: migrationSnapshot({ status: 'IN_PROGRESS', version: 2 }) })
      .mockResolvedValueOnce({ transfer: migrationSnapshot({ status: 'COMPLETED', version: 3 }) });

    const completed = await worker.processMigration(tenantId, actorUserId, migrationId);
    expect(importedText.join('')).toContain('FACTORYOS_TENANT_EXPORT');
    expect(transfers.transitionMigration).toHaveBeenNthCalledWith(
      1,
      tenantId,
      actorUserId,
      migrationId,
      expect.objectContaining({ action: 'START', expected_version: 1 }),
    );
    expect(transfers.transitionMigration).toHaveBeenNthCalledWith(
      2,
      tenantId,
      actorUserId,
      migrationId,
      expect.objectContaining({
        action: 'COMPLETE',
        expected_version: 2,
        target_bundle_reference: 'target-snapshot-001',
        preservation_verified: true,
      }),
    );
    expect(completed.transfer.status).toBe('COMPLETED');
  });

  it('rejects any dataset row whose explicit tenant scope differs from the authenticated tenant', async () => {
    const source = createSnapshotSource(async function* () {
      yield { tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', id: 'foreign-row' };
    });
    worker = new SaasTenantDataTransferWorkerService(transfers as never, bundles as never, source);
    transfers.history.mockResolvedValueOnce([sourceSnapshot({
      version: 1, status: 'REQUESTED', sourceBundleReference: null, sourceBundleDigest: null, sourceManifest: {},
    })]);
    await expect(worker.processExport(tenantId, actorUserId, exportId)).rejects.toBeInstanceOf(BadRequestException);
    expect(transfers.attestExport).not.toHaveBeenCalled();
  });

  it('rejects accidental credential/secret fields in a dataset adapter response', async () => {
    const source = createSnapshotSource(async function* () {
      yield { id: 'customer-1', client_secret: 'do-not-export' };
    });
    worker = new SaasTenantDataTransferWorkerService(transfers as never, bundles as never, source);
    transfers.history.mockResolvedValueOnce([sourceSnapshot({
      version: 1, status: 'REQUESTED', sourceBundleReference: null, sourceBundleDigest: null, sourceManifest: {},
    })]);
    await expect(worker.processExport(tenantId, actorUserId, exportId)).rejects.toBeInstanceOf(BadRequestException);
    expect(transfers.attestExport).not.toHaveBeenCalled();
  });

  it('rejects an unsupported export category before reading any dataset', async () => {
    const source = {
      withSnapshot: jest.fn(async (_tenant: string, _schema: string, callback: (snapshot: { readDataset: () => AsyncIterable<unknown> }) => Promise<unknown>) =>
        callback({ readDataset: jest.fn(async function* () { yield { id: 'unused' }; }) })),
    };
    worker = new SaasTenantDataTransferWorkerService(transfers as never, bundles as never, source);
    transfers.history.mockResolvedValueOnce([sourceSnapshot({
      version: 1,
      status: 'REQUESTED',
      requiredCategories: [...REQUIRED_TRANSFER_CATEGORIES, 'UNSUPPORTED'],
      sourceBundleReference: null,
      sourceBundleDigest: null,
      sourceManifest: {},
    })]);
    await expect(worker.processExport(tenantId, actorUserId, exportId)).rejects.toBeInstanceOf(BadRequestException);
    expect(bundles.put).not.toHaveBeenCalled();
  });
});
