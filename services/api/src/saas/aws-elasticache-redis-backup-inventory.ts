import { createHash, createHmac } from 'node:crypto';

const SERVICE = 'elasticache';
const API_VERSION = '2015-02-02';
const STS_VERSION = '2011-06-15';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SCOPES = 500;
const MAX_HARD_PAGES = 50000;
const MAX_HARD_ITEMS = 100000;
const ACCOUNT_ID = /^\d{12}$/;
const ROLE_NAME = /^[A-Za-z0-9+=,.@_-]{1,64}$/;

export type AwsElastiCachePartition = 'aws' | 'aws-us-gov' | 'aws-cn';

export interface AwsElastiCacheBackupCredentials {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
}

export interface AwsElastiCacheRedisBackupScope {
  account_id: string;
  partition: AwsElastiCachePartition;
  region: string;
  expected_assumed_role_name: string;
  credentials: AwsElastiCacheBackupCredentials;
}

export interface AwsElastiCacheRedisBackupInventoryInput {
  scopes: AwsElastiCacheRedisBackupScope[];
  fetcher?: typeof fetch;
  now?: () => Date;
  max_pages?: number;
  max_items?: number;
  request_timeout_ms?: number;
}

export interface AwsElastiCacheRedisCacheClusterRecord {
  account_id: string;
  region: string;
  cache_cluster_id: string;
  engine: 'redis' | 'valkey';
  engine_version: string | null;
  status: string;
  replication_group_id: string | null;
  cache_node_type: string | null;
  num_cache_nodes: number | null;
  snapshot_retention_limit_days: number | null;
  snapshot_window: string | null;
  created_at: string | null;
}

export interface AwsElastiCacheRedisReplicationGroupRecord {
  account_id: string;
  region: string;
  replication_group_id: string;
  status: string;
  global_replication_group_id: string | null;
  multi_az: boolean | null;
  automatic_failover: string | null;
  cluster_enabled: boolean | null;
  snapshot_retention_limit_days: number | null;
  snapshot_window: string | null;
  snapshotting_cluster_id: string | null;
  member_cluster_ids: string[];
  node_group_ids: string[];
  member_node_roles: Array<{
    cache_cluster_id: string;
    cache_node_id: string | null;
    current_role: string | null;
    availability_zone: string | null;
  }>;
}

export interface AwsElastiCacheRedisGlobalReplicationGroupRecord {
  account_id: string;
  global_replication_group_id: string;
  status: string;
  engine: string | null;
  engine_version: string | null;
  cache_node_type: string | null;
  cluster_enabled: boolean | null;
  members: Array<{
    region: string;
    replication_group_id: string;
    role: string | null;
    status: string | null;
  }>;
  observed_in_regions: string[];
}

export interface AwsElastiCacheRedisSnapshotRecord {
  account_id: string;
  region: string;
  snapshot_name: string;
  snapshot_identity_reference: string;
  snapshot_identity_kind: 'SNAPSHOT_NAME_AND_CREATE_TIME';
  replication_group_id: string | null;
  cache_cluster_id: string | null;
  status: string;
  source: string | null;
  engine: 'redis' | 'valkey';
  engine_version: string | null;
  cache_node_type: string | null;
  create_time: string | null;
  num_cache_nodes: number | null;
  node_snapshots: Array<{
    cache_node_id: string | null;
    snapshot_create_time: string | null;
  }>;
}

export interface AwsElastiCacheServerlessCacheRecord {
  account_id: string;
  region: string;
  cache_name: string;
  cache_arn: string;
  engine: 'redis' | 'valkey' | 'memcached';
  major_engine_version: string | null;
  full_engine_version: string | null;
  status: string;
  snapshot_retention_limit_days: number | null;
  daily_snapshot_time: string | null;
  storage_encryption_type: string | null;
  create_time: string | null;
}

export interface AwsElastiCacheServerlessSnapshotRecord {
  account_id: string;
  region: string;
  snapshot_name: string;
  snapshot_arn: string;
  snapshot_identity_reference: string;
  snapshot_identity_kind: 'PROVIDER_SNAPSHOT_ARN';
  cache_name: string;
  snapshot_type: string;
  status: string;
  create_time: string | null;
  expiry_time: string | null;
  bytes_used_for_cache: string | null;
  engine: 'redis' | 'valkey' | 'memcached' | null;
  major_engine_version: string | null;
}

export interface AwsElastiCacheRedisBackupInventory {
  schema: 'factoryos.aws-elasticache-redis-backup-inventory/v1';
  status: 'COMPLETE' | 'PARTIAL';
  generated_at: string;
  requested_scopes: Array<{ account_id: string; partition: AwsElastiCachePartition; region: string }>;
  verified_scope_count: number;
  cache_clusters: AwsElastiCacheRedisCacheClusterRecord[];
  replication_groups: AwsElastiCacheRedisReplicationGroupRecord[];
  global_replication_groups: AwsElastiCacheRedisGlobalReplicationGroupRecord[];
  snapshots: AwsElastiCacheRedisSnapshotRecord[];
  serverless_caches: AwsElastiCacheServerlessCacheRecord[];
  serverless_snapshots: AwsElastiCacheServerlessSnapshotRecord[];
  non_redis_cache_clusters_excluded: number;
  unscanned_global_member_scopes: Array<{
    account_id: string;
    partition: AwsElastiCachePartition;
    region: string;
    global_replication_group_id: string;
    replication_group_id: string;
  }>;
  pages_fetched: number;
  requests_attempted: number;
  items_observed: number;
  query_receipt_references: string[];
  blockers: string[];
  node_based_catalog_complete: boolean;
  serverless_catalog_complete: boolean;
  serverless_cache_and_snapshot_surfaces_enumerated: boolean;
  self_managed_redis_aof_rdb_and_volume_backup_surfaces_enumerated: false;
  whole_cache_backup_coverage_complete: false;
  provider_mutation_performed: false;
  delete_api_available: false;
  deletion_authorized: false;
}

interface ValidatedLimits {
  max_pages: number;
  max_items: number;
  request_timeout_ms: number;
}

interface PageResult {
  records: string[];
  pages: number;
  receipts: string[];
}

interface MutableBudget {
  requests: number;
  pages: number;
  items: number;
}

interface ApiScopeState {
  scope: AwsElastiCacheRedisBackupScope;
  identity_verified: boolean;
}

function fail(message: string): never {
  throw new Error('AWS ElastiCache Redis backup inventory refused: ' + message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    '%' + character.charCodeAt(0).toString(16).toUpperCase());
}

function validRegion(value: string): boolean {
  return /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(value);
}

function validateLimits(input: AwsElastiCacheRedisBackupInventoryInput): ValidatedLimits {
  const maxPages = input.max_pages ?? 10000;
  const maxItems = input.max_items ?? 20000;
  const timeout = input.request_timeout_ms ?? 10000;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_HARD_PAGES
    || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > MAX_HARD_ITEMS
    || !Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 30000) {
    return fail('pagination, item or request-timeout budget is outside supported bounds');
  }
  return { max_pages: maxPages, max_items: maxItems, request_timeout_ms: timeout };
}

function validateCredentials(value: AwsElastiCacheBackupCredentials): AwsElastiCacheBackupCredentials {
  if (!isRecord(value) || typeof value.access_key_id !== 'string'
    || !/^[A-Z0-9]{16,128}$/.test(value.access_key_id)
    || typeof value.secret_access_key !== 'string' || value.secret_access_key.length < 20
    || /[\r\n]/.test(value.secret_access_key)
    || (value.session_token !== undefined
      && (typeof value.session_token !== 'string' || value.session_token.length < 16 || /[\r\n]/.test(value.session_token)))) {
    return fail('assumed reader credentials are malformed or incomplete');
  }
  return value;
}

function validateScopes(scopes: AwsElastiCacheRedisBackupScope[]): AwsElastiCacheRedisBackupScope[] {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > MAX_SCOPES) {
    return fail('one to 500 explicitly requested account/region scopes are required');
  }
  const seen = new Set<string>();
  const result = scopes.map((scope) => {
    if (!isRecord(scope) || !ACCOUNT_ID.test(scope.account_id)
      || !['aws', 'aws-us-gov', 'aws-cn'].includes(scope.partition)
      || !validRegion(scope.region) || !ROLE_NAME.test(scope.expected_assumed_role_name)
      || !scope.credentials) {
      return fail('ElastiCache reader scope identity or role binding is invalid');
    }
    const expectedPartition = scope.region.startsWith('cn-') ? 'aws-cn'
      : scope.region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws';
    if (scope.partition !== expectedPartition) return fail('scope region and AWS partition do not match');
    validateCredentials(scope.credentials);
    const key = scope.account_id + ':' + scope.region;
    if (seen.has(key)) return fail('duplicate account/region scope was supplied');
    seen.add(key);
    return scope;
  });
  return result.sort((a, b) =>
    a.account_id.localeCompare(b.account_id) || a.region.localeCompare(b.region));
}

function endpointHost(partition: AwsElastiCachePartition, region: string, service: string): string {
  const suffix = partition === 'aws-cn' ? 'amazonaws.com.cn' : 'amazonaws.com';
  return service === 'sts'
    ? 'sts.' + region + '.' + suffix
    : service + '.' + region + '.' + suffix;
}

function xmlBlocks(xml: string, tag: string): string[] {
  const escaped = tag.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
  const token = new RegExp(
    '<(?:(?:[A-Za-z0-9_]+):)?' + escaped + '(?:\\s[^>]*)?(\\/?)>|<\\/(?:(?:[A-Za-z0-9_]+):)?' + escaped + '\\s*>',
    'gi',
  );
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  for (const match of xml.matchAll(token)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (value.startsWith('</')) {
      depth -= 1;
      if (depth < 0) return fail('AWS Query response contains malformed XML element nesting');
      if (depth === 0 && start >= 0) {
        blocks.push(xml.slice(start, index + value.length));
        start = -1;
      }
    } else if (value.endsWith('/>')) {
      if (depth === 0) blocks.push(value);
    } else {
      if (depth === 0) start = index;
      depth += 1;
    }
  }
  if (depth !== 0 || start >= 0) return fail('AWS Query response contains an unterminated XML element');
  return blocks;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)));
}

function xmlText(xml: string, tag: string): string | null {
  const block = xmlBlocks(xml, tag)[0];
  if (!block || block.endsWith('/>')) return null;
  const opening = block.indexOf('>');
  const closing = block.lastIndexOf('</');
  if (opening < 0 || closing < opening) return null;
  return decodeXml(block.slice(opening + 1, closing).trim());
}

function nestedText(xml: string, parentTag: string, childTag: string): string | null {
  const parent = xmlBlocks(xml, parentTag)[0];
  return parent ? directXmlText(parent, childTag) : null;
}

function directChildXmlBlocks(parentXml: string): string[] {
  const openingEnd = parentXml.indexOf('>');
  const closingStart = parentXml.lastIndexOf('</');
  if (openingEnd < 0 || closingStart < openingEnd) return [];
  const inner = parentXml.slice(openingEnd + 1, closingStart);
  const token = /<\/?([A-Za-z0-9_:-]+)(?:\s[^>]*)?\/?>/g;
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  for (const match of inner.matchAll(token)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (value.startsWith('</')) {
      depth -= 1;
      if (depth < 0) return fail('AWS response contains malformed direct-child XML nesting');
      if (depth === 0 && start >= 0) {
        blocks.push(inner.slice(start, index + value.length));
        start = -1;
      }
    } else if (value.endsWith('/>')) {
      if (depth === 0) blocks.push(value);
    } else {
      if (depth === 0) start = index;
      depth += 1;
    }
  }
  if (depth !== 0 || start >= 0) return fail('AWS response contains an unterminated direct-child XML element');
  return blocks;
}

function directXmlText(xml: string, tag: string): string | null {
  const target = tag.toLowerCase();
  for (const block of directChildXmlBlocks(xml)) {
    const opening = /^<(?:(?:[A-Za-z0-9_]+):)?([A-Za-z0-9_]+)/.exec(block);
    if (opening?.[1]?.toLowerCase() === target) return xmlText(block, tag);
  }
  return null;
}

function childRecords(xml: string, containerTag: string, itemTag: string): string[] {
  const container = xmlBlocks(xml, containerTag)[0];
  return container ? xmlBlocks(container, itemTag) : [];
}

function optionalBoolean(value: string | null): boolean | null {
  if (value === null) return null;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return null;
}

function optionalInteger(value: string | null): number | null {
  if (value === null || !/^\d{1,9}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function canonicalTimestamp(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function validIdentifier(value: string | null, field: string): string {
  if (!value || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value)) {
    return fail(field + ' is missing or invalid in the AWS catalog response');
  }
  return value;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return fail('AWS response body is missing');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return fail('AWS response exceeded the 4 MiB response limit');
      }
      chunks.push(Buffer.from(part.value));
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      return fail('AWS response is not valid UTF-8');
    }
  } catch {
    return fail('AWS response stream was interrupted');
  } finally {
    reader.releaseLock();
  }
}

function makeCanonicalQuery(parameters: Record<string, string>): string {
  return Object.keys(parameters).sort((a, b) => {
    const left = rfc3986(a);
    const right = rfc3986(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }).map((key) => rfc3986(key) + '=' + rfc3986(parameters[key]!)).join('&');
}

async function signedQuery(
  service: 'sts' | 'elasticache',
  scope: AwsElastiCacheRedisBackupScope,
  action: string,
  apiParameters: Record<string, string>,
  fetcher: typeof fetch,
  timeoutMs: number,
  now: () => Date,
  budget: MutableBudget,
  maxPages: number,
): Promise<string> {
  if (budget.requests >= maxPages) return fail('global AWS request/page budget exhausted');
  budget.requests += 1;
  const credentials = validateCredentials(scope.credentials);
  const region = service === 'sts' ? scope.region : scope.region;
  const host = endpointHost(scope.partition, region, service);
  const parameters: Record<string, string> = {
    ...apiParameters,
    Action: action,
    Version: service === 'sts' ? STS_VERSION : API_VERSION,
  };
  const body = makeCanonicalQuery(parameters);
  const payloadHash = sha256(body);
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return fail('inventory clock is invalid');
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (credentials.session_token) headers['x-amz-security-token'] = credentials.session_token;
  const headerNames = Object.keys(headers).sort();
  const canonicalHeaders = headerNames.map((name) =>
    name + ':' + headers[name]!.trim().replace(/\s+/g, ' ') + '\n').join('');
  const signedHeaders = headerNames.join(';');
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = dateStamp + '/' + region + '/' + service + '/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac('AWS4' + credentials.secret_access_key, dateStamp), region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const authorization = 'AWS4-HMAC-SHA256 Credential=' + credentials.access_key_id + '/'
    + credentialScope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  let response: Response;
  try {
    response = await fetcher('https://' + host + '/', {
      method: 'POST',
      headers: { ...headers, authorization },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return fail(service + ' ' + action + ' request failed before a verified response');
  }
  const xml = await readBoundedResponse(response);
  if (xml.includes('<!DOCTYPE') || xml.includes('<!ENTITY')) {
    return fail(service + ' ' + action + ' returned a prohibited XML DTD/entity declaration');
  }
  if (!response.ok) {
    const code = xmlText(xml, 'Code') ?? 'HTTP_' + response.status;
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(code)) return fail(service + ' ' + action + ' returned an invalid service error code');
    return fail(service + ' ' + action + ' denied or failed (' + code + ')');
  }
  return xml;
}

async function verifyScopeIdentity(
  scope: AwsElastiCacheRedisBackupScope,
  fetcher: typeof fetch,
  timeoutMs: number,
  now: () => Date,
  budget: MutableBudget,
  maxPages: number,
): Promise<string> {
  const xml = await signedQuery('sts', scope, 'GetCallerIdentity', {}, fetcher, timeoutMs, now, budget, maxPages);
  const account = xmlText(xml, 'Account');
  const arn = xmlText(xml, 'Arn');
  const partition = scope.partition;
  const expectedPrefix = 'arn:' + partition + ':sts::' + scope.account_id
    + ':assumed-role/' + scope.expected_assumed_role_name + '/';
  if (account !== scope.account_id || !arn || !arn.startsWith(expectedPrefix)) {
    return fail('STS caller identity does not match the expected account and dedicated ElastiCache reader role');
  }
  return 'aws-principal.' + sha256(arn).slice(0, 40);
}

async function paginate(
  scope: AwsElastiCacheRedisBackupScope,
  action: string,
  resultTag: string,
  collectionTag: string,
  itemTag: string,
  parameters: Record<string, string>,
  fetcher: typeof fetch,
  timeoutMs: number,
  now: () => Date,
  budget: MutableBudget,
  limits: ValidatedLimits,
): Promise<PageResult> {
  const records: string[] = [];
  const receipts: string[] = [];
  const seenMarkers = new Set<string>();
  let marker: string | null = null;
  let pages = 0;
  do {
    if (pages >= limits.max_pages || budget.pages >= limits.max_pages) {
      return fail(action + ' exhausted the global page budget');
    }
    const requestParameters = { ...parameters };
    if (marker !== null) requestParameters.Marker = marker;
    const xml = await signedQuery('elasticache', scope, action, requestParameters,
      fetcher, timeoutMs, now, budget, limits.max_pages);
    const result = xmlBlocks(xml, resultTag)[0];
    if (!result) return fail(action + ' response omitted its result container');
    const collection = xmlBlocks(result, collectionTag)[0];
    if (!collection && !xml.includes('<' + collectionTag + '/>')) {
      return fail(action + ' response omitted its collection container');
    }
    const pageRecords = collection ? xmlBlocks(collection, itemTag) : [];
    if (budget.items + pageRecords.length > limits.max_items) {
      return fail(action + ' exceeded the global item budget');
    }
    budget.items += pageRecords.length;
    records.push(...pageRecords);
    pages += 1;
    budget.pages += 1;
    receipts.push('elasticache.' + action.toLowerCase() + '.' + scope.account_id + '.'
      + scope.region + '.' + sha256(xml).slice(0, 32));
    const next = xmlText(result, 'Marker');
    if (next !== null && next.length > 4096) return fail(action + ' returned an oversized continuation marker');
    if (next !== null && seenMarkers.has(next)) return fail(action + ' returned a repeated continuation marker');
    if (next !== null) seenMarkers.add(next);
    marker = next;
  } while (marker !== null);
  return { records, pages, receipts };
}


async function paginateNextToken(
  scope: AwsElastiCacheRedisBackupScope,
  action: string,
  resultTag: string,
  collectionTag: string,
  itemTag: string,
  parameters: Record<string, string>,
  fetcher: typeof fetch,
  timeoutMs: number,
  now: () => Date,
  budget: MutableBudget,
  limits: ValidatedLimits,
): Promise<PageResult> {
  const records: string[] = [];
  const receipts: string[] = [];
  const seenTokens = new Set<string>();
  let nextToken: string | null = null;
  let pages = 0;
  do {
    if (pages >= limits.max_pages || budget.pages >= limits.max_pages) {
      return fail(action + ' exhausted the global page budget');
    }
    const requestParameters = { ...parameters };
    if (nextToken !== null) requestParameters.NextToken = nextToken;
    const xml = await signedQuery('elasticache', scope, action, requestParameters,
      fetcher, timeoutMs, now, budget, limits.max_pages);
    const result = xmlBlocks(xml, resultTag)[0];
    if (!result) return fail(action + ' response omitted its result container');
    const collection = xmlBlocks(result, collectionTag)[0];
    if (!collection) return fail(action + ' response omitted its collection container');
    const pageRecords = xmlBlocks(collection, itemTag);
    if (budget.items + pageRecords.length > limits.max_items) {
      return fail(action + ' exceeded the global item budget');
    }
    budget.items += pageRecords.length;
    records.push(...pageRecords);
    pages += 1;
    budget.pages += 1;
    receipts.push('elasticache.' + action.toLowerCase() + '.' + scope.account_id + '.'
      + scope.region + '.' + sha256(xml).slice(0, 32));
    const next = xmlText(result, 'NextToken');
    const normalizedNext = next === null || next.length === 0 ? null : next;
    if (normalizedNext !== null && normalizedNext.length > 4096) {
      return fail(action + ' returned an oversized continuation token');
    }
    if (normalizedNext !== null && seenTokens.has(normalizedNext)) {
      return fail(action + ' returned a repeated continuation token');
    }
    if (normalizedNext !== null) seenTokens.add(normalizedNext);
    nextToken = normalizedNext;
  } while (nextToken !== null);
  return { records, pages, receipts };
}

function serverlessEngine(value: string | null): 'redis' | 'valkey' | 'memcached' {
  const engine = value?.toLowerCase();
  if (engine === 'redis' || engine === 'valkey' || engine === 'memcached') return engine;
  return fail('DescribeServerlessCaches returned an unsupported engine value');
}

function validScopedElastiCacheArn(
  value: string | null,
  scope: AwsElastiCacheRedisBackupScope,
  field: string,
): string {
  const arn = validIdentifier(value, field);
  const expectedPrefix = 'arn:' + scope.partition + ':elasticache:' + scope.region + ':' + scope.account_id + ':';
  if (!arn.startsWith(expectedPrefix) || arn.length > 1024) {
    return fail(field + ' does not belong to the verified account and region');
  }
  return arn;
}

function parseServerlessCache(
  xml: string,
  scope: AwsElastiCacheRedisBackupScope,
): AwsElastiCacheServerlessCacheRecord {
  const cacheName = validIdentifier(directXmlText(xml, 'ServerlessCacheName'), 'ServerlessCacheName');
  return {
    account_id: scope.account_id,
    region: scope.region,
    cache_name: cacheName,
    cache_arn: validScopedElastiCacheArn(directXmlText(xml, 'ARN'), scope, 'ServerlessCache ARN'),
    engine: serverlessEngine(directXmlText(xml, 'Engine')),
    major_engine_version: directXmlText(xml, 'MajorEngineVersion'),
    full_engine_version: directXmlText(xml, 'FullEngineVersion'),
    status: validIdentifier(directXmlText(xml, 'Status'), 'ServerlessCache Status'),
    snapshot_retention_limit_days: optionalInteger(directXmlText(xml, 'SnapshotRetentionLimit')),
    daily_snapshot_time: directXmlText(xml, 'DailySnapshotTime'),
    storage_encryption_type: directXmlText(xml, 'StorageEncryptionType'),
    create_time: canonicalTimestamp(directXmlText(xml, 'CreateTime')),
  };
}

function parseServerlessSnapshot(
  xml: string,
  scope: AwsElastiCacheRedisBackupScope,
): AwsElastiCacheServerlessSnapshotRecord {
  const snapshotName = validIdentifier(
    directXmlText(xml, 'ServerlessCacheSnapshotName'), 'ServerlessCacheSnapshotName',
  );
  const configuration = xmlBlocks(xml, 'ServerlessCacheConfiguration')[0] ?? '';
  const cacheName = validIdentifier(
    directXmlText(configuration, 'ServerlessCacheName'), 'ServerlessCacheConfiguration ServerlessCacheName',
  );
  const engineValue = directXmlText(configuration, 'Engine');
  const engine = engineValue ? serverlessEngine(engineValue) : null;
  const bytes = directXmlText(xml, 'BytesUsedForCache');
  if (bytes !== null && !/^\\d{1,20}$/.test(bytes)) {
    return fail('serverless snapshot byte count is malformed');
  }
  const snapshotArn = validScopedElastiCacheArn(directXmlText(xml, 'ARN'), scope, 'ServerlessCacheSnapshot ARN');
  const createTime = canonicalTimestamp(directXmlText(xml, 'CreateTime'));
  return {
    account_id: scope.account_id,
    region: scope.region,
    snapshot_name: snapshotName,
    snapshot_arn: snapshotArn,
    snapshot_identity_reference: 'elasticache-serverless-snapshot.' + sha256(snapshotArn).slice(0, 40),
    snapshot_identity_kind: 'PROVIDER_SNAPSHOT_ARN',
    cache_name: cacheName,
    snapshot_type: validIdentifier(directXmlText(xml, 'SnapshotType'), 'ServerlessCacheSnapshot SnapshotType'),
    status: validIdentifier(directXmlText(xml, 'Status'), 'ServerlessCacheSnapshot Status'),
    create_time: createTime,
    expiry_time: canonicalTimestamp(directXmlText(xml, 'ExpiryTime')),
    bytes_used_for_cache: bytes,
    engine,
    major_engine_version: directXmlText(configuration, 'MajorEngineVersion'),
  };
}

function redisEngine(value: string | null): 'redis' | 'valkey' | null {
  const engine = value?.toLowerCase();
  return engine === 'redis' || engine === 'valkey' ? engine : null;
}

function parseCacheCluster(
  xml: string,
  scope: AwsElastiCacheRedisBackupScope,
): AwsElastiCacheRedisCacheClusterRecord | null {
  const engine = redisEngine(directXmlText(xml, 'Engine'));
  if (!engine) return null;
  const createdAt = canonicalTimestamp(directXmlText(xml, 'CacheClusterCreateTime'));
  return {
    account_id: scope.account_id,
    region: scope.region,
    cache_cluster_id: validIdentifier(directXmlText(xml, 'CacheClusterId'), 'CacheClusterId'),
    engine,
    engine_version: directXmlText(xml, 'EngineVersion'),
    status: validIdentifier(directXmlText(xml, 'CacheClusterStatus'), 'CacheClusterStatus'),
    replication_group_id: directXmlText(xml, 'ReplicationGroupId'),
    cache_node_type: directXmlText(xml, 'CacheNodeType'),
    num_cache_nodes: optionalInteger(directXmlText(xml, 'NumCacheNodes')),
    snapshot_retention_limit_days: optionalInteger(directXmlText(xml, 'SnapshotRetentionLimit')),
    snapshot_window: directXmlText(xml, 'SnapshotWindow'),
    created_at: createdAt,
  };
}

function parseReplicationGroup(
  xml: string,
  scope: AwsElastiCacheRedisBackupScope,
): AwsElastiCacheRedisReplicationGroupRecord {
  const memberClusters = childRecords(xml, 'MemberClusters', 'ClusterId')
    .map((block) => xmlText(block, 'ClusterId') ?? decodeXml(block.replace(/<[^>]+>/g, '').trim()))
    .filter((value) => value.length > 0)
    .sort();
  const nodeGroups = childRecords(xml, 'NodeGroups', 'NodeGroup');
  const memberNodeRoles = nodeGroups.flatMap((nodeGroup) =>
    childRecords(nodeGroup, 'NodeGroupMembers', 'NodeGroupMember').map((member) => ({
      cache_cluster_id: validIdentifier(xmlText(member, 'CacheClusterId'), 'NodeGroupMember CacheClusterId'),
      cache_node_id: xmlText(member, 'CacheNodeId'),
      current_role: xmlText(member, 'CurrentRole'),
      availability_zone: xmlText(member, 'PreferredAvailabilityZone'),
    }))).sort((a, b) => a.cache_cluster_id.localeCompare(b.cache_cluster_id));
  return {
    account_id: scope.account_id,
    region: scope.region,
    replication_group_id: validIdentifier(directXmlText(xml, 'ReplicationGroupId'), 'ReplicationGroupId'),
    status: validIdentifier(directXmlText(xml, 'Status'), 'ReplicationGroup Status'),
    global_replication_group_id: xmlText(xml, 'GlobalReplicationGroupInfo')
      ? nestedText(xml, 'GlobalReplicationGroupInfo', 'GlobalReplicationGroupId') : null,
    multi_az: optionalBoolean(directXmlText(xml, 'MultiAZ')),
    automatic_failover: directXmlText(xml, 'AutomaticFailover'),
    cluster_enabled: optionalBoolean(directXmlText(xml, 'ClusterEnabled')),
    snapshot_retention_limit_days: optionalInteger(directXmlText(xml, 'SnapshotRetentionLimit')),
    snapshot_window: directXmlText(xml, 'SnapshotWindow'),
    snapshotting_cluster_id: directXmlText(xml, 'SnapshottingClusterId'),
    member_cluster_ids: [...new Set(memberClusters)].sort(),
    node_group_ids: nodeGroups.map((nodeGroup) => xmlText(nodeGroup, 'NodeGroupId'))
      .filter((value): value is string => value !== null).sort(),
    member_node_roles: memberNodeRoles,
  };
}

function parseGlobalReplicationGroup(
  xml: string,
  scope: AwsElastiCacheRedisBackupScope,
): AwsElastiCacheRedisGlobalReplicationGroupRecord {
  const memberContainer = xmlBlocks(xml, 'Members')[0];
  const members = memberContainer ? xmlBlocks(memberContainer, 'GlobalReplicationGroupMember') : [];
  const parsedMembers = members.map((member) => ({
    region: validIdentifier(xmlText(member, 'ReplicationGroupRegion'), 'Global Datastore member region'),
    replication_group_id: validIdentifier(xmlText(member, 'ReplicationGroupId'), 'Global Datastore member ReplicationGroupId'),
    role: xmlText(member, 'Role'),
    status: xmlText(member, 'Status'),
  })).sort((a, b) => a.region.localeCompare(b.region) || a.replication_group_id.localeCompare(b.replication_group_id));
  if (parsedMembers.length === 0) return fail('DescribeGlobalReplicationGroups omitted ShowMemberInfo results');
  if (new Set(parsedMembers.map((member) => member.region + ':' + member.replication_group_id)).size !== parsedMembers.length) {
    return fail('Global Datastore returned duplicate regional replication group members');
  }
  return {
    account_id: scope.account_id,
    global_replication_group_id: validIdentifier(directXmlText(xml, 'GlobalReplicationGroupId'), 'GlobalReplicationGroupId'),
    status: validIdentifier(directXmlText(xml, 'Status'), 'GlobalReplicationGroup Status'),
    engine: directXmlText(xml, 'Engine'),
    engine_version: directXmlText(xml, 'EngineVersion'),
    cache_node_type: directXmlText(xml, 'CacheNodeType'),
    cluster_enabled: optionalBoolean(directXmlText(xml, 'ClusterEnabled')),
    members: parsedMembers,
    observed_in_regions: [scope.region],
  };
}

function parseSnapshot(
  xml: string,
  scope: AwsElastiCacheRedisBackupScope,
): AwsElastiCacheRedisSnapshotRecord | null {
  const engine = redisEngine(directXmlText(xml, 'Engine'));
  if (!engine) return null;
  const snapshotName = validIdentifier(directXmlText(xml, 'SnapshotName'), 'SnapshotName');
  const createTime = canonicalTimestamp(directXmlText(xml, 'SnapshotCreateTime'))
    ?? canonicalTimestamp(xmlText(childRecords(xml, 'NodeSnapshots', 'NodeSnapshot')[0] ?? '', 'SnapshotCreateTime'));
  const nodeSnapshots = childRecords(xml, 'NodeSnapshots', 'NodeSnapshot').map((node) => ({
    cache_node_id: xmlText(node, 'CacheNodeId'),
    snapshot_create_time: canonicalTimestamp(xmlText(node, 'SnapshotCreateTime')),
  }));
  const identityMaterial = [
    scope.partition, scope.account_id, scope.region, snapshotName, createTime ?? 'GENERATION_TIME_UNKNOWN',
  ].join('|');
  return {
    account_id: scope.account_id,
    region: scope.region,
    snapshot_name: snapshotName,
    snapshot_identity_reference: 'elasticache-snapshot.' + sha256(identityMaterial).slice(0, 40),
    snapshot_identity_kind: 'SNAPSHOT_NAME_AND_CREATE_TIME',
    replication_group_id: directXmlText(xml, 'ReplicationGroupId'),
    cache_cluster_id: directXmlText(xml, 'CacheClusterId'),
    status: validIdentifier(directXmlText(xml, 'SnapshotStatus'), 'SnapshotStatus'),
    source: directXmlText(xml, 'SnapshotSource'),
    engine,
    engine_version: directXmlText(xml, 'EngineVersion'),
    cache_node_type: directXmlText(xml, 'CacheNodeType'),
    create_time: createTime,
    num_cache_nodes: optionalInteger(directXmlText(xml, 'NumCacheNodes')),
    node_snapshots: nodeSnapshots,
  };
}

function mergeGlobalReplicationGroups(
  records: AwsElastiCacheRedisGlobalReplicationGroupRecord[],
  blockers: Set<string>,
): AwsElastiCacheRedisGlobalReplicationGroupRecord[] {
  const merged = new Map<string, AwsElastiCacheRedisGlobalReplicationGroupRecord>();
  for (const record of records) {
    const key = record.account_id + ':' + record.global_replication_group_id;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...record, members: [...record.members], observed_in_regions: [...record.observed_in_regions] });
      continue;
    }
    const previous = JSON.stringify({
      status: existing.status,
      engine: existing.engine,
      engine_version: existing.engine_version,
      cache_node_type: existing.cache_node_type,
      cluster_enabled: existing.cluster_enabled,
      members: existing.members,
    });
    const current = JSON.stringify({
      status: record.status,
      engine: record.engine,
      engine_version: record.engine_version,
      cache_node_type: record.cache_node_type,
      cluster_enabled: record.cluster_enabled,
      members: record.members,
    });
    if (previous !== current) blockers.add(record.account_id + ':GLOBAL_DATASTORE_CATALOG_DISAGREEMENT:' + record.global_replication_group_id);
    existing.observed_in_regions = [...new Set([...existing.observed_in_regions, ...record.observed_in_regions])].sort();
  }
  return [...merged.values()].sort((a, b) =>
    a.account_id.localeCompare(b.account_id) || a.global_replication_group_id.localeCompare(b.global_replication_group_id));
}

/**
 * Read-only account/region inventory for node-based ElastiCache Redis OSS/Valkey.
 * Credentials must already belong to a narrowly scoped assumed reader role.
 * The adapter intentionally has no mutation, copy, restore or delete operation.
 */
export async function captureAwsElastiCacheRedisBackupInventory(
  input: AwsElastiCacheRedisBackupInventoryInput,
): Promise<AwsElastiCacheRedisBackupInventory> {
  if (!isRecord(input)) return fail('inventory input is invalid');
  const limits = validateLimits(input);
  const scopes = validateScopes(input.scopes);
  const now = input.now ?? (() => new Date());
  const fetcher = input.fetcher ?? globalThis.fetch;
  const clock = now();
  if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) return fail('inventory clock is invalid');
  const budget: MutableBudget = { requests: 0, pages: 0, items: 0 };
  const blockers = new Set<string>();
  const receipts: string[] = [];
  const cacheClusters: AwsElastiCacheRedisCacheClusterRecord[] = [];
  const replicationGroups: AwsElastiCacheRedisReplicationGroupRecord[] = [];
  const globalReplicationGroups: AwsElastiCacheRedisGlobalReplicationGroupRecord[] = [];
  const snapshots: AwsElastiCacheRedisSnapshotRecord[] = [];
  const serverlessCaches: AwsElastiCacheServerlessCacheRecord[] = [];
  const serverlessSnapshots: AwsElastiCacheServerlessSnapshotRecord[] = [];
  const serverlessBlockers = new Set<string>();
  let serverlessActionsCompleted = 0;
  const nonRedisClusters: number[] = [];
  const verifiedScopes: ApiScopeState[] = [];
  let pageFailure = false;

  for (const scope of scopes) {
    let identityReference: string;
    try {
      identityReference = await verifyScopeIdentity(scope, fetcher, limits.request_timeout_ms, now, budget, limits.max_pages);
      verifiedScopes.push({ scope, identity_verified: true });
    } catch {
      blockers.add(scope.account_id + ':' + scope.region + ':ASSUMED_ROLE_IDENTITY_VERIFICATION_FAILED');
      continue;
    }
    void identityReference;
    const actions: Array<{
      action: string;
      result: string;
      collection: string;
      item: string;
      parameters: Record<string, string>;
      nextToken?: boolean;
    }> = [
      {
        action: 'DescribeCacheClusters',
        result: 'DescribeCacheClustersResult',
        collection: 'CacheClusters',
        item: 'CacheCluster',
        parameters: { MaxRecords: '100', ShowCacheNodeInfo: 'false' },
      },
      {
        action: 'DescribeReplicationGroups',
        result: 'DescribeReplicationGroupsResult',
        collection: 'ReplicationGroups',
        item: 'ReplicationGroup',
        parameters: { MaxRecords: '100' },
      },
      {
        action: 'DescribeGlobalReplicationGroups',
        result: 'DescribeGlobalReplicationGroupsResult',
        collection: 'GlobalReplicationGroups',
        item: 'GlobalReplicationGroup',
        parameters: { MaxRecords: '100', ShowMemberInfo: 'true' },
      },
      {
        action: 'DescribeSnapshots',
        result: 'DescribeSnapshotsResult',
        collection: 'Snapshots',
        item: 'Snapshot',
        parameters: { MaxRecords: '50', ShowNodeGroupConfig: 'true' },
      },
      {
        action: 'DescribeServerlessCaches',
        result: 'DescribeServerlessCachesResult',
        collection: 'ServerlessCaches',
        item: 'member',
        parameters: { MaxResults: '50' },
        nextToken: true,
      },
      {
        action: 'DescribeServerlessCacheSnapshots',
        result: 'DescribeServerlessCacheSnapshotsResult',
        collection: 'ServerlessCacheSnapshots',
        item: 'ServerlessCacheSnapshot',
        parameters: { MaxResults: '50' },
        nextToken: true,
      },
    ];
    for (const action of actions) {
      try {
        const result = action.nextToken
          ? await paginateNextToken(
            scope, action.action, action.result, action.collection, action.item,
            action.parameters, fetcher, limits.request_timeout_ms, now, budget, limits,
          )
          : await paginate(
            scope, action.action, action.result, action.collection, action.item,
            action.parameters, fetcher, limits.request_timeout_ms, now, budget, limits,
          );
        receipts.push(...result.receipts);
        if (action.action === 'DescribeCacheClusters') {
          for (const raw of result.records) {
            const record = parseCacheCluster(raw, scope);
            if (record) cacheClusters.push(record);
            else nonRedisClusters.push(1);
          }
        } else if (action.action === 'DescribeReplicationGroups') {
          replicationGroups.push(...result.records.map((raw) => parseReplicationGroup(raw, scope)));
        } else if (action.action === 'DescribeGlobalReplicationGroups') {
          globalReplicationGroups.push(...result.records.map((raw) => parseGlobalReplicationGroup(raw, scope)));
        } else if (action.action === 'DescribeSnapshots') {
          for (const raw of result.records) {
            const record = parseSnapshot(raw, scope);
            if (record) {
              if (!record.create_time) blockers.add(scope.account_id + ':' + scope.region
                + ':SNAPSHOT_GENERATION_TIMESTAMP_MISSING:' + record.snapshot_name);
              snapshots.push(record);
            }
          }
        } else if (action.action === 'DescribeServerlessCaches') {
          for (const raw of result.records) {
            const record = parseServerlessCache(raw, scope);
            if (!record.create_time) {
              const blocker = scope.account_id + ':' + scope.region
                + ':SERVERLESS_CACHE_CREATE_TIME_MISSING:' + record.cache_name;
              serverlessBlockers.add(blocker);
              blockers.add(blocker);
            }
            serverlessCaches.push(record);
          }
          serverlessActionsCompleted += 1;
        } else if (action.action === 'DescribeServerlessCacheSnapshots') {
          for (const raw of result.records) {
            const record = parseServerlessSnapshot(raw, scope);
            if (!record.create_time) {
              const blocker = scope.account_id + ':' + scope.region
                + ':SERVERLESS_SNAPSHOT_CREATE_TIME_MISSING:' + record.snapshot_name;
              serverlessBlockers.add(blocker);
              blockers.add(blocker);
            }
            serverlessSnapshots.push(record);
          }
          serverlessActionsCompleted += 1;
        }
      } catch (error) {
        const errorText = error instanceof Error ? error.message : '';
        if (errorText.includes('global AWS request/page budget')) {
          blockers.add('GLOBAL_AWS_REQUEST_OR_PAGE_BUDGET_EXHAUSTED');
          if (action.nextToken) serverlessBlockers.add(scope.account_id + ':' + scope.region + ':SERVERLESS_CATALOG_BUDGET_EXHAUSTED');
          pageFailure = true;
          break;
        }
        if (errorText.includes('global item budget')) {
          blockers.add('GLOBAL_AWS_ITEM_BUDGET_EXHAUSTED');
          if (action.nextToken) serverlessBlockers.add(scope.account_id + ':' + scope.region + ':SERVERLESS_CATALOG_ITEM_BUDGET_EXHAUSTED');
          pageFailure = true;
          break;
        }
        const actionBlocker = scope.account_id + ':' + scope.region + ':'
          + (action.nextToken ? 'SERVERLESS_' : '') + action.action.toUpperCase() + '_INVENTORY_INCOMPLETE';
        blockers.add(actionBlocker);
        if (action.nextToken) serverlessBlockers.add(actionBlocker);
      }
    }
    if (pageFailure) break;
  }

  const requestedKeys = new Set(scopes.map((scope) => scope.account_id + ':' + scope.region));
  const unscannedGlobalMembers: AwsElastiCacheRedisBackupInventory['unscanned_global_member_scopes'] = [];
  for (const group of globalReplicationGroups) {
    for (const member of group.members) {
      const key = group.account_id + ':' + member.region;
      if (!requestedKeys.has(key)) {
        const sourceScope = scopes.find((scope) => scope.account_id === group.account_id);
        if (sourceScope) {
          unscannedGlobalMembers.push({
            account_id: group.account_id,
            partition: sourceScope.partition,
            region: member.region,
            global_replication_group_id: group.global_replication_group_id,
            replication_group_id: member.replication_group_id,
          });
          blockers.add(group.account_id + ':' + member.region + ':GLOBAL_DATASTORE_MEMBER_REGION_NOT_SCANNED');
        }
      }
    }
  }
  const globalMembers = new Map<string, AwsElastiCacheRedisReplicationGroupRecord>();
  replicationGroups.forEach((group) => globalMembers.set(group.account_id + ':' + group.region + ':' + group.replication_group_id, group));
  for (const globalGroup of globalReplicationGroups) {
    for (const member of globalGroup.members) {
      if (requestedKeys.has(globalGroup.account_id + ':' + member.region)
        && !globalMembers.has(globalGroup.account_id + ':' + member.region + ':' + member.replication_group_id)) {
        blockers.add(globalGroup.account_id + ':' + member.region + ':GLOBAL_DATASTORE_MEMBER_REPLICATION_GROUP_NOT_IN_LOCAL_CATALOG');
      }
    }
  }
  const mergedGlobals = mergeGlobalReplicationGroups(globalReplicationGroups, blockers);
  const cacheNames = new Set(serverlessCaches.map((cache) => cache.account_id + ':' + cache.region + ':' + cache.cache_name));
  for (const snapshot of serverlessSnapshots) {
    if (!cacheNames.has(snapshot.account_id + ':' + snapshot.region + ':' + snapshot.cache_name)) {
      const blocker = snapshot.account_id + ':' + snapshot.region
        + ':SERVERLESS_SNAPSHOT_SOURCE_CACHE_NOT_IN_CURRENT_CATALOG:' + snapshot.cache_name;
      serverlessBlockers.add(blocker);
      blockers.add(blocker);
    }
  }
  for (const blocker of serverlessBlockers) blockers.add(blocker);
  const uniqueBlockers = [...blockers].sort();
  const nodeBasedBlockers = uniqueBlockers.filter((blocker) => !serverlessBlockers.has(blocker));
  const nodeBasedComplete = nodeBasedBlockers.length === 0 && verifiedScopes.length === scopes.length;
  const serverlessCatalogComplete = serverlessBlockers.size === 0
    && serverlessActionsCompleted === scopes.length * 2
    && verifiedScopes.length === scopes.length;
  const inventoryComplete = nodeBasedComplete && serverlessCatalogComplete;
  return {
    schema: 'factoryos.aws-elasticache-redis-backup-inventory/v1',
    status: inventoryComplete ? 'COMPLETE' : 'PARTIAL',
    generated_at: clock.toISOString(),
    requested_scopes: scopes.map(({ account_id, partition, region }) => ({ account_id, partition, region })),
    verified_scope_count: verifiedScopes.length,
    cache_clusters: cacheClusters.sort((a, b) =>
      a.account_id.localeCompare(b.account_id) || a.region.localeCompare(b.region) || a.cache_cluster_id.localeCompare(b.cache_cluster_id)),
    replication_groups: replicationGroups.sort((a, b) =>
      a.account_id.localeCompare(b.account_id) || a.region.localeCompare(b.region) || a.replication_group_id.localeCompare(b.replication_group_id)),
    global_replication_groups: mergedGlobals,
    snapshots: snapshots.sort((a, b) =>
      a.account_id.localeCompare(b.account_id) || a.region.localeCompare(b.region)
      || a.snapshot_name.localeCompare(b.snapshot_name) || (a.create_time ?? '').localeCompare(b.create_time ?? '')),
    serverless_caches: serverlessCaches.sort((a, b) =>
      a.account_id.localeCompare(b.account_id) || a.region.localeCompare(b.region) || a.cache_name.localeCompare(b.cache_name)),
    serverless_snapshots: serverlessSnapshots.sort((a, b) =>
      a.account_id.localeCompare(b.account_id) || a.region.localeCompare(b.region)
      || a.snapshot_name.localeCompare(b.snapshot_name) || (a.create_time ?? '').localeCompare(b.create_time ?? '')),
    non_redis_cache_clusters_excluded: nonRedisClusters.length,
    unscanned_global_member_scopes: unscannedGlobalMembers.sort((a, b) =>
      a.account_id.localeCompare(b.account_id) || a.region.localeCompare(b.region)
      || a.replication_group_id.localeCompare(b.replication_group_id)),
    pages_fetched: budget.pages,
    requests_attempted: budget.requests,
    items_observed: budget.items,
    query_receipt_references: [...new Set(receipts)].sort(),
    blockers: uniqueBlockers,
    node_based_catalog_complete: nodeBasedComplete,
    serverless_catalog_complete: serverlessCatalogComplete,
    serverless_cache_and_snapshot_surfaces_enumerated: serverlessCatalogComplete,
    self_managed_redis_aof_rdb_and_volume_backup_surfaces_enumerated: false,
    whole_cache_backup_coverage_complete: false,
    provider_mutation_performed: false,
    delete_api_available: false,
    deletion_authorized: false,
  };
}
