import { createHash, createHmac } from 'node:crypto';
import { Client } from 'pg';

const MAX_CA_BUNDLE_BYTES = 1024 * 1024;
const MAX_ROWS_HARD_LIMIT = 5000;
const MAX_DATABASES_HARD_LIMIT = 256;
const MAX_TOTAL_ROWS_HARD_LIMIT = 100000;
const DATABASE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_$.-]{0,62}$/;
const DATABASE_USER = /^[a-z_][a-z0-9_]{0,62}$/;
const AWS_ACCOUNT_ID = /^\d{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface AwsRdsDatabasePrincipalCredentials {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
}

export interface AwsRdsDatabasePrincipalTarget {
  account_id: string;
  region: string;
  resource_arn: string;
  resource_id: string;
  resource_type: 'RDS_DB_INSTANCE' | 'RDS_DB_CLUSTER';
  engine: 'postgres' | 'aurora-postgresql';
  endpoint: string;
  port: number;
  iam_database_authentication_enabled: boolean;
}

export interface AwsRdsDatabasePrincipalReaderConfig {
  database_username: string;
  ca_bundle_pem: string;
  ca_bundle_sha256: string;
  max_databases_per_target?: number;
  max_rows_per_query?: number;
  max_total_rows?: number;
  max_total_queries?: number;
  statement_timeout_ms?: number;
  connection_timeout_ms?: number;
}

export interface AwsRdsDatabasePrincipalRecord {
  resource_arn: string;
  provider_identity_reference: string;
  resource_type: string;
  account_id: string;
  region: string;
  engine: string;
  database_name: string;
  attributes: Record<string, string | null>;
}

export interface AwsRdsDatabasePrincipalInventoryResult {
  records: AwsRdsDatabasePrincipalRecord[];
  replication_records: AwsRdsDatabasePrincipalRecord[];
  targets_discovered: number;
  targets_scanned: number;
  databases_discovered: number;
  databases_scanned: number;
  pages_fetched: number;
  queries_attempted: number;
  total_rows_observed: number;
  item_count: number;
  receipt_references: string[];
  blockers: string[];
  coverage_complete: boolean;
}

interface PgQueryResult {
  rows: Array<Record<string, unknown>>;
}

export interface AwsRdsDatabasePrincipalPgClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
}

export type AwsRdsDatabasePrincipalPgClientFactory =
  (options: Record<string, unknown>) => AwsRdsDatabasePrincipalPgClient;

interface ValidatedConfig {
  database_username: string;
  ca_bundle_pem: string;
  ca_bundle_sha256: string;
  max_databases_per_target: number;
  max_rows_per_query: number;
  max_total_rows: number;
  max_total_queries: number;
  statement_timeout_ms: number;
  connection_timeout_ms: number;
}

const SQL = {
  session: [
    'SELECT current_user AS database_user, current_database() AS database_name,',
    " current_setting('transaction_read_only') AS transaction_read_only,",
    ' r.rolcanlogin, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,',
    " pg_catalog.pg_has_role(current_user, 'pg_monitor', 'MEMBER') AS has_pg_monitor,",
    " COALESCE((SELECT pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER') FROM pg_catalog.pg_roles r WHERE r.rolname = 'rds_superuser'), false) AS has_rds_superuser,",
    " COALESCE((SELECT pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER') FROM pg_catalog.pg_roles r WHERE r.rolname = 'rds_replication'), false) AS has_rds_replication,",
    " COALESCE((SELECT pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER') FROM pg_catalog.pg_roles r WHERE r.rolname = 'pg_write_all_data'), false) AS has_pg_write_all_data,",
    " COALESCE((SELECT pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER') FROM pg_catalog.pg_roles r WHERE r.rolname = 'pg_write_server_files'), false) AS has_pg_write_server_files,",
    " COALESCE((SELECT pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER') FROM pg_catalog.pg_roles r WHERE r.rolname = 'pg_execute_server_program'), false) AS has_pg_execute_server_program",
    ' FROM pg_catalog.pg_roles r WHERE r.rolname = current_user',
  ].join(' '),
  databaseCount: [
    'SELECT count(*)::text AS database_count',
    ' FROM pg_catalog.pg_database WHERE datistemplate = false',
  ].join(' '),
  databases: [
    'SELECT datname, datallowconn, datistemplate',
    ' FROM pg_catalog.pg_database WHERE datistemplate = false',
    ' ORDER BY datname LIMIT $1',
  ].join(' '),
  roles: [
    'SELECT oid::text AS role_oid, rolname, rolcanlogin, rolsuper, rolinherit,',
    ' rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolconnlimit,',
    ' rolvaliduntil::text AS valid_until',
    ' FROM pg_catalog.pg_roles ORDER BY rolname LIMIT $1',
  ].join(' '),
  memberships: [
    'SELECT granted.rolname AS granted_role, member.rolname AS member_role,',
    ' grantor.rolname AS grantor_role, m.admin_option',
    ' FROM pg_catalog.pg_auth_members m',
    ' JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid',
    ' JOIN pg_catalog.pg_roles member ON member.oid = m.member',
    ' JOIN pg_catalog.pg_roles grantor ON grantor.oid = m.grantor',
    ' ORDER BY granted.rolname, member.rolname LIMIT $1',
  ].join(' '),
  databasePrivileges: [
    'SELECT r.rolname AS grantee,',
    " pg_catalog.has_database_privilege(r.oid, current_database(), 'CONNECT') AS can_connect,",
    " pg_catalog.has_database_privilege(r.oid, current_database(), 'CREATE') AS can_create,",
    " pg_catalog.has_database_privilege(r.oid, current_database(), 'TEMP') AS can_temp",
    ' FROM pg_catalog.pg_roles r ORDER BY r.rolname LIMIT $1',
  ].join(' '),
  schemaPrivileges: [
    'SELECT COALESCE(grantee.rolname, \'PUBLIC\') AS grantee, n.nspname AS schema_name,',
    ' acl.privilege_type, acl.is_grantable',
    ' FROM pg_catalog.pg_namespace n',
    ' CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,',
    " pg_catalog.acldefault('n', n.nspowner))) acl",
    ' LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee',
    " WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')",
    " AND acl.privilege_type IN ('CREATE', 'USAGE')",
    ' ORDER BY n.nspname, grantee.rolname, acl.privilege_type LIMIT $1',
  ].join(' '),
  tablePrivileges: [
    'SELECT COALESCE(grantee.rolname, \'PUBLIC\') AS grantee, n.nspname AS schema_name,',
    ' c.relname AS object_name, acl.privilege_type, acl.is_grantable',
    ' FROM pg_catalog.pg_class c',
    ' JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
    ' CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,',
    " pg_catalog.acldefault('r', c.relowner))) acl",
    ' LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee',
    " WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')",
    " AND n.nspname NOT IN ('pg_catalog', 'information_schema')",
    " AND acl.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')",
    ' ORDER BY n.nspname, c.relname, grantee.rolname, acl.privilege_type LIMIT $1',
  ].join(' '),
  columnPrivileges: [
    'SELECT COALESCE(grantee.rolname, \'PUBLIC\') AS grantee, n.nspname AS schema_name,',
    ' c.relname AS table_name, a.attname AS column_name, acl.privilege_type, acl.is_grantable',
    ' FROM pg_catalog.pg_attribute a',
    ' JOIN pg_catalog.pg_class c ON c.oid = a.attrelid',
    ' JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
    ' CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl',
    ' LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee',
    ' WHERE a.attnum > 0 AND NOT a.attisdropped',
    " AND n.nspname NOT IN ('pg_catalog', 'information_schema')",
    " AND acl.privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES')",
    ' ORDER BY n.nspname, c.relname, a.attname, grantee.rolname LIMIT $1',
  ].join(' '),
  sequencePrivileges: [
    'SELECT COALESCE(grantee.rolname, \'PUBLIC\') AS grantee, n.nspname AS schema_name,',
    ' c.relname AS sequence_name, acl.privilege_type, acl.is_grantable',
    ' FROM pg_catalog.pg_class c',
    ' JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
    ' CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,',
    " pg_catalog.acldefault('S', c.relowner))) acl",
    ' LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee',
    " WHERE c.relkind = 'S'",
    " AND n.nspname NOT IN ('pg_catalog', 'information_schema')",
    " AND acl.privilege_type IN ('USAGE', 'UPDATE')",
    ' ORDER BY n.nspname, c.relname, grantee.rolname LIMIT $1',
  ].join(' '),
  defaultTablePrivileges: [
    'SELECT COALESCE(grantee.rolname, \'PUBLIC\') AS grantee,',
    ' COALESCE(n.nspname, \'<GLOBAL>\') AS schema_name, owner.rolname AS owner_role,',
    ' acl.privilege_type, acl.is_grantable',
    ' FROM pg_catalog.pg_default_acl d',
    ' LEFT JOIN pg_catalog.pg_namespace n ON n.oid = NULLIF(d.defaclnamespace, 0)',
    ' JOIN pg_catalog.pg_roles owner ON owner.oid = d.defaclrole',
    ' CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) acl',
    ' LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee',
    " WHERE d.defaclobjtype = 'r'",
    " AND acl.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')",
    ' ORDER BY schema_name, owner.rolname, grantee.rolname LIMIT $1',
  ].join(' '),
  defaultSequencePrivileges: [
    'SELECT COALESCE(grantee.rolname, \'PUBLIC\') AS grantee,',
    ' COALESCE(n.nspname, \'<GLOBAL>\') AS schema_name, owner.rolname AS owner_role,',
    ' acl.privilege_type, acl.is_grantable',
    ' FROM pg_catalog.pg_default_acl d',
    ' LEFT JOIN pg_catalog.pg_namespace n ON n.oid = NULLIF(d.defaclnamespace, 0)',
    ' JOIN pg_catalog.pg_roles owner ON owner.oid = d.defaclrole',
    ' CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) acl',
    ' LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee',
    " WHERE d.defaclobjtype = 'S' AND acl.privilege_type IN ('USAGE', 'UPDATE')",
    ' ORDER BY schema_name, owner.rolname, grantee.rolname LIMIT $1',
  ].join(' '),
  functionPrivileges: [
    'SELECT COALESCE(grantee.rolname, \'PUBLIC\') AS grantee, n.nspname AS schema_name,',
    ' p.proname AS function_name, pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,',
    ' acl.privilege_type, acl.is_grantable',
    ' FROM pg_catalog.pg_proc p',
    ' JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace',
    ' CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,',
    " pg_catalog.acldefault('f', p.proowner))) acl",
    ' LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee',
    " WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')",
    " AND acl.privilege_type = 'EXECUTE'",
    ' ORDER BY n.nspname, p.proname, grantee.rolname LIMIT $1',
  ].join(' '),
  defaultFunctionPrivileges: [
    'SELECT COALESCE(grantee.rolname, \'PUBLIC\') AS grantee,',
    ' COALESCE(n.nspname, \'<GLOBAL>\') AS schema_name, owner.rolname AS owner_role,',
    ' acl.privilege_type, acl.is_grantable',
    ' FROM pg_catalog.pg_default_acl d',
    ' LEFT JOIN pg_catalog.pg_namespace n ON n.oid = NULLIF(d.defaclnamespace, 0)',
    ' JOIN pg_catalog.pg_roles owner ON owner.oid = d.defaclrole',
    ' CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) acl',
    ' LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee',
    " WHERE d.defaclobjtype = 'f' AND acl.privilege_type = 'EXECUTE'",
    ' ORDER BY schema_name, owner.rolname, grantee.rolname LIMIT $1',
  ].join(' '),
  sessions: [
    'SELECT pid, usename, application_name, backend_type, state, wait_event_type, wait_event',
    ' FROM pg_catalog.pg_stat_activity',
    ' WHERE pid <> pg_catalog.pg_backend_pid() AND usename IS NOT NULL',
    ' ORDER BY usename, application_name, pid LIMIT $1',
  ].join(' '),
  replicationSenders: [
    'SELECT pid, usename, application_name, client_addr::text AS client_address,',
    ' state, sync_state, write_lsn::text AS write_lsn, flush_lsn::text AS flush_lsn,',
    ' replay_lsn::text AS replay_lsn',
    ' FROM pg_catalog.pg_stat_replication',
    ' ORDER BY usename, application_name, pid LIMIT $1',
  ].join(' '),
  replicationSlots: [
    'SELECT slot_name, plugin, slot_type, database, active, temporary,',
    ' restart_lsn::text AS restart_lsn, confirmed_flush_lsn::text AS confirmed_flush_lsn,',
    ' wal_status',
    ' FROM pg_catalog.pg_replication_slots ORDER BY slot_name LIMIT $1',
  ].join(' '),
  walReceiver: [
    'SELECT status, receive_start_lsn::text AS receive_start_lsn, received_lsn::text AS received_lsn,',
    ' latest_end_lsn::text AS latest_end_lsn, latest_end_time::text AS latest_end_time,',
    ' slot_name, sender_host, sender_port',
    ' FROM pg_catalog.pg_stat_wal_receiver LIMIT $1',
  ].join(' '),
  subscriptions: [
    'SELECT subname, subowner::pg_catalog.regrole::text AS owner_role, subenabled,',
    ' subslotname, subpublications',
    ' FROM pg_catalog.pg_subscription ORDER BY subname LIMIT $1',
  ].join(' '),
} as const;

const QUERY_KINDS = [
  ['DATABASE_ROLE', SQL.roles, ['rolname']],
  ['ROLE_MEMBERSHIP', SQL.memberships, ['granted_role', 'member_role']],
  ['DATABASE_PRIVILEGE', SQL.databasePrivileges, ['grantee']],
  ['SCHEMA_PRIVILEGE', SQL.schemaPrivileges, ['grantee', 'schema_name', 'privilege_type']],
  ['TABLE_WRITE_PRIVILEGE', SQL.tablePrivileges, ['grantee', 'schema_name', 'object_name', 'privilege_type']],
  ['SEQUENCE_WRITE_PRIVILEGE', SQL.sequencePrivileges, ['grantee', 'schema_name', 'sequence_name', 'privilege_type']],
  ['FUNCTION_EXECUTE_PRIVILEGE', SQL.functionPrivileges, ['grantee', 'schema_name', 'function_name', 'identity_arguments']],
  ['ACTIVE_DATABASE_SESSION', SQL.sessions, ['pid']],
  ['REPLICATION_SENDER', SQL.replicationSenders, ['pid']],
  ['REPLICATION_SLOT', SQL.replicationSlots, ['slot_name']],
  ['WAL_RECEIVER', SQL.walReceiver, ['status', 'sender_host', 'sender_port']],
  ['LOGICAL_SUBSCRIPTION', SQL.subscriptions, ['subname']],
] as const;

const REPLICATION_KINDS = new Set([
  'REPLICATION_SENDER',
  'REPLICATION_SLOT',
  'WAL_RECEIVER',
  'LOGICAL_SUBSCRIPTION',
]);

function fail(message: string): never {
  throw new Error('AWS RDS PostgreSQL database-principal inventory refused: ' + message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    '%' + character.charCodeAt(0).toString(16).toUpperCase());
}

function validateConfig(config: AwsRdsDatabasePrincipalReaderConfig): ValidatedConfig {
  if (!isRecord(config) || !DATABASE_USER.test(config.database_username)
    || typeof config.ca_bundle_pem !== 'string'
    || Buffer.byteLength(config.ca_bundle_pem, 'utf8') < 128
    || Buffer.byteLength(config.ca_bundle_pem, 'utf8') > MAX_CA_BUNDLE_BYTES
    || !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(config.ca_bundle_pem)
    || !SHA256.test(config.ca_bundle_sha256)
    || sha256(config.ca_bundle_pem) !== config.ca_bundle_sha256) {
    return fail('database IAM username or pinned RDS CA bundle is invalid');
  }
  const maxDatabases = config.max_databases_per_target ?? 64;
  const maxRows = config.max_rows_per_query ?? 500;
  const maxTotalRows = config.max_total_rows ?? 20000;
  const maxTotalQueries = config.max_total_queries ?? 10000;
  const statementTimeout = config.statement_timeout_ms ?? 5000;
  const connectionTimeout = config.connection_timeout_ms ?? 5000;
  if (!Number.isSafeInteger(maxDatabases) || maxDatabases < 1 || maxDatabases > MAX_DATABASES_HARD_LIMIT
    || !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS_HARD_LIMIT
    || !Number.isSafeInteger(maxTotalRows) || maxTotalRows < 1 || maxTotalRows > MAX_TOTAL_ROWS_HARD_LIMIT
    || !Number.isSafeInteger(maxTotalQueries) || maxTotalQueries < 1 || maxTotalQueries > 50000
    || !Number.isSafeInteger(statementTimeout) || statementTimeout < 500 || statementTimeout > 30000
    || !Number.isSafeInteger(connectionTimeout) || connectionTimeout < 500 || connectionTimeout > 15000) {
    return fail('database catalog, row or timeout budgets are outside supported limits');
  }
  return {
    database_username: config.database_username,
    ca_bundle_pem: config.ca_bundle_pem,
    ca_bundle_sha256: config.ca_bundle_sha256,
    max_databases_per_target: maxDatabases,
    max_rows_per_query: maxRows,
    max_total_rows: maxTotalRows,
    max_total_queries: maxTotalQueries,
    statement_timeout_ms: statementTimeout,
    connection_timeout_ms: connectionTimeout,
  };
}

function validateCredentials(value: AwsRdsDatabasePrincipalCredentials): AwsRdsDatabasePrincipalCredentials {
  if (!isRecord(value) || typeof value.access_key_id !== 'string'
    || !/^[A-Z0-9]{16,128}$/.test(value.access_key_id)
    || typeof value.secret_access_key !== 'string' || value.secret_access_key.length < 20
    || /[\r\n]/.test(value.secret_access_key)
    || (value.session_token !== undefined
      && (typeof value.session_token !== 'string' || value.session_token.length < 16 || /[\r\n]/.test(value.session_token)))) {
    return fail('database reader role returned incomplete or malformed temporary credentials');
  }
  return value;
}

function validateTarget(target: AwsRdsDatabasePrincipalTarget): AwsRdsDatabasePrincipalTarget {
  if (!isRecord(target) || !AWS_ACCOUNT_ID.test(target.account_id)
    || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(target.region)
    || !/^(db|cluster)-[A-Za-z0-9]+$/.test(target.resource_id)
    || !['RDS_DB_INSTANCE', 'RDS_DB_CLUSTER'].includes(target.resource_type)
    || !['postgres', 'aurora-postgresql'].includes(target.engine)
    || typeof target.endpoint !== 'string' || target.endpoint.length > 253
    || !/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(target.endpoint)
    || !/(?:^|\.)rds\.amazonaws\.com(?:\.cn)?$/i.test(target.endpoint)
    || !Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65535
    || typeof target.iam_database_authentication_enabled !== 'boolean') {
    return fail('RDS database target identity, endpoint, port or IAM-auth metadata is invalid');
  }
  const arn = /^arn:(aws|aws-us-gov|aws-cn):rds:([a-z0-9-]+):(\d{12}):(db|cluster):[A-Za-z0-9:_-]+$/.exec(target.resource_arn);
  const partition = target.region.startsWith('cn-') ? 'aws-cn'
    : target.region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws';
  if (!arn || arn[1] !== partition || arn[2] !== target.region || arn[3] !== target.account_id
    || arn[4] !== (target.resource_type === 'RDS_DB_INSTANCE' ? 'db' : 'cluster')) {
    return fail('RDS database target ARN does not match the exact account, region and resource type');
  }
  return target;
}

/** Generates a short-lived SigV4 RDS IAM DB authentication token; callers must never log it. */
export function createAwsRdsIamDatabaseAuthToken(
  credentialsInput: AwsRdsDatabasePrincipalCredentials,
  targetInput: AwsRdsDatabasePrincipalTarget,
  databaseUsername: string,
  at = new Date(),
): string {
  const credentials = validateCredentials(credentialsInput);
  const target = validateTarget(targetInput);
  if (!target.iam_database_authentication_enabled || !DATABASE_USER.test(databaseUsername)
    || !(at instanceof Date) || !Number.isFinite(at.getTime())) {
    return fail('IAM database authentication is disabled or token input is invalid');
  }
  const host = target.endpoint + ':' + target.port;
  const amzDate = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const query: Record<string, string> = {
    Action: 'connect',
    DBUser: databaseUsername,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': credentials.access_key_id + '/' + dateStamp + '/' + target.region + '/rds-db/aws4_request',
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '900',
    'X-Amz-SignedHeaders': 'host',
  };
  if (credentials.session_token) query['X-Amz-Security-Token'] = credentials.session_token;
  const canonicalQuery = Object.keys(query).sort((a, b) => {
    const left = awsEncode(a);
    const right = awsEncode(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }).map((key) => awsEncode(key) + '=' + awsEncode(query[key]!)).join('&');
  const canonicalRequest = ['GET', '/', canonicalQuery, 'host:' + host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = dateStamp + '/' + target.region + '/rds-db/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac('AWS4' + credentials.secret_access_key, dateStamp), target.region), 'rds-db'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  return host + '/?' + canonicalQuery + '&X-Amz-Signature=' + signature;
}

function defaultClientFactory(options: Record<string, unknown>): AwsRdsDatabasePrincipalPgClient {
  return new Client(options as ConstructorParameters<typeof Client>[0]) as unknown as AwsRdsDatabasePrincipalPgClient;
}

function rowValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return JSON.stringify(value).slice(0, 2048);
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 2048);
  return String(value).slice(0, 2048);
}

function makeRecord(
  target: AwsRdsDatabasePrincipalTarget,
  database: string,
  kind: string,
  identity: string,
  row: Record<string, unknown>,
): AwsRdsDatabasePrincipalRecord {
  const attributes: Record<string, string | null> = {
    CatalogKind: kind,
    DatabaseName: database,
    TargetResourceId: target.resource_id,
  };
  for (const [key, value] of Object.entries(row)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) return fail('database catalog returned an unexpected field name');
    attributes[key] = rowValue(value);
  }
  const material = [
    target.account_id, target.region, target.resource_id, database, kind, identity,
  ].join('\u0000');
  return {
    resource_arn: target.resource_arn,
    provider_identity_reference: 'aws-rds-db-principal.' + sha256(material).slice(0, 40),
    resource_type: 'POSTGRESQL_' + kind,
    account_id: target.account_id,
    region: target.region,
    engine: target.engine,
    database_name: database,
    attributes,
  };
}

function buildPgOptions(
  config: ValidatedConfig,
  target: AwsRdsDatabasePrincipalTarget,
  database: string,
  token: string,
): Record<string, unknown> {
  return {
    host: target.endpoint,
    port: target.port,
    user: config.database_username,
    password: token,
    database,
    ssl: {
      ca: config.ca_bundle_pem,
      rejectUnauthorized: true,
      servername: target.endpoint,
    },
    connectionTimeoutMillis: config.connection_timeout_ms,
    statement_timeout: config.statement_timeout_ms,
    query_timeout: config.statement_timeout_ms + 1000,
    application_name: 'factoryos-rds-principal-inventory',
  };
}

async function openReadOnlyClient(
  factory: AwsRdsDatabasePrincipalPgClientFactory,
  config: ValidatedConfig,
  target: AwsRdsDatabasePrincipalTarget,
  database: string,
  credentials: AwsRdsDatabasePrincipalCredentials,
  budget: { count: number; maximum: number },
): Promise<AwsRdsDatabasePrincipalPgClient> {
  const token = createAwsRdsIamDatabaseAuthToken(
    credentials,
    target,
    config.database_username,
  );
  const client = factory(buildPgOptions(config, target, database, token));
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT pg_catalog.set_config('statement_timeout', $1, true)", [
      String(config.statement_timeout_ms) + 'ms',
    ]);
    await client.query("SELECT pg_catalog.set_config('lock_timeout', '1000ms', true)");
    if (budget.count >= budget.maximum) return fail('database catalog query budget was exhausted');
    budget.count += 1;
    const result = await client.query(SQL.session);
    const session = result.rows[0];
    if (!session || session.database_user !== config.database_username
      || session.database_name !== database
      || String(session.transaction_read_only).toLowerCase() !== 'on'
      || session.rolcanlogin !== true || session.rolsuper !== false
      || session.rolcreaterole !== false || session.rolcreatedb !== false
      || session.rolreplication !== false || session.rolbypassrls !== false
      || session.rolinherit !== true || session.has_pg_monitor !== true
      || session.has_rds_superuser === true || session.has_rds_replication === true
      || session.has_pg_write_all_data === true || session.has_pg_write_server_files === true
      || session.has_pg_execute_server_program === true) {
      return fail('database session identity is not the bounded pg_monitor-only read-only login');
    }
    return client;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* best-effort rollback */ }
    try { await client.end(); } catch { /* best-effort close */ }
    throw error;
  }
}

async function closeReadOnlyClient(client: AwsRdsDatabasePrincipalPgClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* read-only transaction is always rolled back */ }
  try { await client.end(); } catch { /* close failure does not create provider evidence */ }
}

async function readBounded(
  client: AwsRdsDatabasePrincipalPgClient,
  sql: string,
  maxRows: number,
  budget: { count: number; maximum: number },
): Promise<{ rows: Array<Record<string, unknown>>; overflow: boolean }> {
  if (budget.count >= budget.maximum) return fail('database catalog query budget was exhausted');
  budget.count += 1;
  const result = await client.query(sql, [maxRows + 1]);
  if (!Array.isArray(result.rows) || result.rows.length > maxRows + 1) {
    return fail('database catalog query exceeded its bounded result contract');
  }
  return { rows: result.rows.slice(0, maxRows), overflow: result.rows.length > maxRows };
}

function identityFor(kind: string, row: Record<string, unknown>, index: number): string {
  const values = Object.keys(row).sort().map((key) => key + '=' + (rowValue(row[key]) ?? ''));
  return values.join('|') || String(index);
}

/**
 * Inspects PostgreSQL catalogs only. Every connection uses a scoped IAM token,
 * a digest-pinned RDS CA bundle, verified TLS and an explicit read-only transaction.
 */
export async function captureAwsRdsDatabasePrincipalInventory(
  targetsInput: AwsRdsDatabasePrincipalTarget[],
  credentialsInput: AwsRdsDatabasePrincipalCredentials,
  configInput: AwsRdsDatabasePrincipalReaderConfig,
  clientFactory: AwsRdsDatabasePrincipalPgClientFactory = defaultClientFactory,
): Promise<AwsRdsDatabasePrincipalInventoryResult> {
  const config = validateConfig(configInput);
  const credentials = validateCredentials(credentialsInput);
  if (!Array.isArray(targetsInput) || targetsInput.length > 5000) {
    return fail('RDS database target list is malformed or exceeds its global bound');
  }
  const targets = targetsInput.map(validateTarget);
  const targetKeys = targets.map((target) => [
    target.account_id, target.region, target.resource_id, target.endpoint, target.port,
  ].join('\u0000'));
  if (new Set(targetKeys).size !== targetKeys.length) {
    return fail('database principal scan contains a duplicate RDS target');
  }
  const records: AwsRdsDatabasePrincipalRecord[] = [];
  const replicationRecords: AwsRdsDatabasePrincipalRecord[] = [];
  const receiptReferences: string[] = [];
  const blockers: string[] = [];
  let targetsScanned = 0;
  let databasesDiscovered = 0;
  let databasesScanned = 0;
  let pagesFetched = 0;
  let itemCount = 0;
  let coverageComplete = targets.length > 0;
  let totalRows = 0;
  const queryBudget = { count: 0, maximum: config.max_total_queries };

  for (const target of targets) {
    if (!target.iam_database_authentication_enabled) {
      coverageComplete = false;
      blockers.push(target.resource_id + ':IAM_DATABASE_AUTHENTICATION_DISABLED');
      continue;
    }
    if (totalRows >= config.max_total_rows) {
      coverageComplete = false;
      blockers.push('GLOBAL_DATABASE_CATALOG_ROW_BUDGET_EXHAUSTED');
      break;
    }

    let databaseNames: string[] = [];
    let databaseList: Array<Record<string, unknown>> = [];
    let targetConnected = false;
    let bootstrapClient: AwsRdsDatabasePrincipalPgClient | null = null;
    try {
      bootstrapClient = await openReadOnlyClient(
        clientFactory, config, target, 'postgres', credentials, queryBudget,
      );
      targetConnected = true;
      const countResult = await readBounded(bootstrapClient, SQL.databaseCount, 1, queryBudget);
      pagesFetched += 1;
      const databaseCount = Number(countResult.rows[0]?.database_count ?? 0);
      const listResult = await readBounded(
        bootstrapClient, SQL.databases, config.max_databases_per_target, queryBudget,
      );
      pagesFetched += 1;
      databaseList = listResult.rows;
      totalRows += listResult.rows.length;
      databasesDiscovered += Number.isSafeInteger(databaseCount) && databaseCount >= 0 ? databaseCount : 0;
      if (countResult.overflow || !Number.isSafeInteger(databaseCount) || databaseCount < 0
        || databaseCount > config.max_databases_per_target || listResult.overflow
        || databaseList.length !== databaseCount) {
        coverageComplete = false;
        blockers.push(target.resource_id + ':DATABASE_CATALOG_TRUNCATED_OR_INCONSISTENT');
      }
      for (const row of databaseList) {
        const name = row.datname;
        if (typeof name !== 'string' || !DATABASE_NAME.test(name)) {
          coverageComplete = false;
          blockers.push(target.resource_id + ':INVALID_DATABASE_CATALOG_ENTRY');
          continue;
        }
        if (row.datistemplate === true) continue;
        if (row.datallowconn !== true) {
          coverageComplete = false;
          blockers.push(target.resource_id + ':' + name + ':DATABASE_CONNECT_DISABLED');
          continue;
        }
        databaseNames.push(name);
      }
    } catch {
      coverageComplete = false;
      blockers.push(target.resource_id + ':DATABASE_CATALOG_ACCESS_DENIED_OR_FAILED');
    } finally {
      if (bootstrapClient) await closeReadOnlyClient(bootstrapClient);
    }
    if (!targetConnected) continue;
    targetsScanned += 1;

    for (const database of databaseNames) {
      if (totalRows >= config.max_total_rows) {
        coverageComplete = false;
        blockers.push('GLOBAL_DATABASE_CATALOG_ROW_BUDGET_EXHAUSTED');
        break;
      }
      let client: AwsRdsDatabasePrincipalPgClient | null = null;
      try {
        client = await openReadOnlyClient(clientFactory, config, target, database, credentials, queryBudget);
        let databaseFailed = false;
        for (const [kind, sql, identityKeys] of QUERY_KINDS) {
          if (totalRows >= config.max_total_rows) {
            databaseFailed = true;
            coverageComplete = false;
            blockers.push('GLOBAL_DATABASE_CATALOG_ROW_BUDGET_EXHAUSTED');
            break;
          }
          let bounded: { rows: Array<Record<string, unknown>>; overflow: boolean };
          try {
            bounded = await readBounded(client, sql, Math.min(
              config.max_rows_per_query,
              config.max_total_rows - totalRows,
            ), queryBudget);
            pagesFetched += 1;
          } catch {
            databaseFailed = true;
            coverageComplete = false;
            blockers.push(target.resource_id + ':' + database + ':' + kind + ':CATALOG_QUERY_DENIED_OR_FAILED');
            if (queryBudget.count >= queryBudget.maximum) {
              blockers.push('GLOBAL_DATABASE_CATALOG_QUERY_BUDGET_EXHAUSTED');
              break;
            }
            continue;
          }
          totalRows += bounded.rows.length;
          const emitted = bounded.rows.map((row, index) => makeRecord(
            target,
            database,
            kind,
            identityFor(kind, row, index),
            row,
          ));
          records.push(...emitted);
          replicationRecords.push(...emitted.filter((record) => REPLICATION_KINDS.has(kind)));
          itemCount += emitted.length;
          const receiptMaterial = JSON.stringify({ target: target.resource_id, database, kind, rows: bounded.rows });
          receiptReferences.push('postgresql-readonly.' + sha256(receiptMaterial).slice(0, 40));
          if (bounded.overflow) {
            databaseFailed = true;
            coverageComplete = false;
            blockers.push(target.resource_id + ':' + database + ':' + kind + ':ROW_LIMIT_REACHED');
          }
          if (bounded.rows.some((row) => identityKeys.every((key) => row[key] === undefined))) {
            databaseFailed = true;
            coverageComplete = false;
            blockers.push(target.resource_id + ':' + database + ':' + kind + ':CATALOG_IDENTITY_INVALID');
          }
        }
        if (databaseFailed) coverageComplete = false;
        else databasesScanned += 1;
      } catch {
        coverageComplete = false;
        blockers.push(target.resource_id + ':' + database + ':DATABASE_CATALOG_ACCESS_DENIED_OR_FAILED');
      } finally {
        if (client) await closeReadOnlyClient(client);
      }
    }
  }

  if (targets.length === 0) {
    coverageComplete = false;
    blockers.push('NO_POSTGRESQL_IAM_AUTHENTICATED_DATABASE_TARGETS');
  }
  return {
    records,
    replication_records: replicationRecords,
    targets_discovered: targets.length,
    targets_scanned: targetsScanned,
    databases_discovered: databasesDiscovered,
    databases_scanned: databasesScanned,
    pages_fetched: pagesFetched,
    queries_attempted: queryBudget.count,
    total_rows_observed: totalRows,
    item_count: itemCount,
    receipt_references: [...new Set(receiptReferences)].sort(),
    blockers: [...new Set(blockers)].sort(),
    coverage_complete: coverageComplete && targetsScanned === targets.length
      && databasesScanned === databasesDiscovered,
  };
}
