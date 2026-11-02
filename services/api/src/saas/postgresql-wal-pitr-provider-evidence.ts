import { createHash } from 'node:crypto';

export const POSTGRESQL_WAL_PITR_PROVIDER_CAPTURE_SCHEMA =
  'factoryos.postgresql-wal-pitr-provider-capture/v1';
export const POSTGRESQL_WAL_PITR_RESIDUAL_SCAN_SCHEMA =
  'factoryos.postgresql-wal-pitr-independent-residual-scan/v1';

export const POSTGRESQL_WAL_PITR_PROVIDER_SOURCE_KINDS = [
  'POSTGRESQL_CLUSTER_CATALOG',
  'WAL_ARCHIVE_DESTINATION_CATALOG',
  'WAL_SEGMENT_CATALOG',
  'WAL_WRITER_PRINCIPAL_CATALOG',
  'WAL_REPLICATION_PATH_CATALOG',
  'PITR_RESTORE_PATH_CATALOG',
] as const;
export type PostgresqlWalPitrProviderSourceKind =
  typeof POSTGRESQL_WAL_PITR_PROVIDER_SOURCE_KINDS[number];

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 1000;
const DEFAULT_MAX_PAGES_PER_SCOPE = 1000;
const MAX_PAGES_PER_SCOPE = 5000;
const DEFAULT_MAX_TOTAL_ITEMS = 20000;
const MAX_TOTAL_ITEMS = 100000;
const DEFAULT_MAX_TOTAL_PAGES = 10000;
const MAX_TOTAL_PAGES = 50000;
const MAX_ITEM_BYTES = 64 * 1024;
const MAX_SCOPES = 1000;
const SENSITIVE_KEY = /(secret|password|credential|access.?key|session.?token|private.?key|connection.?string|authorization|bearer|raw.?payload)/i;
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/i;

export interface PostgresqlWalPitrProviderScope {
  provider_reference: string;
  account_reference: string;
  region_reference: string;
}

export interface PostgresqlWalPitrProviderScopeDiscovery {
  scopes: PostgresqlWalPitrProviderScope[];
  principal_reference: string;
  discovery_reference: string;
  provider_policy_audit_reference: string;
  discovery_audit_reference: string;
  read_only_access_verified: boolean;
  all_accounts_discovered: boolean;
  all_regions_discovered: boolean;
  pagination_exhausted: boolean;
  pages_fetched: number;
}

export interface PostgresqlWalPitrProviderPage<T extends Record<string, unknown>> {
  scope: PostgresqlWalPitrProviderScope;
  principal_reference: string;
  read_only_access_verified: boolean;
  audit_reference: string;
  items: Array<{ reference: string; value: T }>;
  next_page_token: string | null;
}

export interface PostgresqlWalPitrProviderInventoryGateway {
  /**
   * Provider-specific implementation must enumerate the provider's complete
   * authoritative account/project and region catalog using a read-only identity.
   * It must not infer scope from only the accounts already configured in FactoryOS.
   */
  discoverScopes(): Promise<PostgresqlWalPitrProviderScopeDiscovery>;
  /**
   * List one source page using provider-native read/list APIs only. No write,
   * lifecycle, retention mutation, delete, restore or IAM mutation is permitted.
   * The provider adapter must return normalized manifest-ready records, not raw
   * provider responses, credentials, payloads or signed URLs.
   */
  listSourcePage(input: {
    source_kind: PostgresqlWalPitrProviderSourceKind;
    scope: PostgresqlWalPitrProviderScope;
    page_token: string | null;
    page_size: number;
  }): Promise<PostgresqlWalPitrProviderPage<Record<string, unknown>>>;
}

export interface PostgresqlWalPitrProviderInventoryCaptureInput {
  tenant_id: string;
  category_code: string;
  inventory_id: string;
  collection_run_reference: string;
  page_size?: number;
  max_pages_per_scope?: number;
  max_total_items?: number;
  max_total_pages?: number;
  now?: Date;
}

export interface PostgresqlWalPitrProviderSourceCapture {
  source_kind: PostgresqlWalPitrProviderSourceKind;
  source_reference: string;
  collection_run_reference: string;
  pages_fetched: number;
  item_count: number;
  result_sha256: string;
  items: Array<{ reference: string; value: Record<string, unknown> }>;
  audit_references: string[];
}

export interface PostgresqlWalPitrProviderInventoryCapture {
  schema: typeof POSTGRESQL_WAL_PITR_PROVIDER_CAPTURE_SCHEMA;
  status: 'ENUMERATION_COMPLETE_UNATTESTED';
  tenant_id: string;
  category_code: string;
  inventory_id: string;
  generated_at: string;
  collector_principal_reference: string;
  provider_policy_audit_reference: string;
  scope_discovery_reference: string;
  discovery_audit_reference: string;
  provider_scope_sha256: string;
  provider_scopes: PostgresqlWalPitrProviderScope[];
  source_captures: PostgresqlWalPitrProviderSourceCapture[];
  provider_native_inventory_complete: false;
  source_receipts_signable: false;
  manifest_eligible: false;
}

export interface PostgresqlWalPitrResidualIdentity {
  candidate_reference: string;
  archive_reference: string;
  object_reference: string;
  generation_reference: string;
}

export interface PostgresqlWalPitrResidualProviderPage {
  scope: PostgresqlWalPitrProviderScope;
  principal_reference: string;
  read_only_access_verified: boolean;
  audit_reference: string;
  items: PostgresqlWalPitrResidualIdentity[];
  next_page_token: string | null;
}

export interface PostgresqlWalPitrIndependentResidualGateway {
  /** Must use a dedicated independent principal; never reuse the archive writer or delete executor. */
  discoverScopes(): Promise<PostgresqlWalPitrProviderScopeDiscovery>;
  /** Must independently list all remaining archive/object generations after provider action. */
  listResidualPage(input: {
    scope: PostgresqlWalPitrProviderScope;
    page_token: string | null;
    page_size: number;
  }): Promise<PostgresqlWalPitrResidualProviderPage>;
}

export interface PostgresqlWalPitrIndependentResidualScanInput {
  tenant_id: string;
  expected_provider_scopes: PostgresqlWalPitrProviderScope[];
  expected_scope_sha256: string;
  candidate_identities: PostgresqlWalPitrResidualIdentity[];
  inventory_collector_principal_reference: string;
  deletion_executor_principal_reference: string;
  archive_writer_principal_references: string[];
  verification_reference: string;
  page_size?: number;
  max_pages_per_scope?: number;
  max_total_items?: number;
  max_total_pages?: number;
  now?: Date;
}

export interface PostgresqlWalPitrIndependentResidualScanResult {
  schema: typeof POSTGRESQL_WAL_PITR_RESIDUAL_SCAN_SCHEMA;
  status: 'ZERO_RESIDUALS_OBSERVED' | 'RESIDUALS_FOUND';
  tenant_id: string;
  scanned_at: string;
  independent_verifier_principal_reference: string;
  verification_reference: string;
  provider_scope_sha256: string;
  pages_fetched: number;
  copies_scanned: number;
  residuals: PostgresqlWalPitrResidualIdentity[];
  residual_manifest_sha256: string;
  independent_audit_references: string[];
  destructive_action_permitted: false;
  deletion_authorized: false;
  requires_independent_review: true;
}

function fail(message: string): never {
  throw new Error('PostgreSQL WAL/PITR provider evidence refused: ' + message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeReference(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_REFERENCE.test(value) || value.includes('://')
    || /(secret|password|credential|access.?key|token)/i.test(value)) {
    return fail(field + ' must be a non-secret opaque reference');
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && URL_WITH_CREDENTIALS.test(value)) {
      return fail('provider record contains an embedded URL credential');
    }
    return JSON.stringify(value) ?? 'null';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail('provider record contains a non-finite number');
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (!isRecord(value)) return fail('provider record contains a non-JSON value');
  const entries = Object.keys(value).sort().map((key) => {
    if (SENSITIVE_KEY.test(key)) return fail('provider record contains a sensitive field name');
    return JSON.stringify(key) + ':' + canonicalJson(value[key]);
  });
  return '{' + entries.join(',') + '}';
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeScope(value: unknown): PostgresqlWalPitrProviderScope {
  if (!isRecord(value)) return fail('provider scope is malformed');
  return {
    provider_reference: safeReference(value.provider_reference, 'provider_reference'),
    account_reference: safeReference(value.account_reference, 'account_reference'),
    region_reference: safeReference(value.region_reference, 'region_reference'),
  };
}

function scopeKey(scope: PostgresqlWalPitrProviderScope): string {
  return [scope.provider_reference, scope.account_reference, scope.region_reference].join('\u0000');
}

function canonicalScopes(scopes: unknown): PostgresqlWalPitrProviderScope[] {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > MAX_SCOPES) {
    return fail('provider account/region discovery must return 1..' + MAX_SCOPES + ' explicit scopes');
  }
  const normalized = scopes.map(normalizeScope).sort((left, right) =>
    scopeKey(left) < scopeKey(right) ? -1 : scopeKey(left) > scopeKey(right) ? 1 : 0);
  const keys = normalized.map(scopeKey);
  if (new Set(keys).size !== keys.length) return fail('provider account/region discovery contains duplicate scopes');
  return normalized;
}

function validateDiscovery(
  value: PostgresqlWalPitrProviderScopeDiscovery,
): { scopes: PostgresqlWalPitrProviderScope[]; principal: string; policyAudit: string; discovery: string; audit: string; pagesFetched: number } {
  if (!isRecord(value)) return fail('provider scope discovery evidence is missing');
  const scopes = canonicalScopes(value.scopes);
  const principal = safeReference(value.principal_reference, 'provider collector principal');
  const policyAudit = safeReference(value.provider_policy_audit_reference, 'provider IAM policy audit reference');
  const discovery = safeReference(value.discovery_reference, 'provider scope discovery reference');
  const audit = safeReference(value.discovery_audit_reference, 'provider scope discovery audit reference');
  if (value.read_only_access_verified !== true) return fail('provider collector is not verified read-only');
  if (value.all_accounts_discovered !== true || value.all_regions_discovered !== true
    || value.pagination_exhausted !== true) {
    return fail('authoritative account/project or region discovery is incomplete');
  }
  if (!Number.isSafeInteger(value.pages_fetched) || value.pages_fetched < 1 || value.pages_fetched > 100000) {
    return fail('provider scope discovery page count is invalid');
  }
  return { scopes, principal, policyAudit, discovery, audit, pagesFetched: value.pages_fetched };
}

function validateInput(input: PostgresqlWalPitrProviderInventoryCaptureInput): {
  pageSize: number; maxPages: number; maxItems: number; maxTotalPages: number; now: Date;
} {
  if (!isRecord(input) || typeof input.tenant_id !== 'string' || !UUID.test(input.tenant_id)
    || typeof input.inventory_id !== 'string' || !UUID.test(input.inventory_id)
    || typeof input.category_code !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(input.category_code)) {
    return fail('tenant, inventory and category identity are invalid');
  }
  safeReference(input.collection_run_reference, 'collection_run_reference');
  const pageSize = input.page_size ?? DEFAULT_PAGE_SIZE;
  const maxPages = input.max_pages_per_scope ?? DEFAULT_MAX_PAGES_PER_SCOPE;
  const maxItems = input.max_total_items ?? DEFAULT_MAX_TOTAL_ITEMS;
  const maxTotalPages = input.max_total_pages ?? DEFAULT_MAX_TOTAL_PAGES;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_PER_SCOPE
    || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > MAX_TOTAL_ITEMS
    || !Number.isSafeInteger(maxTotalPages) || maxTotalPages < 1 || maxTotalPages > MAX_TOTAL_PAGES) {
    return fail('provider inventory bounds are outside supported limits');
  }
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return fail('capture clock is invalid');
  return { pageSize, maxPages, maxItems, maxTotalPages, now };
}

async function enumerateSource(
  gateway: PostgresqlWalPitrProviderInventoryGateway,
  kind: PostgresqlWalPitrProviderSourceKind,
  scopes: PostgresqlWalPitrProviderScope[],
  principal: string,
  pageSize: number,
  maxPages: number,
  collectionRunReference: string,
  itemBudget: { total: number; maximum: number },
  pageBudget: { total: number; maximum: number },
): Promise<PostgresqlWalPitrProviderSourceCapture> {
  const items = new Map<string, { reference: string; value: Record<string, unknown> }>();
  const auditReferences = new Set<string>();
  let pagesFetched = 0;
  for (const scope of scopes) {
    let pageToken: string | null = null;
    const seenTokens = new Set<string>();
    let pagesForScope = 0;
    do {
      if (pageBudget.total >= pageBudget.maximum) return fail('provider inventory exceeded its total page budget');
      pageBudget.total += 1;
      const page = await gateway.listSourcePage({ source_kind: kind, scope, page_token: pageToken, page_size: pageSize });
      if (!isRecord(page) || scopeKey(normalizeScope(page.scope)) !== scopeKey(scope)) {
        return fail(kind + ' returned a page outside the requested provider/account/region scope');
      }
      if (page.principal_reference !== principal || page.read_only_access_verified !== true) {
        return fail(kind + ' page used an unexpected or non-read-only collector identity');
      }
      const auditReference = safeReference(page.audit_reference, kind + ' provider query audit reference');
      auditReferences.add(auditReference);
      if (!Array.isArray(page.items)) return fail(kind + ' page items must be an array');
      if (page.items.length > pageSize) return fail(kind + ' page exceeded the requested page size');
      pagesFetched += 1;
      pagesForScope += 1;
      if (pagesForScope > maxPages) return fail(kind + ' exceeded its per-scope page limit');
      for (const candidate of page.items) {
        if (!isRecord(candidate) || !isRecord(candidate.value)) return fail(kind + ' contains a malformed provider item');
        const reference = safeReference(candidate.reference, kind + ' item reference');
        if (items.has(reference)) return fail(kind + ' contains a duplicate provider item reference: ' + reference);
        const canonicalValue = canonicalJson(candidate.value);
        if (Buffer.byteLength(canonicalValue, 'utf8') > MAX_ITEM_BYTES) {
          return fail(kind + ' contains an oversized normalized item');
        }
        items.set(reference, { reference, value: JSON.parse(canonicalValue) as Record<string, unknown> });
        itemBudget.total += 1;
        if (itemBudget.total > itemBudget.maximum) return fail('provider inventory exceeded its total item budget');
      }
      const next = page.next_page_token;
      if (next !== null && (typeof next !== 'string' || next.length < 1 || next.length > 2048)) {
        return fail(kind + ' returned an invalid continuation token');
      }
      if (next !== null) {
        if (seenTokens.has(next)) return fail(kind + ' returned a repeated continuation token');
        seenTokens.add(next);
      }
      pageToken = next;
    } while (pageToken !== null);
  }
  const sorted = [...items.values()].sort((left, right) => left.reference < right.reference ? -1
    : left.reference > right.reference ? 1 : 0);
  const resultDigest = sha256(JSON.stringify(sorted));
  const kindSuffix = kind.toLowerCase().replace(/_/g, '.');
  return {
    source_kind: kind,
    source_reference: 'provider.inventory.' + kindSuffix,
    collection_run_reference: 'provider.capture.' + kindSuffix + '.'
      + sha256(collectionRunReference).slice(0, 24) + '.' + resultDigest.slice(0, 16),
    pages_fetched: pagesFetched,
    item_count: sorted.length,
    result_sha256: resultDigest,
    items: sorted,
    audit_references: [...auditReferences].sort(),
  };
}

/**
 * Orchestrates a provider-specific read-only gateway across every discovered
 * account/region and all six required catalogs. It produces a complete enumeration
 * observation only; it cannot attest the provider implementation, sign receipts,
 * assemble/accept the final manifest, or authorize retention/deletion.
 */
export async function capturePostgresqlWalPitrProviderInventory(
  gateway: PostgresqlWalPitrProviderInventoryGateway,
  input: PostgresqlWalPitrProviderInventoryCaptureInput,
): Promise<PostgresqlWalPitrProviderInventoryCapture> {
  if (!gateway || typeof gateway.discoverScopes !== 'function' || typeof gateway.listSourcePage !== 'function') {
    return fail('a provider-specific read-only inventory gateway is not registered');
  }
  const bounds = validateInput(input);
  const discovery = validateDiscovery(await gateway.discoverScopes());
  if (discovery.pagesFetched > bounds.maxTotalPages) return fail('provider inventory discovery exceeded its total page budget');
  const itemBudget = { total: 0, maximum: bounds.maxItems };
  const pageBudget = { total: discovery.pagesFetched, maximum: bounds.maxTotalPages };
  const captures: PostgresqlWalPitrProviderSourceCapture[] = [];
  for (const kind of POSTGRESQL_WAL_PITR_PROVIDER_SOURCE_KINDS) {
    captures.push(await enumerateSource(
      gateway, kind, discovery.scopes, discovery.principal, bounds.pageSize,
      bounds.maxPages, input.collection_run_reference, itemBudget, pageBudget,
    ));
  }
  const scopeSha = sha256(JSON.stringify(discovery.scopes));
  return {
    schema: POSTGRESQL_WAL_PITR_PROVIDER_CAPTURE_SCHEMA,
    status: 'ENUMERATION_COMPLETE_UNATTESTED',
    tenant_id: input.tenant_id.toLowerCase(),
    category_code: input.category_code,
    inventory_id: input.inventory_id.toLowerCase(),
    generated_at: bounds.now.toISOString(),
    collector_principal_reference: discovery.principal,
    provider_policy_audit_reference: discovery.policyAudit,
    scope_discovery_reference: discovery.discovery,
    discovery_audit_reference: discovery.audit,
    provider_scope_sha256: scopeSha,
    provider_scopes: discovery.scopes,
    source_captures: captures,
    provider_native_inventory_complete: false,
    source_receipts_signable: false,
    manifest_eligible: false,
  };
}

function residualKey(value: PostgresqlWalPitrResidualIdentity): string {
  return [value.candidate_reference, value.archive_reference, value.object_reference, value.generation_reference].join('\u0000');
}

function normalizeResidual(value: unknown): PostgresqlWalPitrResidualIdentity {
  if (!isRecord(value)) return fail('residual provider returned a malformed object identity');
  return {
    candidate_reference: safeReference(value.candidate_reference, 'residual candidate reference'),
    archive_reference: safeReference(value.archive_reference, 'residual archive reference'),
    object_reference: safeReference(value.object_reference, 'residual object reference'),
    generation_reference: safeReference(value.generation_reference, 'residual immutable generation reference'),
  };
}

function scopeDigest(scopes: PostgresqlWalPitrProviderScope[]): string {
  return sha256(JSON.stringify(canonicalScopes(scopes)));
}

/**
 * Scans every expected provider scope through a separate read-only gateway.
 * A zero-residual result is still evidence for independent review, never a delete
 * command or an automatic erasure acceptance decision.
 */
export async function scanPostgresqlWalPitrResidualsIndependently(
  gateway: PostgresqlWalPitrIndependentResidualGateway,
  input: PostgresqlWalPitrIndependentResidualScanInput,
): Promise<PostgresqlWalPitrIndependentResidualScanResult> {
  if (!gateway || typeof gateway.discoverScopes !== 'function' || typeof gateway.listResidualPage !== 'function') {
    return fail('an independent provider residual-read gateway is not registered');
  }
  if (!UUID.test(input.tenant_id) || !SHA256.test(input.expected_scope_sha256)
    || !Array.isArray(input.candidate_identities) || input.candidate_identities.length < 1) {
    return fail('residual scan tenant, expected scope digest or candidate set is invalid');
  }
  const expectedScopes = canonicalScopes(input.expected_provider_scopes);
  if (scopeDigest(expectedScopes) !== input.expected_scope_sha256) {
    return fail('caller expected provider scope digest does not match its canonical scope');
  }
  const discovery = validateDiscovery(await gateway.discoverScopes());
  if (scopeKeyList(discovery.scopes) !== scopeKeyList(expectedScopes)) {
    return fail('independent residual scanner did not enumerate the exact expected provider/account/region scope');
  }
  const excludedPrincipals = new Set([
    safeReference(input.inventory_collector_principal_reference, 'inventory collector principal'),
    safeReference(input.deletion_executor_principal_reference, 'deletion executor principal'),
    ...input.archive_writer_principal_references.map((value) => safeReference(value, 'archive writer principal')),
  ]);
  if (excludedPrincipals.has(discovery.principal)) {
    return fail('independent residual scanner reuses an inventory, deletion or archive-writer principal');
  }
  safeReference(input.verification_reference, 'independent verification reference');
  const pageSize = input.page_size ?? DEFAULT_PAGE_SIZE;
  const maxPages = input.max_pages_per_scope ?? DEFAULT_MAX_PAGES_PER_SCOPE;
  const maxItems = input.max_total_items ?? DEFAULT_MAX_TOTAL_ITEMS;
  const maxTotalPages = input.max_total_pages ?? DEFAULT_MAX_TOTAL_PAGES;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_PER_SCOPE
    || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > MAX_TOTAL_ITEMS
    || !Number.isSafeInteger(maxTotalPages) || maxTotalPages < 1 || maxTotalPages > MAX_TOTAL_PAGES) {
    return fail('independent residual scan bounds are outside supported limits');
  }
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return fail('independent residual scan clock is invalid');
  if (discovery.pagesFetched > maxTotalPages) return fail('independent residual discovery exceeded its total page budget');
  const candidates = new Map<string, PostgresqlWalPitrResidualIdentity>();
  for (const candidate of input.candidate_identities) {
    const normalized = normalizeResidual(candidate);
    const key = residualKey(normalized);
    if (candidates.has(key)) return fail('candidate identity set contains a duplicate immutable generation');
    candidates.set(key, normalized);
  }
  const residuals = new Map<string, PostgresqlWalPitrResidualIdentity>();
  const auditReferences = new Set<string>([discovery.audit, discovery.policyAudit]);
  let pagesFetched = 0;
  let totalPagesBudgetUsed = discovery.pagesFetched;
  let copiesScanned = 0;
  for (const scope of expectedScopes) {
    let pageToken: string | null = null;
    const seenTokens = new Set<string>();
    let pagesForScope = 0;
    do {
      if (totalPagesBudgetUsed >= maxTotalPages) return fail('independent residual scan exceeded its total page budget');
      totalPagesBudgetUsed += 1;
      const page = await gateway.listResidualPage({ scope, page_token: pageToken, page_size: pageSize });
      if (!isRecord(page) || scopeKey(normalizeScope(page.scope)) !== scopeKey(scope)) {
        return fail('independent residual page was returned for an unexpected provider scope');
      }
      if (page.principal_reference !== discovery.principal || page.read_only_access_verified !== true) {
        return fail('independent residual page did not use its verified read-only principal');
      }
      auditReferences.add(safeReference(page.audit_reference, 'independent residual query audit reference'));
      if (!Array.isArray(page.items)) return fail('independent residual page items must be an array');
      if (page.items.length > pageSize) return fail('independent residual page exceeded the requested page size');
      pagesFetched += 1;
      pagesForScope += 1;
      if (pagesForScope > maxPages) return fail('independent residual scan exceeded its per-scope page limit');
      for (const raw of page.items) {
        const item = normalizeResidual(raw);
        const key = residualKey(item);
        if (residuals.has(key)) return fail('independent residual scanner returned a duplicate object generation');
        residuals.set(key, item);
        copiesScanned += 1;
        if (copiesScanned > maxItems) return fail('independent residual scan exceeded its total item budget');
      }
      const next = page.next_page_token;
      if (next !== null && (typeof next !== 'string' || next.length < 1 || next.length > 2048)) {
        return fail('independent residual scanner returned an invalid continuation token');
      }
      if (next !== null) {
        if (seenTokens.has(next)) return fail('independent residual scanner returned a repeated continuation token');
        seenTokens.add(next);
      }
      pageToken = next;
    } while (pageToken !== null);
  }
  const matched = [...candidates.entries()].flatMap(([key, candidate]) =>
    residuals.has(key) ? [candidate] : []);
  const canonicalResiduals = matched.sort((left, right) =>
    residualKey(left) < residualKey(right) ? -1 : residualKey(left) > residualKey(right) ? 1 : 0);
  const nowIso = now.toISOString();
  return {
    schema: POSTGRESQL_WAL_PITR_RESIDUAL_SCAN_SCHEMA,
    status: canonicalResiduals.length === 0 ? 'ZERO_RESIDUALS_OBSERVED' : 'RESIDUALS_FOUND',
    tenant_id: input.tenant_id.toLowerCase(),
    scanned_at: nowIso,
    independent_verifier_principal_reference: discovery.principal,
    verification_reference: input.verification_reference,
    provider_scope_sha256: input.expected_scope_sha256,
    pages_fetched: pagesFetched,
    copies_scanned: copiesScanned,
    residuals: canonicalResiduals,
    residual_manifest_sha256: sha256(JSON.stringify(canonicalResiduals)),
    independent_audit_references: [...auditReferences].sort(),
    destructive_action_permitted: false,
    deletion_authorized: false,
    requires_independent_review: true,
  };
}

function scopeKeyList(scopes: PostgresqlWalPitrProviderScope[]): string {
  return canonicalScopes(scopes).map(scopeKey).join('\n');
}
