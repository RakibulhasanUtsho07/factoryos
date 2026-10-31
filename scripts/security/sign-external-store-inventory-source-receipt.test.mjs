import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = resolve('scripts/security/sign-external-store-inventory-source-receipt.mjs');

function fixture(overrides = {}) {
  const now = new Date().toISOString();
  const tenantId = '28000000-0000-4000-8000-000000000001';
  const manifestId = '28000000-0000-4000-8000-000000000002';
  return {
    tenant_id: tenantId,
    category_code: 'BUSINESS_DATA',
    manifest_id: manifestId,
    source_kind: 'IAM_WRITER_PRINCIPALS',
    source_reference: 'cloudtrail.iam-inventory',
    collection_run_reference: 'collector-run.iam.2026-10-31.001',
    status: 'COMPLETE',
    pagination_exhausted: true,
    pages_fetched: 4,
    item_count: 23,
    result_sha256: createHash('sha256').update('provider-native query result').digest('hex'),
    scope_sha256: createHash('sha256').update('canonical inventory scope').digest('hex'),
    started_at: now,
    completed_at: now,
    attestation_key_id: 'collector.iam-v1',
    attestation_owner_reference: 'owner.collector.iam.v1',
    ...overrides,
  };
}

function canonicalClaims(receipt) {
  return JSON.stringify({
    schema: 'factoryos.external-store-inventory-source-receipt/v1',
    attestationKeyId: receipt.attestation_key_id,
    attestationOwnerReference: receipt.attestation_owner_reference,
    tenantId: receipt.tenant_id.toLowerCase(),
    categoryCode: receipt.category_code,
    manifestId: receipt.manifest_id.toLowerCase(),
    sourceKind: receipt.source_kind,
    sourceReference: receipt.source_reference,
    collectionRunReference: receipt.collection_run_reference,
    status: receipt.status,
    paginationExhausted: receipt.pagination_exhausted,
    pagesFetched: receipt.pages_fetched,
    itemCount: receipt.item_count,
    resultSha256: receipt.result_sha256,
    scopeSha256: receipt.scope_sha256,
    startedAt: receipt.started_at,
    completedAt: receipt.completed_at,
  });
}

function invoke(directory, receipt, privateKeyPem) {
  const receiptPath = join(directory, 'receipt.json');
  const keyPath = join(directory, 'collector-private.pem');
  writeFileSync(receiptPath, JSON.stringify(receipt));
  writeFileSync(keyPath, privateKeyPem);
  return spawnSync(process.execPath, [
    script, '--receipt', receiptPath, '--private-key-file', keyPath,
  ], { encoding: 'utf8' });
}

test('source receipt signer emits a valid Ed25519 signature over the manifest, source and collection claims', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-source-receipt-sign-'));
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const receipt = fixture();
    const result = invoke(directory, receipt, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    assert.equal(result.status, 0, result.stderr);
    const signed = JSON.parse(result.stdout);
    assert.match(signed.attestation_signature, /^[A-Za-z0-9_-]{86}$/);
    assert.equal(verify(
      null,
      Buffer.from(canonicalClaims(signed), 'utf8'),
      publicKey,
      Buffer.from(signed.attestation_signature, 'base64url'),
    ), true);
    assert.equal(signed.collection_run_reference, receipt.collection_run_reference);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('source receipt signer rejects incomplete pagination, stale timestamps and unknown sources', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-source-receipt-reject-'));
  try {
    const { privateKey } = generateKeyPairSync('ed25519');
    const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    for (const [invalid, pattern] of [
      [{ pagination_exhausted: false }, /COMPLETE receipts with pagination_exhausted=true/],
      [{ source_kind: 'UNKNOWN_SOURCE' }, /required discovery source catalog/],
      [{ started_at: new Date(Date.now() - 31 * 86400000).toISOString() }, /no more than 30 days old/],
      [{ completed_at: new Date(Date.now() - 60_000).toISOString() }, /cannot precede started_at/],
      [{ item_count: -1 }, /outside supported bounds/],
    ]) {
      const result = invoke(directory, fixture(invalid), key);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, pattern);
      assert.doesNotMatch(result.stdout, /attestation_signature/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('source receipt signer rejects unsupported keys and already-signed input', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-source-receipt-key-'));
  try {
    const { privateKey: rsaKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsa = invoke(directory, fixture(), rsaKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    assert.notEqual(rsa.status, 0);
    assert.match(rsa.stderr, /must be Ed25519/);

    const { privateKey } = generateKeyPairSync('ed25519');
    const alreadySigned = invoke(directory, { ...fixture(), attestation_signature: 'a'.repeat(86) },
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    assert.notEqual(alreadySigned.status, 0);
    assert.match(alreadySigned.stderr, /Remove attestation_signature/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('source receipt signer refuses symlinked receipt files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-source-receipt-symlink-'));
  try {
    const { privateKey } = generateKeyPairSync('ed25519');
    const keyPath = join(directory, 'collector-private.pem');
    const actualPath = join(directory, 'actual-receipt.json');
    const linkedPath = join(directory, 'receipt-link.json');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(actualPath, JSON.stringify(fixture()));
    symlinkSync(actualPath, linkedPath);
    const result = spawnSync(process.execPath, [
      script, '--receipt', linkedPath, '--private-key-file', keyPath,
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /regular, non-empty file/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
