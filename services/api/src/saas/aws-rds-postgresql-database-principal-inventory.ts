import { createHash, createHmac } from 'node:crypto';
import { Pool, PoolConfig, QueryResultRow } from 'pg';

export interface AwsRdsPitrDatabaseCredentials {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
}

export interface AwsRdsPitrDatabaseTarget {
  account_id: string;
  region: string;
  resource_arn: string;
  db_resource_id: string;
  engine: 'postgres' | 'aurora-postgresql';
  endpoint_host: string;
  endpoint_port: number;
  source_database_reference: string;
}

export interface AwsRdsPitrDatabaseAccessRole {
  role_arn: string;
  principal_reference: string;
  credentials: AwsRdsPitrDatabaseCredentials;
}

export interface AwsRdsPitrDatabasePrincipalOptions {
  database_role_name: string;
  database_username: string;
  database_name: string;
  ca_certificate_pem: string;
  ca_certificate_sha256: string;
  connect_timeout_ms?: number;
  statement_timeout_ms?: number;
  max_rows_per_catalog?: number;
  max_total_rows?: number;
}

export interface AwsRdsPitrDatabasePrincipalCatalog {
  schema: 'factoryos.aws-rds-postgresql-database-principals/v1';
  account_id: string;
  region: string;
  database_resource_arn: string;
  database_resource_id: string;
  source_database_reference: string;
  endpoint_reference: string;
  database_name: string;
  database_username: string;
  database_access_role_arn: string;
  database_access_principal_reference: string;
  status: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  observed_at: string;
  identity: {
    current_user: string;
    session_user: string;
    current_database: string;
    transaction_read_only: true;
    in_recovery: boolean;
    has_pg_read_all_stats: boolean;
    has_rds_iam: boolean;
    privileged_memberships: string[];
    server_version_num: string;
  } | null;
  database_roles: Array<{
    role_name: string;
    can_login: boolean;
    is_superuser: boolean;
    can_create_role: boolean;
    can_create_database: boolean;
    can_replicate: boolean;
    bypasses_rls: boolean;
    inherits: boolean;
  }>;
  role_memberships: Array<{
    granted_role: string;
    member_role: string;
    granted_by: string;
    admin_option: boolean;
  }>;
  database_access: Array<{
    database_name: string;
    owner: string;
    allow_connections: boolean;
    current_user_can_connect: boolean;
    is_template: boolean;
    acl_reference: string | null;
  }>;
  schema_privileges: Array<{
    grantee: string;
    schema_name: string;
    privilege_type: string;
    is_grantable: boolean;
  }>;
  object_privileges: Array<{
    grantee: string;
    schema_name: string;
    object_name: string;
    object_owner: string;
    object_type: string;
    privilege_type: string;
    is_grantable: boolean;
  }>;
  function_privileges: Array<{
    grantee: string;
    schema_name: string;
    function_name: string;
    function_owner: string;
    is_grantable: boolean;
  }>;
  active_sessions: Array<{
    database_user: string | null;
    database_name: string | null;
    backend_type: string;
    state: string | null;
    session_count: number;
  }>;
  replication_senders: Array<{
    database_user: string | null;
    application_reference: string;
    state: string | null;
    sync_state: string | null;
    sender_count: number;
  }>;
  replication_slots: Array<{
    slot_name: string;
    plugin: string | null;
    slot_type: string;
    database_name: string | null;
    active: boolean;
    temporary: boolean;
  }>;
  wal_receivers: Array<{ status: string; slot_name: string | null }>;
  logical_subscriptions: Array<{
    subscription_name: string;
    owner: string;
    enabled: boolean;
    slot_name: string | null;
    publications: string[];
  }>;
  publications: Array<{
    publication_name: string;
    all_tables: boolean;
    inserts: boolean;
    updates: boolean;
    deletes: boolean;
    truncates: boolean;
  }>;
  catalog_status: Array<{
    catalog: string;
    status: 'COMPLETE' | 'TRUNCATED' | 'FAILED' | 'SKIPPED_BUDGET';
    rows_observed: number;
    error_code: string | null;
  }>;
  rows_observed: number;
  queries_executed: number;
  snapshot_sha256: string;
  blockers: string[];
}

interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
  release(): void;
}

interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

export type AwsRdsPitrPgPoolFactory = (config: PoolConfig) => PgPoolLike;

interface ValidatedOptions {
  database_role_name: string;
  database_username: string;
  database_name: string;
  ca_certificate_pem: string;
  ca_certificate_sha256: string;
  connect_timeout_ms: number;
  statement_timeout_ms: number;
  max_rows_per_catalog: number;
  max_total_rows: number;
}

const ACCOUNT_ID = /^\d{12}$/;
const ROLE_NAME = /^[A-Za-z0-9+=,.@_-]{1,64}$/;
const DB_USER = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
const DB_NAME = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
const DB_RESOURCE_ID = /^(?:db|cluster)-[A-Za-z0-9-]{8,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function refuse(message: string): never {
  throw new Error('RDS PostgreSQL principal inventory refused: ' + message);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    '%' + character.charCodeAt(0).toString(16).toUpperCase());
}

function validateCredentials(value: AwsRdsPitrDatabaseCredentials): AwsRdsPitrDatabaseCredentials {
  if (!value || typeof value.access_key_id !== 'string' || !/^[A-Z0-9]{16,128}$/.test(value.access_key_id)
    || typeof value.secret_access_key !== 'string' || value.secret_access_key.length < 20
    || /[\r\n]/.test(value.secret_access_key)
    || (value.session_token !== undefined
      && (typeof value.session_token !== 'string' || value.session_token.length < 16
        || /[\r\n]/.test(value.session_token)))) {
    return refuse('assumed database role credentials are malformed');
  }
  return value;
}

function validateOptions(value: AwsRdsPitrDatabasePrincipalOptions): ValidatedOptions {
  if (!value || !ROLE_NAME.test(value.database_role_name)
    || !DB_USER.test(value.database_username) || !DB_NAME.test(value.database_name)) {
    return refuse('database role name, IAM database username or database name is invalid');
  }
  if (typeof value.ca_certificate_pem !== 'string'
    || !value.ca_certificate_pem.includes('-----BEGIN CERTIFICATE-----')
    || !value.ca_certificate_pem.includes('-----END CERTIFICATE-----')
    || value.ca_certificate_pem.length > 1024 * 1024
    || !SHA256.test(value.ca_certificate_sha256)
    || sha256(value.ca_certificate_pem) !== value.ca_certificate_sha256) {
    return refuse('RDS CA bundle does not match the configured SHA-256 pin');
  }
  const connectTimeout = value.connect_timeout_ms ?? 5000;
  const statementTimeout = value.statement_timeout_ms ?? 10000;
  const maxRows = value.max_rows_per_catalog ?? 500;
  const maxTotalRows = value.max_total_rows ?? 10000;
  if (!Number.isSafeInteger(connectTimeout) || connectTimeout < 1000 || connectTimeout > 15000
    || !Number.isSafeInteger(statementTimeout) || statementTimeout < 1000 || statementTimeout > 30000
    || !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 5000
    || !Number.isSafeInteger(maxTotalRows) || maxTotalRows < 1 || maxTotalRows > 100000) {
    return refuse('database timeout or row limits are outside supported bounds');
  }
  return {
    database_role_name: value.database_role_name,
    database_username: value.database_username,
    database_name: value.database_name,
    ca_certificate_pem: value.ca_certificate_pem,
    ca_certificate_sha256: value.ca_certificate_sha256,
    connect_timeout_ms: connectTimeout,
    statement_timeout_ms: statementTimeout,
    max_rows_per_catalog: maxRows,
    max_total_rows: maxTotalRows,
  };
}

function expectedPartition(region: string): 'aws' | 'aws-us-gov' | 'aws-cn' {
  return region.startsWith('cn-') ? 'aws-cn' : region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws';
}

function validateTarget(value: AwsRdsPitrDatabaseTarget): AwsRdsPitrDatabaseTarget {
  if (!value || !ACCOUNT_ID.test(value.account_id)
    || typeof value.region !== 'string' || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(value.region)
    || typeof value.db_resource_id !== 'string' || !DB_RESOURCE_ID.test(value.db_resource_id)
    || !['postgres', 'aurora-postgresql'].includes(value.engine)
    || typeof value.source_database_reference !== 'string' || !DB_NAME.test(value.source_database_reference)
    || !Number.isSafeInteger(value.endpoint_port) || value.endpoint_port !== 5432
    || typeof value.endpoint_host !== 'string') {
    return refuse('RDS database target identity or endpoint metadata is invalid');
  }
  const arn = new RegExp('^arn:' + expectedPartition(value.region)
    + ':rds:' + value.region + ':' + value.account_id + ':(db|cluster):[A-Za-z0-9:_-]+$');
  if (!arn.test(value.resource_arn)) return refuse('database ARN does not match the expected account and region');
  const host = value.endpoint_host.toLowerCase();
  const suffix = value.region + '.rds.amazonaws.com' + (value.region.startsWith('cn-') ? '.cn' : '');
  if (!/^[a-z0-9.-]{1,253}$/.test(host) || !host.endsWith('.' + suffix)
    || host.startsWith('.') || host.includes('..')) {
    return refuse('RDS endpoint hostname is not an AWS endpoint for the requested region');
  }
  return value;
}

/** Generates an IAM database token. Tokens are ephemeral and valid for 15 minutes. */
export function createAwsRdsPitrIamDatabaseAuthToken(
  input: { host: string; port: number; region: string; username: string },
  credentials: AwsRdsPitrDatabaseCredentials,
  now: Date = new Date(),
): string {
  const safeCredentials = validateCredentials(credentials);
  if (typeof input.host !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(input.host)
    || !Number.isSafeInteger(input.port) || input.port !== 5432
    || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(input.region)
    || !DB_USER.test(input.username) || !Number.isFinite(now.getTime())) {
    return refuse('IAM database token input is invalid');
  }
  const hostPort = input.host.toLowerCase() + ':' + input.port;
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = dateStamp + '/' + input.region + '/rds-db/aws4_request';
  const parameters: Array<[string, string]> = [
    ['Action', 'connect'],
    ['DBUser', input.username],
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', safeCredentials.access_key_id + '/' + scope],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', '900'],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  if (safeCredentials.session_token) parameters.push(['X-Amz-Security-Token', safeCredentials.session_token]);
  const canonicalQuery = parameters
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(([aKey, aValue], [bKey, bValue]) => aKey < bKey ? -1 : aKey > bKey ? 1
      : aValue < bValue ? -1 : aValue > bValue ? 1 : 0)
    .map(([key, value]) => key + '=' + value).join('&');
  const canonicalRequest = [
    'GET', '/', canonicalQuery, 'host:' + hostPort + '\n', 'host', 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac('AWS4' + safeCredentials.secret_access_key, dateStamp), input.region), 'rds-db'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  return hostPort + '/?' + canonicalQuery + '&X-Amz-Signature=' + signature;
}

const CATALOGS = [
  {
    name: 'database_roles',
    sql: '/* factoryos:pitr:database_roles */\n'
      + 'SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, '
      + 'rolreplication, rolbypassrls, rolinherit FROM pg_catalog.pg_roles '
      + 'ORDER BY rolname LIMIT $1',
  },
  {
    name: 'role_memberships',
    sql: '/* factoryos:pitr:role_memberships */\n'
      + 'SELECT parent.rolname AS granted_role, member.rolname AS member_role, '
      + 'grantor.rolname AS granted_by, membership.admin_option '
      + 'FROM pg_catalog.pg_auth_members AS membership '
      + 'JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid '
      + 'JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member '
      + 'JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = membership.grantor '
      + 'ORDER BY parent.rolname, member.rolname LIMIT $1',
  },
  {
    name: 'database_access',
    sql: '/* factoryos:pitr:database_access */\n'
      + 'SELECT datname, pg_catalog.pg_get_userbyid(datdba) AS owner, '
      + 'datallowconn, pg_catalog.has_database_privilege(current_user, datname, \'CONNECT\') AS current_user_can_connect, '
      + 'datistemplate, datacl::text AS acl_reference '
      + 'FROM pg_catalog.pg_database ORDER BY datname LIMIT $1',
  },
  {
    name: 'schema_privileges',
    sql: '/* factoryos:pitr:schema_privileges */\n'
      + 'SELECT CASE WHEN grants.grantee = 0 THEN \'PUBLIC\' '
      + 'ELSE pg_catalog.pg_get_userbyid(grants.grantee) END AS grantee, '
      + 'namespace.nspname AS schema_name, grants.privilege_type, grants.is_grantable '
      + 'FROM pg_catalog.pg_namespace AS namespace '
      + 'CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(namespace.nspacl, '
      + 'pg_catalog.acldefault(\'n\', namespace.nspowner))) AS grants '
      + 'WHERE namespace.nspname NOT IN (\'pg_catalog\', \'information_schema\') '
      + 'AND grants.privilege_type IN (\'CREATE\', \'USAGE\') '
      + 'ORDER BY namespace.nspname, grantee, grants.privilege_type LIMIT $1',
  },
  {
    name: 'object_privileges',
    sql: '/* factoryos:pitr:object_privileges */\n'
      + 'SELECT CASE WHEN grants.grantee = 0 THEN \'PUBLIC\' '
      + 'ELSE pg_catalog.pg_get_userbyid(grants.grantee) END AS grantee, '
      + 'namespace.nspname AS schema_name, relation.relname AS object_name, '
      + 'pg_catalog.pg_get_userbyid(relation.relowner) AS object_owner, '
      + 'relation.relkind::text AS object_type, grants.privilege_type, grants.is_grantable '
      + 'FROM pg_catalog.pg_class AS relation '
      + 'JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace '
      + 'CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(relation.relacl, '
      + 'pg_catalog.acldefault(CASE WHEN relation.relkind = \'S\' THEN \'S\' ELSE \'r\' END, relation.relowner))) AS grants '
      + 'WHERE namespace.nspname NOT IN (\'pg_catalog\', \'information_schema\') '
      + 'AND relation.relkind IN (\'r\', \'p\', \'v\', \'m\', \'S\') '
      + 'AND grants.privilege_type IN (\'INSERT\', \'UPDATE\', \'DELETE\', \'TRUNCATE\', \'TRIGGER\', \'REFERENCES\', \'USAGE\') '
      + 'ORDER BY namespace.nspname, relation.relname, grantee, grants.privilege_type LIMIT $1',
  },
  {
    name: 'function_privileges',
    sql: '/* factoryos:pitr:function_privileges */\n'
      + 'SELECT CASE WHEN grants.grantee = 0 THEN \'PUBLIC\' '
      + 'ELSE pg_catalog.pg_get_userbyid(grants.grantee) END AS grantee, '
      + 'namespace.nspname AS schema_name, procedure.proname AS function_name, '
      + 'pg_catalog.pg_get_userbyid(procedure.proowner) AS function_owner, grants.is_grantable '
      + 'FROM pg_catalog.pg_proc AS procedure '
      + 'JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace '
      + 'CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(procedure.proacl, '
      + 'pg_catalog.acldefault(\'f\', procedure.proowner))) AS grants '
      + 'WHERE namespace.nspname NOT IN (\'pg_catalog\', \'information_schema\') '
      + 'AND grants.privilege_type = \'EXECUTE\' '
      + 'ORDER BY namespace.nspname, procedure.proname, grantee LIMIT $1',
  },
  {
    name: 'active_sessions',
    sql: '/* factoryos:pitr:active_sessions */\n'
      + 'SELECT usename AS database_user, datname AS database_name, backend_type, state, '
      + 'count(*)::integer AS session_count FROM pg_catalog.pg_stat_activity '
      + 'WHERE pid <> pg_catalog.pg_backend_pid() '
      + 'GROUP BY usename, datname, backend_type, state '
      + 'ORDER BY usename, datname, backend_type, state LIMIT $1',
  },
  {
    name: 'replication_senders',
    sql: '/* factoryos:pitr:replication_senders */\n'
      + 'SELECT usename AS database_user, application_name, state, sync_state, '
      + 'count(*)::integer AS sender_count FROM pg_catalog.pg_stat_replication '
      + 'GROUP BY usename, application_name, state, sync_state '
      + 'ORDER BY usename, application_name, state LIMIT $1',
  },
  {
    name: 'replication_slots',
    sql: '/* factoryos:pitr:replication_slots */\n'
      + 'SELECT slot_name, plugin, slot_type, database, active, temporary '
      + 'FROM pg_catalog.pg_replication_slots ORDER BY slot_name LIMIT $1',
  },
  {
    name: 'wal_receivers',
    sql: '/* factoryos:pitr:wal_receivers */\n'
      + 'SELECT status, slot_name FROM pg_catalog.pg_stat_wal_receiver LIMIT $1',
  },
  {
    name: 'logical_subscriptions',
    sql: '/* factoryos:pitr:logical_subscriptions */\n'
      + 'SELECT subscription.subname AS subscription_name, owner.rolname AS owner, '
      + 'subscription.subenabled AS enabled, subscription.subslotname AS slot_name, '
      + 'subscription.subpublications AS publications '
      + 'FROM pg_catalog.pg_subscription AS subscription '
      + 'JOIN pg_catalog.pg_roles AS owner ON owner.oid = subscription.subowner '
      + 'ORDER BY subscription.subname LIMIT $1',
  },
  {
    name: 'publications',
    sql: '/* factoryos:pitr:publications */\n'
      + 'SELECT pubname AS publication_name, puballtables AS all_tables, '
      + 'pubinsert AS inserts, pubupdate AS updates, pubdelete AS deletes, '
      + 'pubtruncate AS truncates FROM pg_catalog.pg_publication '
      + 'ORDER BY pubname LIMIT $1',
  },
] as const;

function sqlState(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

function queryErrorCode(code: string | null): string {
  if (code === '42501') return 'ACCESS_DENIED';
  if (code === '57014') return 'QUERY_TIMEOUT';
  if (code === '53300' || code === '53400') return 'RESOURCE_LIMIT';
  return code ? 'POSTGRES_' + code : 'QUERY_FAILED';
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256
    || /[\r\n]/.test(value)) return refuse('database returned invalid ' + field);
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') return refuse('database returned invalid ' + field);
  return value;
}

function asCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return refuse('database returned an invalid row count');
  return parsed;
}

export class AwsRdsPitrDatabasePrincipalInventoryReader {
  private readonly options: ValidatedOptions;

  constructor(
    options: AwsRdsPitrDatabasePrincipalOptions,
    private readonly poolFactory: AwsRdsPitrPgPoolFactory = (config) => new Pool(config),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.options = validateOptions(options);
  }

  async captureAll(
    target: AwsRdsPitrDatabaseTarget,
    accessRole: AwsRdsPitrDatabaseAccessRole,
    remainingRowBudget = this.options.max_total_rows,
  ): Promise<AwsRdsPitrDatabasePrincipalCatalog[]> {
    const first = await this.capture(target, accessRole, remainingRowBudget);
    const catalogs = [first];
    if (!first.identity || first.catalog_status.find((item) => item.catalog === 'database_access')?.status !== 'COMPLETE'
      || first.blockers.includes('DATABASE_PRINCIPAL_READER_CANNOT_CONNECT_TO_EVERY_CONNECTABLE_DATABASE')) {
      if (!first.blockers.includes('DATABASE_LIST_NOT_COMPLETE_FOR_CLUSTER_INVENTORY')) {
        first.blockers.push('DATABASE_LIST_NOT_COMPLETE_FOR_CLUSTER_INVENTORY');
        first.status = 'PARTIAL';
        first.snapshot_sha256 = sha256(JSON.stringify({ ...first, snapshot_sha256: '' }));
      }
      return catalogs;
    }
    const databaseNames = first.database_access
      .filter((item) => item.allow_connections && !item.is_template && item.current_user_can_connect)
      .map((item) => item.database_name);
    if (!databaseNames.includes(this.options.database_name)) {
      return refuse('configured metadata database is not in the connectable database catalog');
    }
    if (new Set(databaseNames).size !== databaseNames.length) {
      return refuse('PostgreSQL database catalog returned duplicate connectable database names');
    }
    let remaining = Math.max(0, remainingRowBudget - first.rows_observed);
    for (const databaseName of databaseNames.filter((name) => name !== this.options.database_name).sort()) {
      if (remaining < 1) {
        const unavailable = this.emptyResult(
          target,
          'aws-rds-endpoint.' + sha256(target.endpoint_host).slice(0, 32),
          accessRole,
          this.now().toISOString(),
          ['DATABASE_PRINCIPAL_GLOBAL_ROW_BUDGET_EXHAUSTED'],
          [{ catalog: 'connection', status: 'SKIPPED_BUDGET', rows_observed: 0, error_code: null }],
          0,
        );
        unavailable.database_name = databaseName;
        unavailable.status = 'UNAVAILABLE';
        unavailable.snapshot_sha256 = sha256(JSON.stringify({ ...unavailable, snapshot_sha256: '' }));
        catalogs.push(unavailable);
        continue;
      }
      const reader = new AwsRdsPitrDatabasePrincipalInventoryReader({
        ...this.options,
        database_name: databaseName,
        max_total_rows: remaining,
      }, this.poolFactory, this.now);
      const catalog = await reader.capture(target, accessRole, remaining);
      catalogs.push(catalog);
      remaining = Math.max(0, remaining - catalog.rows_observed);
    }
    return catalogs;
  }

  async capture(
    targetInput: AwsRdsPitrDatabaseTarget,
    accessRole: AwsRdsPitrDatabaseAccessRole,
    remainingRowBudget = this.options.max_total_rows,
  ): Promise<AwsRdsPitrDatabasePrincipalCatalog> {
    const target = validateTarget(targetInput);
    const credentials = validateCredentials(accessRole.credentials);
    const expectedRoleArn = 'arn:' + expectedPartition(target.region) + ':iam::'
      + target.account_id + ':role/' + this.options.database_role_name;
    const expectedPrincipalPrefix = 'arn:' + expectedPartition(target.region) + ':sts::'
      + target.account_id + ':assumed-role/' + this.options.database_role_name + '/';
    const principalSessionName = accessRole.principal_reference.startsWith(expectedPrincipalPrefix)
      ? accessRole.principal_reference.slice(expectedPrincipalPrefix.length) : '';
    if (accessRole.role_arn !== expectedRoleArn
      || !/^[A-Za-z0-9+=,.@_-]{2,64}$/.test(principalSessionName)) {
      return refuse('database access role identity does not match the exact expected account and role');
    }
    if (!Number.isSafeInteger(remainingRowBudget) || remainingRowBudget < 1
      || remainingRowBudget > this.options.max_total_rows) {
      return refuse('remaining database principal row budget is invalid');
    }
    const observedAt = this.now().toISOString();
    const endpointReference = 'aws-rds-endpoint.' + sha256(target.endpoint_host).slice(0, 32);
    const token = createAwsRdsPitrIamDatabaseAuthToken({
      host: target.endpoint_host,
      port: target.endpoint_port,
      region: target.region,
      username: this.options.database_username,
    }, credentials, this.now());
    const poolConfig: PoolConfig = {
      host: target.endpoint_host,
      port: target.endpoint_port,
      database: this.options.database_name,
      user: this.options.database_username,
      password: token,
      ssl: { ca: this.options.ca_certificate_pem, rejectUnauthorized: true },
      max: 1,
      connectionTimeoutMillis: this.options.connect_timeout_ms,
      idleTimeoutMillis: 1000,
      application_name: 'factoryos-pitr-principal-inventory',
      allowExitOnIdle: true,
    };
    const pool = this.poolFactory(poolConfig);
    let client: PgClientLike | null = null;
    let inTransaction = false;
    const blockers: string[] = [];
    const catalogStatus: AwsRdsPitrDatabasePrincipalCatalog['catalog_status'] = [];
    const rowsObserved: Record<string, QueryResultRow[]> = {};
    let queriesExecuted = 0;
    let identity: AwsRdsPitrDatabasePrincipalCatalog['identity'] = null;
    let rowBudget = remainingRowBudget;
    try {
      try {
        client = await pool.connect();
      } catch {
        blockers.push('DATABASE_IAM_CONNECTION_FAILED');
        return this.emptyResult(target, endpointReference, accessRole, observedAt, blockers, catalogStatus, queriesExecuted);
      }
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      inTransaction = true;
      await client.query('SET LOCAL statement_timeout = ' + this.options.statement_timeout_ms);
      await client.query('SET LOCAL lock_timeout = 1000');
      const identityResult = await client.query(
        '/* factoryos:pitr:session_identity */ SELECT current_user AS current_user, '
        + 'session_user AS session_user, current_database() AS current_database, '
        + 'current_setting(\'transaction_read_only\') AS transaction_read_only, '
        + 'pg_catalog.pg_is_in_recovery() AS in_recovery, '
        + 'pg_catalog.pg_has_role(current_user, \'pg_read_all_stats\', \'member\') AS has_pg_read_all_stats, '
        + 'pg_catalog.pg_has_role(current_user, \'rds_iam\', \'member\') AS has_rds_iam, '
        + 'ARRAY(SELECT role.rolname FROM pg_catalog.pg_roles AS role '
        + 'WHERE role.rolname IN (\'rds_superuser\', \'rds_replication\', \'pg_read_all_data\', \'pg_write_all_data\', '
        + '\'pg_execute_server_program\', \'pg_read_server_files\', \'pg_write_server_files\') '
        + 'AND pg_catalog.pg_has_role(current_user, role.oid, \'MEMBER\') ORDER BY role.rolname) AS privileged_memberships, '
        + 'current_setting(\'server_version_num\') AS server_version_num',
      );
      queriesExecuted += 1;
      const row = identityResult.rows[0];
      if (!row || row.current_user !== this.options.database_username
        || row.session_user !== this.options.database_username
        || row.current_database !== this.options.database_name
        || row.transaction_read_only !== 'on') {
        blockers.push('DATABASE_SESSION_IDENTITY_OR_READ_ONLY_GUARD_FAILED');
        await client.query('ROLLBACK');
        inTransaction = false;
        return this.emptyResult(target, endpointReference, accessRole, observedAt, blockers, catalogStatus, queriesExecuted);
      }
      identity = {
        current_user: requiredString(row.current_user, 'current_user'),
        session_user: requiredString(row.session_user, 'session_user'),
        current_database: requiredString(row.current_database, 'current_database'),
        transaction_read_only: true,
        in_recovery: asBoolean(row.in_recovery, 'in_recovery'),
        has_pg_read_all_stats: asBoolean(row.has_pg_read_all_stats, 'has_pg_read_all_stats'),
        has_rds_iam: asBoolean(row.has_rds_iam, 'has_rds_iam'),
        privileged_memberships: Array.isArray(row.privileged_memberships)
          ? row.privileged_memberships.map((item) => requiredString(item, 'privileged_membership')) : [],
        server_version_num: requiredString(row.server_version_num, 'server_version_num'),
      };

      for (const catalog of CATALOGS) {
        if (rowBudget <= 0) {
          catalogStatus.push({ catalog: catalog.name, status: 'SKIPPED_BUDGET', rows_observed: 0, error_code: null });
          blockers.push('DATABASE_PRINCIPAL_GLOBAL_ROW_BUDGET_EXHAUSTED');
          continue;
        }
        await client.query('SAVEPOINT factoryos_pitr_catalog');
        let resultRows: QueryResultRow[] = [];
        let state: 'COMPLETE' | 'TRUNCATED' | 'FAILED' = 'COMPLETE';
        let errorCode: string | null = null;
        const limit = Math.min(this.options.max_rows_per_catalog, rowBudget);
        try {
          queriesExecuted += 1;
          const result = await client.query(catalog.sql, [limit + 1]);
          resultRows = result.rows;
          if (resultRows.length > limit) {
            state = 'TRUNCATED';
            resultRows = resultRows.slice(0, limit);
            blockers.push('DATABASE_PRINCIPAL_CATALOG_TRUNCATED:' + catalog.name);
          }
          rowBudget -= resultRows.length;
          rowsObserved[catalog.name] = resultRows;
        } catch (error) {
          const code = sqlState(error);
          errorCode = queryErrorCode(code);
          state = 'FAILED';
          blockers.push('DATABASE_PRINCIPAL_CATALOG_FAILED:' + catalog.name + ':' + errorCode);
          await client.query('ROLLBACK TO SAVEPOINT factoryos_pitr_catalog');
        }
        catalogStatus.push({
          catalog: catalog.name,
          status: state,
          rows_observed: resultRows.length,
          error_code: errorCode,
        });
        await client.query('RELEASE SAVEPOINT factoryos_pitr_catalog');
      }
      const roleRows = rowsObserved.database_roles ?? [];
      const readerRole = roleRows.find((candidate) => candidate.rolname === this.options.database_username);
      const databaseCatalog = rowsObserved.database_access ?? [];
      if (!databaseCatalog.some((candidate) => candidate.datname === this.options.database_name)) {
        blockers.push('DATABASE_CURRENT_DATABASE_NOT_PRESENT_IN_COMPLETE_DATABASE_CATALOG');
      }
      if (databaseCatalog.some((candidate) => candidate.datallowconn === true
        && candidate.datistemplate === false && candidate.current_user_can_connect !== true)) {
        blockers.push('DATABASE_PRINCIPAL_READER_CANNOT_CONNECT_TO_EVERY_CONNECTABLE_DATABASE');
      }
      if (!readerRole || readerRole.rolsuper !== false || readerRole.rolcreaterole !== false
        || readerRole.rolcreatedb !== false || readerRole.rolreplication !== false
        || readerRole.rolbypassrls !== false || readerRole.rolcanlogin !== true
        || readerRole.rolinherit !== true || identity.has_pg_read_all_stats !== true || identity.has_rds_iam !== true
        || identity.privileged_memberships.length > 0) {
        blockers.push('DATABASE_INVENTORY_LOGIN_ROLE_IS_MISSING_OR_OVERPRIVILEGED');
      }
      await client.query('COMMIT');
      inTransaction = false;
    } catch (error) {
      if (inTransaction && client) await client.query('ROLLBACK').catch(() => undefined);
      blockers.push('DATABASE_PRINCIPAL_SNAPSHOT_FAILED:' + queryErrorCode(sqlState(error)));
    } finally {
      client?.release();
      await pool.end().catch(() => undefined);
    }

    const allCatalogsComplete = catalogStatus.length === CATALOGS.length
      && catalogStatus.every((entry) => entry.status === 'COMPLETE');
    const complete = Boolean(identity) && allCatalogsComplete && blockers.length === 0;
    const roles = rowsObserved.database_roles ?? [];
    const result: AwsRdsPitrDatabasePrincipalCatalog = {
      schema: 'factoryos.aws-rds-postgresql-database-principals/v1',
      account_id: target.account_id,
      region: target.region,
      database_resource_arn: target.resource_arn,
      database_resource_id: target.db_resource_id,
      source_database_reference: target.source_database_reference,
      endpoint_reference: endpointReference,
      database_name: this.options.database_name,
      database_username: this.options.database_username,
      database_access_role_arn: accessRole.role_arn,
      database_access_principal_reference: accessRole.principal_reference,
      status: complete ? 'COMPLETE' : identity ? 'PARTIAL' : 'UNAVAILABLE',
      observed_at: observedAt,
      identity,
      database_roles: roles.map((item) => ({
        role_name: requiredString(item.rolname, 'role_name'),
        can_login: asBoolean(item.rolcanlogin, 'rolcanlogin'),
        is_superuser: asBoolean(item.rolsuper, 'rolsuper'),
        can_create_role: asBoolean(item.rolcreaterole, 'rolcreaterole'),
        can_create_database: asBoolean(item.rolcreatedb, 'rolcreatedb'),
        can_replicate: asBoolean(item.rolreplication, 'rolreplication'),
        bypasses_rls: asBoolean(item.rolbypassrls, 'rolbypassrls'),
        inherits: asBoolean(item.rolinherit, 'rolinherit'),
      })),
      role_memberships: (rowsObserved.role_memberships ?? []).map((item) => ({
        granted_role: requiredString(item.granted_role, 'granted_role'),
        member_role: requiredString(item.member_role, 'member_role'),
        granted_by: requiredString(item.granted_by, 'granted_by'),
        admin_option: asBoolean(item.admin_option, 'admin_option'),
      })),
      database_access: (rowsObserved.database_access ?? []).map((item) => ({
        database_name: requiredString(item.datname, 'datname'),
        owner: requiredString(item.owner, 'database_owner'),
        allow_connections: asBoolean(item.datallowconn, 'datallowconn'),
        current_user_can_connect: asBoolean(item.current_user_can_connect, 'database_connect_privilege'),
        is_template: asBoolean(item.datistemplate, 'datistemplate'),
        acl_reference: typeof item.acl_reference === 'string' ? item.acl_reference.slice(0, 2048) : null,
      })),
      schema_privileges: (rowsObserved.schema_privileges ?? []).map((item) => ({
        grantee: requiredString(item.grantee, 'schema_grantee'),
        schema_name: requiredString(item.schema_name, 'schema_name'),
        privilege_type: requiredString(item.privilege_type, 'schema_privilege'),
        is_grantable: asBoolean(item.is_grantable, 'schema_is_grantable'),
      })),
      object_privileges: (rowsObserved.object_privileges ?? []).map((item) => ({
        grantee: requiredString(item.grantee, 'object_grantee'),
        schema_name: requiredString(item.schema_name, 'schema_name'),
        object_name: requiredString(item.object_name, 'object_name'),
        object_owner: requiredString(item.object_owner, 'object_owner'),
        object_type: requiredString(item.object_type, 'object_type'),
        privilege_type: requiredString(item.privilege_type, 'object_privilege'),
        is_grantable: asBoolean(item.is_grantable, 'object_is_grantable'),
      })),
      function_privileges: (rowsObserved.function_privileges ?? []).map((item) => ({
        grantee: requiredString(item.grantee, 'function_grantee'),
        schema_name: requiredString(item.schema_name, 'schema_name'),
        function_name: requiredString(item.function_name, 'function_name'),
        function_owner: requiredString(item.function_owner, 'function_owner'),
        is_grantable: asBoolean(item.is_grantable, 'function_is_grantable'),
      })),
      active_sessions: (rowsObserved.active_sessions ?? []).map((item) => ({
        database_user: typeof item.database_user === 'string' ? item.database_user : null,
        database_name: typeof item.database_name === 'string' ? item.database_name : null,
        backend_type: requiredString(item.backend_type, 'backend_type'),
        state: typeof item.state === 'string' ? item.state : null,
        session_count: asCount(item.session_count),
      })),
      replication_senders: (rowsObserved.replication_senders ?? []).map((item) => ({
        database_user: typeof item.database_user === 'string' ? item.database_user : null,
        application_reference: 'pg-application.' + sha256(String(item.application_name ?? '')).slice(0, 32),
        state: typeof item.state === 'string' ? item.state : null,
        sync_state: typeof item.sync_state === 'string' ? item.sync_state : null,
        sender_count: asCount(item.sender_count),
      })),
      replication_slots: (rowsObserved.replication_slots ?? []).map((item) => ({
        slot_name: requiredString(item.slot_name, 'slot_name'),
        plugin: typeof item.plugin === 'string' ? item.plugin : null,
        slot_type: requiredString(item.slot_type, 'slot_type'),
        database_name: typeof item.database === 'string' ? item.database : null,
        active: asBoolean(item.active, 'slot_active'),
        temporary: asBoolean(item.temporary, 'slot_temporary'),
      })),
      wal_receivers: (rowsObserved.wal_receivers ?? []).map((item) => ({
        status: requiredString(item.status, 'wal_receiver_status'),
        slot_name: typeof item.slot_name === 'string' ? item.slot_name : null,
      })),
      logical_subscriptions: (rowsObserved.logical_subscriptions ?? []).map((item) => ({
        subscription_name: requiredString(item.subscription_name, 'subscription_name'),
        owner: requiredString(item.owner, 'subscription_owner'),
        enabled: asBoolean(item.enabled, 'subscription_enabled'),
        slot_name: typeof item.slot_name === 'string' ? item.slot_name : null,
        publications: Array.isArray(item.publications)
          ? item.publications.map((value) => requiredString(value, 'publication_name')) : [],
      })),
      publications: (rowsObserved.publications ?? []).map((item) => ({
        publication_name: requiredString(item.publication_name, 'publication_name'),
        all_tables: asBoolean(item.all_tables, 'publication_all_tables'),
        inserts: asBoolean(item.inserts, 'publication_inserts'),
        updates: asBoolean(item.updates, 'publication_updates'),
        deletes: asBoolean(item.deletes, 'publication_deletes'),
        truncates: asBoolean(item.truncates, 'publication_truncates'),
      })),
      catalog_status: catalogStatus,
      rows_observed: catalogStatus.reduce((sum, item) => sum + item.rows_observed, 0),
      queries_executed: queriesExecuted,
      snapshot_sha256: '',
      blockers,
    };
    result.snapshot_sha256 = sha256(JSON.stringify(result));
    return result;
  }

  private emptyResult(
    target: AwsRdsPitrDatabaseTarget,
    endpointReference: string,
    accessRole: AwsRdsPitrDatabaseAccessRole,
    observedAt: string,
    blockers: string[],
    catalogStatus: AwsRdsPitrDatabasePrincipalCatalog['catalog_status'],
    queriesExecuted: number,
  ): AwsRdsPitrDatabasePrincipalCatalog {
    const result: AwsRdsPitrDatabasePrincipalCatalog = {
      schema: 'factoryos.aws-rds-postgresql-database-principals/v1',
      account_id: target.account_id,
      region: target.region,
      database_resource_arn: target.resource_arn,
      database_resource_id: target.db_resource_id,
      source_database_reference: target.source_database_reference,
      endpoint_reference: endpointReference,
      database_name: this.options.database_name,
      database_username: this.options.database_username,
      database_access_role_arn: accessRole.role_arn,
      database_access_principal_reference: accessRole.principal_reference,
      status: 'UNAVAILABLE',
      observed_at: observedAt,
      identity: null,
      database_roles: [],
      role_memberships: [],
      database_access: [],
      schema_privileges: [],
      object_privileges: [],
      function_privileges: [],
      active_sessions: [],
      replication_senders: [],
      replication_slots: [],
      wal_receivers: [],
      logical_subscriptions: [],
      publications: [],
      catalog_status: catalogStatus,
      rows_observed: 0,
      queries_executed: queriesExecuted,
      snapshot_sha256: '',
      blockers,
    };
    result.snapshot_sha256 = sha256(JSON.stringify(result));
    return result;
  }
}
