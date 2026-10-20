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
    assert.match(result.stderr, /set FACTORYOS_RESTORE_CONFIRM_EMPTY_DATABASE=I_HAVE_VERIFIED_EMPTY/);
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
