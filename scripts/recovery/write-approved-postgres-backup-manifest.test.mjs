import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./write-approved-postgres-backup-manifest.mjs', import.meta.url));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-backup-manifest-'));
  const artifact = join(directory, 'approved-source.dump.gpg');
  const manifest = join(directory, 'approved-source.manifest.json');
  const bytes = Buffer.from('encrypted approved PostgreSQL archive fixture');
  writeFileSync(artifact, bytes, { mode: 0o600 });
  chmodSync(artifact, 0o600);
  return { directory, artifact, manifest, bytes };
}

function run(value, overrides = {}) {
  const args = [
    helper,
    '--artifact', overrides.artifact ?? value.artifact,
    '--output', overrides.output ?? value.manifest,
    '--source-database-identity', overrides.sourceIdentity ?? 'factoryos_source|10.0.0.10|5432',
    '--backup-created-at-utc', overrides.createdAt ?? '2026-10-20T09:55:00Z',
    '--backup-duration-seconds', overrides.duration ?? '42',
    '--pg-dump-version', overrides.pgDumpVersion ?? 'pg_dump (PostgreSQL) 16.10',
    '--source-server-version', overrides.serverVersion ?? '16.10',
    '--recipient-fingerprint', overrides.recipient ?? 'B'.repeat(40),
  ];
  return spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10_000 });
}

test('approved backup manifest builder records an exact create-only artifact digest and provenance', () => {
  const value = fixture();
  try {
    const result = run(value);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(value.manifest, 'utf8'));
    assert.equal(manifest.schema, 'factoryos.approved-postgresql-backup/v1');
    assert.equal(manifest.artifactFileName, 'approved-source.dump.gpg');
    assert.equal(manifest.artifactSizeBytes, value.bytes.length);
    assert.equal(manifest.artifactSha256, createHash('sha256').update(value.bytes).digest('hex'));
    assert.equal(manifest.sourceDatabaseIdentity, 'factoryos_source|10.0.0.10|5432');
    assert.equal(manifest.backupCreatedAtUtc, '2026-10-20T09:55:00Z');
    assert.equal(manifest.backupDurationSeconds, 42);
    assert.equal(manifest.backupTool, 'pg_dump');
    assert.equal(manifest.pgDumpVersion, 'pg_dump (PostgreSQL) 16.10');
    assert.equal(manifest.sourceServerVersion, '16.10');
    assert.equal(manifest.encryption, 'GPG');
    assert.equal(manifest.recipientFingerprint, 'B'.repeat(40));
    assert.equal(statSync(value.manifest).mode & 0o777, 0o600);
    const second = run(value);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already exists/);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test('approved backup manifest builder rejects invalid calendar timestamps and negative durations', () => {
  const value = fixture();
  try {
    const invalidDate = run(value, { createdAt: '2026-02-30T09:55:00Z' });
    assert.notEqual(invalidDate.status, 0);
    assert.match(invalidDate.stderr, /real UTC RFC3339 timestamp/);
    const negativeDuration = run(value, { duration: '-1' });
    assert.notEqual(negativeDuration.status, 0);
    assert.match(negativeDuration.stderr, /non-negative safe integer/);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test('approved backup manifest builder rejects an invalid recipient fingerprint and writable artifact', () => {
  const value = fixture();
  try {
    const invalidRecipient = run(value, { recipient: 'not-a-key' });
    assert.notEqual(invalidRecipient.status, 0);
    assert.match(invalidRecipient.stderr, /full 40- or 64-character GPG encryption key fingerprint/);
    chmodSync(value.artifact, 0o666);
    const writableArtifact = run(value);
    assert.notEqual(writableArtifact.status, 0);
    assert.match(writableArtifact.stderr, /not be group\/world writable/);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});
