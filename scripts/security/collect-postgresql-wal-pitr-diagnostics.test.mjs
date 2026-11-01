import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectPostgresqlWalPitrDiagnostics,
  REQUIRED_POSTGRESQL_WAL_PITR_SOURCES,
} from './collect-postgresql-wal-pitr-diagnostics.mjs';

function makeClient({ role = {}, readOnly = 'on', failures = [], archiveSecrets = false } = {}) {
  const calls = [];
  const defaultRole = {
    rolname: 'factoryos_wal_audit',
    rolcanlogin: true,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    can_create_in_database: false,
    pg_monitor_member: true,
    ...role,
  };
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (sql === 'BEGIN READ ONLY' || sql === 'ROLLBACK'
        || sql.startsWith('SET LOCAL')) return { rows: [] };
      if (sql.includes('transaction_read_only')) return { rows: [{ transaction_read_only: readOnly }] };
      if (sql.includes('WHERE r.rolname = current_user')) return { rows: [defaultRole] };
      if (sql.includes('FROM pg_control_system')) {
        if (failures.includes('cluster')) throw new Error('permission denied');
        return { rows: [{
          system_identifier: '7656119800000000000',
          server_version_num: '170004',
          server_version: '17.4',
          in_recovery: false,
          postmaster_started_at: new Date('2026-11-01T10:00:00.000Z'),
        }] };
      }
      if (sql.includes('FROM pg_stat_archiver')) {
        if (failures.includes('archive')) throw new Error('permission denied');
        return { rows: [{
          archive_mode: 'on',
          archive_command_configured: true,
          archive_library_configured: false,
          wal_level: 'replica',
          archive_timeout: '300',
          archived_count: 100,
          failed_count: 0,
          last_archived_wal: '000000010000000000000001',
          last_archived_time: new Date('2026-11-01T10:00:00.000Z'),
          last_failed_wal: null,
          last_failed_time: null,
          ...(archiveSecrets ? { archive_command: 'env AWS_SECRET_ACCESS_KEY=do-not-leak' } : {}),
        }] };
      }
      if (sql.includes('pg_ls_waldir')) {
        if (failures.includes('wal')) throw new Error('permission denied');
        return { rows: [{
          name: '000000010000000000000001',
          size_bytes: '16777216',
          modification: new Date('2026-11-01T10:00:00.000Z'),
        }] };
      }
      if (sql.includes('FROM pg_roles r') && !sql.includes('WHERE r.rolname = current_user')) {
        if (failures.includes('writers')) throw new Error('permission denied');
        return { rows: [{
          rolname: 'wal_archiver',
          rolcanlogin: true,
          rolreplication: false,
          rolsuper: false,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
        }] };
      }
      if (sql.includes('FROM pg_stat_replication')) {
        if (failures.includes('replication')) throw new Error('permission denied');
        return { rows: [{
          application_name: 'dr-replica-01', state: 'streaming', sync_state: 'async',
          sent_lsn: '0/1000', write_lsn: '0/1000', flush_lsn: '0/1000', replay_lsn: '0/0',
          backend_start: new Date('2026-11-01T10:00:00.000Z'),
        }] };
      }
      if (sql.includes('FROM pg_stat_wal_receiver')) return { rows: [] };
      if (sql.includes('restore_command')) return { rows: [{
        in_recovery: false,
        restore_command_configured: true,
        archive_cleanup_command_configured: false,
        recovery_target_timeline: 'latest',
        recovery_target_time: null,
      }] };
      throw new Error('unexpected query');
    },
  };
}

test('collector runs read-only, records six bounded diagnostics and never emits signable receipts', async () => {
  const client = makeClient();
  const report = await collectPostgresqlWalPitrDiagnostics({
    client,
    clusterReference: 'pg.cluster.production',
    runReference: 'pgdiag.test-run',
    startedAt: new Date('2026-11-01T11:00:00.000Z'),
    connectionSecurity: { host: 'localhost', encrypted: false },
  });

  assert.deepEqual(report.sources.map((item) => item.source_kind), REQUIRED_POSTGRESQL_WAL_PITR_SOURCES);
  assert.ok(client.calls.includes('BEGIN READ ONLY'));
  assert.ok(client.calls.includes('ROLLBACK'));
  assert.ok(client.calls.every((sql) => ['SELECT', 'BEGIN', 'SET', 'ROLLBACK'].includes(sql.trim().split(' ')[0].toUpperCase())));
  assert.equal(report.connection_security.transaction_read_only, true);
  assert.equal(report.tenant_scoped, false);
  assert.equal(report.provider_native_inventory_complete, false);
  assert.equal(report.source_receipts_signable, false);
  assert.equal(report.tenant_scoped_delete_permitted, false);
  assert.equal(report.copy_class_disposition, 'UNRESOLVED');
  assert.ok(report.sources.every((item) => item.status !== 'COMPLETE'));
});

test('collector rejects privileged identities before collecting inventory', async () => {
  const client = makeClient({ role: { rolsuper: true } });
  await assert.rejects(
    collectPostgresqlWalPitrDiagnostics({
      client, clusterReference: 'pg.cluster.production',
      connectionSecurity: { host: 'localhost', encrypted: false },
    }),
    /without superuser/i,
  );
  assert.ok(client.calls.includes('ROLLBACK'));
  assert.equal(client.calls.some((sql) => sql.includes('FROM pg_control_system')), false);
});

test('collector refuses a transaction that PostgreSQL did not mark read-only', async () => {
  const client = makeClient({ readOnly: 'off' });
  await assert.rejects(
    collectPostgresqlWalPitrDiagnostics({
      client, clusterReference: 'pg.cluster.production',
      connectionSecurity: { host: 'localhost', encrypted: false },
    }),
    /read-only transaction/i,
  );
  assert.ok(client.calls.includes('ROLLBACK'));
});

test('remote database connection requires verified TLS before any SQL executes', async () => {
  const client = makeClient();
  await assert.rejects(
    collectPostgresqlWalPitrDiagnostics({
      client, clusterReference: 'pg.cluster.production',
      connectionSecurity: { host: 'db.example.internal', encrypted: false },
    }),
    /require verified TLS/i,
  );
  assert.equal(client.calls.length, 0);
});

test('unavailable provider-adjacent queries remain explicitly incomplete', async () => {
  const report = await collectPostgresqlWalPitrDiagnostics({
    client: makeClient({ failures: ['archive', 'wal', 'replication'] }),
    clusterReference: 'pg.cluster.production',
    connectionSecurity: { host: 'localhost', encrypted: false },
  });
  const archive = report.sources.find((item) => item.source_kind === 'WAL_ARCHIVE_DESTINATION_CATALOG');
  const wal = report.sources.find((item) => item.source_kind === 'WAL_SEGMENT_CATALOG');
  const replication = report.sources.find((item) => item.source_kind === 'WAL_REPLICATION_PATH_CATALOG');
  assert.equal(archive.status, 'UNAVAILABLE');
  assert.equal(wal.status, 'UNAVAILABLE');
  assert.equal(replication.status, 'UNAVAILABLE');
  assert.equal(report.provider_native_inventory_complete, false);
  assert.equal(report.source_receipts_signable, false);
});

test('diagnostic projection never serializes archive command credentials', async () => {
  const report = await collectPostgresqlWalPitrDiagnostics({
    client: makeClient({ archiveSecrets: true }),
    clusterReference: 'pg.cluster.production',
    connectionSecurity: { host: 'localhost', encrypted: false },
  });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('do-not-leak'), false);
  assert.equal(serialized.includes('AWS_SECRET_ACCESS_KEY'), false);
  const archive = report.sources.find((item) => item.source_kind === 'WAL_ARCHIVE_DESTINATION_CATALOG');
  assert.equal(archive.records[0].archive_command_configured, true);
});
