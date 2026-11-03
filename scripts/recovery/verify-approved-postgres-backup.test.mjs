import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./verify-approved-postgres-backup.mjs', import.meta.url));
const signer = 'A'.repeat(40);
const sourceIdentity = 'factoryos_source|10.0.0.1|5432';
const incidentCutoff = '2026-10-20T10:00:25Z';

function fixture(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-approved-backup-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin, { mode: 0o700 });
  const gpg = join(bin, 'gpg');
  writeFileSync(gpg, [
    '#!/bin/sh',
    'if [ "$FAKE_GPG_FAILURE" = "1" ]; then echo "bad signature" >&2; exit 1; fi',
    'printf "[GNUPG:] VALIDSIG %s 20261103 1793683200 0 4 0 1 8 00 %s\\n" "$FAKE_GPG_SIGNER" "$FAKE_GPG_PRIMARY"',
    'exit 0',
    '',
  ].join('\\n'), { mode: 0o700 });
  chmodSync(gpg, 0o700);

  const artifact = join(directory, 'approved.dump.gpg');
  const manifest = join(directory, 'approved.manifest.json');
  const signature = join(directory, 'approved.manifest.sig');
  const output = join(directory, 'verified.json');
  const artifactBytes = Buffer.from('GPG-encrypted PostgreSQL custom archive fixture');
  writeFileSync(artifact, artifactBytes, { mode: 0o600 });
  const body = {
    schema: 'factoryos.approved-postgresql-backup/v1',
    artifactFileName: 'approved.dump.gpg',
    artifactSha256: createHash('sha256').update(artifactBytes).digest('hex'),
    sourceDatabaseIdentity: sourceIdentity,
    backupCreatedAtUtc: '2026-10-20T09:58:00Z',
    backupTool: 'pg_dump',
    pgDumpVersion: 'pg_dump (PostgreSQL) 16.10',
    sourceServerVersion: '16.10',
    encryption: 'GPG',
    recipientFingerprint: 'B'.repeat(40),
    ...overrides.manifest,
  };
  writeFileSync(manifest, JSON.stringify(body, null, 2) + '\\n', { mode: 0o600 });
  writeFileSync(signature, 'detached-signature-fixture', { mode: 0o600 });

  const expectedSigner = overrides.expectedSigner ?? signer;
  const result = {
    directory, bin, artifact, manifest, signature, output, body,
    expectedSigner,
    env: {
      PATH: [bin, process.env.PATH ?? '/usr/bin:/bin'].join(delimiter),
      FAKE_GPG_SIGNER: overrides.fakeSigner ?? signer,
      FAKE_GPG_PRIMARY: overrides.fakePrimary ?? signer,
      FAKE_GPG_FAILURE: overrides.gpgFailure ?? '0',
    },
  };
  return result;
}

function execute(fixtureData, overrides = {}) {
  return spawnSync(process.execPath, [helper,
    '--artifact', fixtureData.artifact,
    '--manifest', fixtureData.manifest,
    '--signature', fixtureData.signature,
    '--signer-fingerprint', fixtureData.expectedSigner,
    '--source-database-identity', overrides.sourceIdentity ?? sourceIdentity,
    '--incident-cutoff-utc', overrides.incidentCutoff ?? incidentCutoff,
    '--output', fixtureData.output,
  ], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...fixtureData.env, ...overrides.env },
  });
}

test('approved backup verification accepts only signed artifact metadata matching the source, digest and incident time', () => {
  const value = fixture();
  try {
    const result = execute(value);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(value.output, 'utf8'));
    assert.equal(receipt.schema, 'factoryos.approved-postgresql-backup-verification/v1');
    assert.equal(receipt.artifactSha256, value.body.artifactSha256);
    assert.equal(receipt.manifestSha256.length, 64);
    assert.equal(receipt.signatureSha256.length, 64);
    assert.equal(receipt.signerFingerprint, signer);
    assert.equal(receipt.sourceDatabaseIdentity, sourceIdentity);
    assert.equal(receipt.backupCreatedAtUtc, value.body.backupCreatedAtUtc);
    assert.equal(receipt.signatureStatus, 'VALID_PINNED_SIGNER');
    const mode = (await import('node:fs')).statSync(value.output).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test('approved backup verification rejects a signer that is not the pinned backup-controller fingerprint', () => {
  const value = fixture({ fakeSigner: 'C'.repeat(40), fakePrimary: 'C'.repeat(40) });
  try {
    const result = execute(value);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pinned independent backup-controller fingerprint/);
    assert.equal(result.stderr.includes('password'), false);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test('approved backup verification rejects a changed artifact digest', () => {
  const value = fixture();
  try {
    writeFileSync(value.artifact, 'tampered encrypted archive', { mode: 0o600 });
    const result = execute(value);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA-256 does not match its signed manifest/);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test('approved backup verification rejects a source database identity mismatch', () => {
  const value = fixture();
  try {
    const result = execute(value, { sourceIdentity: 'different_source|10.0.0.8|5432' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match the connected source/);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test('approved backup verification rejects a snapshot created after the incident cutoff', () => {
  const value = fixture({ manifest: { backupCreatedAtUtc: '2026-10-20T10:00:26Z' } });
  try {
    const result = execute(value);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /created after the incident cutoff/);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test('approved backup verification rejects an invalid detached signature', () => {
  const value = fixture({ gpgFailure: '1' });
  try {
    const result = execute(value);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /detached OpenPGP signature verification failed/);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});
