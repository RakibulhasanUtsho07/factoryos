import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';
import { SaasTransferDatasetDigest } from './dto/attest-saas-tenant-export.dto';

export const SAAS_ENCRYPTED_TENANT_BUNDLE_STORE = Symbol('SAAS_ENCRYPTED_TENANT_BUNDLE_STORE');
export const SAAS_TENANT_TRANSFER_DATASET_SOURCE = Symbol('SAAS_TENANT_TRANSFER_DATASET_SOURCE');
export const SAAS_TENANT_MIGRATION_TARGET_ADAPTER = Symbol('SAAS_TENANT_MIGRATION_TARGET_ADAPTER');

export interface SaasTenantTransferDatasetSnapshot {
  readDataset(category: SaasTransferDatasetCategory): AsyncIterable<unknown>;
}

export interface SaasTenantTransferDatasetSource {
  /**
   * Run the callback against one tenant-scoped, repeatable-read snapshot.
   * The snapshot and its iterators are valid only until the callback settles.
   * Implementations must roll back if a reader is abandoned or the callback fails.
   */
  withSnapshot<T>(
    tenantId: string,
    schemaVersion: string,
    callback: (snapshot: SaasTenantTransferDatasetSnapshot) => Promise<T>,
  ): Promise<T>;
}

export interface SaasTenantTransferExportManifest {
  [category: string]: SaasTransferDatasetDigest;
}

export interface SaasTenantMigrationTargetAdapter {
  /**
   * Decrypts/reads the source bundle stream and imports it to an isolated
   * target. It returns an independently measured target manifest and durable
   * opaque backup reference; caller still verifies protected record counts.
   */
  importBundle(input: {
    tenantId: string;
    transferId: string;
    sourceSchemaVersion: string;
    targetSchemaVersion: string;
    sourceBundle: AsyncIterable<Buffer>;
    sourceManifest: SaasTenantTransferExportManifest;
    requiredCategories: SaasTransferDatasetCategory[];
  }): Promise<{
    targetBundleReference: string;
    targetBundleDigest: string;
    targetManifest: SaasTenantTransferExportManifest;
  }>;
}

export interface SaasTenantEncryptedBundleStore {
  put(chunks: AsyncIterable<Buffer | string>): Promise<{ reference: string; digest: string; bytes: number }>;
  read(reference: string, expectedDigest: string): AsyncIterable<Buffer>;
  remove(reference: string): Promise<void>;
}
