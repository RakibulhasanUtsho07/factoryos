import { createHash } from 'node:crypto';
import {
  AwsRdsPitrDatabaseAccessRole,
  AwsRdsPitrDatabasePrincipalInventoryReader,
  AwsRdsPitrDatabasePrincipalOptions,
  AwsRdsPitrDatabaseTarget,
  createAwsRdsPitrIamDatabaseAuthToken,
  AwsRdsPitrPgPoolFactory,
} from './aws-rds-postgresql-database-principal-inventory';

const account = '111111111111';
const region = 'ap-southeast-1';
const username = 'factoryos_pitr_inventory';
const caPem = '-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----\n';
const caSha256 = createHash('sha256').update(caPem).digest('hex');
const credentials = {
  access_key_id: 'ASIAABCDEFGHIJKLMNOP',
  secret_access_key: 'temporary-secret-key-material-0123456789',
  session_token: 'temporary-session-token-material-0123456789',
};
const role: AwsRdsPitrDatabaseAccessRole = {
  role_arn: 'arn:aws:iam::111111111111:role/FactoryOSDatabaseInventory',
  principal_reference: 'arn:aws:sts::111111111111:assumed-role/FactoryOSDatabaseInventory/session',
  credentials,
};
const target: AwsRdsPitrDatabaseTarget = {
  account_id: account,
  region,
  resource_arn: 'arn:aws:rds:ap-southeast-1:111111111111:db:orders-db',
  db_resource_id: 'db-ABCDEFGH12345678',
  engine: 'postgres',
  endpoint_host: 'orders-db.abcdefghijkl.ap-southeast-1.rds.amazonaws.com',
  endpoint_port: 5432,
  source_database_reference: 'orders-db',
};
const options: AwsRdsPitrDatabasePrincipalOptions = {
  database_role_name: 'FactoryOSDatabaseInventory',
  database_username: username,
  database_name: 'postgres',
  ca_certificate_pem: caPem,
  ca_certificate_sha256: caSha256,
  connect_timeout_ms: 5000,
  statement_timeout_ms: 10000,
  max_rows_per_catalog: 10,
  max_total_rows: 100,
};

function makePoolFactory(settings: {
  failCatalog?: string;
  truncateCatalog?: string;
  superuser?: boolean;
  readOnly?: string;
  sessionUser?: string;
} = {}) {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const poolConfig: Array<Record<string, unknown>> = [];
  let released = false;
  let ended = false;
  const poolFactory: AwsRdsPitrPgPoolFactory = (config) => {
    poolConfig.push(config as unknown as Record<string, unknown>);
    return {
      connect: async () => ({
        query: async (sql, values) => {
          queries.push({ sql, values });
          if (sql.includes('factoryos:pitr:session_identity')) {
            return { rows: [{
              current_user: username,
              session_user: settings.sessionUser ?? username,
              current_database: 'postgres',
              transaction_read_only: settings.readOnly ?? 'on',
              in_recovery: false,
              has_pg_read_all_stats: true,
              has_rds_iam: true,
              privileged_memberships: [],
              server_version_num: '160004',
            }] };
          }
          if (sql.includes('factoryos:pitr:database_roles')) {
            const rows = [
              { rolname: username, rolcanlogin: true, rolsuper: settings.superuser ?? false,
                rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, rolinherit: true },
              { rolname: 'app_writer', rolcanlogin: true, rolsuper: false,
                rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, rolinherit: true },
            ];
            return { rows: settings.truncateCatalog === 'database_roles' ? [...rows, ...rows] : rows };
          }
          if (sql.includes('factoryos:pitr:role_memberships')) {
            return { rows: [
              { granted_role: 'pg_read_all_stats', member_role: username, granted_by: 'rds_superuser', admin_option: false },
              { granted_role: 'rds_iam', member_role: username, granted_by: 'rds_superuser', admin_option: false },
            ] };
          }
          if (sql.includes('factoryos:pitr:database_access')) {
            return { rows: [{ datname: 'postgres', owner: 'rdsadmin', datallowconn: true, current_user_can_connect: true, datistemplate: false, acl_reference: null }] };
          }
          if (sql.includes('factoryos:pitr:schema_privileges')) {
            return { rows: [{ grantee: 'app_writer', schema_name: 'public', privilege_type: 'CREATE', is_grantable: false }] };
          }
          if (sql.includes('factoryos:pitr:object_privileges')) {
            return { rows: [{ grantee: 'app_writer', schema_name: 'public', object_name: 'orders',
              object_owner: 'app_writer', object_type: 'r', privilege_type: 'INSERT', is_grantable: false }] };
          }
          if (sql.includes('factoryos:pitr:function_privileges')) {
            return { rows: [{ grantee: 'PUBLIC', schema_name: 'public', function_name: 'mutate_order',
              function_owner: 'app_writer', is_grantable: false }] };
          }
          if (sql.includes('factoryos:pitr:active_sessions')) {
            return { rows: [{ database_user: 'app_writer', database_name: 'orders', backend_type: 'client backend', state: 'active', session_count: 2 }] };
          }
          if (sql.includes('factoryos:pitr:replication_senders')) {
            return { rows: [{ database_user: 'replicator', application_name: 'orders-stream', state: 'streaming', sync_state: 'async', sender_count: 1 }] };
          }
          if (sql.includes('factoryos:pitr:replication_slots')) {
            return { rows: [{ slot_name: 'orders_slot', plugin: 'pgoutput', slot_type: 'logical', database: 'orders', active: true, temporary: false }] };
          }
          if (sql.includes('factoryos:pitr:wal_receivers')) {
            return { rows: [{ status: 'streaming', slot_name: 'upstream_slot' }] };
          }
          if (sql.includes('factoryos:pitr:logical_subscriptions')) {
            expect(sql.toLowerCase()).not.toContain('subconninfo');
            return { rows: [{ subscription_name: 'orders_subscription', owner: 'replicator',
              enabled: true, slot_name: 'orders_subscription_slot', publications: ['orders_publication'] }] };
          }
          if (sql.includes('factoryos:pitr:publications')) {
            return { rows: [{ publication_name: 'orders_publication', all_tables: false,
              inserts: true, updates: true, deletes: true, truncates: true }] };
          }
          if (sql.includes('SELECT')) return { rows: [] };
          return { rows: [] };
        },
        release: () => { released = true; },
      }),
      end: async () => { ended = true; },
    };
  };
  return { poolFactory, queries, poolConfig, released: () => released, ended: () => ended };
}

describe('AwsRdsPitrDatabasePrincipalInventoryReader', () => {
  it('creates a short-lived SigV4 token for the rds-db service without returning secret material as query output', () => {
    const token = createAwsRdsPitrIamDatabaseAuthToken({
      host: target.endpoint_host,
      port: 5432,
      region,
      username,
    }, credentials, new Date('2026-11-02T06:00:00.000Z'));
    expect(token.startsWith(target.endpoint_host + ':5432/?')).toBe(true);
    expect(token).toContain('Action=connect');
    expect(token).toContain('DBUser=' + username);
    expect(token).toContain('X-Amz-Expires=900');
    expect(token).toContain('X-Amz-Security-Token=');
    expect(token).toContain('X-Amz-Signature=');
    expect(token).not.toContain(credentials.secret_access_key);
  });

  it('captures roles, grants, current sessions, replication senders, slots, receivers and subscriptions in a read-only TLS session', async () => {
    const mock = makePoolFactory();
    const reader = new AwsRdsPitrDatabasePrincipalInventoryReader(options, mock.poolFactory,
      () => new Date('2026-11-02T06:01:00.000Z'));
    const catalog = await reader.capture(target, role);

    expect(catalog.status).toBe('COMPLETE');
    expect(catalog.identity?.transaction_read_only).toBe(true);
    expect(catalog.identity?.has_pg_read_all_stats).toBe(true);
    expect(catalog.identity?.has_rds_iam).toBe(true);
    expect(catalog.database_roles.map((item) => item.role_name)).toEqual([username, 'app_writer']);
    expect(catalog.role_memberships).toHaveLength(1);
    expect(catalog.schema_privileges[0]?.privilege_type).toBe('CREATE');
    expect(catalog.object_privileges[0]?.privilege_type).toBe('INSERT');
    expect(catalog.function_privileges[0]?.function_name).toBe('mutate_order');
    expect(catalog.active_sessions[0]?.session_count).toBe(2);
    expect(catalog.replication_senders[0]?.application_reference).not.toContain('orders-stream');
    expect(catalog.replication_slots[0]?.slot_name).toBe('orders_slot');
    expect(catalog.wal_receivers[0]?.status).toBe('streaming');
    expect(catalog.logical_subscriptions[0]?.subscription_name).toBe('orders_subscription');
    expect(catalog.logical_subscriptions[0]).not.toHaveProperty('subconninfo');
    expect(catalog.catalog_status).toHaveLength(12);
    expect(catalog.rows_observed).toBeGreaterThan(0);
    expect(catalog.snapshot_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(mock.poolConfig[0]?.ssl).toEqual({ ca: caPem, rejectUnauthorized: true });
    expect(String(mock.poolConfig[0]?.password)).toContain('X-Amz-Signature=');
    expect(mock.queries.some((q) => q.sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')).toBe(true);
    expect(mock.queries.some((q) => q.sql.includes('SET LOCAL statement_timeout'))).toBe(true);
    expect(mock.queries.every((q) => !q.sql.toLowerCase().includes('subconninfo'))).toBe(true);
    expect(mock.queries.every((q) => !q.sql.toLowerCase().includes('rolpassword'))).toBe(true);
    expect(mock.queries.some((q) => q.sql === 'COMMIT')).toBe(true);
    expect(mock.released()).toBe(true);
    expect(mock.ended()).toBe(true);
  });

  it('marks a database role with superuser or replication authority as an incomplete inventory credential', async () => {
    const mock = makePoolFactory({ superuser: true });
    const reader = new AwsRdsPitrDatabasePrincipalInventoryReader(options, mock.poolFactory);
    const catalog = await reader.capture(target, role);
    expect(catalog.status).toBe('PARTIAL');
    expect(catalog.blockers).toContain('DATABASE_INVENTORY_LOGIN_ROLE_IS_MISSING_OR_OVERPRIVILEGED');
  });

  it('fails closed when the PostgreSQL connection does not report a read-only transaction', async () => {
    const mock = makePoolFactory({ readOnly: 'off' });
    const reader = new AwsRdsPitrDatabasePrincipalInventoryReader(options, mock.poolFactory);
    const catalog = await reader.capture(target, role);
    expect(catalog.status).toBe('UNAVAILABLE');
    expect(catalog.blockers).toContain('DATABASE_SESSION_IDENTITY_OR_READ_ONLY_GUARD_FAILED');
    expect(mock.queries.some((q) => q.sql === 'COMMIT')).toBe(false);
  });

  it('marks denied and over-limit catalogs incomplete without returning database error text', async () => {
    const mock = makePoolFactory();
    const base = mock.poolFactory;
    const poolFactory: AwsRdsPitrPgPoolFactory = (config) => {
      const pool = base(config);
      const connect = pool.connect;
      return {
        connect: async () => {
          const client = await connect();
          const query = client.query;
          return {
            ...client,
            query: async (sql, values) => {
              if (sql.includes('factoryos:pitr:logical_subscriptions')) {
                const error = new Error('do-not-leak-secret-conninfo') as Error & { code: string };
                error.code = '42501';
                throw error;
              }
              return query(sql, values);
            },
          };
        },
        end: pool.end,
      };
    };
    const reader = new AwsRdsPitrDatabasePrincipalInventoryReader(options, poolFactory);
    const catalog = await reader.capture(target, role);
    expect(catalog.status).toBe('PARTIAL');
    expect(catalog.blockers).toContain('DATABASE_PRINCIPAL_CATALOG_FAILED:logical_subscriptions:ACCESS_DENIED');
    expect(catalog.blockers.join(' ')).not.toContain('do-not-leak-secret-conninfo');
  });

  it('rejects a database role assumed in a different account or under the inventory collection role', async () => {
    const mock = makePoolFactory();
    const reader = new AwsRdsPitrDatabasePrincipalInventoryReader(options, mock.poolFactory);
    await expect(reader.capture(target, {
      ...role,
      role_arn: 'arn:aws:iam::999999999999:role/FactoryOSDatabaseInventory',
    })).rejects.toThrow(/database access role identity/i);
    expect(mock.poolConfig).toHaveLength(0);
  });

  it('rejects a CA bundle with a mismatched SHA-256 pin before creating a connection pool', () => {
    expect(() => new AwsRdsPitrDatabasePrincipalInventoryReader({
      ...options,
      ca_certificate_sha256: '0'.repeat(64),
    })).toThrow(/CA bundle does not match/i);
  });

  it('rejects a custom DNS endpoint outside the discovered AWS RDS region', async () => {
    const mock = makePoolFactory();
    const reader = new AwsRdsPitrDatabasePrincipalInventoryReader(options, mock.poolFactory);
    await expect(reader.capture({
      ...target,
      endpoint_host: 'attacker.example.com',
    }, role)).rejects.toThrow(/AWS endpoint for the requested region/i);
    expect(mock.poolConfig).toHaveLength(0);
  });

  it('rejects an exhausted row budget instead of returning a complete database principal inventory', async () => {
    const mock = makePoolFactory();
    const reader = new AwsRdsPitrDatabasePrincipalInventoryReader(options, mock.poolFactory);
    await expect(reader.capture(target, role, 0)).rejects.toThrow(/remaining database principal row budget/i);
    expect(mock.poolConfig).toHaveLength(0);
  });
});
