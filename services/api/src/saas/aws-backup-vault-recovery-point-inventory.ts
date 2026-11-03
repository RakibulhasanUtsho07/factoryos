import { createHash, createHmac } from 'node:crypto';

const STS_API_VERSION = '2011-06-15';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SCOPES = 500;
const MAX_HARD_PAGES = 50000;
const MAX_HARD_ITEMS = 100000;
const MAX_HARD_REQUESTS = 100000;
const ACCOUNT_ID = /^\d{12}$/;
const ROLE_NAME = /^[A-Za-z0-9+=,.@_-]{1,64}$/;
const VAULT_TYPES = [
  'BACKUP_VAULT',
  'LOGICALLY_AIR_GAPPED_BACKUP_VAULT',
  'RESTORE_ACCESS_BACKUP_VAULT',
] as const;

export type AwsBackupPartition = 'aws' | 'aws-us-gov' | 'aws-cn';
export type AwsBackupVaultType = typeof VAULT_TYPES[number];

export interface AwsBackupInventoryCredentials {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
}

export interface AwsBackupInventoryScope {
  account_id: string;
  partition: AwsBackupPartition;
  region: string;
  expected_assumed_role_name: string;
  credentials: AwsBackupInventoryCredentials;
}

export interface AwsBackupVaultRecoveryPointInventoryInput {
  scopes: AwsBackupInventoryScope[];
  fetcher?: typeof fetch;
  now?: () => Date;
  max_pages?: number;
  max_requests?: number;
  max_items?: number;
  request_timeout_ms?: number;
}

export interface AwsBackupVaultRecord {
  account_id: string;
  partition: AwsBackupPartition;
  region: string;
  backup_vault_name: string;
  backup_vault_arn: string;
  vault_type: AwsBackupVaultType | null;
  vault_state: string | null;
  creation_date: string | null;
  encryption_key_arn: string | null;
  encryption_key_type: string | null;
  number_of_recovery_points_reported: number | null;
  locked: boolean | null;
  min_retention_days: number | null;
  max_retention_days: number | null;
  lock_date: string | null;
  source_backup_vault_arn: string | null;
}

export interface AwsBackupRecoveryPointRecord {
  account_id: string;
  partition: AwsBackupPartition;
  region: string;
  recovery_point_arn: string;
  backup_vault_name: string;
  backup_vault_arn: string;
  vault_type: AwsBackupVaultType | null;
  resource_arn: string | null;
  resource_type: string | null;
  resource_name: string | null;
  status: string | null;
  creation_date: string | null;
  completion_date: string | null;
  initiation_date: string | null;
  last_restore_time: string | null;
  backup_size_in_bytes: number | null;
  is_encrypted: boolean | null;
  encryption_key_arn: string | null;
  encryption_key_type: string | null;
  source_backup_vault_arn: string | null;
  backup_plan_arn: string | null;
  backup_plan_id: string | null;
  backup_plan_version: string | null;
  backup_rule_id: string | null;
  backup_rule_name: string | null;
  lifecycle_delete_after_days: number | null;
  lifecycle_delete_after_event: string | null;
  lifecycle_move_to_cold_storage_after_days: number | null;
  lifecycle_opt_in_to_archive: boolean | null;
  calculated_delete_at: string | null;
  calculated_move_to_cold_storage_at: string | null;
  is_parent: boolean | null;
  parent_recovery_point_arn: string | null;
  composite_member_identifier: string | null;
}

export interface AwsBackupLegalHoldRecord {
  account_id: string;
  partition: AwsBackupPartition;
  region: string;
  legal_hold_id: string;
  legal_hold_arn: string | null;
  status: string | null;
  creation_date: string | null;
  cancellation_date: string | null;
  retain_record_until: string | null;
  selected_vault_names: string[];
  selected_resource_identifier_count: number;
  selection_from_date: string | null;
  selection_to_date: string | null;
}

export interface AwsBackupLegalHoldRecoveryPointRelationship {
  account_id: string;
  region: string;
  legal_hold_id: string;
  legal_hold_status: string | null;
  recovery_point_arn: string;
  backup_vault_name: string | null;
  resource_arn: string | null;
  resource_type: string | null;
}

export interface AwsBackupRestoreAccessVaultRelationship {
  account_id: string;
  region: string;
  source_backup_vault_arn: string;
  restore_access_backup_vault_arn: string;
  vault_state: string | null;
  creation_date: string | null;
  approval_date: string | null;
  latest_revoke_status: string | null;
  latest_revoke_initiation_date: string | null;
  latest_revoke_expiry_date: string | null;
}

export type AwsBackupCopyJobState = 'CREATED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PARTIAL';

export interface AwsBackupCopyJobRecord {
  account_id: string;
  partition: AwsBackupPartition;
  region: string;
  copy_job_id: string;
  state: AwsBackupCopyJobState | null;
  creation_date: string | null;
  completion_date: string | null;
  backup_size_in_bytes: number | null;
  resource_arn: string | null;
  resource_type: string | null;
  source_backup_vault_arn: string;
  source_recovery_point_arn: string;
  destination_backup_vault_arn: string;
  destination_recovery_point_arn: string | null;
  destination_encryption_key_arn: string | null;
  destination_vault_lock_state: string | null;
  destination_vault_type: 'BACKUP_VAULT' | 'LOGICALLY_AIR_GAPPED_BACKUP_VAULT' | null;
  destination_lifecycle_delete_after_days: number | null;
  destination_lifecycle_move_to_cold_storage_after_days: number | null;
  destination_lifecycle_opt_in_to_archive: boolean | null;
  backup_plan_arn: string | null;
  backup_plan_id: string | null;
  backup_plan_name: string | null;
  backup_plan_version: string | null;
  backup_rule_id: string | null;
  backup_rule_name: string | null;
  created_by_backup_job_id: string | null;
  parent_job_id: string | null;
  is_parent: boolean | null;
  number_of_child_jobs: number | null;
  composite_member_identifier: string | null;
  message_category: string | null;
}

export interface AwsBackupVaultRecoveryPointInventory {
  schema: 'factoryos.aws-backup-vault-recovery-point-inventory/v1';
  status: 'COMPLETE' | 'PARTIAL';
  generated_at: string;
  requested_scopes: Array<{ account_id: string; partition: AwsBackupPartition; region: string }>;
  verified_scope_count: number;
  vaults: AwsBackupVaultRecord[];
  recovery_points: AwsBackupRecoveryPointRecord[];
  legal_holds: AwsBackupLegalHoldRecord[];
  legal_hold_recovery_point_relationships: AwsBackupLegalHoldRecoveryPointRelationship[];
  restore_access_vault_relationships: AwsBackupRestoreAccessVaultRelationship[];
  copy_jobs: AwsBackupCopyJobRecord[];
  copy_job_terminal_record_retention_days: 30;
  copy_job_catalog_complete: boolean;
  copy_job_destination_reconciliation_complete: boolean;
  copy_job_source_scope_gaps: string[];
  copy_job_destination_scope_gaps: string[];
  copy_job_vault_catalog_gaps: string[];
  copy_job_recovery_point_catalog_gaps: string[];
  cross_account_copy_job_count: number;
  cross_region_copy_job_count: number;
  vault_types_supported: AwsBackupVaultType[];
  observed_vault_types: AwsBackupVaultType[];
  vault_catalog_complete: boolean;
  recovery_point_catalog_complete: boolean;
  legal_hold_catalog_complete: boolean;
  restore_access_relationships_complete: boolean;
  source_vault_scope_gaps: string[];
  pages_fetched: number;
  requests_attempted: number;
  items_observed: number;
  query_receipt_references: string[];
  blockers: string[];
  aws_backup_copy_job_catalog_enumerated: boolean;
  non_aws_backup_external_copy_surfaces_enumerated: false;
  whole_backup_coverage_complete: false;
  provider_mutation_performed: false;
  restore_api_available: false;
  copy_api_available: false;
  delete_api_available: false;
  deletion_authorized: false;
}

interface Limits {
  max_pages: number;
  max_requests: number;
  max_items: number;
  request_timeout_ms: number;
}

interface Budget {
  pages: number;
  requests: number;
  items: number;
}

interface Context {
  fetcher: typeof fetch;
  now: () => Date;
  limits: Limits;
  budget: Budget;
  receipts: string[];
}

interface PageSet<T> {
  items: T[];
  complete: boolean;
}

function fail(message: string): never {
  throw new Error('AWS Backup vault/recovery-point inventory refused: ' + message);
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

function validateCredentials(value: AwsBackupInventoryCredentials): AwsBackupInventoryCredentials {
  if (!isRecord(value) || typeof value.access_key_id !== 'string'
    || !/^[A-Z0-9]{16,128}$/.test(value.access_key_id)
    || typeof value.secret_access_key !== 'string' || value.secret_access_key.length < 20
    || /[\r\n]/.test(value.secret_access_key)
    || (value.session_token !== undefined
      && (typeof value.session_token !== 'string' || value.session_token.length < 16
        || /[\r\n]/.test(value.session_token)))) {
    return fail('assumed reader credentials are malformed or incomplete');
  }
  return value;
}

function validateScopes(scopes: AwsBackupInventoryScope[]): AwsBackupInventoryScope[] {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > MAX_SCOPES) {
    return fail('one to 500 explicitly requested account/region scopes are required');
  }
  const seen = new Set<string>();
  return scopes.map((scope) => {
    if (!isRecord(scope) || !ACCOUNT_ID.test(scope.account_id)
      || !['aws', 'aws-us-gov', 'aws-cn'].includes(scope.partition)
      || !validRegion(scope.region) || !ROLE_NAME.test(scope.expected_assumed_role_name)
      || !scope.credentials) {
      return fail('AWS Backup reader scope identity or role binding is invalid');
    }
    const expectedPartition = scope.region.startsWith('cn-') ? 'aws-cn'
      : scope.region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws';
    if (scope.partition !== expectedPartition) return fail('scope region and AWS partition do not match');
    validateCredentials(scope.credentials);
    const key = scope.account_id + ':' + scope.region;
    if (seen.has(key)) return fail('duplicate account/region scope was supplied');
    seen.add(key);
    return scope;
  }).sort((a, b) => a.account_id.localeCompare(b.account_id) || a.region.localeCompare(b.region));
}

function validateLimits(input: AwsBackupVaultRecoveryPointInventoryInput): Limits {
  const maxPages = input.max_pages ?? 10000;
  const maxRequests = input.max_requests ?? 25000;
  const maxItems = input.max_items ?? 20000;
  const timeout = input.request_timeout_ms ?? 10000;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_HARD_PAGES
    || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > MAX_HARD_REQUESTS
    || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > MAX_HARD_ITEMS
    || !Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 30000) {
    return fail('request, page, item or timeout budget is outside supported bounds');
  }
  return { max_pages: maxPages, max_requests: maxRequests, max_items: maxItems, request_timeout_ms: timeout };
}

function endpointHost(partition: AwsBackupPartition, region: string, service: 'sts' | 'backup'): string {
  const suffix = partition === 'aws-cn' ? 'amazonaws.com.cn' : 'amazonaws.com';
  return service + '.' + region + '.' + suffix;
}

function canonicalQuery(parameters: Record<string, string>): string {
  return Object.keys(parameters).sort((left, right) => {
    const a = rfc3986(left);
    const b = rfc3986(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }).map((key) => rfc3986(key) + '=' + rfc3986(parameters[key]!)).join('&');
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const date = new Date(value * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === 'string' && value.length > 0 && value.length <= 128) {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
  }
  return null;
}

function optionalInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function hasControlCharacters(value: string, allowWhitespaceControls = false): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 127 || (code <= 31
      && !(allowWhitespaceControls && (code === 9 || code === 10 || code === 13)))) {
      return true;
    }
  }
  return false;
}

function optionalString(value: unknown, maxLength = 2048): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength
    || hasControlCharacters(value, true)) return null;
  return value;
}

function validBackupArn(value: unknown, partition: AwsBackupPartition, serviceAccount?: string, serviceRegion?: string): string | null {
  const arn = optionalString(value, 2048);
  if (!arn) return null;
  const match = /^arn:(aws|aws-us-gov|aws-cn):backup:([a-z0-9-]+):(\d{12}):(backup-vault|recovery-point):(.+)$/.exec(arn);
  if (!match || match[1] !== partition || (serviceAccount && match[3] !== serviceAccount)
    || (serviceRegion && match[2] !== serviceRegion)) return null;
  return arn;
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

async function signedFetch(
  service: 'sts' | 'backup',
  scope: AwsBackupInventoryScope,
  method: 'GET' | 'POST',
  path: string,
  query: Record<string, string>,
  body: string,
  context: Context,
): Promise<string> {
  if (context.budget.requests >= context.limits.max_requests) return fail('global AWS request budget exhausted');
  context.budget.requests += 1;
  const credentials = validateCredentials(scope.credentials);
  const host = endpointHost(scope.partition, scope.region, service);
  const date = context.now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return fail('inventory clock is invalid');
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded; charset=utf-8';
  if (credentials.session_token) headers['x-amz-security-token'] = credentials.session_token;
  const headerNames = Object.keys(headers).sort();
  const canonicalHeaders = headerNames.map((name) =>
    name + ':' + headers[name]!.trim().replace(/\s+/g, ' ') + '\n').join('');
  const signedHeaders = headerNames.join(';');
  const queryString = canonicalQuery(query);
  const canonicalRequest = [method, path, queryString, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = dateStamp + '/' + scope.region + '/' + service + '/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac('AWS4' + credentials.secret_access_key, dateStamp), scope.region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  headers.authorization = 'AWS4-HMAC-SHA256 Credential=' + credentials.access_key_id + '/'
    + credentialScope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  const url = 'https://' + host + path + (queryString ? '?' + queryString : '');
  let response: Response;
  try {
    response = await context.fetcher(url, {
      method,
      headers,
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(context.limits.request_timeout_ms),
    });
  } catch {
    return fail(service + ' request failed before a verified response');
  }
  const text = await readBoundedResponse(response);
  if (!response.ok) {
    let code = 'HTTP_' + response.status;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) {
        const rawCode = optionalString(parsed.code ?? parsed.Code ?? parsed.__type, 160);
        if (rawCode) code = rawCode.split('#').pop()!.split(':').pop()!;
      }
    } catch {
      // The sanitized HTTP status is sufficient when an error body is not JSON.
    }
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(code)) code = 'SERVICE_ERROR';
    return fail(service + ' request denied or failed (' + code + ')');
  }
  return text;
}

function apiActionForPath(path: string): string {
  if (path === '/backup-vaults/') return 'ListBackupVaults';
  if (path === '/copy-jobs/') return 'ListCopyJobs';
  if (/^\/copy-jobs\/[^/]+$/.test(path)) return 'DescribeCopyJob';
  if (path === '/legal-holds/') return 'ListLegalHolds';
  if (/^\/backup-vaults\/[^/]+\/recovery-points\/$/.test(path)) return 'ListRecoveryPointsByBackupVault';
  if (/^\/backup-vaults\/[^/]+$/.test(path)) return 'DescribeBackupVault';
  if (/^\/logically-air-gapped-backup-vaults\/[^/]+\/restore-access-backup-vaults\/$/.test(path)) return 'ListRestoreAccessBackupVaults';
  if (/^\/legal-holds\/[^/]+\/recovery-points$/.test(path)) return 'ListRecoveryPointsByLegalHold';
  if (/^\/legal-holds\/[^/]+\/$/.test(path)) return 'GetLegalHold';
  return 'UnknownAWSBackupOperation';
}

async function backupGet(
  scope: AwsBackupInventoryScope,
  path: string,
  query: Record<string, string>,
  context: Context,
): Promise<Record<string, unknown>> {
  try {
    const text = await signedFetch('backup', scope, 'GET', path, query, '', context);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail('AWS Backup returned malformed JSON');
    }
    if (!isRecord(parsed)) return fail('AWS Backup response root is not an object');
    context.receipts.push('aws-backup-page.' + sha256(path + '\n' + canonicalQuery(query) + '\n' + text).slice(0, 40));
    return parsed;
  } catch (error) {
    throw new Error(apiActionForPath(path) + ': ' + safeError(error));
  }
}

async function verifyScopeIdentity(scope: AwsBackupInventoryScope, context: Context): Promise<void> {
  const form = new URLSearchParams({ Action: 'GetCallerIdentity', Version: STS_API_VERSION }).toString();
  const text = await signedFetch('sts', scope, 'POST', '/', {}, form, context);
  if (text.includes('<!DOCTYPE') || text.includes('<!ENTITY')) return fail('STS returned a prohibited XML DTD/entity declaration');
  const account = /<Account>([^<]+)<\/Account>/.exec(text)?.[1] ?? null;
  const arn = /<Arn>([^<]+)<\/Arn>/.exec(text)?.[1] ?? null;
  const expectedPrefix = 'arn:' + scope.partition + ':sts::' + scope.account_id
    + ':assumed-role/' + scope.expected_assumed_role_name + '/';
  if (account !== scope.account_id || !arn || !arn.startsWith(expectedPrefix)) {
    return fail('STS caller identity does not match the expected account and dedicated AWS Backup reader role');
  }
}

async function paginate<T>(
  scope: AwsBackupInventoryScope,
  path: string,
  collection: string,
  mapItem: (item: Record<string, unknown>) => T,
  context: Context,
): Promise<PageSet<T>> {
  const items: T[] = [];
  const seenTokens = new Set<string>();
  let nextToken: string | undefined;
  let complete = false;
  do {
    if (context.budget.pages >= context.limits.max_pages) return fail('global AWS Backup page budget exhausted');
    const query: Record<string, string> = { maxResults: '1000' };
    if (nextToken) query.nextToken = nextToken;
    const response = await backupGet(scope, path, query, context);
    context.budget.pages += 1;
    const pageItems = response[collection];
    if (!Array.isArray(pageItems)) return fail(collection + ' is missing or is not an array');
    context.budget.items += pageItems.length;
    if (context.budget.items > context.limits.max_items) return fail('global AWS Backup item budget exhausted');
    for (const item of pageItems) {
      if (!isRecord(item)) return fail(collection + ' contains a non-object item');
      items.push(mapItem(item));
    }
    const token = response.NextToken;
    if (token === undefined || token === null || token === '') {
      complete = true;
      nextToken = undefined;
    } else {
      if (typeof token !== 'string' || token.length > 2048 || hasControlCharacters(token)) {
        return fail('AWS Backup returned a malformed continuation token');
      }
      if (seenTokens.has(token)) return fail('AWS Backup repeated a continuation token');
      seenTokens.add(token);
      nextToken = token;
    }
  } while (nextToken);
  return { items, complete };
}

function vaultName(value: unknown): string {
  const name = optionalString(value, 50);
  if (!name || !/^[A-Za-z0-9_-]{2,50}$/.test(name)) return fail('backup vault name is missing or invalid');
  return name;
}

function normalizeVaultSummary(
  raw: Record<string, unknown>,
  scope: AwsBackupInventoryScope,
  blockers: string[],
): AwsBackupVaultRecord {
  const name = vaultName(raw.BackupVaultName);
  const arn = validBackupArn(raw.BackupVaultArn, scope.partition, scope.account_id, scope.region);
  if (!arn || !arn.startsWith('arn:' + scope.partition + ':backup:' + scope.region + ':' + scope.account_id + ':backup-vault:')) {
    blockers.push(scope.account_id + '/' + scope.region + ': backup vault ' + name + ' has a missing or out-of-scope ARN');
  }
  const rawType = optionalString(raw.VaultType, 100);
  const type = VAULT_TYPES.includes(rawType as AwsBackupVaultType) ? rawType as AwsBackupVaultType : null;
  if (!type) blockers.push(scope.account_id + '/' + scope.region + ': backup vault ' + name + ' has an unknown or missing VaultType');
  return {
    account_id: scope.account_id,
    partition: scope.partition,
    region: scope.region,
    backup_vault_name: name,
    backup_vault_arn: arn ?? String(raw.BackupVaultArn ?? ''),
    vault_type: type,
    vault_state: optionalString(raw.VaultState, 100),
    creation_date: canonicalTimestamp(raw.CreationDate),
    encryption_key_arn: optionalString(raw.EncryptionKeyArn, 2048),
    encryption_key_type: optionalString(raw.EncryptionKeyType, 100),
    number_of_recovery_points_reported: optionalInteger(raw.NumberOfRecoveryPoints),
    locked: optionalBoolean(raw.Locked),
    min_retention_days: optionalInteger(raw.MinRetentionDays),
    max_retention_days: optionalInteger(raw.MaxRetentionDays),
    lock_date: canonicalTimestamp(raw.LockDate),
    source_backup_vault_arn: optionalString(raw.SourceBackupVaultArn, 2048),
  };
}

function applyVaultDescription(
  summary: AwsBackupVaultRecord,
  detail: Record<string, unknown>,
  scope: AwsBackupInventoryScope,
  blockers: string[],
): AwsBackupVaultRecord {
  const arn = validBackupArn(detail.BackupVaultArn, scope.partition, scope.account_id, scope.region);
  if (arn && summary.backup_vault_arn && arn !== summary.backup_vault_arn) {
    blockers.push(scope.account_id + '/' + scope.region + ': DescribeBackupVault ARN differs from ListBackupVaults');
  }
  const type = optionalString(detail.VaultType, 100);
  if (type && !VAULT_TYPES.includes(type as AwsBackupVaultType)) {
    blockers.push(scope.account_id + '/' + scope.region + ': DescribeBackupVault returned an unknown VaultType');
  }
  return {
    ...summary,
    backup_vault_arn: arn ?? summary.backup_vault_arn,
    vault_type: type && VAULT_TYPES.includes(type as AwsBackupVaultType) ? type as AwsBackupVaultType : summary.vault_type,
    vault_state: optionalString(detail.VaultState, 100) ?? summary.vault_state,
    creation_date: canonicalTimestamp(detail.CreationDate) ?? summary.creation_date,
    encryption_key_arn: optionalString(detail.EncryptionKeyArn, 2048) ?? summary.encryption_key_arn,
    encryption_key_type: optionalString(detail.EncryptionKeyType, 100) ?? summary.encryption_key_type,
    number_of_recovery_points_reported: optionalInteger(detail.NumberOfRecoveryPoints)
      ?? summary.number_of_recovery_points_reported,
    locked: optionalBoolean(detail.Locked) ?? summary.locked,
    min_retention_days: optionalInteger(detail.MinRetentionDays) ?? summary.min_retention_days,
    max_retention_days: optionalInteger(detail.MaxRetentionDays) ?? summary.max_retention_days,
    lock_date: canonicalTimestamp(detail.LockDate) ?? summary.lock_date,
    source_backup_vault_arn: optionalString(detail.SourceBackupVaultArn, 2048) ?? summary.source_backup_vault_arn,
  };
}

function normalizeRecoveryPoint(
  raw: Record<string, unknown>,
  vault: AwsBackupVaultRecord,
  scope: AwsBackupInventoryScope,
  blockers: string[],
): AwsBackupRecoveryPointRecord {
  const arn = validBackupArn(raw.RecoveryPointArn, scope.partition, scope.account_id, scope.region);
  if (!arn || !arn.includes(':recovery-point:')) {
    blockers.push(scope.account_id + '/' + scope.region + '/' + vault.backup_vault_name
      + ': recovery point has a missing or out-of-scope ARN');
  }
  const creationDate = canonicalTimestamp(raw.CreationDate);
  if (!creationDate) {
    blockers.push(scope.account_id + '/' + scope.region + '/' + vault.backup_vault_name
      + ': a recovery point is missing a valid CreationDate');
  }
  const sourceArn = raw.SourceBackupVaultArn === undefined || raw.SourceBackupVaultArn === null
    ? null : validBackupArn(raw.SourceBackupVaultArn, scope.partition);
  if (raw.SourceBackupVaultArn && (!sourceArn || !sourceArn.includes(':backup-vault:'))) {
    blockers.push(scope.account_id + '/' + scope.region + '/' + vault.backup_vault_name
      + ': recovery point SourceBackupVaultArn is malformed or is not a backup-vault ARN');
  }
  const lifecycle = isRecord(raw.Lifecycle) ? raw.Lifecycle : {};
  const calculated = isRecord(raw.CalculatedLifecycle) ? raw.CalculatedLifecycle : {};
  const createdBy = isRecord(raw.CreatedBy) ? raw.CreatedBy : {};
  const backupSize = raw.BackupSizeInBytes === undefined || raw.BackupSizeInBytes === null
    ? null : optionalInteger(raw.BackupSizeInBytes);
  if (raw.BackupSizeInBytes !== undefined && raw.BackupSizeInBytes !== null && backupSize === null) {
    blockers.push(scope.account_id + '/' + scope.region + ': recovery point BackupSizeInBytes is not a safe non-negative integer');
  }
  return {
    account_id: scope.account_id,
    partition: scope.partition,
    region: scope.region,
    recovery_point_arn: arn ?? String(raw.RecoveryPointArn ?? ''),
    backup_vault_name: vault.backup_vault_name,
    backup_vault_arn: vault.backup_vault_arn,
    vault_type: vault.vault_type,
    resource_arn: optionalString(raw.ResourceArn, 2048),
    resource_type: optionalString(raw.ResourceType, 100),
    resource_name: optionalString(raw.ResourceName, 512),
    status: optionalString(raw.Status, 100),
    creation_date: creationDate,
    completion_date: canonicalTimestamp(raw.CompletionDate),
    initiation_date: canonicalTimestamp(raw.InitiationDate),
    last_restore_time: canonicalTimestamp(raw.LastRestoreTime),
    backup_size_in_bytes: backupSize,
    is_encrypted: optionalBoolean(raw.IsEncrypted),
    encryption_key_arn: optionalString(raw.EncryptionKeyArn, 2048),
    encryption_key_type: optionalString(raw.EncryptionKeyType, 100),
    source_backup_vault_arn: sourceArn,
    backup_plan_arn: optionalString(createdBy.BackupPlanArn, 2048),
    backup_plan_id: optionalString(createdBy.BackupPlanId, 256),
    backup_plan_version: optionalString(createdBy.BackupPlanVersion, 256),
    backup_rule_id: optionalString(createdBy.BackupRuleId, 256),
    backup_rule_name: optionalString(createdBy.BackupRuleName, 256),
    lifecycle_delete_after_days: optionalInteger(lifecycle.DeleteAfterDays),
    lifecycle_delete_after_event: optionalString(lifecycle.DeleteAfterEvent, 100),
    lifecycle_move_to_cold_storage_after_days: optionalInteger(lifecycle.MoveToColdStorageAfterDays),
    lifecycle_opt_in_to_archive: optionalBoolean(lifecycle.OptInToArchiveForSupportedResources),
    calculated_delete_at: canonicalTimestamp(calculated.DeleteAt),
    calculated_move_to_cold_storage_at: canonicalTimestamp(calculated.MoveToColdStorageAt),
    is_parent: optionalBoolean(raw.IsParent),
    parent_recovery_point_arn: optionalString(raw.ParentRecoveryPointArn, 2048),
    composite_member_identifier: optionalString(raw.CompositeMemberIdentifier, 512),
  };
}

function normalizeLegalHoldSummary(
  raw: Record<string, unknown>,
  scope: AwsBackupInventoryScope,
): AwsBackupLegalHoldRecord {
  const id = optionalString(raw.LegalHoldId, 256);
  if (!id || !/^[A-Za-z0-9-]{1,256}$/.test(id)) return fail('ListLegalHolds returned an invalid LegalHoldId');
  return {
    account_id: scope.account_id,
    partition: scope.partition,
    region: scope.region,
    legal_hold_id: id,
    legal_hold_arn: optionalString(raw.LegalHoldArn, 2048),
    status: optionalString(raw.Status, 100),
    creation_date: canonicalTimestamp(raw.CreationDate),
    cancellation_date: canonicalTimestamp(raw.CancellationDate),
    retain_record_until: null,
    selected_vault_names: [],
    selected_resource_identifier_count: 0,
    selection_from_date: null,
    selection_to_date: null,
  };
}

function applyLegalHoldDetail(
  summary: AwsBackupLegalHoldRecord,
  detail: Record<string, unknown>,
  scope: AwsBackupInventoryScope,
  blockers: string[],
): AwsBackupLegalHoldRecord {
  const key = scope.account_id + '/' + scope.region + '/' + summary.legal_hold_id;
  const selection = isRecord(detail.RecoveryPointSelection) ? detail.RecoveryPointSelection : {};
  if (detail.RecoveryPointSelection !== undefined && !isRecord(detail.RecoveryPointSelection)) {
    blockers.push(key + ': GetLegalHold returned a malformed RecoveryPointSelection');
  }
  const dateRange = isRecord(selection.DateRange) ? selection.DateRange : {};
  if (selection.DateRange !== undefined && !isRecord(selection.DateRange)) {
    blockers.push(key + ': GetLegalHold returned a malformed RecoveryPointSelection DateRange');
  }
  const rawVaultNames = selection.VaultNames;
  const vaultNames: string[] = [];
  if (rawVaultNames !== undefined && !Array.isArray(rawVaultNames)) {
    blockers.push(key + ': GetLegalHold returned a malformed VaultNames selection');
  } else if (Array.isArray(rawVaultNames)) {
    for (const item of rawVaultNames) {
      if (typeof item !== 'string' || !/^[A-Za-z0-9_-]{2,50}$/.test(item)) {
        blockers.push(key + ': GetLegalHold returned an invalid selected vault name');
      } else {
        vaultNames.push(item);
      }
    }
  }
  const rawIdentifiers = selection.ResourceIdentifiers;
  let resourceIdentifiers = 0;
  if (rawIdentifiers !== undefined && !Array.isArray(rawIdentifiers)) {
    blockers.push(key + ': GetLegalHold returned malformed ResourceIdentifiers');
  } else if (Array.isArray(rawIdentifiers)) {
    resourceIdentifiers = rawIdentifiers.length;
    for (const identifier of rawIdentifiers) {
      if (typeof identifier !== 'string' || identifier.length < 1 || identifier.length > 2048
        || hasControlCharacters(identifier)) {
        blockers.push(key + ': GetLegalHold returned an invalid resource identifier');
      }
    }
  }
  const fromDate = dateRange.FromDate === undefined ? null : canonicalTimestamp(dateRange.FromDate);
  const toDate = dateRange.ToDate === undefined ? null : canonicalTimestamp(dateRange.ToDate);
  if (dateRange.FromDate !== undefined && !fromDate) blockers.push(key + ': GetLegalHold returned an invalid selection FromDate');
  if (dateRange.ToDate !== undefined && !toDate) blockers.push(key + ': GetLegalHold returned an invalid selection ToDate');
  const status = optionalString(detail.Status, 100) ?? summary.status;
  if (status && !['CREATING', 'ACTIVE', 'CANCELING', 'CANCELED'].includes(status)) {
    blockers.push(key + ': GetLegalHold returned an unknown status');
  }
  const arn = optionalString(detail.LegalHoldArn, 2048) ?? summary.legal_hold_arn;
  if (arn && !new RegExp('^arn:' + scope.partition + ':backup:' + scope.region + ':' + scope.account_id
    + ':legal-hold:[A-Za-z0-9-]{1,256}$').test(arn)) {
    blockers.push(key + ': GetLegalHold returned an out-of-scope LegalHoldArn');
  }
  return {
    ...summary,
    legal_hold_arn: arn,
    status,
    creation_date: canonicalTimestamp(detail.CreationDate) ?? summary.creation_date,
    cancellation_date: canonicalTimestamp(detail.CancellationDate) ?? summary.cancellation_date,
    retain_record_until: canonicalTimestamp(detail.RetainRecordUntil),
    selected_vault_names: [...new Set(vaultNames)].sort(),
    selected_resource_identifier_count: resourceIdentifiers,
    selection_from_date: fromDate,
    selection_to_date: toDate,
  };
}

function normalizeRestoreAccessRelationship(
  raw: Record<string, unknown>,
  sourceVault: AwsBackupVaultRecord,
  scope: AwsBackupInventoryScope,
  blockers: string[],
): AwsBackupRestoreAccessVaultRelationship {
  const arn = validBackupArn(raw.RestoreAccessBackupVaultArn, scope.partition, scope.account_id, scope.region);
  if (!arn || !arn.includes(':backup-vault:')) {
    blockers.push(scope.account_id + '/' + scope.region + ': restore-access vault relationship has a missing or out-of-scope ARN');
  }
  const latest = isRecord(raw.LatestRevokeRequest) ? raw.LatestRevokeRequest : {};
  return {
    account_id: scope.account_id,
    region: scope.region,
    source_backup_vault_arn: sourceVault.backup_vault_arn,
    restore_access_backup_vault_arn: arn ?? String(raw.RestoreAccessBackupVaultArn ?? ''),
    vault_state: optionalString(raw.VaultState, 100),
    creation_date: canonicalTimestamp(raw.CreationDate),
    approval_date: canonicalTimestamp(raw.ApprovalDate),
    latest_revoke_status: optionalString(latest.Status, 100),
    latest_revoke_initiation_date: canonicalTimestamp(latest.InitiationDate),
    latest_revoke_expiry_date: canonicalTimestamp(latest.ExpiryDate),
  };
}

function normalizeCopyJob(
  raw: Record<string, unknown>,
  scope: AwsBackupInventoryScope,
  blockers: string[],
): AwsBackupCopyJobRecord {
  const key = scope.account_id + '/' + scope.region;
  const copyJobId = optionalString(raw.CopyJobId, 128);
  if (!copyJobId || !/^[A-Za-z0-9-]{1,128}$/.test(copyJobId)) {
    blockers.push(key + ': ListCopyJobs/DescribeCopyJob returned an invalid CopyJobId');
  }
  const accountId = optionalString(raw.AccountId, 12);
  if (raw.AccountId !== undefined && (!accountId || !ACCOUNT_ID.test(accountId))) {
    blockers.push(key + ': DescribeCopyJob returned a malformed AccountId');
  } else if (accountId && accountId !== scope.account_id) {
    blockers.push(key + ': DescribeCopyJob AccountId does not match the verified caller account');
  }

  const stateValue = optionalString(raw.State, 40);
  const states: AwsBackupCopyJobState[] = ['CREATED', 'RUNNING', 'COMPLETED', 'FAILED', 'PARTIAL'];
  const state = states.includes(stateValue as AwsBackupCopyJobState)
    ? stateValue as AwsBackupCopyJobState : null;
  if (!state) blockers.push(key + ': copy job has a missing or unknown State');

  const creationDate = canonicalTimestamp(raw.CreationDate);
  if (!creationDate) blockers.push(key + ': copy job ' + (copyJobId ?? 'unknown') + ' is missing a valid CreationDate');
  const completionDate = canonicalTimestamp(raw.CompletionDate);
  if (state === 'COMPLETED' && !completionDate) {
    blockers.push(key + ': completed copy job ' + (copyJobId ?? 'unknown') + ' is missing a valid CompletionDate');
  }

  const sourceVaultArn = validBackupArn(raw.SourceBackupVaultArn, scope.partition);
  if (!sourceVaultArn || !sourceVaultArn.includes(':backup-vault:')) {
    blockers.push(key + ': copy job ' + (copyJobId ?? 'unknown') + ' has a missing or invalid SourceBackupVaultArn');
  }
  const sourceRecoveryPointArn = validBackupArn(raw.SourceRecoveryPointArn, scope.partition);
  if (!sourceRecoveryPointArn || !sourceRecoveryPointArn.includes(':recovery-point:')) {
    blockers.push(key + ': copy job ' + (copyJobId ?? 'unknown') + ' has a missing or invalid SourceRecoveryPointArn');
  }
  const destinationVaultArn = validBackupArn(raw.DestinationBackupVaultArn, scope.partition);
  if (!destinationVaultArn || !destinationVaultArn.includes(':backup-vault:')) {
    blockers.push(key + ': copy job ' + (copyJobId ?? 'unknown') + ' has a missing or invalid DestinationBackupVaultArn');
  }
  const destinationRecoveryPointArn = raw.DestinationRecoveryPointArn === undefined
    || raw.DestinationRecoveryPointArn === null || raw.DestinationRecoveryPointArn === ''
    ? null : validBackupArn(raw.DestinationRecoveryPointArn, scope.partition);
  if (raw.DestinationRecoveryPointArn && (!destinationRecoveryPointArn
    || !destinationRecoveryPointArn.includes(':recovery-point:'))) {
    blockers.push(key + ': copy job ' + (copyJobId ?? 'unknown') + ' has an invalid DestinationRecoveryPointArn');
  }
  if (state === 'COMPLETED' && !destinationRecoveryPointArn) {
    blockers.push(key + ': completed copy job ' + (copyJobId ?? 'unknown') + ' has no destination recovery-point ARN');
  }

  const rawDestinationVaultType = optionalString(raw.DestinationVaultType, 100);
  const destinationVaultType = rawDestinationVaultType === 'BACKUP_VAULT'
    || rawDestinationVaultType === 'LOGICALLY_AIR_GAPPED_BACKUP_VAULT'
    ? rawDestinationVaultType : null;
  if (rawDestinationVaultType && !destinationVaultType) {
    blockers.push(key + ': copy job ' + (copyJobId ?? 'unknown') + ' has an unknown DestinationVaultType');
  }

  const lifecycle = isRecord(raw.DestinationRecoveryPointLifecycle)
    ? raw.DestinationRecoveryPointLifecycle : {};
  if (raw.DestinationRecoveryPointLifecycle !== undefined
    && !isRecord(raw.DestinationRecoveryPointLifecycle)) {
    blockers.push(key + ': copy job returned malformed DestinationRecoveryPointLifecycle');
  }
  const lifecycleDays = (value: unknown): number | null => {
    if (value === -1) return -1;
    return optionalInteger(value);
  };
  const deleteAfterDays = lifecycleDays(lifecycle.DeleteAfterDays);
  const moveToColdDays = lifecycleDays(lifecycle.MoveToColdStorageAfterDays);
  if (lifecycle.DeleteAfterDays !== undefined && deleteAfterDays === null) {
    blockers.push(key + ': copy job has invalid destination DeleteAfterDays');
  }
  if (lifecycle.MoveToColdStorageAfterDays !== undefined && moveToColdDays === null) {
    blockers.push(key + ': copy job has invalid destination MoveToColdStorageAfterDays');
  }

  const createdBy = isRecord(raw.CreatedBy) ? raw.CreatedBy : {};
  if (raw.CreatedBy !== undefined && !isRecord(raw.CreatedBy)) {
    blockers.push(key + ': copy job returned malformed CreatedBy metadata');
  }
  const backupSize = raw.BackupSizeInBytes === undefined || raw.BackupSizeInBytes === null
    ? null : optionalInteger(raw.BackupSizeInBytes);
  if (raw.BackupSizeInBytes !== undefined && raw.BackupSizeInBytes !== null && backupSize === null) {
    blockers.push(key + ': copy job BackupSizeInBytes is not a safe non-negative integer');
  }
  const childCount = raw.NumberOfChildJobs === undefined || raw.NumberOfChildJobs === null
    ? null : optionalInteger(raw.NumberOfChildJobs);
  if (raw.NumberOfChildJobs !== undefined && raw.NumberOfChildJobs !== null && childCount === null) {
    blockers.push(key + ': copy job NumberOfChildJobs is invalid');
  }

  return {
    account_id: scope.account_id,
    partition: scope.partition,
    region: scope.region,
    copy_job_id: copyJobId ?? String(raw.CopyJobId ?? ''),
    state,
    creation_date: creationDate,
    completion_date: completionDate,
    backup_size_in_bytes: backupSize,
    resource_arn: optionalString(raw.ResourceArn, 2048),
    resource_type: optionalString(raw.ResourceType, 100),
    source_backup_vault_arn: sourceVaultArn ?? String(raw.SourceBackupVaultArn ?? ''),
    source_recovery_point_arn: sourceRecoveryPointArn ?? String(raw.SourceRecoveryPointArn ?? ''),
    destination_backup_vault_arn: destinationVaultArn ?? String(raw.DestinationBackupVaultArn ?? ''),
    destination_recovery_point_arn: destinationRecoveryPointArn,
    destination_encryption_key_arn: optionalString(raw.DestinationEncryptionKeyArn, 2048),
    destination_vault_lock_state: optionalString(raw.DestinationVaultLockState, 100),
    destination_vault_type: destinationVaultType,
    destination_lifecycle_delete_after_days: deleteAfterDays,
    destination_lifecycle_move_to_cold_storage_after_days: moveToColdDays,
    destination_lifecycle_opt_in_to_archive: optionalBoolean(lifecycle.OptInToArchiveForSupportedResources),
    backup_plan_arn: optionalString(createdBy.BackupPlanArn, 2048),
    backup_plan_id: optionalString(createdBy.BackupPlanId, 256),
    backup_plan_name: optionalString(createdBy.BackupPlanName, 256),
    backup_plan_version: optionalString(createdBy.BackupPlanVersion, 128),
    backup_rule_id: optionalString(createdBy.BackupRuleId, 256),
    backup_rule_name: optionalString(createdBy.BackupRuleName, 256),
    created_by_backup_job_id: optionalString(raw.CreatedByBackupJobId, 256),
    parent_job_id: optionalString(raw.ParentJobId, 256),
    is_parent: optionalBoolean(raw.IsParent),
    number_of_child_jobs: childCount,
    composite_member_identifier: optionalString(raw.CompositeMemberIdentifier, 512),
    message_category: optionalString(raw.MessageCategory, 100),
  };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown provider error';
  return message.replace(/[\r\n]/g, ' ').slice(0, 240);
}

function scopedArnIdentity(arn: string): { partition: AwsBackupPartition; account: string; region: string } | null {
  const match = /^arn:(aws|aws-us-gov|aws-cn):backup:([a-z0-9-]+):(\d{12}):(backup-vault|recovery-point):/.exec(arn);
  return match ? {
    partition: match[1] as AwsBackupPartition,
    region: match[2]!,
    account: match[3]!,
  } : null;
}

export async function captureAwsBackupVaultRecoveryPointInventory(
  input: AwsBackupVaultRecoveryPointInventoryInput,
): Promise<AwsBackupVaultRecoveryPointInventory> {
  const scopes = validateScopes(input.scopes);
  const limits = validateLimits(input);
  const now = input.now ?? (() => new Date());
  const context: Context = {
    fetcher: input.fetcher ?? fetch,
    now,
    limits,
    budget: { pages: 0, requests: 0, items: 0 },
    receipts: [],
  };
  const blockers: string[] = [];
  const vaults: AwsBackupVaultRecord[] = [];
  const recoveryPoints: AwsBackupRecoveryPointRecord[] = [];
  const legalHolds: AwsBackupLegalHoldRecord[] = [];
  const legalHoldRelationships: AwsBackupLegalHoldRecoveryPointRelationship[] = [];
  const restoreAccessRelationships: AwsBackupRestoreAccessVaultRelationship[] = [];
  const copyJobs: AwsBackupCopyJobRecord[] = [];
  const sourceVaultScopeGaps = new Set<string>();
  let verifiedScopeCount = 0;
  let vaultComplete = true;
  let recoveryComplete = true;
  let legalHoldComplete = true;
  let restoreAccessComplete = true;
  let copyJobComplete = true;

  for (const scope of scopes) {
    const scopeKey = scope.account_id + '/' + scope.region;
    try {
      await verifyScopeIdentity(scope, context);
      verifiedScopeCount += 1;

      const vaultBlockerCount = blockers.length;
      const vaultPages = await paginate(
        scope,
        '/backup-vaults/',
        'BackupVaultList',
        (item) => normalizeVaultSummary(item, scope, blockers),
        context,
      );
      vaultComplete = vaultComplete && vaultPages.complete && blockers.length === vaultBlockerCount;
      const currentScopeVaults: AwsBackupVaultRecord[] = [];
      const seenVaultNames = new Set<string>();
      for (const summary of vaultPages.items) {
        if (seenVaultNames.has(summary.backup_vault_name)) {
          blockers.push(scopeKey + ': duplicate backup vault name in ListBackupVaults');
          vaultComplete = false;
          continue;
        }
        seenVaultNames.add(summary.backup_vault_name);
        const detail = await backupGet(
          scope,
          '/backup-vaults/' + rfc3986(summary.backup_vault_name),
          {},
          context,
        );
        const normalized = applyVaultDescription(summary, detail, scope, blockers);
        if (normalized.vault_type === null) restoreAccessComplete = false;
        currentScopeVaults.push(normalized);
        vaults.push(normalized);
      }

      for (const vault of currentScopeVaults) {
        const recoveryBlockerCount = blockers.length;
        const recoveryPages = await paginate(
          scope,
          '/backup-vaults/' + rfc3986(vault.backup_vault_name) + '/recovery-points/',
          'RecoveryPoints',
          (item) => normalizeRecoveryPoint(item, vault, scope, blockers),
          context,
        );
        recoveryComplete = recoveryComplete && recoveryPages.complete && blockers.length === recoveryBlockerCount;
        recoveryPoints.push(...recoveryPages.items);

        if (vault.vault_type === 'LOGICALLY_AIR_GAPPED_BACKUP_VAULT') {
          const restoreBlockerCount = blockers.length;
          const restorePages = await paginate(
            scope,
            '/logically-air-gapped-backup-vaults/' + rfc3986(vault.backup_vault_name) + '/restore-access-backup-vaults/',
            'RestoreAccessBackupVaults',
            (item) => normalizeRestoreAccessRelationship(item, vault, scope, blockers),
            context,
          );
          restoreAccessComplete = restoreAccessComplete && restorePages.complete && blockers.length === restoreBlockerCount;
          restoreAccessRelationships.push(...restorePages.items);
        }
      }

      const holdBlockerCount = blockers.length;
      const holdPages = await paginate(
        scope,
        '/legal-holds/',
        'LegalHolds',
        (item) => normalizeLegalHoldSummary(item, scope),
        context,
      );
      legalHoldComplete = legalHoldComplete && holdPages.complete && blockers.length === holdBlockerCount;
      for (const summary of holdPages.items) {
        const detail = await backupGet(
          scope,
          '/legal-holds/' + rfc3986(summary.legal_hold_id) + '/',
          {},
          context,
        );
        if (detail.LegalHoldId !== undefined && detail.LegalHoldId !== summary.legal_hold_id) {
          blockers.push(scopeKey + ': GetLegalHold returned a different LegalHoldId');
          legalHoldComplete = false;
          continue;
        }
        const hold = applyLegalHoldDetail(summary, detail, scope, blockers);
        legalHolds.push(hold);
        const relationshipBlockerCount = blockers.length;
        const relationPages = await paginate(
          scope,
          '/legal-holds/' + rfc3986(hold.legal_hold_id) + '/recovery-points',
          'RecoveryPoints',
          (item) => {
            const arn = validBackupArn(item.RecoveryPointArn, scope.partition, scope.account_id, scope.region);
            if (!arn || !arn.includes(':recovery-point:')) {
              blockers.push(scopeKey + ': legal hold relationship returned a missing or out-of-scope recovery-point ARN');
            }
            return {
              account_id: scope.account_id,
              region: scope.region,
              legal_hold_id: hold.legal_hold_id,
              legal_hold_status: hold.status,
              recovery_point_arn: arn ?? String(item.RecoveryPointArn ?? ''),
              backup_vault_name: optionalString(item.BackupVaultName, 50),
              resource_arn: optionalString(item.ResourceArn, 2048),
              resource_type: optionalString(item.ResourceType, 100),
            };
          },
          context,
        );
        legalHoldComplete = legalHoldComplete && relationPages.complete
          && blockers.length === relationshipBlockerCount;
        legalHoldRelationships.push(...relationPages.items);
      }

      const copyBlockerCount = blockers.length;
      const copyPages = await paginate(
        scope,
        '/copy-jobs/',
        'CopyJobs',
        (item) => item,
        context,
      );
      copyJobComplete = copyJobComplete && copyPages.complete;
      const seenCopyJobIds = new Set<string>();
      for (const summary of copyPages.items) {
        const copyJobId = optionalString(summary.CopyJobId, 128);
        if (!copyJobId || !/^[A-Za-z0-9-]{1,128}$/.test(copyJobId)) {
          blockers.push(scopeKey + ': ListCopyJobs returned an invalid or missing CopyJobId');
          copyJobComplete = false;
          continue;
        }
        if (seenCopyJobIds.has(copyJobId)) {
          blockers.push(scopeKey + ': ListCopyJobs returned duplicate CopyJobId ' + copyJobId);
          copyJobComplete = false;
          continue;
        }
        seenCopyJobIds.add(copyJobId);
        const detailResponse = await backupGet(
          scope,
          '/copy-jobs/' + rfc3986(copyJobId),
          {},
          context,
        );
        if (!isRecord(detailResponse.CopyJob)) {
          blockers.push(scopeKey + ': DescribeCopyJob returned no CopyJob object for ' + copyJobId);
          copyJobComplete = false;
          continue;
        }
        const detail = detailResponse.CopyJob;
        if (detail.CopyJobId !== copyJobId) {
          blockers.push(scopeKey + ': DescribeCopyJob returned a different CopyJobId than ListCopyJobs');
          copyJobComplete = false;
          continue;
        }
        const job = normalizeCopyJob(detail, scope, blockers);
        copyJobs.push(job);
      }
      copyJobComplete = copyJobComplete && blockers.length === copyBlockerCount;
    } catch (error) {
      const message = safeError(error);
      blockers.push(scopeKey + ': ' + message);
      // Any earlier scope failure also means the later copy-job surface was not fully visited.
      copyJobComplete = false;
      if (message.includes('ListBackupVaults') || message.includes('DescribeBackupVault')) {
        vaultComplete = false;
        recoveryComplete = false;
        restoreAccessComplete = false;
        legalHoldComplete = false;
      } else if (message.includes('ListRecoveryPointsByBackupVault')) {
        recoveryComplete = false;
        // Abort of the scope also prevents the later hold catalog from running.
        legalHoldComplete = false;
      } else if (message.includes('ListRestoreAccessBackupVaults')) {
        restoreAccessComplete = false;
        // Keep unvisited scope surfaces incomplete when an earlier call aborts traversal.
        legalHoldComplete = false;
      } else if (message.includes('ListLegalHolds') || message.includes('GetLegalHold')
        || message.includes('ListRecoveryPointsByLegalHold')) {
        legalHoldComplete = false;
      } else if (message.includes('ListCopyJobs') || message.includes('DescribeCopyJob')) {
        copyJobComplete = false;
      } else {
        vaultComplete = false;
        recoveryComplete = false;
        legalHoldComplete = false;
        restoreAccessComplete = false;
      }
    }
  }

  const recoveryPointArns = new Set(recoveryPoints.map((item) => item.recovery_point_arn).filter(Boolean));
  for (const relationship of legalHoldRelationships) {
    if (!recoveryPointArns.has(relationship.recovery_point_arn)) {
      blockers.push(relationship.account_id + '/' + relationship.region + ': legal hold references a recovery point absent from the enumerated vault catalog');
      legalHoldComplete = false;
    }
  }

  for (const point of recoveryPoints) {
    if (point.source_backup_vault_arn) {
      const identity = scopedArnIdentity(point.source_backup_vault_arn);
      if (!identity) {
        blockers.push(point.account_id + '/' + point.region + ': source vault ARN cannot be reconciled to an AWS Backup account/region');
        recoveryComplete = false;
      } else if (!scopes.some((scope) => scope.account_id === identity.account
        && scope.partition === identity.partition && scope.region === identity.region)) {
        sourceVaultScopeGaps.add(point.source_backup_vault_arn);
      }
    }
  }
  for (const arn of sourceVaultScopeGaps) {
    blockers.push('source backup vault is outside the explicitly supplied account/region scopes: ' + arn);
    recoveryComplete = false;
  }

  const suppliedScopeKeys = new Set(scopes.map((scope) =>
    scope.partition + ':' + scope.account_id + ':' + scope.region));
  const vaultArns = new Set(vaults.map((vault) => vault.backup_vault_arn));
  const copySourceScopeGaps = new Set<string>();
  const copyDestinationScopeGaps = new Set<string>();
  const copyVaultCatalogGaps = new Set<string>();
  const copyRecoveryPointCatalogGaps = new Set<string>();
  let copyReconciliationBlocked = false;
  let crossAccountCopyJobCount = 0;
  let crossRegionCopyJobCount = 0;

  const reconcileArnScope = (
    arn: string,
    description: string,
    scopeGaps: Set<string>,
  ): { partition: AwsBackupPartition; account: string; region: string } | null => {
    const identity = scopedArnIdentity(arn);
    if (!identity) {
      blockers.push(description + ' has a malformed or unsupported AWS Backup ARN');
      copyReconciliationBlocked = true;
      return null;
    }
    const key = identity.partition + ':' + identity.account + ':' + identity.region;
    if (!suppliedScopeKeys.has(key)) {
      scopeGaps.add(arn);
      return identity;
    }
    return identity;
  };

  for (const job of copyJobs) {
    const sourceVault = reconcileArnScope(job.source_backup_vault_arn,
      'copy job source vault ' + job.copy_job_id, copySourceScopeGaps);
    const destinationVault = reconcileArnScope(job.destination_backup_vault_arn,
      'copy job destination vault ' + job.copy_job_id, copyDestinationScopeGaps);
    const sourcePoint = reconcileArnScope(job.source_recovery_point_arn,
      'copy job source recovery point ' + job.copy_job_id, copySourceScopeGaps);
    if (sourceVault && (sourceVault.account !== job.account_id || sourceVault.region !== job.region)) {
      blockers.push('copy job ' + job.copy_job_id + ' source vault is outside its enumerated job account/region');
      copyReconciliationBlocked = true;
    }
    if (sourceVault && sourcePoint && (sourceVault.account !== sourcePoint.account
      || sourceVault.region !== sourcePoint.region || sourceVault.partition !== sourcePoint.partition)) {
      blockers.push('copy job ' + job.copy_job_id + ' source recovery point does not belong to its source vault scope');
      copyReconciliationBlocked = true;
    }
    if (sourceVault && suppliedScopeKeys.has(sourceVault.partition + ':' + sourceVault.account + ':' + sourceVault.region)
      && !vaultArns.has(job.source_backup_vault_arn)) {
      copyVaultCatalogGaps.add(job.source_backup_vault_arn);
    }
    if (destinationVault && suppliedScopeKeys.has(destinationVault.partition + ':' + destinationVault.account + ':' + destinationVault.region)
      && !vaultArns.has(job.destination_backup_vault_arn)) {
      copyVaultCatalogGaps.add(job.destination_backup_vault_arn);
    }
    if (sourcePoint && suppliedScopeKeys.has(sourcePoint.partition + ':' + sourcePoint.account + ':' + sourcePoint.region)
      && !recoveryPointArns.has(job.source_recovery_point_arn)) {
      copyRecoveryPointCatalogGaps.add(job.source_recovery_point_arn);
    }
    if (job.destination_recovery_point_arn) {
      const destinationPoint = reconcileArnScope(job.destination_recovery_point_arn,
        'copy job destination recovery point ' + job.copy_job_id, copyDestinationScopeGaps);
      if (destinationPoint && suppliedScopeKeys.has(destinationPoint.partition + ':' + destinationPoint.account + ':' + destinationPoint.region)
        && !recoveryPointArns.has(job.destination_recovery_point_arn)) {
        copyRecoveryPointCatalogGaps.add(job.destination_recovery_point_arn);
      }
      if (destinationVault && destinationPoint && (destinationVault.account !== destinationPoint.account
        || destinationVault.region !== destinationPoint.region || destinationVault.partition !== destinationPoint.partition)) {
        blockers.push('copy job ' + job.copy_job_id + ' destination recovery point does not belong to its destination vault scope');
        copyReconciliationBlocked = true;
      }
    }
    if (sourceVault && destinationVault) {
      if (sourceVault.account !== destinationVault.account) crossAccountCopyJobCount += 1;
      if (sourceVault.region !== destinationVault.region) crossRegionCopyJobCount += 1;
    }
  }

  for (const arn of copySourceScopeGaps) {
    blockers.push('copy-job source ARN is outside the explicitly supplied account/region scopes: ' + arn);
  }
  for (const arn of copyDestinationScopeGaps) {
    blockers.push('copy-job destination ARN is outside the explicitly supplied account/region scopes: ' + arn);
  }
  for (const arn of copyVaultCatalogGaps) {
    blockers.push('copy job references a vault absent from the enumerated vault catalog: ' + arn);
  }
  for (const arn of copyRecoveryPointCatalogGaps) {
    blockers.push('copy job references a recovery point absent from the enumerated recovery-point catalog: ' + arn);
  }
  const copyJobDestinationReconciliationComplete = copyJobComplete && !copyReconciliationBlocked
    && copySourceScopeGaps.size === 0 && copyDestinationScopeGaps.size === 0
    && copyVaultCatalogGaps.size === 0 && copyRecoveryPointCatalogGaps.size === 0;

  const observedTypes = [...new Set(vaults.map((vault) => vault.vault_type).filter(
    (value): value is AwsBackupVaultType => value !== null,
  ))].sort();
  const generatedAt = now();
  if (!(generatedAt instanceof Date) || !Number.isFinite(generatedAt.getTime())) {
    return fail('inventory clock is invalid at completion');
  }
  const complete = blockers.length === 0 && verifiedScopeCount === scopes.length
    && vaultComplete && recoveryComplete && legalHoldComplete && restoreAccessComplete
    && copyJobComplete && copyJobDestinationReconciliationComplete;
  return {
    schema: 'factoryos.aws-backup-vault-recovery-point-inventory/v1',
    status: complete ? 'COMPLETE' : 'PARTIAL',
    generated_at: generatedAt.toISOString(),
    requested_scopes: scopes.map(({ account_id, partition, region }) => ({ account_id, partition, region })),
    verified_scope_count: verifiedScopeCount,
    vaults,
    recovery_points: recoveryPoints,
    legal_holds: legalHolds,
    legal_hold_recovery_point_relationships: legalHoldRelationships,
    restore_access_vault_relationships: restoreAccessRelationships,
    copy_jobs: copyJobs,
    copy_job_terminal_record_retention_days: 30,
    copy_job_catalog_complete: copyJobComplete && verifiedScopeCount === scopes.length,
    copy_job_destination_reconciliation_complete: copyJobDestinationReconciliationComplete,
    copy_job_source_scope_gaps: [...copySourceScopeGaps].sort(),
    copy_job_destination_scope_gaps: [...copyDestinationScopeGaps].sort(),
    copy_job_vault_catalog_gaps: [...copyVaultCatalogGaps].sort(),
    copy_job_recovery_point_catalog_gaps: [...copyRecoveryPointCatalogGaps].sort(),
    cross_account_copy_job_count: crossAccountCopyJobCount,
    cross_region_copy_job_count: crossRegionCopyJobCount,
    vault_types_supported: [...VAULT_TYPES],
    observed_vault_types: observedTypes,
    vault_catalog_complete: vaultComplete && verifiedScopeCount === scopes.length,
    recovery_point_catalog_complete: recoveryComplete && verifiedScopeCount === scopes.length,
    legal_hold_catalog_complete: legalHoldComplete && verifiedScopeCount === scopes.length,
    restore_access_relationships_complete: restoreAccessComplete && verifiedScopeCount === scopes.length,
    source_vault_scope_gaps: [...sourceVaultScopeGaps].sort(),
    pages_fetched: context.budget.pages,
    requests_attempted: context.budget.requests,
    items_observed: context.budget.items,
    query_receipt_references: context.receipts,
    blockers: [...new Set(blockers)],
    aws_backup_copy_job_catalog_enumerated: copyJobComplete && verifiedScopeCount === scopes.length,
    non_aws_backup_external_copy_surfaces_enumerated: false,
    whole_backup_coverage_complete: false,
    provider_mutation_performed: false,
    restore_api_available: false,
    copy_api_available: false,
    delete_api_available: false,
    deletion_authorized: false,
  };
}
