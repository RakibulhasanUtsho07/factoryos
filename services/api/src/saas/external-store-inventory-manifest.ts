import { createHash } from 'node:crypto';

export const EXTERNAL_STORE_INVENTORY_MANIFEST_SCHEMA = 'factoryos.external-store-inventory/v1';

export const REQUIRED_EXTERNAL_INVENTORY_SOURCE_KINDS = [
  'TENANT_SCOPE_CATALOG',
  'RESOURCE_TYPE_CATALOG',
  'IAM_WRITER_PRINCIPALS',
  'REPLICATION_AND_DELIVERY',
  'SCHEDULED_AND_DELAYED_WRITERS',
  'RESTORE_AND_DR_PATHS',
  'SECONDARY_EXTERNAL_STORES',
] as const;

const KNOWN_STORE_KINDS = new Set([
  'OBJECT_STORAGE', 'CACHE', 'SEARCH_INDEX', 'VECTOR_STORE',
  'LEARNING_ARTIFACT', 'EXTERNAL_PROVIDER', 'REPLICA', 'BACKUP',
]);
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface ExternalStoreInventoryScope {
  provider_references: string[];
  account_references: string[];
  project_references: string[];
  region_references: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function safeReference(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_REFERENCE.test(value) || value.includes('://')
    || /(secret|password|credential|access[-_]?key|token)/i.test(value)) {
    throw new Error(field + ' must be a non-secret opaque reference');
  }
  return value;
}

function timestamp(value: unknown, field: string, now: number): number {
  if (typeof value !== 'string' || !value.trim()) throw new Error(field + ' must be an ISO timestamp');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > now + MAX_CLOCK_SKEW_MS || parsed < now - MAX_AGE_MS) {
    throw new Error(field + ' must be current and no more than 30 days old');
  }
  return parsed;
}

function scopeReferences(value: unknown, field: keyof ExternalStoreInventoryScope): string[] {
  if (!Array.isArray(value)) throw new Error('scope.' + field + ' must be an array');
  const references = value.map((item, index) => safeReference(item, 'scope.' + field + '[' + index + ']'));
  if (new Set(references).size !== references.length) throw new Error('scope.' + field + ' must not contain duplicates');
  return references.sort();
}

export function canonicalizeExternalStoreInventoryScope(value: unknown): ExternalStoreInventoryScope {
  const source = record(value);
  if (!source) throw new Error('scope must be an object');
  const scope: ExternalStoreInventoryScope = {
    provider_references: scopeReferences(source.provider_references, 'provider_references'),
    account_references: scopeReferences(source.account_references, 'account_references'),
    project_references: scopeReferences(source.project_references, 'project_references'),
    region_references: scopeReferences(source.region_references, 'region_references'),
  };
  if (scope.provider_references.length + scope.account_references.length + scope.project_references.length === 0) {
    throw new Error('scope must identify at least one provider, account or project');
  }
  return scope;
}

export function digestExternalStoreInventoryScope(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeExternalStoreInventoryScope(value)), 'utf8')
    .digest('hex');
}

/**
 * Validates the exact signed evidence bytes used by the UNCLASSIFIED_EXTERNAL_STORE
 * sentinel. A NOT_APPLICABLE decision is accepted only when every mandatory discovery
 * source is complete, all pagination is exhausted, the source results bind to the same
 * declared scope, and no unclassified store type is reported.
 *
 * This validates structure and integrity claims; it does not independently authenticate
 * provider APIs or prove that the owner queried the authoritative systems.
 */
export function validateExternalStoreInventoryManifest(
  bytes: Buffer,
  expectedTenantId: string,
  expectedCategoryCode: string,
  nowValue: Date | number = Date.now(),
): void {
  const now = nowValue instanceof Date ? nowValue.getTime() : nowValue;
  if (!Number.isFinite(now)) throw new Error('validation clock is invalid');

  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('evidence artifact must contain a valid external-store inventory JSON manifest');
  }
  const manifest = record(decoded);
  if (!manifest) throw new Error('external-store inventory manifest must be a JSON object');
  if (manifest.schema !== EXTERNAL_STORE_INVENTORY_MANIFEST_SCHEMA) {
    throw new Error('external-store inventory manifest schema is unsupported');
  }
  if (typeof manifest.tenant_id !== 'string' || manifest.tenant_id.toLowerCase() !== expectedTenantId.toLowerCase()) {
    throw new Error('external-store inventory manifest tenant does not match the signed coverage claim');
  }
  if (manifest.category_code !== expectedCategoryCode) {
    throw new Error('external-store inventory manifest category does not match the signed coverage claim');
  }
  timestamp(manifest.generated_at, 'generated_at', now);

  const scope = canonicalizeExternalStoreInventoryScope(manifest.scope);
  const scopeDigest = digestExternalStoreInventoryScope(scope);
  if (typeof manifest.scope_sha256 !== 'string' || !SHA256.test(manifest.scope_sha256)
    || manifest.scope_sha256 !== scopeDigest) {
    throw new Error('external-store inventory scope digest does not match the canonical scope');
  }
  if (manifest.inventory_complete !== true) throw new Error('external-store inventory must assert inventory_complete=true');
  if (manifest.unclassified_store_count !== 0) {
    throw new Error('external-store inventory contains an unknown or unclassified store type');
  }
  if (!Array.isArray(manifest.discovered_store_kinds)
    || manifest.discovered_store_kinds.some((kind) => typeof kind !== 'string' || !KNOWN_STORE_KINDS.has(kind))
    || new Set(manifest.discovered_store_kinds).size !== manifest.discovered_store_kinds.length) {
    throw new Error('discovered_store_kinds must contain only unique, catalogued external store kinds');
  }

  if (!Array.isArray(manifest.sources) || manifest.sources.length !== REQUIRED_EXTERNAL_INVENTORY_SOURCE_KINDS.length) {
    throw new Error('external-store inventory must contain exactly the required discovery source set');
  }
  const sources = new Map<string, Record<string, unknown>>();
  for (const candidate of manifest.sources) {
    const source = record(candidate);
    if (!source || typeof source.source_kind !== 'string'
      || !REQUIRED_EXTERNAL_INVENTORY_SOURCE_KINDS.includes(source.source_kind as typeof REQUIRED_EXTERNAL_INVENTORY_SOURCE_KINDS[number])
      || sources.has(source.source_kind)) {
      throw new Error('external-store inventory contains a missing, duplicate or unsupported discovery source');
    }
    safeReference(source.source_reference, 'source_reference');
    if (source.status !== 'COMPLETE' || source.pagination_exhausted !== true) {
      throw new Error('every external-store discovery source must be COMPLETE with pagination exhausted');
    }
    if (!Number.isSafeInteger(source.pages_fetched) || (source.pages_fetched as number) < 1
      || (source.pages_fetched as number) > 100000) {
      throw new Error('each discovery source must report a positive bounded pages_fetched count');
    }
    if (!Number.isSafeInteger(source.item_count) || (source.item_count as number) < 0) {
      throw new Error('each discovery source must report a non-negative item_count');
    }
    if (typeof source.result_sha256 !== 'string' || !SHA256.test(source.result_sha256)) {
      throw new Error('each discovery source must include a SHA-256 result digest');
    }
    if (source.scope_sha256 !== scopeDigest) {
      throw new Error('each discovery source must bind to the complete inventory scope digest');
    }
    const startedAt = timestamp(source.started_at, 'source.started_at', now);
    const completedAt = timestamp(source.completed_at, 'source.completed_at', now);
    if (completedAt < startedAt) throw new Error('discovery source completion cannot precede its start');
    sources.set(source.source_kind, source);
  }

  for (const sourceKind of REQUIRED_EXTERNAL_INVENTORY_SOURCE_KINDS) {
    if (!sources.has(sourceKind)) throw new Error('required external-store discovery source is missing: ' + sourceKind);
  }
}
