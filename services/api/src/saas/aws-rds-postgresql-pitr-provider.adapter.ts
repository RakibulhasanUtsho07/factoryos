import { createHash, createHmac } from 'node:crypto';
import { AwsBackupInventoryApi, AwsBackupLegalHoldRecord, AwsBackupRecoveryPointRecord, AwsBackupVaultRecord } from './aws-backup-inventory-api';
import {
  AwsRdsPitrDatabasePrincipalCatalog,
  AwsRdsPitrDatabasePrincipalInventoryOptions,
  AwsRdsPitrDatabasePrincipalInventoryReader,
  AwsRdsPitrDatabaseTarget,
  AwsRdsPitrPgPoolFactory,
} from './aws-rds-postgresql-database-principal-inventory';

export const AWS_RDS_POSTGRESQL_PITR_INVENTORY_SCHEMA =
  'factoryos.aws-rds-postgresql-pitr-inventory/v1';
export const AWS_RDS_POSTGRESQL_PITR_RETENTION_PLAN_SCHEMA =
  'factoryos.aws-rds-postgresql-pitr-retention-dry-run/v1';

const QUERY_VERSIONS = {
  sts: '2011-06-15',
  ec2: '2016-11-15',
  rds: '2014-10-31',
} as const;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ACCOUNTS = 1000;
const MAX_SCOPES = 5000;
const MAX_TOTAL_PAGES = 50000;
const MAX_TOTAL_ITEMS = 100000;
const DEFAULT_TOTAL_PAGES = 10000;
const DEFAULT_TOTAL_ITEMS = 20000;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const AWS_ACCOUNT_ID = /^\d{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ROLE_NAME = /^[A-Za-z0-9+=,.@_-]{1,64}$/;
const RDS_ARN = /^arn:(aws|aws-us-gov|aws-cn):rds:[a-z0-9-]+:\d{12}:(?:db|cluster|global-cluster|snapshot|cluster-snapshot|auto-backup):[A-Za-z0-9:_-]+$/;

export interface AwsRdsPitrCredentials {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
}

export interface AwsRdsPitrProviderConfig {
  organization_account_id: string;
  read_only_role_name: string;
  external_id: string;
  organization_region?: string;
  page_size?: number;
  max_total_pages?: number;
  max_total_items?: number;
  request_timeout_ms?: number;
  read_only_policy_sha256?: string;
  policy_review_reference?: string;
  database_principal_inventory?: AwsRdsPitrDatabasePrincipalInventoryOptions;
}

export interface AwsRdsPitrProviderScope {
  provider_reference: 'aws';
  account_reference: string;
  region_reference: string;
}

export type AwsRdsPitrSourceKind =
  | 'POSTGRESQL_CLUSTER_CATALOG'
  | 'WAL_ARCHIVE_DESTINATION_CATALOG'
  | 'WAL_SEGMENT_CATALOG'
  | 'WAL_WRITER_PRINCIPAL_CATALOG'
  | 'WAL_REPLICATION_PATH_CATALOG'
  | 'PITR_RESTORE_PATH_CATALOG';

export type AwsRdsPitrSourceStatus =
  | 'COMPLETE'
  | 'PARTIAL'
  | 'OPAQUE_PROVIDER_MANAGED'
  | 'NOT_ENUMERATED';

export interface AwsRdsPitrResource {
  resource_arn: string | null;
  provider_identity_reference: string;
  identity_kind: 'IMMUTABLE_RESOURCE_ARN' | 'SOURCE_DB_RESOURCE_ID';
  provider_delete_identity_reference: string | null;
  provider_delete_identity_kind: 'DBI_RESOURCE_ID' | 'REPLICATED_BACKUP_ARN' | 'SNAPSHOT_IDENTIFIER' | 'AWS_BACKUP_RECOVERY_POINT_ARN' | null;
  replication_destination_arns: string[];
  resource_type: string;
  account_id: string;
  region: string;
  engine: string | null;
  source_database_reference: string | null;
  status: string | null;
  created_at: string | null;
  earliest_restorable_time: string | null;
  latest_restorable_time: string | null;
  retention_days: number | null;
  attributes: Record<string, string | null>;
}

export interface AwsRdsPitrCatalogSource {
  source_kind: AwsRdsPitrSourceKind;
  status: AwsRdsPitrSourceStatus;
  reason: string;
  pages_fetched: number;
  item_count: number;
  result_sha256: string;
  query_receipt_references: string[];
  items: AwsRdsPitrResource[];
}

export interface AwsRdsPostgresqlPitrInventory {
  schema: typeof AWS_RDS_POSTGRESQL_PITR_INVENTORY_SCHEMA;
  status: 'INCOMPLETE' | 'ENUMERATED_WITH_EXPLICIT_GAPS';
  generated_at: string;
  organization_account_id: string;
  source_principal_reference: string;
  collector_role_name: string;
  collector_role_identity_verified: true;
  collector_policy_sha256: string | null;
  collector_policy_review_reference: string | null;
  collector_policy_independently_verified: false;
  account_discovery_complete: boolean;
  region_discovery_complete: boolean;
  pagination_exhausted: true;
  accounts_discovered: number;
  regions_discovered: number;
  scopes_discovered: number;
  total_pages_fetched: number;
  total_provider_requests: number;
  total_items_observed: number;
  scopes: Array<{
    scope: AwsRdsPitrProviderScope;
    assumed_role_arn: string;
    verified_principal_reference: string;
  }>;
  excluded_accounts: Array<{ account_id: string; state: string; reason: string }>;
  excluded_regions: Array<{ account_id: string; region: string; opt_in_status: string }>;
  sources: AwsRdsPitrCatalogSource[];
  backup_vault_catalog_complete: boolean;
  backup_vaults: AwsBackupVaultRecord[];
  aws_backup_recovery_points_enumerated: boolean;
  aws_backup_recovery_points: AwsBackupRecoveryPointRecord[];
  aws_backup_legal_holds_enumerated: boolean;
  aws_backup_legal_holds: AwsBackupLegalHoldRecord[];
  aws_backup_legal_hold_recovery_point_arns: string[];
  aws_backup_legal_hold_scope_status_uncertain: boolean;
  aws_backup_receipt_references: string[];
  unresolved_replication_destination_arns: string[];
  provider_managed_wal_segments_individually_enumerated: false;
  database_writer_principals_fully_enumerated: boolean;
  database_principal_catalogs: AwsRdsPitrDatabasePrincipalCatalog[];

  source_receipts_signable: false;
  manifest_eligible: false;
  deletion_authorized: false;
}

export interface AwsRdsPitrRetentionDryRunInput {
  inventory: AwsRdsPostgresqlPitrInventory;
  candidate_provider_identity_reference: string;
  candidate_resource_arn?: string;
  expected_account_id: string;
  expected_region: string;
  minimum_recovery_horizon_end_at: string;
  retention_expires_at: string;
  legal_hold_status: 'NONE' | 'ACTIVE' | 'UNKNOWN';
  dependency_status: 'NO_DEPENDENCY' | 'DEPENDENCY' | 'UNKNOWN';
  data_owner_approval_reference?: string;
  infrastructure_owner_approval_reference?: string;
  policy_reference?: string;
}

export interface AwsRdsPitrRetentionDryRunPlan {
  schema: typeof AWS_RDS_POSTGRESQL_PITR_RETENTION_PLAN_SCHEMA;
  status: 'BLOCKED' | 'REVIEW_REQUIRED';
  candidate_provider_identity_reference: string | null;
  candidate_resource_arn: string | null;
  provider_delete_identity_reference: string | null;
  provider_delete_identity_kind: AwsRdsPitrResource['provider_delete_identity_kind'];
  candidate_identity_sha256: string | null;
  blockers: string[];
  operation: 'DRY_RUN_ONLY';
  provider_mutation_performed: false;
  delete_api_available: false;
  deletion_authorized: false;
  requires_independent_review: true;
}

function fail(message: string): never {
  throw new Error('AWS RDS PostgreSQL PITR inventory refused: ' + message);
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

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    '%' + character.charCodeAt(0).toString(16).toUpperCase());
}

function safeReference(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_REFERENCE.test(value)
    || value.includes('://') || /(secret|password|credential|access.?key|token)/i.test(value)) {
    return fail(field + ' must be a non-secret opaque reference');
  }
  return value;
}

function decodeXml(value: string): string {
  const decoded = value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)));
  if (/&(?:#|[A-Za-z])/.test(decoded)) return fail('AWS returned malformed XML entity encoding');
  return decoded;
}

function xmlText(xml: string, tag: string): string | null {
  const expression = new RegExp('<(?:[A-Za-z0-9_]+:)?' + tag
    + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?' + tag + '>', 'i');
  const match = xml.match(expression);
  return match ? decodeXml(match[1]!.trim()) : null;
}

function xmlBlocks(xml: string, tag: string): string[] {
  const expression = new RegExp('<(?:[A-Za-z0-9_]+:)?' + tag
    + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?' + tag + '>', 'gi');
  return [...xml.matchAll(expression)].map((match) => match[1]!);
}

async function readBoundedResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return fail('AWS response body is missing');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await reader.read();
      } catch {
        return fail('AWS response stream was interrupted');
      }
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return fail('AWS response exceeded its byte limit');
      }
      chunks.push(Buffer.from(part.value));
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      return fail('AWS response was not valid UTF-8');
    }
  } finally {
    reader.releaseLock();
  }
}
function partitionForRegion(region: string): 'aws' | 'aws-us-gov' | 'aws-cn' {
  return region.startsWith('cn-') ? 'aws-cn' : region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws';
}

function requireAwsArn(value: string | null, field: string, scope: AwsRdsPitrProviderScope): string {
  const match = value && RDS_ARN.exec(value);
  if (!match || !value) return fail(field + ' did not return an exact AWS RDS resource ARN');
  const identity = /^arn:(aws|aws-us-gov|aws-cn):rds:([a-z0-9-]+):(\d{12}):/.exec(value);
  if (!identity || identity[1] !== partitionForRegion(scope.region_reference)
    || identity[2] !== scope.region_reference || identity[3] !== scope.account_reference) {
    return fail(field + ' ARN is outside the requested account/region scope');
  }
  return value;
}

function optionalString(value: string | null): string | null {
  return value === null || value === '' ? null : value;
}

function optionalInteger(value: string | null): number | null {
  if (value === null || !/^\d{1,6}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validateConfig(config: AwsRdsPitrProviderConfig): Required<Pick<
  AwsRdsPitrProviderConfig, 'organization_account_id' | 'read_only_role_name'
>> & {
  organization_region: string;
  page_size: number;
  max_total_pages: number;
  max_total_items: number;
  request_timeout_ms: number;
  external_id: string;
  read_only_policy_sha256?: string;
  policy_review_reference?: string;
  database_principal_inventory?: AwsRdsPitrDatabasePrincipalInventoryOptions;
} {
  if (!isRecord(config) || !AWS_ACCOUNT_ID.test(config.organization_account_id)
    || !ROLE_NAME.test(config.read_only_role_name)) {
    return fail('organization account or read-only role name is invalid');
  }
  const organizationRegion = config.organization_region ?? 'us-east-1';
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(organizationRegion)) {
    return fail('organization region is invalid');
  }
  const pageSize = config.page_size ?? 100;
  const maxTotalPages = config.max_total_pages ?? DEFAULT_TOTAL_PAGES;
  const maxTotalItems = config.max_total_items ?? DEFAULT_TOTAL_ITEMS;
  const timeout = config.request_timeout_ms ?? 10000;
  if (!Number.isSafeInteger(pageSize) || pageSize < 20 || pageSize > 100
    || !Number.isSafeInteger(maxTotalPages) || maxTotalPages < 1 || maxTotalPages > MAX_TOTAL_PAGES
    || !Number.isSafeInteger(maxTotalItems) || maxTotalItems < 1 || maxTotalItems > MAX_TOTAL_ITEMS
    || !Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 30000) {
    return fail('AWS pagination, item or request timeout bounds are outside supported limits');
  }
  if (typeof config.external_id !== 'string' || config.external_id.length < 2 || config.external_id.length > 1224
    || /[\r\n]/.test(config.external_id)) {
    return fail('a valid non-empty external ID is required by the cross-account trust policy');
  }
  if (config.read_only_policy_sha256 !== undefined && !SHA256.test(config.read_only_policy_sha256)) {
    return fail('read-only policy SHA-256 is invalid');
  }
  if (config.policy_review_reference !== undefined) {
    safeReference(config.policy_review_reference, 'read-only policy review reference');
  }
  return {
    organization_account_id: config.organization_account_id,
    read_only_role_name: config.read_only_role_name,
    organization_region: organizationRegion,
    page_size: pageSize,
    max_total_pages: maxTotalPages,
    max_total_items: maxTotalItems,
    request_timeout_ms: timeout,
    external_id: config.external_id,
    read_only_policy_sha256: config.read_only_policy_sha256,
    policy_review_reference: config.policy_review_reference,
    database_principal_inventory: config.database_principal_inventory,
  };
}

function validateCredentials(value: AwsRdsPitrCredentials): AwsRdsPitrCredentials {
  if (!isRecord(value) || typeof value.access_key_id !== 'string'
    || !/^[A-Z0-9]{16,128}$/.test(value.access_key_id)
    || typeof value.secret_access_key !== 'string' || value.secret_access_key.length < 20
    || /[\r\n]/.test(value.secret_access_key)
    || (value.session_token !== undefined
      && (typeof value.session_token !== 'string' || value.session_token.length < 16 || /[\r\n]/.test(value.session_token)))) {
    return fail('source credential provider returned incomplete or malformed credentials');
  }
  return value;
}

export interface AwsRdsPitrWebIdentityInput {
  role_arn: string;
  region: string;
  role_session_name: string;
  web_identity_token: string;
}

/** Exchanges an externally read OIDC/web-identity token for short-lived STS credentials. */
export async function exchangeAwsRdsPitrWebIdentityToken(
  input: AwsRdsPitrWebIdentityInput,
  fetcher: typeof fetch = globalThis.fetch,
  timeoutMs = 10000,
): Promise<AwsRdsPitrCredentials> {
  const arn = /^arn:(aws|aws-us-gov|aws-cn):iam::(\d{12}):role\/([A-Za-z0-9+=,.@_/-]{1,512})$/.exec(input.role_arn);
  if (!arn || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(input.region)
    || !/^[A-Za-z0-9+=,.@_-]{2,64}$/.test(input.role_session_name)
    || typeof input.web_identity_token !== 'string'
    || input.web_identity_token.length < 32 || input.web_identity_token.length > 65536
    || /[\r\n]/.test(input.web_identity_token)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    return fail('AWS web-identity input is incomplete or outside supported bounds');
  }
  const dnsSuffix = input.region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
  const endpoint = 'https://sts.' + input.region + '.' + dnsSuffix + '/';
  const body = new URLSearchParams({
    Action: 'AssumeRoleWithWebIdentity',
    Version: QUERY_VERSIONS.sts,
    RoleArn: input.role_arn,
    RoleSessionName: input.role_session_name,
    DurationSeconds: '900',
    WebIdentityToken: input.web_identity_token,
  }).toString();
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return fail('AWS STS web-identity exchange failed before a verified response');
  }
  const xml = await readBoundedResponse(response);
  if (!response.ok) {
    const code = xmlText(xml, 'Code') ?? 'HTTP_' + response.status;
    return fail('AWS STS web-identity exchange was denied or failed (' + code + ')');
  }
  if (!xml.includes('<AssumeRoleWithWebIdentityResult')) {
    return fail('AWS STS web-identity response has an unexpected shape');
  }
  const credentialBlock = xmlBlocks(xml, 'Credentials')[0];
  if (!credentialBlock) return fail('AWS STS web-identity response omitted temporary credentials');
  return validateCredentials({
    access_key_id: xmlText(credentialBlock, 'AccessKeyId') ?? '',
    secret_access_key: xmlText(credentialBlock, 'SecretAccessKey') ?? '',
    session_token: xmlText(credentialBlock, 'SessionToken') ?? '',
  });
}

interface QueryResult {
  xml: string;
  queryReceiptReference: string;
}

interface PageBudget {
  total: number;
  maximum: number;
}

class AwsQueryApi {
  constructor(
    private readonly timeoutMs: number,
    private readonly fetcher: typeof fetch,
    private readonly budget: PageBudget,
  ) {}

  async call(
    service: 'sts' | 'ec2' | 'rds',
    region: string,
    credentials: AwsRdsPitrCredentials,
    action: string,
    parameters: Record<string, string> = {},
  ): Promise<QueryResult> {
    if (this.budget.total >= this.budget.maximum) return fail('AWS provider calls exceeded the global page/request budget');
    this.budget.total += 1;
    const dnsSuffix = region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
    const host = service === 'sts'
      ? 'sts.' + region + '.' + dnsSuffix
      : service + '.' + region + '.' + dnsSuffix;
    const endpoint = 'https://' + host + '/';
    const bodyParams: Record<string, string> = { Action: action, Version: QUERY_VERSIONS[service], ...parameters };
    const body = Object.keys(bodyParams).sort().map((key) => encode(key) + '=' + encode(bodyParams[key]!)).join('&');
    const payloadHash = sha256(body);
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (credentials.session_token) headers['x-amz-security-token'] = credentials.session_token;
    const signedNames = Object.keys(headers).sort();
    const canonicalHeaders = signedNames.map((name) =>
      name + ':' + headers[name]!.trim().replace(/\s+/g, ' ') + '\n').join('');
    const signedHeaders = signedNames.join(';');
    const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = dateStamp + '/' + region + '/' + service + '/aws4_request';
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
    const signingKey = hmac(
      hmac(hmac(hmac('AWS4' + credentials.secret_access_key, dateStamp), region), service),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
    const authorization = 'AWS4-HMAC-SHA256 Credential=' + credentials.access_key_id + '/'
      + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: 'POST',
        headers: { ...headers, authorization },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return fail('AWS ' + service + ' ' + action + ' request failed before a verified response');
    }
    const xml = await readBoundedResponse(response);
    if (!response.ok) {
      const code = xmlText(xml, 'Code') ?? 'HTTP_' + response.status;
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(code)) return fail('AWS returned an invalid service error code');
      return fail('AWS ' + service + ' ' + action + ' was denied or failed (' + code + ')');
    }
    if (!xml.includes('<' + action + 'Result') && !xml.includes('<' + action + 'Response')) {
      return fail('AWS ' + service + ' ' + action + ' returned an unexpected XML response');
    }
    const queryReceiptReference = 'aws-query.' + service + '.' + action.toLowerCase() + '.'
      + sha256(endpoint + action + sha256(credentials.access_key_id) + sha256(xml)).slice(0, 32);
    return { xml, queryReceiptReference };
  }

  async paginateOrganizations(
    region: string,
    credentials: AwsRdsPitrCredentials,
  ): Promise<{
    accounts: Array<{ id: string; state: string }>;
    pages: number;
    receipts: string[];
  }> {
    const accounts: Array<{ id: string; state: string }> = [];
    const receipts: string[] = [];
    const seenTokens = new Set<string>();
    let nextToken: string | null = null;
    let pages = 0;
    do {
      if (this.budget.total >= this.budget.maximum) {
        return fail('AWS provider calls exceeded the global page/request budget');
      }
      this.budget.total += 1;
      const dnsSuffix = region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
      const host = 'organizations.' + region + '.' + dnsSuffix;
      const endpoint = 'https://' + host + '/';
      const requestBody: Record<string, unknown> = { MaxResults: 20 };
      if (nextToken !== null) requestBody.NextToken = nextToken;
      const body = JSON.stringify(requestBody);
      const payloadHash = sha256(body);
      const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      const dateStamp = amzDate.slice(0, 8);
      const target = 'AWSOrganizationsV20161128.ListAccounts';
      const headers: Record<string, string> = {
        'content-type': 'application/x-amz-json-1.1',
        host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        'x-amz-target': target,
      };
      if (credentials.session_token) headers['x-amz-security-token'] = credentials.session_token;
      const signedNames = Object.keys(headers).sort();
      const canonicalHeaders = signedNames.map((name) =>
        name + ':' + headers[name]!.trim().replace(/\s+/g, ' ') + '\n').join('');
      const signedHeaders = signedNames.join(';');
      const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
      const scope = dateStamp + '/' + region + '/organizations/aws4_request';
      const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
      const signingKey = hmac(
        hmac(hmac(hmac('AWS4' + credentials.secret_access_key, dateStamp), region), 'organizations'),
        'aws4_request',
      );
      const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
      const authorization = 'AWS4-HMAC-SHA256 Credential=' + credentials.access_key_id + '/'
        + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
      let response: Response;
      try {
        response = await this.fetcher(endpoint, {
          method: 'POST',
          headers: { ...headers, authorization },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        return fail('AWS Organizations ListAccounts request failed before a verified response');
      }
      const responseText = await readBoundedResponse(response);
      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText) as unknown;
      } catch {
        return fail('AWS Organizations ListAccounts returned malformed JSON');
      }
      if (!response.ok) {
        const error = isRecord(parsed) ? String(parsed.__type ?? parsed.code ?? parsed.Code ?? 'HTTP_' + response.status) : 'HTTP_' + response.status;
        const code = error.split('#').pop()?.split(':').pop() ?? 'UNKNOWN';
        if (!/^[A-Za-z0-9_.-]{1,100}$/.test(code)) return fail('AWS Organizations returned an invalid service error code');
        return fail('AWS Organizations ListAccounts was denied or failed (' + code + ')');
      }
      if (!isRecord(parsed) || !Array.isArray(parsed.Accounts)) {
        return fail('AWS Organizations ListAccounts response has an unexpected JSON shape');
      }
      if (parsed.Accounts.length > 20 || accounts.length + parsed.Accounts.length > MAX_ACCOUNTS) {
        return fail('AWS Organizations ListAccounts exceeded its per-page or total account item budget');
      }
      for (const item of parsed.Accounts) {
        if (!isRecord(item)) return fail('AWS Organizations returned a malformed account entry');
        const id = typeof item.Id === 'string' ? item.Id : '';
        const state = typeof item.State === 'string' ? item.State.toUpperCase()
          : typeof item.Status === 'string' ? item.Status.toUpperCase() : 'UNKNOWN';
        accounts.push({ id, state });
      }
      pages += 1;
      receipts.push('aws-query.organizations.listaccounts.'
        + sha256(endpoint + target + sha256(credentials.access_key_id) + sha256(responseText)).slice(0, 32));
      const tokenValue = parsed.NextToken;
      if (tokenValue !== undefined && tokenValue !== null && tokenValue !== '') {
        if (typeof tokenValue !== 'string' || tokenValue.length > 100000 || seenTokens.has(tokenValue)) {
          return fail('AWS Organizations ListAccounts returned an invalid or repeated continuation token');
        }
        seenTokens.add(tokenValue);
        nextToken = tokenValue;
      } else {
        nextToken = null;
      }
    } while (nextToken !== null);
    return { accounts, pages, receipts };
  }

  async paginate(
    service: 'ec2' | 'rds',
    region: string,
    credentials: AwsRdsPitrCredentials,
    action: string,
    itemTag: string,
    markerName: 'NextToken' | 'Marker',
    parameters: Record<string, string> = {},
    maxItems = MAX_TOTAL_ITEMS,
  ): Promise<{ blocks: string[]; pages: number; receipts: string[] }> {
    const requestedPageSize = Number(parameters.MaxRecords ?? parameters.MaxResults ?? 100);
    if (!Number.isSafeInteger(requestedPageSize) || requestedPageSize < 1 || requestedPageSize > 1000
      || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > MAX_TOTAL_ITEMS) {
      return fail('AWS ' + action + ' pagination limits are invalid');
    }
    const blocks: string[] = [];
    const receipts: string[] = [];
    const seenMarkers = new Set<string>();
    let marker: string | null = null;
    let pages = 0;
    do {
      const params = { ...parameters };
      if (marker) params[markerName] = marker;
      const response = await this.call(service, region, credentials, action, params);
      pages += 1;
      receipts.push(response.queryReceiptReference);
      const pageItems = xmlBlocks(response.xml, itemTag);
      if (pageItems.length > requestedPageSize) {
        return fail('AWS ' + action + ' returned more items than its requested page size');
      }
      if (blocks.length + pageItems.length > maxItems) {
        return fail('AWS ' + action + ' exceeded its bounded catalog item limit');
      }
      blocks.push(...pageItems);
      const next = xmlText(response.xml, markerName);
      if (next !== null && next !== '') {
        if (next.length > 4096 || seenMarkers.has(next)) {
          return fail('AWS ' + action + ' returned an invalid or repeated continuation token');
        }
        seenMarkers.add(next);
      }
      marker = next;
    } while (marker !== null && marker !== '');
    return { blocks, pages, receipts };
  }
}

function xmlWithoutAutomatedBackupReplications(block: string): string {
  return block.replace(
    /<(?:[A-Za-z0-9_]+:)?DBInstanceAutomatedBackupsReplications(?:\s[^>]*)?>[\s\S]*?<\/(?:[A-Za-z0-9_]+:)?DBInstanceAutomatedBackupsReplications\s*>/i,
    '',
  );
}

function resourceFromBlock(
  block: string,
  _tag: string,
  scope: AwsRdsPitrProviderScope,
  resourceType: string,
  arnTag: string,
  sourceDatabaseTag: string | null,
  fieldNames: string[],
): AwsRdsPitrResource {
  const primaryBlock = resourceType === 'RDS_AUTOMATED_BACKUP'
    ? xmlWithoutAutomatedBackupReplications(block) : block;
  const rawArn = xmlText(primaryBlock, arnTag);
  const arn = rawArn === null && resourceType === 'RDS_AUTOMATED_BACKUP'
    ? null
    : requireAwsArn(rawArn, resourceType + ' ARN', scope);
  const sourceDatabaseReference = sourceDatabaseTag ? optionalString(xmlText(primaryBlock, sourceDatabaseTag)) : null;
  const dbiResourceId = optionalString(xmlText(primaryBlock, 'DbiResourceId'));
  if (resourceType === 'RDS_AUTOMATED_BACKUP' && !arn
    && (typeof dbiResourceId !== 'string' || !/^db-[A-Za-z0-9]+$/.test(dbiResourceId))) {
    return fail('RDS automated backup omitted a valid stable source DbiResourceId and replicated-backup ARN');
  }
  const identityMaterial = arn ?? [
    scope.account_reference,
    scope.region_reference,
    resourceType,
    dbiResourceId ?? '',
  ].join('\u0000');
  const providerIdentityReference = 'aws-rds-resource.' + sha256(identityMaterial).slice(0, 40);
  const isAutomatedBackup = resourceType === 'RDS_AUTOMATED_BACKUP';
  const isSnapshot = resourceType === 'RDS_DB_SNAPSHOT' || resourceType === 'RDS_DB_CLUSTER_SNAPSHOT';
  const snapshotIdentifier = resourceType === 'RDS_DB_SNAPSHOT' ? optionalString(xmlText(primaryBlock, 'DBSnapshotIdentifier'))
    : resourceType === 'RDS_DB_CLUSTER_SNAPSHOT' ? optionalString(xmlText(primaryBlock, 'DBClusterSnapshotIdentifier')) : null;
  const providerDeleteIdentity = isAutomatedBackup ? (arn ?? dbiResourceId)
    : isSnapshot ? snapshotIdentifier : null;
  const providerDeleteIdentityKind = isAutomatedBackup ? (arn ? 'REPLICATED_BACKUP_ARN' : 'DBI_RESOURCE_ID')
    : isSnapshot && snapshotIdentifier ? 'SNAPSHOT_IDENTIFIER' : null;
  const replicationDestinationArns = resourceType === 'RDS_AUTOMATED_BACKUP'
    ? xmlBlocks(block, 'DBInstanceAutomatedBackupsReplication').map((entry) => xmlText(entry, 'DBInstanceAutomatedBackupsArn'))
      .filter((entry): entry is string => entry !== null).map((entry) => {
        const match = /^arn:(aws|aws-us-gov|aws-cn):rds:([a-z0-9-]+):(\d{12}):auto-backup:[A-Za-z0-9_-]+$/.exec(entry);
        if (!match || match[1] !== partitionForRegion(scope.region_reference)
          || match[3] !== scope.account_reference || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(match[2]!)) {
          return fail('RDS automated-backup replication returned an invalid cross-region backup ARN');
        }
        return entry;
      })
    : [];
  const retention = optionalInteger(xmlText(primaryBlock, 'BackupRetentionPeriod'));
  const attrs: Record<string, string | null> = {};
  for (const name of fieldNames) attrs[name] = optionalString(xmlText(primaryBlock, name));
  return {
    resource_arn: arn,
    provider_identity_reference: providerIdentityReference,
    identity_kind: arn ? 'IMMUTABLE_RESOURCE_ARN' : 'SOURCE_DB_RESOURCE_ID',
    provider_delete_identity_reference: providerDeleteIdentity,
    provider_delete_identity_kind: providerDeleteIdentityKind,
    replication_destination_arns: replicationDestinationArns,
    resource_type: resourceType,
    account_id: scope.account_reference,
    region: scope.region_reference,
    engine: optionalString(xmlText(primaryBlock, 'Engine')),
    source_database_reference: sourceDatabaseReference,
    status: optionalString(xmlText(primaryBlock, 'Status') ?? xmlText(primaryBlock, 'DBInstanceStatus') ?? xmlText(primaryBlock, 'DBClusterStatus')),
    created_at: optionalString(xmlText(primaryBlock, 'SnapshotCreateTime') ?? xmlText(primaryBlock, 'InstanceCreateTime')),
    earliest_restorable_time: optionalString(xmlText(primaryBlock, 'EarliestTime')),
    latest_restorable_time: optionalString(xmlText(primaryBlock, 'LatestTime') ?? xmlText(primaryBlock, 'LatestRestorableTime')),
    retention_days: retention,
    attributes: { account_id: scope.account_reference, region: scope.region_reference, ...attrs },
  };
}
function sourceFromItems(
  sourceKind: AwsRdsPitrSourceKind,
  status: AwsRdsPitrSourceStatus,
  reason: string,
  items: AwsRdsPitrResource[],
  pages: number,
  receipts: string[],
): AwsRdsPitrCatalogSource {
  const sorted = [...items].sort((a, b) => a.provider_identity_reference < b.provider_identity_reference ? -1
    : a.provider_identity_reference > b.provider_identity_reference ? 1 : 0);
  const unique = new Set(sorted.map((item) => item.provider_identity_reference));
  if (unique.size !== sorted.length) return fail(sourceKind + ' contains a duplicate provider resource identity');
  const normalized = JSON.stringify(sorted);
  return {
    source_kind: sourceKind,
    status,
    reason,
    pages_fetched: pages,
    item_count: sorted.length,
    result_sha256: sha256(normalized),
    query_receipt_references: [...new Set(receipts)].sort(),
    items: sorted,
  };
}

function validateTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    return fail(field + ' must be a canonical UTC timestamp');
  }
  return parsed;
}

/**
 * AWS Query-protocol inventory adapter. It only implements STS AssumeRole,
 * Organizations/EC2 discovery and RDS Describe* APIs; there are deliberately
 * no RDS Delete*, Modify* or restore methods in this class.
 */
export class AwsRdsPostgresqlPitrProviderAdapter {
  private readonly config: ReturnType<typeof validateConfig>;
  private readonly sourceCredentials: AwsRdsPitrCredentials;
  private readonly api: AwsQueryApi;
  private readonly backupApi: AwsBackupInventoryApi;
  private readonly databasePrincipalReader: AwsRdsPitrDatabasePrincipalInventoryReader | null;
  private totalDatabaseQueries = 0;
  private totalDatabasePrincipalRows = 0;
  private totalItems = 0;
  private totalPaginationPages = 0;

  constructor(
    config: AwsRdsPitrProviderConfig,
    sourceCredentials: AwsRdsPitrCredentials,
    fetcher: typeof fetch = globalThis.fetch,
    now: () => Date = () => new Date(),
    databasePoolFactory?: AwsRdsPitrPgPoolFactory,
  ) {
    this.config = validateConfig(config);
    this.sourceCredentials = validateCredentials(sourceCredentials);
    this.now = now;
    this.budget = { total: 0, maximum: this.config.max_total_pages };
    this.api = new AwsQueryApi(this.config.request_timeout_ms, fetcher, this.budget);
    this.backupApi = new AwsBackupInventoryApi(this.config.request_timeout_ms, fetcher, this.budget, this.config.max_total_items);
    this.databasePrincipalReader = this.config.database_principal_inventory
      ? new AwsRdsPitrDatabasePrincipalInventoryReader(this.config.database_principal_inventory, databasePoolFactory)
      : null;
  }

  private readonly now: () => Date;
  private readonly budget: PageBudget;

  private addItems(count: number): void {
    this.totalItems += count;
    if (this.totalItems > this.config.max_total_items) {
      return fail('AWS account, region and resource inventory exceeded the global item budget');
    }
  }

  private async callerIdentity(credentials: AwsRdsPitrCredentials, expectedAccount: string): Promise<string> {
    const response = await this.api.call('sts', this.config.organization_region, credentials, 'GetCallerIdentity');
    const account = xmlText(response.xml, 'Account');
    const arn = xmlText(response.xml, 'Arn');
    if (account !== expectedAccount || !arn || !arn.startsWith('arn:' + partitionForRegion(this.config.organization_region) + ':sts::' + expectedAccount + ':')) {
      return fail('AWS STS identity does not match the expected account');
    }
    return safeReference(arn, 'AWS STS caller principal');
  }

  private async assumeReadOnlyRole(
    accountId: string,
    roleName = this.config.read_only_role_name,
  ): Promise<{ credentials: AwsRdsPitrCredentials; arn: string; principal: string }> {
    if (!ROLE_NAME.test(roleName)) return fail('requested AWS read-only role name is invalid');
    const roleArn = 'arn:' + partitionForRegion(this.config.organization_region) + ':iam::' + accountId + ':role/' + roleName;
    const params: Record<string, string> = {
      RoleArn: roleArn,
      RoleSessionName: 'FactoryOSPitrInventory',
      DurationSeconds: '900',
    };
    if (this.config.external_id) params.ExternalId = this.config.external_id;
    const response = await this.api.call('sts', this.config.organization_region, this.sourceCredentials, 'AssumeRole', params);
    const credentialsBlock = xmlBlocks(response.xml, 'Credentials')[0];
    if (!credentialsBlock) return fail('AWS STS AssumeRole omitted temporary credentials');
    const credentials = validateCredentials({
      access_key_id: xmlText(credentialsBlock, 'AccessKeyId') ?? '',
      secret_access_key: xmlText(credentialsBlock, 'SecretAccessKey') ?? '',
      session_token: xmlText(credentialsBlock, 'SessionToken') ?? '',
    });
    const principal = await this.callerIdentity(credentials, accountId);
    const expectedPrincipalPrefix = 'arn:' + partitionForRegion(this.config.organization_region) + ':sts::' + accountId + ':assumed-role/' + roleName + '/';
    if (!principal.startsWith(expectedPrincipalPrefix)) {
      return fail('assumed AWS principal does not match the configured read-only role');
    }
    return { credentials, arn: roleArn, principal };
  }

  private async discoverAccounts(): Promise<{
    accounts: Array<{ id: string; state: string }>;
    pages: number;
    receipts: string[];
  }> {
    await this.callerIdentity(this.sourceCredentials, this.config.organization_account_id);
    const result = await this.api.paginateOrganizations(
      this.config.organization_region,
      this.sourceCredentials,
    );
    this.totalPaginationPages += result.pages;
    const accounts = result.accounts;
if (accounts.length < 1 || accounts.length > MAX_ACCOUNTS
      || accounts.some((account) => !AWS_ACCOUNT_ID.test(account.id))) {
      return fail('AWS Organizations did not return a complete, valid account catalog');
    }
    if (new Set(accounts.map((account) => account.id)).size !== accounts.length) {
      return fail('AWS Organizations returned duplicate account IDs');
    }
    this.addItems(accounts.length);
    return { accounts: accounts.map((account) => ({ ...account, state: account.state.toUpperCase() })), pages: result.pages, receipts: result.receipts };
  }

  private async discoverRegions(
    credentials: AwsRdsPitrCredentials,
    accountId: string,
  ): Promise<{ enabled: string[]; excluded: Array<{ region: string; optInStatus: string }>; pages: number; receipts: string[] }> {
    const result = await this.api.paginate(
      'ec2',
      this.config.organization_region,
      credentials,
      'DescribeRegions',
      'item',
      'NextToken',
      { AllRegions: 'true', MaxResults: '1000' },
      Math.min(this.config.max_total_items, MAX_TOTAL_ITEMS),
    );
    this.totalPaginationPages += result.pages;
    const regions = result.blocks.map((block) => ({
      region: xmlText(block, 'regionName') ?? '',
      optInStatus: xmlText(block, 'optInStatus') ?? 'unknown',
    }));
    if (regions.length < 1 || regions.some((region) => !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(region.region)
      || !['opted-in', 'opt-in-not-required', 'not-opted-in'].includes(region.optInStatus))) {
      return fail('AWS EC2 DescribeRegions returned an incomplete region or unknown opt-in status for account ' + accountId);
    }
    if (new Set(regions.map((region) => region.region)).size !== regions.length) {
      return fail('AWS EC2 DescribeRegions returned duplicate regions');
    }
    this.addItems(regions.length);
    return {
      enabled: regions.filter((region) => region.optInStatus === 'opted-in' || region.optInStatus === 'opt-in-not-required')
        .map((region) => region.region).sort(),
      excluded: regions.filter((region) => region.optInStatus === 'not-opted-in')
        .map((region) => ({ region: region.region, optInStatus: region.optInStatus })),
      pages: result.pages,
      receipts: result.receipts,
    };
  }

  private async listRds(
    action: string,
    itemTag: string,
    scope: AwsRdsPitrProviderScope,
    credentials: AwsRdsPitrCredentials,
  ): Promise<{ blocks: string[]; pages: number; receipts: string[] }> {
    return this.api.paginate(
      'rds',
      scope.region_reference,
      credentials,
      action,
      itemTag,
      'Marker',
      { MaxRecords: String(this.config.page_size) },
      Math.min(this.config.max_total_items, MAX_TOTAL_ITEMS),
    );
  }

  async captureInventory(): Promise<AwsRdsPostgresqlPitrInventory> {
    const generatedAt = this.now();
    if (!(generatedAt instanceof Date) || !Number.isFinite(generatedAt.getTime())) {
      return fail('inventory clock is invalid');
    }
    this.totalItems = 0;
    this.totalPaginationPages = 0;
    this.budget.total = 0;
    const accountResult = await this.discoverAccounts();
    const scopes: AwsRdsPostgresqlPitrInventory['scopes'] = [];
    const excludedAccounts: AwsRdsPostgresqlPitrInventory['excluded_accounts'] = [];
    const excludedRegions: AwsRdsPostgresqlPitrInventory['excluded_regions'] = [];
    let regionPages = 0;
    let accountDiscoveryComplete = true;
    let regionDiscoveryComplete = true;

    for (const account of accountResult.accounts) {
      if (account.state !== 'ACTIVE') {
        excludedAccounts.push({
          account_id: account.id,
          state: account.state,
          reason: 'The account is not ACTIVE; role assumption and resource enumeration were not claimed.',
        });
        accountDiscoveryComplete = false;
        continue;
      }
      const role = await this.assumeReadOnlyRole(account.id);
      const regionResult = await this.discoverRegions(role.credentials, account.id);
      regionPages += regionResult.pages;
      excludedRegions.push(...regionResult.excluded.map((item) => ({
        account_id: account.id,
        region: item.region,
        opt_in_status: item.optInStatus,
      })));
      if (regionResult.enabled.length === 0) {
        regionDiscoveryComplete = false;
        excludedAccounts.push({
          account_id: account.id,
          state: account.state,
          reason: 'No enabled AWS region was returned for this active account.',
        });
      }
      for (const region of regionResult.enabled) {
        scopes.push({
          scope: { provider_reference: 'aws', account_reference: account.id, region_reference: region },
          assumed_role_arn: role.arn,
          verified_principal_reference: role.principal,
        });
      }
    }
if (scopes.length < 1 || scopes.length > MAX_SCOPES)
    this.addItems(scopes.length);

    const backupVaults: AwsBackupVaultRecord[] = [];
    const backupRecoveryPoints: AwsBackupRecoveryPointRecord[] = [];
    const backupLegalHolds: AwsBackupLegalHoldRecord[] = [];
    const backupLegalHoldRecoveryPointArns = new Set<string>();
    const backupReceiptReferences: string[] = [];
    let backupLegalHoldScopeStatusUncertain = false;
    let backupPages = 0;
    const sourceItems = new Map<AwsRdsPitrSourceKind, AwsRdsPitrResource[]>();
    const sourcePages = new Map<AwsRdsPitrSourceKind, number>();
    const sourceReceipts = new Map<AwsRdsPitrSourceKind, string[]>();
    const append = (kind: AwsRdsPitrSourceKind, resources: AwsRdsPitrResource[], pages: number, receipts: string[]) => {
      const current = sourceItems.get(kind) ?? [];
      current.push(...resources);
      sourceItems.set(kind, current);
      sourcePages.set(kind, (sourcePages.get(kind) ?? 0) + pages);
      sourceReceipts.set(kind, [...(sourceReceipts.get(kind) ?? []), ...receipts]);
      this.addItems(resources.length);
    };

    for (const entry of scopes) {
      const scope = entry.scope;
      const role = await this.assumeReadOnlyRole(scope.account_reference);
      if (role.principal !== entry.verified_principal_reference) {
        return fail('AWS role identity changed between discovery and resource enumeration');
      }
      const [instances, clusters, globals, automated, snapshots, clusterSnapshots] = await Promise.all([
        this.listRds('DescribeDBInstances', 'DBInstance', scope, role.credentials),
        this.listRds('DescribeDBClusters', 'DBCluster', scope, role.credentials),
        this.listRds('DescribeGlobalClusters', 'GlobalCluster', scope, role.credentials),
        this.listRds('DescribeDBInstanceAutomatedBackups', 'DBInstanceAutomatedBackup', scope, role.credentials),
        this.listRds('DescribeDBSnapshots', 'DBSnapshot', scope, role.credentials),
        this.listRds('DescribeDBClusterSnapshots', 'DBClusterSnapshot', scope, role.credentials),
      ]);
      this.totalPaginationPages += instances.pages + clusters.pages + globals.pages
        + automated.pages + snapshots.pages + clusterSnapshots.pages;
      const backupVaultResult = await this.backupApi.listBackupVaults(scope, role.credentials);
      backupReceiptReferences.push(...backupVaultResult.receipts);
      backupVaults.push(...backupVaultResult.vaults);
      backupPages += backupVaultResult.pages;
      this.totalPaginationPages += backupVaultResult.pages;
      this.addItems(backupVaultResult.vaults.length);
      for (const vault of backupVaultResult.vaults) {
        const recoveryResult = await this.backupApi.listRecoveryPointsByVault(scope, role.credentials, vault);
        backupReceiptReferences.push(...recoveryResult.receipts);
        backupRecoveryPoints.push(...recoveryResult.points);
        backupPages += recoveryResult.pages;
        this.totalPaginationPages += recoveryResult.pages;
        this.addItems(recoveryResult.total_items_seen);
        if (vault.number_of_recovery_points !== null
          && vault.number_of_recovery_points !== recoveryResult.total_items_seen) {
          return fail('AWS Backup recovery-point page count does not reconcile with the provider vault inventory');
        }
      }
      const legalHoldResult = await this.backupApi.listLegalHolds(scope, role.credentials);
      backupReceiptReferences.push(...legalHoldResult.receipts);
      backupLegalHolds.push(...legalHoldResult.legal_holds);
      legalHoldResult.recovery_point_arns.forEach((arn) => backupLegalHoldRecoveryPointArns.add(arn));
      backupLegalHoldScopeStatusUncertain ||= legalHoldResult.scope_status_uncertain;
      backupPages += legalHoldResult.pages;
      this.totalPaginationPages += legalHoldResult.pages;
      this.addItems(legalHoldResult.total_items_seen);
      const postgresEngine = (engine: string | null) =>
        engine?.toLowerCase() === 'postgres' || engine?.toLowerCase() === 'aurora-postgresql';
      const clusterResources = [
        ...instances.blocks.map((block) => resourceFromBlock(block, 'DBInstance', scope, 'RDS_DB_INSTANCE', 'DBInstanceArn',
          'DbiResourceId', ['DBInstanceIdentifier', 'DbiResourceId', 'DBInstanceStatus', 'BackupRetentionPeriod',
            'LatestRestorableTime', 'ReadReplicaSourceDBInstanceIdentifier', 'MultiAZ', 'StorageEncrypted'])),
        ...clusters.blocks.map((block) => resourceFromBlock(block, 'DBCluster', scope, 'RDS_DB_CLUSTER', 'DBClusterArn',
          'DBClusterIdentifier', ['DBClusterIdentifier', 'DBClusterStatus', 'GlobalClusterIdentifier',
            'ReplicationSourceIdentifier', 'BackupRetentionPeriod', 'StorageEncrypted'])),
        ...globals.blocks.map((block) => resourceFromBlock(block, 'GlobalCluster', scope, 'RDS_GLOBAL_CLUSTER', 'GlobalClusterArn',
          'GlobalClusterIdentifier', ['GlobalClusterIdentifier', 'Engine', 'Status', 'EngineVersion'])),
      ].filter((resource) => postgresEngine(resource.engine));
      append('POSTGRESQL_CLUSTER_CATALOG', clusterResources,
        instances.pages + clusters.pages + globals.pages,
        [...instances.receipts, ...clusters.receipts, ...globals.receipts]);

      const archiveResources = [
        ...automated.blocks.map((block) => resourceFromBlock(block, 'DBInstanceAutomatedBackup', scope, 'RDS_AUTOMATED_BACKUP',
          'DBInstanceAutomatedBackupsArn', 'DBInstanceIdentifier',
          ['DBInstanceArn', 'DBInstanceAutomatedBackupsArn', 'AwsBackupRecoveryPointArn', 'DBInstanceIdentifier', 'DbiResourceId', 'Region', 'Status', 'BackupRetentionPeriod'])),
        ...snapshots.blocks.map((block) => resourceFromBlock(block, 'DBSnapshot', scope, 'RDS_DB_SNAPSHOT', 'DBSnapshotArn',
          'DBInstanceIdentifier', ['DBSnapshotIdentifier', 'DBInstanceIdentifier', 'SnapshotType', 'Status', 'Encrypted', 'KmsKeyId'])),
        ...clusterSnapshots.blocks.map((block) => resourceFromBlock(block, 'DBClusterSnapshot', scope, 'RDS_DB_CLUSTER_SNAPSHOT', 'DBClusterSnapshotArn',
          'DBClusterIdentifier', ['DBClusterSnapshotIdentifier', 'DBClusterIdentifier', 'SnapshotType', 'Status', 'Encrypted', 'KmsKeyId'])),
      ].filter((resource) => postgresEngine(resource.engine));
      append('WAL_ARCHIVE_DESTINATION_CATALOG', archiveResources,
        automated.pages + snapshots.pages + clusterSnapshots.pages,
        [...automated.receipts, ...snapshots.receipts, ...clusterSnapshots.receipts]);

      const replicationResources = [
        ...clusterResources.filter((resource) => resource.attributes.ReadReplicaSourceDBInstanceIdentifier
          || resource.attributes.GlobalClusterIdentifier || resource.attributes.ReplicationSourceIdentifier),
        ...archiveResources.filter((resource) => resource.replication_destination_arns.length > 0),
      ];
      append('WAL_REPLICATION_PATH_CATALOG', replicationResources,
        instances.pages + clusters.pages + globals.pages + automated.pages,
        [...instances.receipts, ...clusters.receipts, ...globals.receipts, ...automated.receipts]);

      append('PITR_RESTORE_PATH_CATALOG', archiveResources.filter((resource) =>
        resource.resource_type === 'RDS_AUTOMATED_BACKUP'
        || resource.resource_type === 'RDS_DB_SNAPSHOT'
        || resource.resource_type === 'RDS_DB_CLUSTER_SNAPSHOT'),
      automated.pages + snapshots.pages + clusterSnapshots.pages,
      [...automated.receipts, ...snapshots.receipts, ...clusterSnapshots.receipts]);
    }

    const discoveredAutomatedBackupArns = new Set(
      (sourceItems.get('WAL_ARCHIVE_DESTINATION_CATALOG') ?? [])
        .filter((resource) => resource.resource_type === 'RDS_AUTOMATED_BACKUP' && resource.resource_arn !== null)
        .map((resource) => resource.resource_arn as string),
    );
    const unresolvedReplicationDestinationArns = [...new Set(
      (sourceItems.get('WAL_ARCHIVE_DESTINATION_CATALOG') ?? [])
        .flatMap((resource) => resource.replication_destination_arns),
    )].filter((arn) => !discoveredAutomatedBackupArns.has(arn)).sort();
    const backupRecoveryResources: AwsRdsPitrResource[] = backupRecoveryPoints.map((point) => ({
      resource_arn: point.recovery_point_arn,
      provider_identity_reference: 'aws-backup-recovery-point.' + sha256(point.recovery_point_arn).slice(0, 40),
      identity_kind: 'IMMUTABLE_RESOURCE_ARN',
      provider_delete_identity_reference: point.recovery_point_arn,
      provider_delete_identity_kind: 'AWS_BACKUP_RECOVERY_POINT_ARN',
      replication_destination_arns: [],
      resource_type: 'AWS_BACKUP_RECOVERY_POINT',
      account_id: point.account_id,
      region: point.region,
      engine: null,
      source_database_reference: point.resource_arn,
      status: point.status,
      created_at: point.creation_date,
      earliest_restorable_time: null,
      latest_restorable_time: null,
      retention_days: null,
      attributes: {
        ResourceArn: point.resource_arn,
        ResourceType: point.resource_type,
        BackupVaultArn: point.backup_vault_arn,
        BackupVaultName: point.backup_vault_name,
        CompletionDate: point.completion_date,
        LastRestoreTime: point.last_restore_time,
        LifecycleDeleteAt: point.lifecycle_delete_at,
        LifecycleDeleteAfterDays: point.lifecycle_delete_after_days === null ? null : String(point.lifecycle_delete_after_days),
        LifecycleMoveToColdStorageAfterDays: point.lifecycle_move_to_cold_storage_after_days === null
          ? null : String(point.lifecycle_move_to_cold_storage_after_days),
        LifecycleMoveToColdStorageAt: point.lifecycle_move_to_cold_storage_at,
        IsEncrypted: point.is_encrypted === null ? null : String(point.is_encrypted),
        EncryptionKeyArn: point.encryption_key_arn,
        BackupSizeInBytes: point.backup_size_bytes === null ? null : String(point.backup_size_bytes),
        SourceBackupVaultArn: point.source_backup_vault_arn,
        BackupVaultType: point.backup_vault_type,
        BackupVaultState: point.backup_vault_state,
        BackupVaultLocked: point.backup_vault_locked === null ? null : String(point.backup_vault_locked),
        BackupVaultLockDate: point.backup_vault_lock_date,
        BackupVaultMinRetentionDays: point.backup_vault_min_retention_days === null ? null : String(point.backup_vault_min_retention_days),
        BackupVaultMaxRetentionDays: point.backup_vault_max_retention_days === null ? null : String(point.backup_vault_max_retention_days),
      },
    }));
    const backupCatalogComplete = accountDiscoveryComplete && regionDiscoveryComplete;
    const sources: AwsRdsPitrCatalogSource[] = [
      sourceFromItems('POSTGRESQL_CLUSTER_CATALOG', accountDiscoveryComplete && regionDiscoveryComplete ? 'COMPLETE' : 'PARTIAL',
        'RDS DB instance, DB cluster and global-cluster catalogs were enumerated for every discovered enabled account/region scope.',
        sourceItems.get('POSTGRESQL_CLUSTER_CATALOG') ?? [], sourcePages.get('POSTGRESQL_CLUSTER_CATALOG') ?? 0,
        sourceReceipts.get('POSTGRESQL_CLUSTER_CATALOG') ?? []),
      sourceFromItems('WAL_ARCHIVE_DESTINATION_CATALOG', accountDiscoveryComplete && regionDiscoveryComplete ? 'COMPLETE' : 'PARTIAL',
        'RDS-managed automated backups and manual/automated snapshot resources were enumerated. This is not an individual WAL object inventory.',
        sourceItems.get('WAL_ARCHIVE_DESTINATION_CATALOG') ?? [], sourcePages.get('WAL_ARCHIVE_DESTINATION_CATALOG') ?? 0,
        sourceReceipts.get('WAL_ARCHIVE_DESTINATION_CATALOG') ?? []),
      sourceFromItems('WAL_SEGMENT_CATALOG', 'OPAQUE_PROVIDER_MANAGED',
        'RDS-managed PostgreSQL WAL/system-backup chains are provider-managed; AWS RDS Describe APIs do not expose every WAL segment as an independently addressable object generation.',
        [], 0, []),
      sourceFromItems('WAL_WRITER_PRINCIPAL_CATALOG', 'NOT_ENUMERATED',
        'IAM role discovery and database-native login/replication principal inventory are not included in this adapter and remain a hard release blocker.',
        [], 0, []),
      sourceFromItems('WAL_REPLICATION_PATH_CATALOG', 'PARTIAL',
        'Read-replica, global-cluster and automated-backup cross-region relationships are captured; external delivery queues and database-side replication identities are not covered.',
        sourceItems.get('WAL_REPLICATION_PATH_CATALOG') ?? [], sourcePages.get('WAL_REPLICATION_PATH_CATALOG') ?? 0,
        sourceReceipts.get('WAL_REPLICATION_PATH_CATALOG') ?? []),
      sourceFromItems('PITR_RESTORE_PATH_CATALOG', 'PARTIAL',
        'RDS automated-backup restore windows, RDS snapshots, AWS Backup RDS/Aurora recovery points and legal-hold membership are enumerated; live restore rehearsal and independent provider audit attestation remain pending.',
        [...(sourceItems.get('PITR_RESTORE_PATH_CATALOG') ?? []), ...backupRecoveryResources],
        (sourcePages.get('PITR_RESTORE_PATH_CATALOG') ?? 0) + backupPages,
        [...(sourceReceipts.get('PITR_RESTORE_PATH_CATALOG') ?? []), ...backupReceiptReferences]),
    ];
    const incomplete = !accountDiscoveryComplete || !regionDiscoveryComplete;
    const sourcePrincipalReference = await this.callerIdentity(this.sourceCredentials, this.config.organization_account_id);
    return {
      schema: AWS_RDS_POSTGRESQL_PITR_INVENTORY_SCHEMA,
      status: incomplete ? 'INCOMPLETE' : 'ENUMERATED_WITH_EXPLICIT_GAPS',
      generated_at: generatedAt.toISOString(),
      organization_account_id: this.config.organization_account_id,
      source_principal_reference: sourcePrincipalReference,
      collector_role_name: this.config.read_only_role_name,
      collector_role_identity_verified: true,
      collector_policy_sha256: this.config.read_only_policy_sha256 ?? null,
      collector_policy_review_reference: this.config.policy_review_reference ?? null,
      collector_policy_independently_verified: false,
      account_discovery_complete: accountDiscoveryComplete,
      region_discovery_complete: regionDiscoveryComplete,
      pagination_exhausted: true,
      accounts_discovered: accountResult.accounts.length,
      regions_discovered: new Set(scopes.map((entry) => entry.scope.region_reference)).size,
      scopes_discovered: scopes.length,
      total_pages_fetched: this.totalPaginationPages,
      total_provider_requests: this.budget.total,
      total_items_observed: this.totalItems,
      scopes,
      excluded_accounts: excludedAccounts,
      excluded_regions: excludedRegions,
      sources,
      backup_vault_catalog_complete: backupCatalogComplete,
      backup_vaults: backupVaults,
      aws_backup_recovery_points_enumerated: backupCatalogComplete,
      aws_backup_recovery_points: backupRecoveryPoints,
      aws_backup_legal_holds_enumerated: backupCatalogComplete,
      aws_backup_legal_holds: backupLegalHolds,
      aws_backup_legal_hold_recovery_point_arns: [...backupLegalHoldRecoveryPointArns].sort(),
      aws_backup_legal_hold_scope_status_uncertain: backupLegalHoldScopeStatusUncertain,
      aws_backup_receipt_references: [...new Set(backupReceiptReferences)].sort(),
      unresolved_replication_destination_arns: unresolvedReplicationDestinationArns,
      provider_managed_wal_segments_individually_enumerated: false,
      database_writer_principals_fully_enumerated: false,
      source_receipts_signable: false,
      manifest_eligible: false,
      deletion_authorized: false,
    };
  }
}

/**
 * Retention preflight is intentionally non-destructive. Even a REVIEW_REQUIRED
 * result does not expose a delete operation or authorize a provider mutation.
 */
export function createAwsRdsPitrRetentionDryRunPlan(
  value: AwsRdsPitrRetentionDryRunInput,
): AwsRdsPitrRetentionDryRunPlan {
  const blockers: string[] = [];
  if (!isRecord(value)) return fail('retention dry-run input must be an object');
  const inventory = value.inventory;
  if (!isRecord(inventory) || inventory.schema !== AWS_RDS_POSTGRESQL_PITR_INVENTORY_SCHEMA
    || !Array.isArray(inventory.sources) || !Array.isArray(inventory.scopes)) {
    blockers.push('A supported AWS RDS PostgreSQL PITR inventory with source and scope catalogs is required.');
  }
  if (inventory && (inventory.status !== 'ENUMERATED_WITH_EXPLICIT_GAPS'
    || !inventory.account_discovery_complete || !inventory.region_discovery_complete
    || inventory.pagination_exhausted !== true)) {
    blockers.push('AWS account/region inventory is incomplete.');
  }
  const candidateReference = typeof value.candidate_provider_identity_reference === 'string'
    && /^aws-(?:rds-resource|backup-recovery-point)\.[a-f0-9]{40}$/.test(value.candidate_provider_identity_reference)
    ? value.candidate_provider_identity_reference : null;
  if (!candidateReference) blockers.push('Candidate must use an exact provider inventory identity reference.');
  const candidateArn = typeof value.candidate_resource_arn === 'string'
    && (RDS_ARN.test(value.candidate_resource_arn)
      || /^arn:(aws|aws-us-gov|aws-cn):backup:[a-z0-9-]+:\d{12}:recovery-point:[A-Za-z0-9._:/-]+$/.test(value.candidate_resource_arn))
    ? value.candidate_resource_arn : null;
  if (value.candidate_resource_arn !== undefined && !candidateArn) {
    blockers.push('Optional candidate resource ARN is malformed.');
  }
  if (!AWS_ACCOUNT_ID.test(value.expected_account_id ?? '')
    || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(value.expected_region ?? '')) {
    blockers.push('Expected AWS account or region is invalid.');
  }
  const now = Date.now();
  let expiry: number | null = null;
  let horizon: number | null = null;
  try {
    expiry = validateTimestamp(value.retention_expires_at, 'retention_expires_at');
    horizon = validateTimestamp(value.minimum_recovery_horizon_end_at, 'minimum_recovery_horizon_end_at');
  } catch {
    blockers.push('Retention expiry or minimum recovery horizon timestamp is invalid.');
  }
  const inventorySources = Array.isArray(inventory?.sources) ? inventory.sources : [];
  const inventoryItems: AwsRdsPitrResource[] = [];
  for (const source of inventorySources) {
    if (!isRecord(source) || !Array.isArray(source.items)) continue;
    for (const item of source.items) {
      if (isRecord(item)) inventoryItems.push(item as unknown as AwsRdsPitrResource);
    }
  }
  const resource = candidateReference
    ? inventoryItems.find((item) => item.provider_identity_reference === candidateReference
      && ['RDS_AUTOMATED_BACKUP', 'RDS_DB_SNAPSHOT', 'RDS_DB_CLUSTER_SNAPSHOT', 'AWS_BACKUP_RECOVERY_POINT'].includes(item.resource_type))
    : undefined;
  if (!resource) {
    blockers.push('Candidate resource was not observed as an exact backup/snapshot provider identity in the supplied inventory.');
  } else {
    if (resource.account_id !== value.expected_account_id || resource.region !== value.expected_region) {
      blockers.push('Observed resource record is outside the expected inventory account/region scope.');
    }
    if (candidateArn !== null && resource.resource_arn !== candidateArn) {
      blockers.push('Candidate ARN does not match the exact provider inventory identity.');
    }
    if (resource.resource_type === 'RDS_AUTOMATED_BACKUP') {
      if (resource.status?.toLowerCase() !== 'retained') {
        blockers.push('Automated backup is not in retained state.');
      }
      if (!resource.provider_delete_identity_reference
        || !['DBI_RESOURCE_ID', 'REPLICATED_BACKUP_ARN'].includes(resource.provider_delete_identity_kind ?? '')) {
        blockers.push('Automated backup lacks an exact AWS-supported retention identity.');
      }
      for (const destinationArn of resource.replication_destination_arns) {
        if (inventory?.unresolved_replication_destination_arns?.includes(destinationArn)) {
          blockers.push('An RDS automated-backup replication destination is absent from the discovered account/region catalogs.');
        }
      }
    } else if (resource.resource_type === 'AWS_BACKUP_RECOVERY_POINT') {
      const postgresSource = inventoryItems.find((item) =>
        item.resource_arn === resource.attributes.ResourceArn
        && ['RDS_DB_INSTANCE', 'RDS_DB_CLUSTER'].includes(item.resource_type)
        && (item.engine?.toLowerCase() === 'postgres' || item.engine?.toLowerCase() === 'aurora-postgresql'));
      if (!postgresSource) {
        blockers.push('AWS Backup recovery point does not map to an inventoried PostgreSQL/Aurora PostgreSQL resource.');
      }
      if (resource.status?.toUpperCase() !== 'COMPLETED') {
        blockers.push('AWS Backup recovery point is not in COMPLETED state.');
      }
      if (resource.provider_delete_identity_kind !== 'AWS_BACKUP_RECOVERY_POINT_ARN'
        || !resource.provider_delete_identity_reference) {
        blockers.push('AWS Backup recovery point lacks its exact recovery-point ARN.');
      }
      if (resource.attributes.BackupVaultType !== 'BACKUP_VAULT') {
        blockers.push('AWS Backup recovery point is not in a standard BACKUP_VAULT.');
      }
      if (resource.attributes.BackupVaultState !== 'AVAILABLE') {
        blockers.push('AWS Backup vault is not AVAILABLE.');
      }
      if (resource.attributes.BackupVaultLocked !== 'false' || resource.attributes.BackupVaultLockDate) {
        blockers.push('AWS Backup vault lock is active, in grace-period configuration, or unknown.');
      }
      const scheduledDeleteAt = resource.attributes.LifecycleDeleteAt;
      if (scheduledDeleteAt) {
        const scheduledDeleteTime = Date.parse(scheduledDeleteAt);
        if (!Number.isFinite(scheduledDeleteTime) || (expiry !== null && expiry < scheduledDeleteTime)) {
          blockers.push('Requested retention expiry precedes the provider-reported AWS Backup lifecycle delete time.');
        }
      }
      const vaultMinimumDays = Number(resource.attributes.BackupVaultMinRetentionDays);
      const vaultMaximumDays = Number(resource.attributes.BackupVaultMaxRetentionDays);
      const pointCreatedAt = resource.created_at ? Date.parse(resource.created_at) : Number.NaN;
      if (Number.isSafeInteger(vaultMinimumDays) && vaultMinimumDays > 0) {
        if (!Number.isFinite(pointCreatedAt)) {
          blockers.push('AWS Backup recovery-point creation time is missing for vault minimum-retention validation.');
        } else if (expiry !== null && expiry < pointCreatedAt + vaultMinimumDays * 86400000) {
          blockers.push('Requested retention expiry violates the AWS Backup vault minimum retention period.');
        }
      }
      if (Number.isSafeInteger(vaultMaximumDays) && vaultMaximumDays > 0) {
        if (!Number.isFinite(pointCreatedAt)) {
          blockers.push('AWS Backup recovery-point creation time is missing for vault maximum-retention validation.');
        } else if (expiry !== null && expiry > pointCreatedAt + vaultMaximumDays * 86400000) {
          blockers.push('Requested retention expiry exceeds the AWS Backup vault maximum retention period.');
        }
      }
      if (resource.attributes.LifecycleDeleteAfterDays !== null
        && resource.attributes.LifecycleDeleteAfterDays !== undefined
        && !resource.attributes.LifecycleDeleteAt) {
        blockers.push('AWS Backup configured DeleteAfterDays has no calculated provider deletion timestamp.');
      }
    } else if (resource.status?.toLowerCase() !== 'available'
      || resource.provider_delete_identity_kind !== 'SNAPSHOT_IDENTIFIER'
      || !resource.provider_delete_identity_reference) {
      blockers.push('Snapshot is not available or lacks an exact snapshot ARN identity.');
    }
  }
  const scopeExists = Array.isArray(inventory?.scopes)
    && inventory.scopes.some((entry: unknown) => isRecord(entry)
      && isRecord(entry.scope)
      && entry.scope.account_reference === value.expected_account_id
      && entry.scope.region_reference === value.expected_region);
  if (!scopeExists) blockers.push('Expected account/region is not present in the captured inventory scope.');
  if (expiry !== null && horizon !== null && expiry < horizon) {
    blockers.push('Candidate retention expires before the approved minimum recovery horizon.');
  }
  if (expiry !== null && expiry > now) blockers.push('Candidate retention period has not expired.');
  if (value.legal_hold_status !== 'NONE') blockers.push('Legal hold is active or unknown.');
  if (value.dependency_status !== 'NO_DEPENDENCY') blockers.push('Restore/replication/copy dependency is present or unknown.');
  for (const [field, reference] of [
    ['policy_reference', value.policy_reference],
    ['data_owner_approval_reference', value.data_owner_approval_reference],
    ['infrastructure_owner_approval_reference', value.infrastructure_owner_approval_reference],
  ] as const) {
    try { safeReference(reference, field); } catch { blockers.push(field + ' is missing or invalid.'); }
  }
  if (inventory && (inventory.backup_vault_catalog_complete !== true
    || inventory.aws_backup_recovery_points_enumerated !== true
    || inventory.aws_backup_legal_holds_enumerated !== true)) {
    blockers.push('AWS Backup vault/recovery-point/legal-hold catalog coverage is incomplete.');
  }
  if (resource && inventory) {
    const linkedRecoveryPointArn = resource.resource_type === 'AWS_BACKUP_RECOVERY_POINT'
      ? resource.resource_arn : resource.attributes.AwsBackupRecoveryPointArn;
    const linkedRecoveryPoint = resource.resource_type === 'AWS_BACKUP_RECOVERY_POINT'
      ? resource
      : linkedRecoveryPointArn
        ? inventoryItems.find((item) => item.resource_type === 'AWS_BACKUP_RECOVERY_POINT'
          && item.resource_arn === linkedRecoveryPointArn)
        : undefined;
    if (resource.resource_type === 'RDS_AUTOMATED_BACKUP' && linkedRecoveryPointArn && !linkedRecoveryPoint) {
      blockers.push('RDS automated backup references an AWS Backup recovery point absent from the complete vault inventory.');
    }
    if (linkedRecoveryPoint) {
      if (linkedRecoveryPoint.status?.toUpperCase() !== 'COMPLETED') {
        blockers.push('Linked AWS Backup recovery point is not in COMPLETED state.');
      }
      if (linkedRecoveryPoint.attributes.BackupVaultLocked !== 'false'
        || linkedRecoveryPoint.attributes.BackupVaultLockDate) {
        blockers.push('Linked AWS Backup vault lock is active, in grace-period configuration, or unknown.');
      }
      const sourceArn = resource.resource_type === 'RDS_AUTOMATED_BACKUP'
        ? resource.attributes.DBInstanceArn : linkedRecoveryPoint.attributes.ResourceArn;
      if (sourceArn && linkedRecoveryPoint.attributes.ResourceArn !== sourceArn) {
        blockers.push('Linked AWS Backup recovery point source ARN does not match the RDS backup source.');
      }
      const linkedDeleteAt = linkedRecoveryPoint.attributes.LifecycleDeleteAt;
      if (linkedDeleteAt) {
        const linkedDeleteTime = Date.parse(linkedDeleteAt);
        if (!Number.isFinite(linkedDeleteTime) || (expiry !== null && expiry < linkedDeleteTime)) {
          blockers.push('Requested retention expiry precedes the linked AWS Backup lifecycle delete time.');
        }
      }
      const linkedMinDays = Number(linkedRecoveryPoint.attributes.BackupVaultMinRetentionDays);
      const linkedMaxDays = Number(linkedRecoveryPoint.attributes.BackupVaultMaxRetentionDays);
      const linkedCreatedAt = linkedRecoveryPoint.created_at ? Date.parse(linkedRecoveryPoint.created_at) : Number.NaN;
      if (Number.isSafeInteger(linkedMinDays) && linkedMinDays > 0) {
        if (!Number.isFinite(linkedCreatedAt)) {
          blockers.push('Linked AWS Backup recovery-point creation time is missing for minimum-retention validation.');
        } else if (expiry !== null && expiry < linkedCreatedAt + linkedMinDays * 86400000) {
          blockers.push('Requested retention expiry violates the linked AWS Backup vault minimum retention period.');
        }
      }
      if (Number.isSafeInteger(linkedMaxDays) && linkedMaxDays > 0) {
        if (!Number.isFinite(linkedCreatedAt)) {
          blockers.push('Linked AWS Backup recovery-point creation time is missing for maximum-retention validation.');
        } else if (expiry !== null && expiry > linkedCreatedAt + linkedMaxDays * 86400000) {
          blockers.push('Requested retention expiry exceeds the linked AWS Backup vault maximum retention period.');
        }
      }
      if (linkedRecoveryPoint.attributes.LifecycleDeleteAfterDays !== null
        && linkedRecoveryPoint.attributes.LifecycleDeleteAfterDays !== undefined
        && !linkedRecoveryPoint.attributes.LifecycleDeleteAt) {
        blockers.push('Linked AWS Backup configured DeleteAfterDays has no calculated provider deletion timestamp.');
      }
      if (inventory.aws_backup_legal_hold_recovery_point_arns?.includes(linkedRecoveryPointArn ?? '')) {
        blockers.push('Candidate recovery point is covered by an active AWS Backup legal hold.');
      }
    }
    if (inventory.aws_backup_legal_hold_scope_status_uncertain) {
      blockers.push('An AWS Backup legal hold is being created/canceled; legal-hold scope is not stable.');
    }
  }
  if (inventory) {
    blockers.push('Provider-managed WAL segments and database writer principal coverage remain unresolved.');
  }
  const identityDigest = resource ? sha256(JSON.stringify({
    provider_identity_reference: resource.provider_identity_reference,
    resource_arn: resource.resource_arn,
    provider_delete_identity_reference: resource.provider_delete_identity_reference,
    provider_delete_identity_kind: resource.provider_delete_identity_kind,
    account_id: resource.account_id,
    region: resource.region,
    inventory_scope_sha256: sha256(JSON.stringify(inventory?.scopes ?? [])),
    inventory_generated_at: inventory?.generated_at ?? null,
    policy_reference: value.policy_reference ?? null,
  })) : null;
  return {
    schema: AWS_RDS_POSTGRESQL_PITR_RETENTION_PLAN_SCHEMA,
    status: blockers.length ? 'BLOCKED' : 'REVIEW_REQUIRED',
    candidate_provider_identity_reference: resource?.provider_identity_reference ?? null,
    candidate_resource_arn: resource?.resource_arn ?? null,
    provider_delete_identity_reference: resource?.provider_delete_identity_reference ?? null,
    provider_delete_identity_kind: resource?.provider_delete_identity_kind ?? null,
    candidate_identity_sha256: identityDigest,
    blockers,
    operation: 'DRY_RUN_ONLY',
    provider_mutation_performed: false,
    delete_api_available: false,
    deletion_authorized: false,
    requires_independent_review: true,
  };
}
