import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./postgres-backup-restore-rehearsal.sh', import.meta.url));

function runScript(overrides = {}) {
  return spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '',
      ...overrides,
    },
  });
}

function commonConfig(directory, overrides = {}) {
  return {
    FACTORYOS_BACKUP_PGSERVICE: 'factoryos-source',
    FACTORYOS_RESTORE_PGSERVICE: 'factoryos-recovery',
    FACTORYOS_BACKUP_OUTPUT: join(directory, 'factoryos-recovery.dump.gpg'),
    FACTORYOS_BACKUP_GPG_RECIPIENT: 'ci-nonexistent-recipient@example.invalid',
    FACTORYOS_RESTORE_SMOKE_SQL: join(directory, 'restore-smoke.sql'),
    ...overrides,
  };
}

test('backup rehearsal requires configuration before invoking database tools', () => {
  const result = runScript();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required environment variable is missing: FACTORYOS_BACKUP_PGSERVICE/);
  assert.equal(result.stderr.includes('password'), false);
});

test('backup rehearsal refuses an unencrypted archive output extension', () => {
  const result = runScript({
    FACTORYOS_BACKUP_PGSERVICE: 'factoryos-source',
    FACTORYOS_RESTORE_PGSERVICE: 'factoryos-recovery',
    FACTORYOS_BACKUP_OUTPUT: '/tmp/factoryos-unencrypted.dump',
    FACTORYOS_BACKUP_GPG_RECIPIENT: 'ci-nonexistent-recipient@example.invalid',
    FACTORYOS_RESTORE_SMOKE_SQL: '/tmp/restore-smoke-not-present.sql',
    FACTORYOS_RESTORE_CONFIRM_EMPTY_DATABASE: 'I_HAVE_VERIFIED_EMPTY',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /backup output must end in \.dump\.gpg/);
});

test('backup rehearsal requires explicit empty-target operator confirmation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-recovery-contract-'));
  try {
    const smokeSql = join(directory, 'restore-smoke.sql');
    writeFileSync(smokeSql, 'SELECT 1;\n', { mode: 0o600 });
    const result = runScript(commonConfig(directory));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /confirm the restore target is disposable and isolated before continuing/);
    assert.equal(result.stderr.includes('could not establish source database identity'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('backup rehearsal rejects identical source and restore service names', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-recovery-contract-'));
  try {
    const smokeSql = join(directory, 'restore-smoke.sql');
    writeFileSync(smokeSql, 'SELECT 1;\n', { mode: 0o600 });
    const result = runScript(commonConfig(directory, {
      FACTORYOS_RESTORE_PGSERVICE: 'factoryos-source',
      FACTORYOS_RESTORE_CONFIRM_EMPTY_DATABASE: 'I_HAVE_VERIFIED_EMPTY',
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /backup and restore service names must differ/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('release-gate mode requires a durable evidence receipt before opening any database connection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-release-gate-'));
  try {
    const smokeSql = join(directory, 'restore-smoke.sql');
    writeFileSync(smokeSql, 'SELECT 1;\n', { mode: 0o600 });
    const result = runScript(commonConfig(directory, {
      FACTORYOS_DR_MODE: 'RELEASE_GATE',
      FACTORYOS_RESTORE_CONFIRM_EMPTY_DATABASE: 'I_HAVE_VERIFIED_EMPTY',
      FACTORYOS_RECOVERY_EVIDENCE_JSON: join(directory, 'recovery-receipt.json'),
      FACTORYOS_RECOVERY_OPERATOR: 'CI operator',
      FACTORYOS_RECOVERY_APPROVER: 'CI approver',
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /required environment variable is missing: FACTORYOS_CANDIDATE_MIGRATION_MANIFEST/);
    assert.equal(result.stderr.includes('could not establish source database identity'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release-gate mode requires an externally reviewed erasure replay ledger before opening database connections', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-erasure-replay-'));
  try {
    const smokeSql = join(directory, 'restore-smoke.sql');
    const watermarkSql = join(directory, 'watermark.sql');
    writeFileSync(smokeSql, 'SELECT 1;\\n', { mode: 0o600 });
    writeFileSync(watermarkSql, 'SELECT 1;\\n', { mode: 0o600 });
    const result = runScript(commonConfig(directory, {
      FACTORYOS_DR_MODE: 'RELEASE_GATE',
      FACTORYOS_RESTORE_CONFIRM_EMPTY_DATABASE: 'I_HAVE_VERIFIED_EMPTY',
      FACTORYOS_RECOVERY_EVIDENCE_JSON: join(directory, 'recovery-receipt.json'),
      FACTORYOS_CANDIDATE_MIGRATION_MANIFEST: 'scripts/recovery/ci-candidate-migrations.txt',
      FACTORYOS_RECOVERY_WATERMARK_SQL: watermarkSql,
      FACTORYOS_RECOVERY_EVENT_TIME_UTC: '2026-10-20T12:00:00Z',
      FACTORYOS_RECOVERY_OPERATOR: 'CI operator',
      FACTORYOS_RECOVERY_APPROVER: 'CI approver',
      FACTORYOS_CANDIDATE_SHA: 'a'.repeat(40),
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /required environment variable is missing: FACTORYOS_RESTORE_ERASURE_REPLAY_SQL/);
    assert.equal(result.stderr.includes('could not establish source database identity'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release-gate mode refuses approved SLOs without explicit owner-approved RPO and RTO seconds', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-slo-guard-'));
  try {
    const smokeSql = join(directory, 'restore-smoke.sql');
    const migrations = join(directory, 'candidate-migrations.txt');
    const watermarkSql = join(directory, 'watermark.sql');
    writeFileSync(smokeSql, 'SELECT 1;\n', { mode: 0o600 });
    writeFileSync(migrations, 'migrations/151_growth_forecast_evaluation_calibration.sql\n', { mode: 0o600 });
    writeFileSync(watermarkSql, "SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD\\\"T\\\"HH24:MI:SS\\\"Z\\\"');\n", { mode: 0o600 });
    const result = runScript(commonConfig(directory, {
      FACTORYOS_DR_MODE: 'RELEASE_GATE',
      FACTORYOS_RESTORE_CONFIRM_EMPTY_DATABASE: 'I_HAVE_VERIFIED_EMPTY',
      FACTORYOS_RECOVERY_EVIDENCE_JSON: join(directory, 'recovery-receipt.json'),
      FACTORYOS_CANDIDATE_MIGRATION_MANIFEST: 'scripts/recovery/ci-candidate-migrations.txt',
      FACTORYOS_RECOVERY_WATERMARK_SQL: watermarkSql,
      FACTORYOS_RECOVERY_EVENT_TIME_UTC: '2026-10-20T12:00:00Z',
      FACTORYOS_RECOVERY_OPERATOR: 'CI operator',
      FACTORYOS_RECOVERY_APPROVER: 'CI approver',
      FACTORYOS_DR_TARGETS_APPROVED: 'YES',
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /approved RPO target must be integer seconds/);
    assert.equal(result.stderr.includes('could not establish source database identity'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
