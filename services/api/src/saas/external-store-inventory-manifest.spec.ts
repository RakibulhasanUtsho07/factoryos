import { createHash } from 'node:crypto';
import {
  digestExternalStoreInventoryScope,
  EXTERNAL_STORE_INVENTORY_MANIFEST_SCHEMA,
  REQUIRED_EXTERNAL_INVENTORY_SOURCE_KINDS,
  validateExternalStoreInventoryManifest,
} from './external-store-inventory-manifest';

const tenant = '16000000-0000-4000-8000-000000000001';
const scope = {
  provider_references: ['provider.aws-account-001'],
  account_references: ['account.001'],
  project_references: ['project.factoryos'],
  region_references: ['region.ap-southeast-1'],
};

interface InventoryManifestFixture {
  schema: string;
  tenant_id: string;
  category_code: string;
  generated_at: string;
  scope: typeof scope;
  scope_sha256: string;
  inventory_complete: boolean;
  unclassified_store_count: number;
  discovered_store_kinds: string[];
  sources: Array<{
    source_kind: string;
    source_reference: string;
    status: string;
    pagination_exhausted: boolean;
    pages_fetched: number;
    item_count: number;
    result_sha256: string;
    scope_sha256: string;
    started_at: string;
    completed_at: string;
  }>;
}

function manifest(overrides: Partial<InventoryManifestFixture> = {}): InventoryManifestFixture {
  const now = new Date().toISOString();
  const scopeSha256 = digestExternalStoreInventoryScope(scope);
  return {
    schema: EXTERNAL_STORE_INVENTORY_MANIFEST_SCHEMA,
    tenant_id: tenant,
    category_code: 'BUSINESS_DATA',
    generated_at: now,
    scope,
    scope_sha256: scopeSha256,
    inventory_complete: true,
    unclassified_store_count: 0,
    discovered_store_kinds: ['OBJECT_STORAGE', 'CACHE', 'BACKUP'],
    sources: REQUIRED_EXTERNAL_INVENTORY_SOURCE_KINDS.map((sourceKind) => ({
      source_kind: sourceKind,
      source_reference: 'discovery.' + sourceKind.toLowerCase(),
      status: 'COMPLETE',
      pagination_exhausted: true,
      pages_fetched: 1,
      item_count: 0,
      result_sha256: createHash('sha256').update(sourceKind).digest('hex'),
      scope_sha256: scopeSha256,
      started_at: now,
      completed_at: now,
    })),
    ...overrides,
  };
}

describe('external-store inventory manifest', () => {
  it('accepts a complete, scope-bound discovery pack for the exact tenant and category', () => {
    const bytes = Buffer.from(JSON.stringify(manifest()), 'utf8');
    expect(() => validateExternalStoreInventoryManifest(bytes, tenant, 'BUSINESS_DATA')).not.toThrow();
  });

  it('rejects a tenant or category mismatch', () => {
    const bytes = Buffer.from(JSON.stringify(manifest()), 'utf8');
    expect(() => validateExternalStoreInventoryManifest(bytes, '26000000-0000-4000-8000-000000000001', 'BUSINESS_DATA'))
      .toThrow(/tenant does not match/);
    expect(() => validateExternalStoreInventoryManifest(bytes, tenant, 'AUDIT_LOG'))
      .toThrow(/category does not match/);
  });

  it('rejects missing discovery sources, incomplete pagination and duplicate sources', () => {
    const base = manifest();
    const missing = { ...base, sources: base.sources.slice(1) };
    expect(() => validateExternalStoreInventoryManifest(Buffer.from(JSON.stringify(missing)), tenant, 'BUSINESS_DATA'))
      .toThrow(/required discovery source set/);
    const partial = manifest({
      sources: base.sources.map((source, index) => index === 0
        ? { ...source, pagination_exhausted: false } : source),
    });
    expect(() => validateExternalStoreInventoryManifest(Buffer.from(JSON.stringify(partial)), tenant, 'BUSINESS_DATA'))
      .toThrow(/pagination exhausted/);
    const duplicate = manifest({
      sources: base.sources.map((source, index) => index === 0
        ? { ...source, source_kind: base.sources[1].source_kind } : source),
    });
    expect(() => validateExternalStoreInventoryManifest(Buffer.from(JSON.stringify(duplicate)), tenant, 'BUSINESS_DATA'))
      .toThrow(/duplicate or unsupported/);
  });

  it('rejects stale evidence, an unclassified store and non-catalogued store kinds', () => {
    const stale = manifest({ generated_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString() });
    expect(() => validateExternalStoreInventoryManifest(Buffer.from(JSON.stringify(stale)), tenant, 'BUSINESS_DATA'))
      .toThrow(/no more than 30 days old/);
    const unclassified = manifest({ unclassified_store_count: 1 });
    expect(() => validateExternalStoreInventoryManifest(Buffer.from(JSON.stringify(unclassified)), tenant, 'BUSINESS_DATA'))
      .toThrow(/unknown or unclassified/);
    const unknownKind = manifest({ discovered_store_kinds: ['OBJECT_STORAGE', 'NEW_UNKNOWN_STORE'] });
    expect(() => validateExternalStoreInventoryManifest(Buffer.from(JSON.stringify(unknownKind)), tenant, 'BUSINESS_DATA'))
      .toThrow(/catalogued external store kinds/);
  });

  it('rejects source results that are not bound to the declared complete scope', () => {
    const base = manifest();
    const sourceRows = base.sources.map((source, index) => index === 0
      ? { ...source, scope_sha256: 'f'.repeat(64) } : source);
    const mismatch = manifest({ sources: sourceRows });
    expect(() => validateExternalStoreInventoryManifest(Buffer.from(JSON.stringify(mismatch)), tenant, 'BUSINESS_DATA'))
      .toThrow(/bind to the complete inventory scope/);
  });
});
