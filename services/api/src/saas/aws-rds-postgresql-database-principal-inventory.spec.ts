import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import {
  captureAwsRdsDatabasePrincipalInventory,
  createAwsRdsIamDatabaseAuthToken,
} from './aws-rds-postgresql-database-principal-inventory';
import type {
  AwsRdsDatabasePrincipalPgClientFactory,
  AwsRdsDatabasePrincipalTarget,
} from './aws-rds-postgresql-database-principal-inventory';

const caBundle = '-----BEGIN CERTIFICATE-----\n' + 'A'.repeat(160) + '\n-----END CERTIFICATE-----';
const credentials = {
  access_key_id: 'ASIAABCDEFGHIJKLMNOP',
  secret_access_key: 'database-reader-secret-material-0123456789',
  session_token: 'database-reader-session-token-material-0123456789',
};
const target: AwsRdsDatabasePrincipalTarget = {
  account_id: '111111111111',
  region: 'ap-southeast-1',
  resource_arn: 'arn:aws:rds:ap-southeast-1:111111111111:db:orders-db',
  resource_id: 'db-ABCDEFGHIJKLMNOP',
  resource_type: 'RDS_DB_INSTANCE',
  engine: 'postgres',
  endpoint: 'orders-db.abcdefghijkl.ap-southeast-1.rds.amazonaws.com',
  port: 5432,
  iam_database_authentication_enabled: true,
};
const config = {
  database_username: 'factoryos_db_inventory_reader',
  ca_bundle_pem: caBundle,
  ca_bundle_sha256: createHash('sha256').update(caBundle, 'utf8').digest('hex'),
};

type QueryLog = { database: string; sql: string; values?: unknown[] };

function createClientFactory(options: {
  databaseCount?: string;
  databases?: Array<Record<string, unknown>>;
  deniedSqlFragment?: string;
  elevatedReader?: boolean;
  elevatedReadOnly?: boolean;
  excessRoleRows?: boolean;
  unapprovedMembership?: boolean;
} = {}) {
  const clientOptions: Array<Record<string, unknown>> = [];
  const queries: QueryLog[] = [];
  const factory: AwsRdsDatabasePrincipalPgClientFactory = (pgOptions) => {
    clientOptions.push(pgOptions);
    const database = String(pgOptions.database);
    return {
      connect: jest.fn(async () => undefined),
      query: jest.fn(async (sql: string, values?: unknown[]) => {
        queries.push({ database, sql, values });
        if (options.deniedSqlFragment && sql.includes(options.deniedSqlFragment)) {
          throw new Error('permission denied for catalog');
        }
        if (sql === 'BEGIN READ ONLY' || sql === 'ROLLBACK'
          || sql.includes("pg_catalog.set_config('statement_timeout'")
          || sql.includes("pg_catalog.set_config('lock_timeout'")) {
          return { rows: [] };
        }
        if (sql.includes('current_user AS database_user')) {
          return {
            rows: [{
              database_user: config.database_username,
              authenticated_database_user: config.database_username,
              database_name: database,
              transaction_read_only: 'on',
              rolcanlogin: true,
              rolsuper: false,
              rolinherit: true,
              rolcreaterole: false,
              rolcreatedb: false,
              rolreplication: false,
              rolbypassrls: false,
              has_pg_monitor: true,
              has_rds_iam: true,
              has_unapproved_role_membership: options.unapprovedMembership === true,
              has_rds_superuser: false,
              has_rds_replication: false,
              has_pg_read_all_data: options.elevatedReadOnly === true,
              has_pg_read_server_files: false,
              has_pg_write_all_data: options.elevatedReader === true,
              has_pg_write_server_files: false,
              has_pg_execute_server_program: false,
            }],
          };
        }
        if (sql.includes('count(*)::text AS database_count')) {
          return { rows: [{ database_count: options.databaseCount ?? '2' }] };
        }
        if (sql.startsWith('SELECT datname, datallowconn, datistemplate')) {
          return {
            rows: options.databases ?? [
              { datname: 'orders', datallowconn: true, datistemplate: false },
              { datname: 'postgres', datallowconn: true, datistemplate: false },
            ],
          };
        }
        if (sql.includes('FROM pg_catalog.pg_roles ORDER BY')) {
          const rows = [{ role_oid: '16384', rolname: 'factoryos_db_inventory_reader' }];
          return { rows: options.excessRoleRows ? [...rows, { role_oid: '16385', rolname: 'writer_role' }] : rows };
        }
        if (sql.includes('FROM pg_catalog.pg_auth_members')) {
          return { rows: [{ granted_role: 'pg_monitor', member_role: 'factoryos_db_inventory_reader' }] };
        }
        if (sql.includes('FROM pg_catalog.pg_stat_activity')) {
          return { rows: [{ pid: 102, usename: 'orders_app', application_name: 'orders-app|opaque-label' }] };
        }
        if (sql.includes('FROM pg_catalog.pg_stat_replication')) {
          return { rows: [{ pid: 101, usename: 'replication_writer', application_name: 'orders-replica' }] };
        }
        if (sql.includes('FROM pg_catalog.pg_replication_slots')) {
          return { rows: [{ slot_name: 'orders_logical_slot', plugin: 'pgoutput', slot_type: 'logical', active: true }] };
        }
        if (sql.includes('FROM pg_catalog.pg_stat_wal_receiver')) {
          return { rows: [{ status: 'streaming', sender_host: 'source.example.rds.amazonaws.com', sender_port: 5432 }] };
        }
        if (sql.includes('FROM pg_catalog.pg_subscription')) {
          return {
            rows: database === 'orders' ? [{
              subname: 'orders_subscription',
              owner_role: 'replication_owner',
              subenabled: true,
              subslotname: 'orders_remote_slot',
              subpublications: ['orders_publication'],
            }] : [],
          };
        }
        return { rows: [] };
      }),
      end: jest.fn(async () => undefined),
    };
  };
  return { factory, clientOptions, queries };
}

describe('AWS RDS PostgreSQL database-native principal inventory', () => {
  it('creates a short-lived RDS IAM token for the exact resource, region, database user and endpoint', () => {
    const token = createAwsRdsIamDatabaseAuthToken(
      credentials,
      target,
      config.database_username,
      new Date('2026-11-02T04:00:00.000Z'),
    );
    const parsed = new URL('https://' + token);
    expect(parsed.host).toBe(target.endpoint + ':5432');
    expect(parsed.searchParams.get('Action')).toBe('connect');
    expect(parsed.searchParams.get('DBUser')).toBe(config.database_username);
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(parsed.searchParams.get('X-Amz-Credential')).toContain('/ap-southeast-1/rds-db/aws4_request');
    expect(parsed.searchParams.get('X-Amz-Security-Token')).toBe(credentials.session_token);
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
    expect(token).not.toContain(credentials.secret_access_key);
  });

  it('scans every connectable non-template database using pinned TLS, IAM auth and read-only transactions', async () => {
    const mock = createClientFactory();
    const result = await captureAwsRdsDatabasePrincipalInventory(
      [target], credentials, config, mock.factory,
    );

    expect(result.coverage_complete).toBe(true);
    expect(result.targets_discovered).toBe(1);
    expect(result.targets_scanned).toBe(1);
    expect(result.databases_discovered).toBe(2);
    expect(result.databases_scanned).toBe(2);
    expect(result.total_rows_observed).toBeGreaterThan(0);
    expect(result.pages_fetched).toBeGreaterThan(0);
    expect(result.queries_attempted).toBeGreaterThan(result.pages_fetched);
    expect(result.records.some((record) => record.resource_type === 'POSTGRESQL_DATABASE_ROLE')).toBe(true);
    expect(result.records.filter((record) => record.resource_type === 'POSTGRESQL_DATABASE_ROLE')).toHaveLength(1);
    expect(result.records.some((record) => record.resource_type === 'POSTGRESQL_LOGICAL_SUBSCRIPTION')).toBe(true);
    expect(result.records.filter((record) => record.resource_type === 'POSTGRESQL_LOGICAL_SUBSCRIPTION')).toHaveLength(1);
    expect(result.records.filter((record) => record.resource_type === 'POSTGRESQL_REPLICATION_SLOT')).toHaveLength(1);
    expect(result.records.filter((record) => record.resource_type === 'POSTGRESQL_REPLICATION_SENDER')).toHaveLength(1);
    expect(result.replication_records.some((record) => record.resource_type === 'POSTGRESQL_REPLICATION_SLOT')).toBe(true);
    expect(result.replication_records.some((record) => record.resource_type === 'POSTGRESQL_REPLICATION_SENDER')).toBe(true);
    const sessionRecord = result.records.find((record) => record.resource_type === 'POSTGRESQL_ACTIVE_DATABASE_SESSION');
    expect(sessionRecord?.attributes.application_name).toBeUndefined();
    expect(sessionRecord?.attributes.application_name_sha256).toMatch(/^[a-f0-9]{64}$/);

    expect(mock.clientOptions).toHaveLength(3);
    for (const options of mock.clientOptions) {
      const tls = options.ssl as Record<string, unknown>;
      expect(tls.ca).toBe(caBundle);
      expect(tls.rejectUnauthorized).toBe(true);
      expect(tls.servername).toBe(target.endpoint);
      expect(String(options.password)).toContain('X-Amz-Signature=');
      expect(String(options.password)).toContain('X-Amz-Security-Token=');
      expect(options.application_name).toBe('factoryos-rds-principal-inventory');
    }
    expect(mock.queries.some((query) => query.sql === 'BEGIN READ ONLY')).toBe(true);
    expect(mock.queries.some((query) => query.sql === 'ROLLBACK')).toBe(true);
    const subscriptionQuery = mock.queries.find((query) => query.sql.includes('FROM pg_catalog.pg_subscription'));
    expect(subscriptionQuery).toBeDefined();
    expect(subscriptionQuery?.sql).not.toMatch(/subconninfo|password/i);
    const rolesQuery = mock.queries.find((query) => query.sql.includes('FROM pg_catalog.pg_roles ORDER BY'));
    expect(rolesQuery?.sql).not.toMatch(/rolpassword|pg_authid/i);
    expect(mock.queries.every((query) => !query.sql.includes('pg_stat_activity') || !query.sql.includes('query AS'))).toBe(true);
    expect(result.receipt_references.every((receipt) => /^postgresql-readonly\.[a-f0-9]{40}$/.test(receipt))).toBe(true);
  });

  it('fails closed when the CA bundle digest does not match the supplied RDS trust bundle', async () => {
    const mock = createClientFactory();
    await expect(captureAwsRdsDatabasePrincipalInventory(
      [target], credentials, { ...config, ca_bundle_sha256: '0'.repeat(64) }, mock.factory,
    )).rejects.toThrow(/pinned RDS CA bundle is invalid/i);
    expect(mock.clientOptions).toHaveLength(0);
  });

  it('does not connect when IAM database authentication is disabled', async () => {
    const mock = createClientFactory();
    const result = await captureAwsRdsDatabasePrincipalInventory(
      [{ ...target, iam_database_authentication_enabled: false }],
      credentials, config, mock.factory,
    );
    expect(result.coverage_complete).toBe(false);
    expect(result.blockers).toContain('db-ABCDEFGHIJKLMNOP:IAM_DATABASE_AUTHENTICATION_DISABLED');
    expect(mock.clientOptions).toHaveLength(0);
  });

  it('rejects an assumed reader with write, server-file, replication or superuser-equivalent role membership', async () => {
    const mock = createClientFactory({ elevatedReader: true });
    const result = await captureAwsRdsDatabasePrincipalInventory(
      [target], credentials, config, mock.factory,
    );
    expect(result.coverage_complete).toBe(false);
    expect(result.blockers).toContain('db-ABCDEFGHIJKLMNOP:DATABASE_CATALOG_ACCESS_DENIED_OR_FAILED');
    expect(mock.queries.some((query) => query.sql.includes('FROM pg_catalog.pg_roles ORDER BY'))).toBe(false);
  });

  it('rejects a reader with broader read-all-data or server-file access', async () => {
    const mock = createClientFactory({ elevatedReadOnly: true });
    const result = await captureAwsRdsDatabasePrincipalInventory(
      [target], credentials, config, mock.factory,
    );
    expect(result.coverage_complete).toBe(false);
    expect(result.blockers).toContain('db-ABCDEFGHIJKLMNOP:DATABASE_CATALOG_ACCESS_DENIED_OR_FAILED');
    expect(mock.queries.some((query) => query.sql.includes('FROM pg_catalog.pg_roles ORDER BY'))).toBe(false);
  });

  it('rejects inherited custom or privileged role memberships beyond pg_monitor and rds_iam', async () => {
    const mock = createClientFactory({ unapprovedMembership: true });
    const result = await captureAwsRdsDatabasePrincipalInventory(
      [target], credentials, config, mock.factory,
    );
    expect(result.coverage_complete).toBe(false);
    expect(result.blockers).toContain('db-ABCDEFGHIJKLMNOP:DATABASE_CATALOG_ACCESS_DENIED_OR_FAILED');
    expect(mock.queries.some((query) => query.sql.includes('FROM pg_catalog.pg_roles ORDER BY'))).toBe(false);
  });

  it('keeps the database partially covered when one sensitive catalog is not readable, while collecting other replication evidence', async () => {
    const mock = createClientFactory({ deniedSqlFragment: 'FROM pg_catalog.pg_subscription' });
    const result = await captureAwsRdsDatabasePrincipalInventory(
      [target], credentials, config, mock.factory,
    );
    expect(result.coverage_complete).toBe(false);
    expect(result.blockers.some((blocker) => blocker.includes('LOGICAL_SUBSCRIPTION:CATALOG_QUERY_DENIED_OR_FAILED'))).toBe(true);
    expect(result.replication_records.some((record) => record.resource_type === 'POSTGRESQL_REPLICATION_SLOT')).toBe(true);
  });

  it('marks the source partial when the database catalog exceeds a query row cap', async () => {
    const mock = createClientFactory({ excessRoleRows: true });
    const result = await captureAwsRdsDatabasePrincipalInventory(
      [target], credentials, { ...config, max_rows_per_query: 1 }, mock.factory,
    );
    expect(result.coverage_complete).toBe(false);
    expect(result.blockers.some((blocker) => blocker.includes('DATABASE_ROLE:ROW_LIMIT_REACHED'))).toBe(true);
  });

  it('marks database enumeration partial when a non-template database cannot be connected', async () => {
    const mock = createClientFactory({
      databases: [
        { datname: 'orders', datallowconn: true, datistemplate: false },
        { datname: 'locked_db', datallowconn: false, datistemplate: false },
      ],
      databaseCount: '2',
    });
    const result = await captureAwsRdsDatabasePrincipalInventory(
      [target], credentials, config, mock.factory,
    );
    expect(result.coverage_complete).toBe(false);
    expect(result.blockers).toContain('db-ABCDEFGHIJKLMNOP:locked_db:DATABASE_CONNECT_DISABLED');
    expect(result.databases_discovered).toBe(2);
    expect(result.databases_scanned).toBe(1);
  });

  it('rejects foreign account, region, resource type and unsupported endpoint identities before connecting', async () => {
    const mock = createClientFactory();
    await expect(captureAwsRdsDatabasePrincipalInventory(
      [{ ...target, account_id: '999999999999' }],
      credentials, config, mock.factory,
    )).rejects.toThrow(/target ARN does not match/i);
    await expect(captureAwsRdsDatabasePrincipalInventory(
      [{ ...target, endpoint: 'attacker.example.com' }],
      credentials, config, mock.factory,
    )).rejects.toThrow(/target identity, endpoint, port or IAM-auth metadata is invalid/i);
    expect(mock.clientOptions).toHaveLength(0);
  });

  it('fails validation for unbounded database, row, query and timeout configuration', async () => {
    const mock = createClientFactory();
    await expect(captureAwsRdsDatabasePrincipalInventory(
      [target], credentials, { ...config, max_total_queries: 50001 }, mock.factory,
    )).rejects.toThrow(/outside supported limits/i);
    expect(mock.clientOptions).toHaveLength(0);
  });
});
