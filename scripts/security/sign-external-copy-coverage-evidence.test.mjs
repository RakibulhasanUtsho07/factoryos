import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = resolve('scripts/security/sign-external-copy-coverage-evidence.mjs');
const tenantId = '28000000-0000-4000-8000-000000000001';

function canonicalClaims(body) {
  return JSON.stringify({
    schema: 'factoryos.external-copy-coverage-evidence-attestation/v1',
    attestationKeyId: body.attestation_key_id,
    attestationOwnerReference: body.attestation_owner_reference,
    tenantId,
    categoryCode: body.category_code,
    storeKind: body.store_kind,
    disposition: body.disposition,
    evidenceReference: body.evidence_reference,
    evidenceSha256: body.evidence_sha256,
    evidenceAt: new Date(body.evidence_at).toISOString(),
    dataOwnerReference: body.data_owner_reference,
    infrastructureOwnerReference: body.infrastructure_owner_reference,
    policyReference: body.policy_reference,
    reason: body.reason.trim(),
  });
}

test('external coverage signer hashes the local evidence file and emits a verifiable store-kind signature', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-external-copy-attestation-'));
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const keyPath = join(directory, 'owner-private.pem');
    const evidencePath = join(directory, 'evidence-pack.bin');
    const payloadPath = join(directory, 'payload.json');
    const evidence = Buffer.from('synthetic exhaustive external provider inventory evidence', 'utf8');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(evidencePath, evidence);
    const payload = {
      category_code: 'BUSINESS_DATA',
      store_kind: 'OBJECT_STORAGE',
      disposition: 'NOT_APPLICABLE',
      evidence_reference: 'external.inventory.object-storage.v1',
      evidence_sha256: createHash('sha256').update(evidence).digest('hex'),
      evidence_at: new Date().toISOString(),
      attestation_key_id: 'external-copy-owner-test-v1',
      attestation_owner_reference: 'owner.infrastructure.v1',
      data_owner_reference: 'owner.data.v1',
      infrastructure_owner_reference: 'owner.infrastructure.v1',
      policy_reference: 'policy.retention.v1',
      reason: 'Exhaustive provider inventory returned no matching copies',
      idempotency_key: 'external-copy-inventory-v1',
    };
    writeFileSync(payloadPath, JSON.stringify(payload));
    const result = spawnSync(process.execPath, [
      script, '--payload', payloadPath, '--evidence-file', evidencePath,
      '--private-key-file', keyPath, '--tenant-id', tenantId,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const signedBody = JSON.parse(result.stdout);
    assert.match(signedBody.attestation_signature, /^[A-Za-z0-9_-]{86}$/);
    assert.equal(verify(
      null,
      Buffer.from(canonicalClaims(signedBody), 'utf8'),
      publicKey,
      Buffer.from(signedBody.attestation_signature, 'base64url'),
    ), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('external coverage signer rejects unknown store kinds and path-like evidence references', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-external-copy-attestation-reject-'));
  try {
    const { privateKey } = generateKeyPairSync('ed25519');
    const keyPath = join(directory, 'owner-private.pem');
    const evidencePath = join(directory, 'evidence-pack.bin');
    const payloadPath = join(directory, 'payload.json');
    const evidence = Buffer.from('inventory evidence', 'utf8');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(evidencePath, evidence);
    const base = {
      category_code: 'BUSINESS_DATA', store_kind: 'NEW_UNKNOWN_STORE',
      disposition: 'UNRESOLVED', evidence_reference: 'external.inventory.v1',
      evidence_sha256: createHash('sha256').update(evidence).digest('hex'),
      evidence_at: new Date().toISOString(), attestation_key_id: 'external-copy-test-v1',
      attestation_owner_reference: 'owner.infrastructure.v1', data_owner_reference: 'owner.data.v1',
      infrastructure_owner_reference: 'owner.infrastructure.v1', policy_reference: 'policy.retention.v1',
      reason: 'Unknown store needs review', idempotency_key: 'unknown-store-v1',
    };
    writeFileSync(payloadPath, JSON.stringify(base));
    let result = spawnSync(process.execPath, [
      script, '--payload', payloadPath, '--evidence-file', evidencePath,
      '--private-key-file', keyPath, '--tenant-id', tenantId,
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /store_kind is not in the required external-store catalog/);
    writeFileSync(payloadPath, JSON.stringify({ ...base, store_kind: 'OBJECT_STORAGE', evidence_reference: '../outside' }));
    result = spawnSync(process.execPath, [
      script, '--payload', payloadPath, '--evidence-file', evidencePath,
      '--private-key-file', keyPath, '--tenant-id', tenantId,
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /single opaque artifact identifier/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('external coverage signer allows only fail-closed dispositions for an unclassified external store', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-external-copy-attestation-unclassified-'));
  try {
    const { privateKey } = generateKeyPairSync('ed25519');
    const keyPath = join(directory, 'owner-private.pem');
    const evidencePath = join(directory, 'evidence-pack.bin');
    const payloadPath = join(directory, 'payload.json');
    const evidence = Buffer.from('unclassified external source inventory', 'utf8');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(evidencePath, evidence);
    const payload = {
      category_code: 'BUSINESS_DATA', store_kind: 'UNCLASSIFIED_EXTERNAL_STORE',
      disposition: 'SUPPORTED', evidence_reference: 'external.inventory.unclassified.v1',
      evidence_sha256: createHash('sha256').update(evidence).digest('hex'),
      evidence_at: new Date().toISOString(), attestation_key_id: 'external-copy-test-v1',
      attestation_owner_reference: 'owner.infrastructure.v1', data_owner_reference: 'owner.data.v1',
      infrastructure_owner_reference: 'owner.infrastructure.v1', policy_reference: 'policy.retention.v1',
      reason: 'A newly discovered provider store has not been classified', idempotency_key: 'unclassified-supported-v1',
    };
    writeFileSync(payloadPath, JSON.stringify(payload));
    let result = spawnSync(process.execPath, [
      script, '--payload', payloadPath, '--evidence-file', evidencePath,
      '--private-key-file', keyPath, '--tenant-id', tenantId,
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot be marked SUPPORTED/);
    writeFileSync(payloadPath, JSON.stringify({ ...payload, disposition: 'UNRESOLVED' }));
    result = spawnSync(process.execPath, [
      script, '--payload', payloadPath, '--evidence-file', evidencePath,
      '--private-key-file', keyPath, '--tenant-id', tenantId,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).attestation_signature, /^[A-Za-z0-9_-]{86}$/);
    writeFileSync(payloadPath, JSON.stringify({ ...payload, disposition: 'NOT_APPLICABLE' }));
    result = spawnSync(process.execPath, [
      script, '--payload', payloadPath, '--evidence-file', evidencePath,
      '--private-key-file', keyPath, '--tenant-id', tenantId,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('external coverage signer refuses a mismatched evidence digest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-external-copy-attestation-digest-'));
  try {
    const { privateKey } = generateKeyPairSync('ed25519');
    const keyPath = join(directory, 'owner-private.pem');
    const evidencePath = join(directory, 'evidence-pack.bin');
    const payloadPath = join(directory, 'payload.json');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(evidencePath, 'actual evidence');
    writeFileSync(payloadPath, JSON.stringify({
      category_code: 'BUSINESS_DATA', store_kind: 'OBJECT_STORAGE', disposition: 'UNRESOLVED',
      evidence_reference: 'external.inventory.v1', evidence_sha256: 'a'.repeat(64),
      evidence_at: new Date().toISOString(), attestation_key_id: 'external-copy-test-v1',
      attestation_owner_reference: 'owner.infrastructure.v1', data_owner_reference: 'owner.data.v1',
      infrastructure_owner_reference: 'owner.infrastructure.v1', policy_reference: 'policy.retention.v1',
      reason: 'Inventory needs reconciliation', idempotency_key: 'digest-mismatch-v1',
    }));
    const result = spawnSync(process.execPath, [
      script, '--payload', payloadPath, '--evidence-file', evidencePath,
      '--private-key-file', keyPath, '--tenant-id', tenantId,
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Evidence pack digest does not match/);
    assert.doesNotMatch(result.stdout, /attestation_signature/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
