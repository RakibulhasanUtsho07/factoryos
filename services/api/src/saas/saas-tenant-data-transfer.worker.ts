import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  REQUIRED_TRANSFER_CATEGORIES,
  SaasTransferDatasetCategory,
} from './dto/create-saas-schema-compatibility-rule.dto';
import { SaasTenantMigrationAction } from './dto/transition-saas-tenant-migration.dto';
import { SaasTenantDataTransferService } from './saas-tenant-data-transfer.service';
import {
  SAAS_ENCRYPTED_TENANT_BUNDLE_STORE,
  SAAS_TENANT_MIGRATION_TARGET_ADAPTER,
  SAAS_TENANT_TRANSFER_DATASET_SOURCE,
} from './saas-tenant-data-transfer.adapters';
import type {
  SaasTenantEncryptedBundleStore,
  SaasTenantMigrationTargetAdapter,
  SaasTenantTransferDatasetSource,
  SaasTenantTransferExportManifest,
} from './saas-tenant-data-transfer.adapters';

@Injectable()
export class SaasTenantDataTransferWorkerService {
  constructor(
    private readonly transfers: SaasTenantDataTransferService,
    @Inject(SAAS_ENCRYPTED_TENANT_BUNDLE_STORE)
    private readonly bundles: SaasTenantEncryptedBundleStore,
    @Optional()
    @Inject(SAAS_TENANT_TRANSFER_DATASET_SOURCE)
    private readonly datasetSource?: SaasTenantTransferDatasetSource,
    @Optional()
    @Inject(SAAS_TENANT_MIGRATION_TARGET_ADAPTER)
    private readonly migrationTarget?: SaasTenantMigrationTargetAdapter,
  ) {}

  async processExport(tenantId: string, actorUserId: string, transferId: string) {
    if (!this.datasetSource) {
      throw new ServiceUnavailableException(
        'Tenant export is disabled because no governed dataset source adapters are registered',
      );
    }
    const history = await this.transfers.history(tenantId, actorUserId, transferId);
    const current = history[0];
    if (!current || current.operationType !== 'EXPORT') {
      throw new BadRequestException('The requested transfer is not an export');
    }
    if (current.status !== 'REQUESTED') {
      throw new ConflictException('Only a REQUESTED export can be processed');
    }

    const requiredCategories = current.requiredCategories as SaasTransferDatasetCategory[];
    const schemaVersion = current.sourceSchemaVersion as string;
    const manifest: SaasTenantTransferExportManifest = {};
    const payload = this.exportPayload(
      tenantId,
      current.transferId as string,
      schemaVersion,
      requiredCategories,
      manifest,
    );
    const stored = await this.bundles.put(payload);
    try {
      const completed = await this.transfers.attestExport(tenantId, actorUserId, current.transferId as string, {
        expected_version: Number(current.version),
        bundle_reference: stored.reference,
        bundle_digest: stored.digest,
        dataset_manifest: manifest,
        reason: 'Worker generated an encrypted, tenant-scoped bundle and verified category hashes',
        idempotency_key: this.workerKey('export', current.transferId as string, Number(current.version)),
      });
      return {
        transfer: completed.transfer,
        artifact: {
          reference: stored.reference,
          digest: stored.digest,
          bytes: stored.bytes,
          encryption: 'AES-256-GCM',
          compression: 'GZIP',
        },
      };
    } catch (error) {
      await this.bundles.remove(stored.reference).catch(() => undefined);
      throw error;
    }
  }

  async processMigration(tenantId: string, actorUserId: string, transferId: string) {
    if (!this.migrationTarget) {
      throw new ServiceUnavailableException(
        'Tenant migration is disabled because no governed target adapter is registered',
      );
    }
    const history = await this.transfers.history(tenantId, actorUserId, transferId);
    let current = history[0];
    if (!current || current.operationType !== 'MIGRATION') {
      throw new BadRequestException('The requested transfer is not a migration');
    }
    if (current.status === 'VALIDATED') {
      const started = await this.transfers.transitionMigration(tenantId, actorUserId, current.transferId as string, {
        action: SaasTenantMigrationAction.START,
        expected_version: Number(current.version),
        reason: 'Worker accepted the previously schema-validated transfer',
        idempotency_key: this.workerKey('migration-start', current.transferId as string, Number(current.version)),
      });
      current = started.transfer;
    }
    if (current.status !== 'IN_PROGRESS') {
      throw new ConflictException('Only a VALIDATED or IN_PROGRESS migration can be processed');
    }

    const migrationId = current.transferId as string;
    const sourceTransferId = current.sourceTransferId as string | null;
    if (!sourceTransferId || !current.targetSchemaVersion) {
      throw new ConflictException('Migration snapshot is missing its source export or target schema version');
    }

    try {
      const sourceHistory = await this.transfers.history(tenantId, actorUserId, sourceTransferId);
      const source = sourceHistory[0];
      if (
        !source ||
        source.operationType !== 'EXPORT' ||
        source.status !== 'COMPLETED' ||
        !source.sourceBundleReference ||
        !source.sourceBundleDigest
      ) {
        throw new ConflictException('Migration source must be a completed export with an attested encrypted bundle');
      }

      const result = await this.migrationTarget.importBundle({
        tenantId,
        transferId: migrationId,
        sourceSchemaVersion: current.sourceSchemaVersion as string,
        targetSchemaVersion: current.targetSchemaVersion as string,
        sourceBundle: this.bundles.read(source.sourceBundleReference as string, source.sourceBundleDigest as string),
        sourceManifest: source.sourceManifest as SaasTenantTransferExportManifest,
        requiredCategories: current.requiredCategories as SaasTransferDatasetCategory[],
      });
      const completed = await this.transfers.transitionMigration(tenantId, actorUserId, migrationId, {
        action: SaasTenantMigrationAction.COMPLETE,
        expected_version: Number(current.version),
        target_bundle_reference: result.targetBundleReference,
        target_bundle_digest: result.targetBundleDigest,
        target_manifest: result.targetManifest,
        preservation_verified: true,
        reason: 'Target adapter verified the imported target bundle and preservation manifest',
        idempotency_key: this.workerKey('migration-complete', migrationId, Number(current.version)),
      });
      return completed;
    } catch (error) {
      // Record failure without leaking source data or provider error payloads into the audit ledger.
      try {
        await this.transfers.transitionMigration(tenantId, actorUserId, migrationId, {
          action: SaasTenantMigrationAction.FAIL,
          expected_version: Number(current.version),
          reason: 'Worker import failed; inspect the restricted target-adapter logs',
          idempotency_key: this.workerKey('migration-failed', migrationId, Number(current.version)),
        });
      } catch {
        // Do not mask the original error; the ledger guard prevents stale failure transitions.
      }
      throw error;
    }
  }

  private async *exportPayload(
    tenantId: string,
    transferId: string,
    schemaVersion: string,
    categories: SaasTransferDatasetCategory[],
    manifest: SaasTenantTransferExportManifest,
  ): AsyncIterable<Buffer> {
    const uniqueCategories = [...new Set(categories)];
    const required = REQUIRED_TRANSFER_CATEGORIES as readonly SaasTransferDatasetCategory[];
    if (required.some((category) => !uniqueCategories.includes(category))) {
      throw new BadRequestException('Export snapshot does not include the mandatory preservation categories');
    }
    if (uniqueCategories.some((category) => !Object.values(SaasTransferDatasetCategory).includes(category))) {
      throw new BadRequestException('Export snapshot contains an unsupported dataset category');
    }

    const header = JSON.stringify({
      format: 'FACTORYOS_TENANT_EXPORT',
      formatVersion: 1,
      tenantId,
      transferId,
      schemaVersion,
      createdAt: new Date().toISOString(),
    });
    yield Buffer.from(header.slice(0, -1) + ',"datasets":{', 'utf8');

    for (let categoryIndex = 0; categoryIndex < uniqueCategories.length; categoryIndex += 1) {
      const category = uniqueCategories[categoryIndex];
      if (categoryIndex > 0) yield Buffer.from(',', 'utf8');
      yield Buffer.from(JSON.stringify(category) + ':[', 'utf8');

      const categoryHash = createHash('sha256');
      let count = 0;
      for await (const row of this.datasetSource!.readDataset(tenantId, schemaVersion, category)) {
        this.assertTenantScope(row, tenantId, category);
        const canonical = this.canonicalJson(row);
        if (count > 0) yield Buffer.from(',', 'utf8');
        yield Buffer.from(canonical, 'utf8');
        categoryHash.update(canonical, 'utf8');
        categoryHash.update('\n', 'utf8');
        count += 1;
        if (!Number.isSafeInteger(count)) throw new BadRequestException('Dataset exceeds the safe manifest record-count limit');
      }
      manifest[category] = { record_count: count, sha256: categoryHash.digest('hex') };
      yield Buffer.from(']', 'utf8');
    }

    yield Buffer.from('},"manifest":' + JSON.stringify(manifest) + '}', 'utf8');
  }

  private canonicalJson(value: unknown, ancestors = new WeakSet<object>()): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value) as string;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new BadRequestException('Dataset records cannot contain non-finite numbers');
      return JSON.stringify(value);
    }
    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) throw new BadRequestException('Dataset records cannot contain invalid dates');
      return JSON.stringify(value.toISOString());
    }
    if (typeof value !== 'object' || value === undefined) {
      throw new BadRequestException('Dataset records must be JSON-compatible values');
    }
    if (ancestors.has(value)) throw new BadRequestException('Dataset records cannot contain circular references');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return '[' + value.map((item) => this.canonicalJson(item, ancestors)).join(',') + ']';
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new BadRequestException('Dataset records may contain only plain JSON objects');
      }
      const object = value as Record<string, unknown>;
      const keys = Object.keys(object).sort();
      keys.forEach((key) => this.assertExportField(key));
      return '{' + keys.map((key) => JSON.stringify(key) + ':' + this.canonicalJson(object[key], ancestors)).join(',') + '}';
    } finally {
      ancestors.delete(value);
    }
  }

  private assertTenantScope(row: unknown, tenantId: string, category: SaasTransferDatasetCategory) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    const record = row as Record<string, unknown>;
    for (const field of ['tenant_id', 'tenantId']) {
      if (Object.prototype.hasOwnProperty.call(record, field) && record[field] !== tenantId) {
        throw new BadRequestException('Dataset source returned a row outside the authenticated tenant for ' + category);
      }
    }
  }

  private assertExportField(field: string) {
    const normalized = field.replace(/([a-z0-9])([A-Z])/g, (_match, left: string, right: string) => left + '_' + right).replace(/[.-]/g, '_').toLowerCase();
    if (/^(password|password_hash|token|access_token|refresh_token|client_secret|client_token|secret|api_key|private_key|authorization|connection_string|database_url|jwt_secret|encryption_key|signing_key)$/.test(normalized)
      || /(?:^|_)(?:password|secret|access_token|refresh_token|api_key|private_key|connection_string)(?:_|$)/.test(normalized)) {
      throw new BadRequestException('Dataset source attempted to export a credential/secret field');
    }
  }

  private workerKey(operation: string, transferId: string, version: number) {
    return 'worker-' + operation + '-' + transferId + '-v' + version;
  }
}
