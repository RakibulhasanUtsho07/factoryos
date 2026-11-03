import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = resolve('scripts/security/sign-backup-copy-class-evidence.mjs');
const tenantId = '28000000-0000-4000-8000-000000000001';

function canonicalClaims(body) {
  return JSON.stringify({
    schema: 'factoryos.backup-copy-class-evidence-attestation/v1',
    attestationKeyId: body.attestation_key_id,
    attestationOwnerReference: body.attestation_owner_reference,
    tenantId,
    categoryCode: body.category_code,
    copyClassCode: body.copy_class_code,
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

test('signer checks the evidence-pack digest and emits a verifiable Ed25519 API signature', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-backup-copy-attestation-'));
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const keyPath = join(directory, 'owner-private.pem');
    const evidencePath = join(directory, 'evidence-pack.bin');
    const payloadPath = join(directory, 'payload.json');
    const evidence = Buffer.from('synthetic provider inventory and retention-policy evidence', 'utf8');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(evidencePath, evidence);
    const payload = {
      category_code: 'BUSINESS_DATA',
      copy_class_code: 'POSTGRESQL_WAL_PITR',
      disposition: 'UNRESOLVED',
      evidence_reference: 'backup.inventory.wal.v1',
      evidence_sha256: createHash('sha256').update(evidence).digest('hex'),
      evidence_at: new Date().toISOString(),
      attestation_key_id: 'copy-owner-ed25519-test-v1',
      attestation_owner_reference: 'owner.infrastructure.v1',
      data_owner_reference: 'owner.data.v1',
      infrastructure_owner_reference: 'owner.infrastructure.v1',
      policy_reference: 'policy.retention.v1',
      reason: 'WAL archive class needs investigation',
      idempotency_key: 'wal-pitr-attested-v1',
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

test('signer refuses URL and path references so the API cannot perform remote fetches', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-backup-copy-attestation-reference-'));
  try {
    const { privateKey } = generateKeyPairSync('ed25519');
    const keyPath = join(directory, 'owner-private.pem');
    const evidencePath = join(directory, 'evidence-pack.bin');
    const payloadPath = join(directory, 'payload.json');
    const evidence = Buffer.from('opaque evidence artifact', 'utf8');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(evidencePath, evidence);
    writeFileSync(payloadPath, JSON.stringify({
      category_code: 'BUSINESS_DATA', copy_class_code: 'POSTGRESQL_WAL_PITR', disposition: 'UNRESOLVED',
      evidence_reference: '../outside', evidence_sha256: createHash('sha256').update(evidence).digest('hex'),
      evidence_at: new Date().toISOString(), attestation_key_id: 'copy-owner-test-v1',
      attestation_owner_reference: 'owner.infrastructure.v1', data_owner_reference: 'owner.data.v1',
      infrastructure_owner_reference: 'owner.infrastructure.v1', policy_reference: 'policy.retention.v1',
      reason: 'WAL archive class needs investigation', idempotency_key: 'wal-pitr-path-reference-v1',
    }));
    const result = spawnSync(process.execPath, [
      script, '--payload', payloadPath, '--evidence-file', evidencePath,
      '--private-key-file', keyPath, '--tenant-id', tenantId,
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /single opaque artifact identifier/);
    assert.doesNotMatch(result.stdout, /attestation_signature/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('signer refuses to sign when evidence bytes do not match the claimed digest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-backup-copy-attestation-mismatch-'));
  try {
    const { privateKey } = generateKeyPairSync('ed25519');
    const keyPath = join(directory, 'owner-private.pem');
    const evidencePath = join(directory, 'evidence-pack.bin');
    const payloadPath = join(directory, 'payload.json');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(evidencePath, 'actual evidence');
    writeFileSync(payloadPath, JSON.stringify({
      category_code: 'BUSINESS_DATA', copy_class_code: 'POSTGRESQL_WAL_PITR', disposition: 'UNRESOLVED',
      evidence_reference: 'backup.inventory.wal.v1', evidence_sha256: 'a'.repeat(64),
      evidence_at: new Date().toISOString(), attestation_key_id: 'copy-owner-test-v1',
      attestation_owner_reference: 'owner.infrastructure.v1', data_owner_reference: 'owner.data.v1',
      infrastructure_owner_reference: 'owner.infrastructure.v1', policy_reference: 'policy.retention.v1',
      reason: 'WAL archive class needs investigation', idempotency_key: 'wal-pitr-mismatch-v1',
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
