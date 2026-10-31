import { createHash, createPublicKey, verify } from 'node:crypto';

export const EXTERNAL_STORE_INVENTORY_MANIFEST_SCHEMA = 'factoryos.external-store-inventory/v1';
export const EXTERNAL_STORE_INVENTORY_SOURCE_RECEIPT_SCHEMA = 'factoryos.external-store-inventory-source-receipt/v1';

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
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_SOURCE_TRUSTED_KEYS = 200;

export interface ExternalStoreInventoryScope {
  provider_references: string[];
  account_references: string[];
  project_references: string[];
  region_references: string[];
}

export interface ExternalStoreInventorySourceReceipt {
  source_kind: string;
  source_reference: string;
  collection_run_reference: string;
  status: string;
  pagination_exhausted: boolean;
  pages_fetched: number;
  item_count: number;
  result_sha256: string;
  scope_sha256: string;
  started_at: string;
  completed_at: string;
  attestation_key_id: string;
  attestation_owner_reference: string;
  attestation_signature: string;
}

interface TrustedSourceKey {
  keyId: string;
  ownerReference: string;
  sourceKinds: string[];
  publicKeyPem: string;
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
 * Stable signed source-receipt wire format. The manifest ID prevents an otherwise
 * valid receipt from being replayed into a later inventory manifest. The trusted key
 * store separately limits each collector identity to approved source kinds.
 */
export function canonicalizeExternalStoreInventorySourceReceipt(
  source: ExternalStoreInventorySourceReceipt,
  context: { tenantId: string; categoryCode: string; manifestId: string },
): string {
  return JSON.stringify({
    schema: EXTERNAL_STORE_INVENTORY_SOURCE_RECEIPT_SCHEMA,
    attestationKeyId: source.attestation_key_id,
    attestationOwnerReference: source.attestation_owner_reference,
    tenantId: context.tenantId.toLowerCase(),
    categoryCode: context.categoryCode,
    manifestId: context.manifestId.toLowerCase(),
    sourceKind: source.source_kind,
    sourceReference: source.source_reference,
    collectionRunReference: source.collection_run_reference,
    status: source.status,
    paginationExhausted: source.pagination_exhausted,
    pagesFetched: source.pages_fetched,
    itemCount: source.item_count,
    resultSha256: source.result_sha256,
    scopeSha256: source.scope_sha256,
    startedAt: source.started_at,
    completedAt: source.completed_at,
  });
}

function loadTrustedSourceKeys(raw: string | undefined): Map<string, TrustedSourceKey> {
  if (!raw?.trim()) {
    throw new Error('external inventory source attestation trust is not configured');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('external inventory source trusted-key configuration is invalid');
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_SOURCE_TRUSTED_KEYS) {
    throw new Error('external inventory source trusted-key configuration is invalid');
  }

  const keys = new Map<string, TrustedSourceKey>();
  for (const candidate of parsed as unknown[]) {
    const entry = record(candidate);
    if (!entry) throw new Error('external inventory source trusted-key configuration is invalid');
    const keyId = entry.keyId;
    const ownerReference = entry.ownerReference;
    const sourceKinds = entry.sourceKinds;
    const publicKeyPem = entry.publicKeyPem;
    if (typeof keyId !== 'string' || !KEY_ID.test(keyId)
      || typeof ownerReference !== 'string' || !SAFE_REFERENCE.test(ownerReference)
      || ownerReference.includes('://') || /(secret|password|credential|access[-_]?key|token)/i.test(ownerReference)
      || !Array.isArray(sourceKinds) || sourceKinds.length < 1
      || sourceKinds.some((kind) => typeof kind !== 'string'
        || !REQUIRED_EXTERNAL_INVENTORY_SOURCE_KINDS.includes(kind as typeof REQUIRED_EXTERNAL_INVENTORY_SOURCE_KINDS[number]))
      || new Set(sourceKinds).size !== sourceKinds.length
      || typeof publicKeyPem !== 'string' || !publicKeyPem.includes('-----BEGIN PUBLIC KEY-----')
      || publicKeyPem.includes('PRIVATE KEY') || keys.has(keyId)) {
      throw new Error('external inventory source trusted-key configuration is invalid');
    }
    try {
      const publicKey = createPublicKey(publicKeyPem);
      if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('source receipt keys must use Ed25519');
    } catch {
      throw new Error('external inventory source trusted-key configuration is invalid');
    }
    keys.set(keyId, { keyId, ownerReference, sourceKinds: sourceKinds as string[], publicKeyPem });
  }
  return keys;
}

function verifyExternalStoreInventorySourceReceipt(
  source: ExternalStoreInventorySourceReceipt,
  context: { tenantId: string; categoryCode: string; manifestId: string },
  trustedKeys: Map<string, TrustedSourceKey>,
): void {
  if (typeof source.attestation_key_id !== 'string' || !KEY_ID.test(source.attestation_key_id)
    || typeof source.attestation_owner_reference !== 'string'
    || !SAFE_REFERENCE.test(source.attestation_owner_reference)
    || source.attestation_owner_reference.includes('://')
    || !SIGNATURE.test(source.attestation_signature)) {
    throw new Error('external inventory source receipt signing metadata is invalid');
  }
  const trustedKey = trustedKeys.get(source.attestation_key_id);
  if (!trustedKey || trustedKey.ownerReference !== source.attestation_owner_reference
    || !trustedKey.sourceKinds.includes(source.source_kind)) {
    throw new Error('external inventory source receipt signer is not trusted for ' + source.source_kind);
  }
  const signature = Buffer.from(source.attestation_signature, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== source.attestation_signature) {
    throw new Error('external inventory source receipt signature is not canonical');
  }
  const message = Buffer.from(canonicalizeExternalStoreInventorySourceReceipt(source, context), 'utf8');
  if (!verify(null, message, createPublicKey(trustedKey.publicKeyPem), signature)) {
    throw new Error('external inventory source receipt signature does not match its claims');
  }
}

/**
 * Validates the exact signed evidence bytes used by the UNCLASSIFIED_EXTERNAL_STORE
 * sentinel. A NOT_APPLICABLE decision requires a complete manifest and independently
 * trusted signatures for every required discovery-source receipt.
 *
 * This authenticates the configured collector key and the signed receipt claims. It
 * does not independently call provider APIs or prove that the collector queried every
 * authoritative account or control plane.
 */
export function validateExternalStoreInventoryManifest(
  bytes: Buffer,
  expectedTenantId: string,
  expectedCategoryCode: string,
  nowValue: Date | number = Date.now(),
  trustedSourceKeysJson: string | undefined = process.env.FACTORYOS_EXTERNAL_INVENTORY_SOURCE_TRUSTED_KEYS_JSON,
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
  if (typeof manifest.manifest_id !== 'string' || !UUID.test(manifest.manifest_id)) {
    throw new Error('external-store inventory manifest manifest_id must be a UUID');
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
  const trustedKeys = loadTrustedSourceKeys(trustedSourceKeysJson);
  const sourceContext = {
    tenantId: expectedTenantId,
    categoryCode: expectedCategoryCode,
    manifestId: manifest.manifest_id,
  };
  const sources = new Map<string, Record<string, unknown>>();
  const collectionRuns = new Set<string>();
  for (const candidate of manifest.sources) {
    const source = record(candidate) as (Record<string, unknown> & Partial<ExternalStoreInventorySourceReceipt>) | null;
    if (!source || typeof source.source_kind !== 'string'
      || !REQUIRED_EXTERNAL_INVENTORY_SOURCE_KINDS.includes(source.source_kind as typeof REQUIRED_EXTERNAL_INVENTORY_SOURCE_KINDS[number])
      || sources.has(source.source_kind)) {
      throw new Error('external-store inventory contains a missing, duplicate or unsupported discovery source');
    }
    safeReference(source.source_reference, 'source_reference');
    const collectionRunReference = safeReference(source.collection_run_reference, 'collection_run_reference');
    if (collectionRuns.has(collectionRunReference)) {
      throw new Error('external inventory source collection_run_reference must be unique per manifest');
    }
    collectionRuns.add(collectionRunReference);
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
    verifyExternalStoreInventorySourceReceipt(source as unknown as ExternalStoreInventorySourceReceipt, sourceContext, trustedKeys);
    sources.set(source.source_kind, source);
  }

  for (const sourceKind of REQUIRED_EXTERNAL_INVENTORY_SOURCE_KINDS) {
    if (!sources.has(sourceKind)) throw new Error('required external-store discovery source is missing: ' + sourceKind);
  }
}
