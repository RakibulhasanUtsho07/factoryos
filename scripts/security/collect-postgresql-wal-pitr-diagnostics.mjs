#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const POSTGRESQL_WAL_PITR_DIAGNOSTIC_SCHEMA = 'factoryos.postgresql-wal-pitr-diagnostic/v1';
export const REQUIRED_POSTGRESQL_WAL_PITR_SOURCES = [
  'POSTGRESQL_CLUSTER_CATALOG',
  'WAL_ARCHIVE_DESTINATION_CATALOG',
  'WAL_SEGMENT_CATALOG',
  'WAL_WRITER_PRINCIPAL_CATALOG',
  'WAL_REPLICATION_PATH_CATALOG',
  'PITR_RESTORE_PATH_CATALOG',
];
const MAX_WAL_DIRECTORY_ROWS = 10000;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}
function safeReference(value, field) {
  if (typeof value !== 'string' || !SAFE_REFERENCE.test(value)
    || /(secret|password|credential|access[-_]?key|token)/i.test(value)) {
    throw new Error(field + ' must be a non-secret opaque reference');
  }
  return value;
}
function isLocalHost(host) {
  const value = String(host || '').toLowerCase();
  return value === 'localhost' || value === '::1' || value === '[::1]'
    || value.startsWith('127.') || value.endsWith('.localhost') || value.startsWith('/');
}
function source(kind, records, status, reason, extra = {}) {
  const bounded = Array.isArray(records) ? records : [];
  return {
    source_kind: kind,
    status,
    pages_fetched: status === 'UNAVAILABLE' ? 0 : 1,
    item_count: bounded.length,
    pagination_exhausted: false,
    result_sha256: digest(bounded),
    records: bounded,
    reason,
    ...extra,
  };
}
function hashOpaqueReference(value) {
  return 'ref.' + createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex').slice(0, 24);
}
async function observe(kind, operation, reason, extra = {}) {
  try {
    const result = await operation();
    return source(kind, result, 'OBSERVED', reason, extra);
  } catch {
    return source(kind, [], 'UNAVAILABLE', 'The database-native query was unavailable; no completeness claim is made.');
  }
}

/**
 * Diagnostic-only collector. It runs inside a read-only PostgreSQL transaction and
 * deliberately does not create signable COMPLETE source receipts or an inventory manifest.
 * Cloud account/region, remote archive, provider IAM and restore-vault discovery must be
 * collected by provider-native read-only APIs outside this database connection.
 */
export async function collectPostgresqlWalPitrDiagnostics({
  client,
  clusterReference,
  runReference = 'pgdiag.' + randomUUID(),
  startedAt = new Date(),
  connectionSecurity = { host: 'localhost', encrypted: false },
}) {
  const stableClusterReference = safeReference(clusterReference, 'clusterReference');
  const stableRunReference = safeReference(runReference, 'runReference');
  if (!connectionSecurity || typeof connectionSecurity.host !== 'string') {
    throw new Error('connection security metadata is required');
  }
  if (!isLocalHost(connectionSecurity.host) && connectionSecurity.encrypted !== true) {
    throw new Error('remote PostgreSQL connections require verified TLS');
  }

  const started = new Date(startedAt);
  if (!Number.isFinite(started.getTime())) throw new Error('startedAt must be a valid date');
  const sql = {
    readOnly: "SELECT current_setting('transaction_read_only') AS transaction_read_only",
    role: 'SELECT r.rolname, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, '
      + 'r.rolreplication, r.rolbypassrls, '
      + "has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_in_database, "
      + "pg_has_role(current_user, 'pg_monitor', 'member') AS pg_monitor_member "
      + 'FROM pg_roles r WHERE r.rolname = current_user',
    cluster: "SELECT current_setting('server_version_num') AS server_version_num, "
      + "current_setting('server_version') AS server_version, pg_is_in_recovery() AS in_recovery, "
      + 'pg_postmaster_start_time() AS postmaster_started_at, '
      + '(SELECT system_identifier::text FROM pg_control_system()) AS system_identifier',
    archive: "SELECT current_setting('archive_mode') AS archive_mode, "
      + "(COALESCE(NULLIF(current_setting('archive_command', true), ''), '(disabled)') <> '(disabled)') "
      + 'AS archive_command_configured, '
      + "(COALESCE(NULLIF(current_setting('archive_library', true), ''), '') <> '') AS archive_library_configured, "
      + "current_setting('wal_level') AS wal_level, current_setting('archive_timeout') AS archive_timeout, "
      + 'archived_count, failed_count, last_archived_wal, last_archived_time, last_failed_wal, last_failed_time '
      + 'FROM pg_stat_archiver',
    wal: "SELECT name, size::text AS size_bytes, modification FROM pg_ls_waldir() "
      + "WHERE name ~ '^[0-9A-F]{24}($|\\.partial$)' ORDER BY name LIMIT 10001",
    writers: 'SELECT r.rolname, r.rolcanlogin, r.rolreplication, r.rolsuper, r.rolbypassrls, '
      + 'r.rolcreatedb, r.rolcreaterole FROM pg_roles r '
      + 'WHERE r.rolcanlogin IS TRUE OR r.rolreplication IS TRUE OR r.rolsuper IS TRUE '
      + 'OR r.rolbypassrls IS TRUE OR r.rolcreatedb IS TRUE OR r.rolcreaterole IS TRUE '
      + 'ORDER BY r.rolname LIMIT 10001',
    senders: 'SELECT application_name, state, sync_state, sent_lsn, write_lsn, flush_lsn, '
      + 'replay_lsn, backend_start FROM pg_stat_replication ORDER BY application_name LIMIT 10001',
    receiver: 'SELECT status, written_lsn, flushed_lsn, latest_end_lsn, latest_end_time '
      + 'FROM pg_stat_wal_receiver LIMIT 10001',
    restore: 'SELECT pg_is_in_recovery() AS in_recovery, '
      + "(COALESCE(NULLIF(current_setting('restore_command', true), ''), '') <> '') AS restore_command_configured, "
      + "(COALESCE(NULLIF(current_setting('archive_cleanup_command', true), ''), '') <> '') "
      + 'AS archive_cleanup_command_configured, '
      + "current_setting('recovery_target_timeline', true) AS recovery_target_timeline, "
      + "current_setting('recovery_target_time', true) AS recovery_target_time",
  };

  let transactionStarted = false;
  try {
    await client.query('BEGIN READ ONLY');
    transactionStarted = true;
    await client.query("SET LOCAL statement_timeout = '10000'");
    await client.query("SET LOCAL lock_timeout = '2000'");
    const readOnly = await client.query(sql.readOnly);
    const readOnlyValue = readOnly.rows?.[0]?.transaction_read_only;
    if (!(readOnlyValue === true || String(readOnlyValue).toLowerCase() === 'on')) {
      throw new Error('PostgreSQL did not confirm a read-only transaction');
    }

    const roleResult = await client.query(sql.role);
    const role = roleResult.rows?.[0];
    if (!role || role.rolcanlogin !== true || role.rolsuper === true || role.rolcreatedb === true
      || role.rolcreaterole === true || role.rolreplication === true || role.rolbypassrls === true
      || role.can_create_in_database === true) {
      throw new Error('collector identity must be a login role without superuser, role/database creation, replication or RLS bypass privileges');
    }

    const clusterSource = await observe(
      'POSTGRESQL_CLUSTER_CATALOG',
      async () => {
        const result = await client.query(sql.cluster);
        const row = result.rows?.[0];
        if (!row || !/^\d{1,20}$/.test(String(row.system_identifier ?? ''))
          || !/^\d{1,5}$/.test(String(row.server_version_num ?? ''))) {
          throw new Error('cluster identity metadata is incomplete');
        }
        return [{
          cluster_reference: stableClusterReference,
          system_identifier: String(row.system_identifier),
          server_version_num: String(row.server_version_num),
          server_version: String(row.server_version),
          in_recovery: row.in_recovery === true,
          postmaster_started_at: row.postmaster_started_at instanceof Date
            ? row.postmaster_started_at.toISOString() : String(row.postmaster_started_at),
        }];
      },
      'One connected PostgreSQL instance was observed; this does not enumerate all provider accounts, regions or clusters.',
    );

    const archiveSource = await observe(
      'WAL_ARCHIVE_DESTINATION_CATALOG',
      async () => {
        const result = await client.query(sql.archive);
        const row = result.rows?.[0];
        if (!row) throw new Error('pg_stat_archiver did not return a row');
        return [{
          cluster_reference: stableClusterReference,
          archive_mode: String(row.archive_mode),
          archive_command_configured: row.archive_command_configured === true,
          archive_library_configured: row.archive_library_configured === true,
          wal_level: String(row.wal_level),
          archive_timeout: String(row.archive_timeout),
          archived_count: Number(row.archived_count),
          failed_count: Number(row.failed_count),
          last_archived_wal: row.last_archived_wal ?? null,
          last_archived_time: row.last_archived_time instanceof Date
            ? row.last_archived_time.toISOString() : row.last_archived_time ?? null,
          last_failed_wal: row.last_failed_wal ?? null,
          last_failed_time: row.last_failed_time instanceof Date
            ? row.last_failed_time.toISOString() : row.last_failed_time ?? null,
        }];
      },
      'PostgreSQL archiver counters/configuration are observations only; remote archive buckets, vaults, accounts, regions and object generations were not enumerated.',
    );

    const walSource = await observe(
      'WAL_SEGMENT_CATALOG',
      async () => {
        const result = await client.query(sql.wal);
        return (result.rows ?? []).map((row) => ({
          filename: String(row.name),
          size_bytes: String(row.size_bytes),
          modification: row.modification instanceof Date
            ? row.modification.toISOString() : String(row.modification),
          location_scope: 'LOCAL_PG_WAL_DIRECTORY_ONLY',
        }));
      },
      'This is a bounded local pg_wal directory sample, not a remote WAL archive inventory or complete PITR segment history.',
      { bounded_limit: MAX_WAL_DIRECTORY_ROWS },
    );
    if (walSource.item_count > MAX_WAL_DIRECTORY_ROWS) {
      walSource.records = walSource.records.slice(0, MAX_WAL_DIRECTORY_ROWS);
      walSource.item_count = walSource.records.length;
      walSource.pagination_exhausted = false;
      walSource.status = 'PARTIAL';
      walSource.result_sha256 = digest(walSource.records);
    } else {
      walSource.status = 'PARTIAL';
      walSource.pagination_exhausted = false;
    }

    const writerSource = await observe(
      'WAL_WRITER_PRINCIPAL_CATALOG',
      async () => {
        const result = await client.query(sql.writers);
        return (result.rows ?? []).map((row) => ({
          database_role: String(row.rolname),
          can_login: row.rolcanlogin === true,
          replication: row.rolreplication === true,
          superuser: row.rolsuper === true,
          bypass_rls: row.rolbypassrls === true,
          create_database: row.rolcreatedb === true,
          create_role: row.rolcreaterole === true,
        }));
      },
      'PostgreSQL roles do not enumerate cloud IAM roles, archive writers, replication service principals, scheduled jobs or external producer credentials.',
    );

    const replicationSource = await observe(
      'WAL_REPLICATION_PATH_CATALOG',
      async () => {
        const senders = await client.query(sql.senders);
        const receivers = await client.query(sql.receiver);
        const records = (senders.rows ?? []).map((row) => ({
          direction: 'SENDER',
          path_reference: hashOpaqueReference(row.application_name),
          state: String(row.state),
          sync_state: String(row.sync_state),
          sent_lsn: row.sent_lsn ?? null,
          write_lsn: row.write_lsn ?? null,
          flush_lsn: row.flush_lsn ?? null,
          replay_lsn: row.replay_lsn ?? null,
          backend_started_at: row.backend_start instanceof Date
            ? row.backend_start.toISOString() : row.backend_start ?? null,
        }));
        for (const row of receivers.rows ?? []) records.push({
          direction: 'RECEIVER',
          path_reference: hashOpaqueReference('receiver.' + String(row.status)),
          state: String(row.status),
          sync_state: null,
          sent_lsn: null,
          write_lsn: row.written_lsn ?? null,
          flush_lsn: row.flushed_lsn ?? null,
          replay_lsn: row.latest_end_lsn ?? null,
          backend_started_at: row.latest_end_time instanceof Date
            ? row.latest_end_time.toISOString() : row.latest_end_time ?? null,
        });
        return records;
      },
      'The connected server replication views do not enumerate provider replication policies, cross-account replicas or archived-log consumers.',
    );

    const restoreSource = await observe(
      'PITR_RESTORE_PATH_CATALOG',
      async () => {
        const result = await client.query(sql.restore);
        const row = result.rows?.[0];
        if (!row) throw new Error('restore configuration query returned no row');
        return [{
          cluster_reference: stableClusterReference,
          in_recovery: row.in_recovery === true,
          restore_command_configured: row.restore_command_configured === true,
          archive_cleanup_command_configured: row.archive_cleanup_command_configured === true,
          recovery_target_timeline: row.recovery_target_timeline ?? null,
          recovery_target_time: row.recovery_target_time ?? null,
          restore_rehearsal_evidence: 'NOT_PROVIDED',
          tombstone_replay_evidence: 'NOT_PROVIDED',
        }];
      },
      'Configuration presence is not proof of a provider restore target, a successful PITR rehearsal or tombstone replay.',
    );

    const sources = [clusterSource, archiveSource, walSource, writerSource, replicationSource, restoreSource];
    const completed = new Date();
    return {
      schema: POSTGRESQL_WAL_PITR_DIAGNOSTIC_SCHEMA,
      diagnostic_only: true,
      run_reference: stableRunReference,
      cluster_reference: stableClusterReference,
      scope_kind: 'POSTGRESQL_CLUSTER',
      tenant_scoped: false,
      started_at: started.toISOString(),
      completed_at: completed.toISOString(),
      connection_security: {
        transaction_read_only: true,
        tls_required_for_remote_host: true,
        transport_encrypted: connectionSecurity.encrypted === true,
        collector_role: String(role.rolname),
        collector_role_non_privileged: true,
        pg_monitor_member: role.pg_monitor_member === true,
      },
      sources,
      provider_native_inventory_complete: false,
      source_receipts_signable: false,
      retention_adapter_registered: false,
      tenant_scoped_delete_permitted: false,
      copy_class_disposition: 'UNRESOLVED',
      required_follow_up: [
        'Enumerate all authoritative cloud/provider accounts, projects and regions using a provider-native read-only identity.',
        'Enumerate remote WAL archive destinations, every object version/generation, retention policy and legal hold.',
        'Enumerate all external writer principals, replication routes, scheduled producers and restore/vault targets.',
        'Run a controlled PITR restore rehearsal and verify application tombstone replay against the restored data.',
        'Implement a provider-specific retention workflow with independent residual scans; do not delete cluster-shared WAL by tenant scope.',
      ],
    };
  } finally {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined);
  }
}

async function main() {
  const connectionString = process.env.FACTORYOS_POSTGRESQL_WAL_PITR_READONLY_DATABASE_URL;
  const clusterReference = process.env.FACTORYOS_POSTGRESQL_WAL_PITR_CLUSTER_REFERENCE;
  if (!connectionString) throw new Error('FACTORYOS_POSTGRESQL_WAL_PITR_READONLY_DATABASE_URL is required');
  if (!clusterReference) throw new Error('FACTORYOS_POSTGRESQL_WAL_PITR_CLUSTER_REFERENCE is required');
  const databaseUrl = new URL(connectionString);
  const local = isLocalHost(databaseUrl.hostname);
  const requireFromApi = createRequire(resolve(process.cwd(), 'services/api/package.json'));
  const { Client } = requireFromApi('pg');
  const client = new Client({
    connectionString,
    application_name: 'factoryos-postgresql-wal-pitr-readonly-diagnostic',
    statement_timeout: 10000,
    query_timeout: 12000,
    ...(local ? {} : { ssl: { rejectUnauthorized: true } }),
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const encrypted = client.connection?.stream?.encrypted === true;
    const report = await collectPostgresqlWalPitrDiagnostics({
      client,
      clusterReference,
      connectionSecurity: { host: databaseUrl.hostname, encrypted },
    });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    // Exit non-zero deliberately: this collector is diagnostic-only and cannot
    // satisfy the provider-native completeness/signing gate by itself.
    process.exitCode = 2;
  } finally {
    if (connected) await client.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const code = error && typeof error.code === 'string' ? ' (' + error.code + ')' : '';
    process.stderr.write('PostgreSQL WAL/PITR diagnostic collection refused: '
      + (error instanceof Error ? error.message : 'unknown error') + code + '\n');
    process.exitCode = 1;
  });
}
