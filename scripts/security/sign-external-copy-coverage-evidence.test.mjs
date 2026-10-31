import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = resolve('scripts/security/sign-external-copy-coverage-evidence.mjs');
const tenantId = '28000000-0000-4000-8000-000000000001';
const inventorySourceKinds = [
  'TENANT_SCOPE_CATALOG', 'RESOURCE_TYPE_CATALOG', 'IAM_WRITER_PRINCIPALS',
  'REPLICATION_AND_DELIVERY', 'SCHEDULED_AND_DELAYED_WRITERS',
  'RESTORE_AND_DR_PATHS', 'SECONDARY_EXTERNAL_STORES',
];

function sourceReceiptClaims(receipt, context) {
  return JSON.stringify({
    schema: 'factoryos.external-store-inventory-source-receipt/v1',
    attestationKeyId: receipt.attestation_key_id,
    attestationOwnerReference: receipt.attestation_owner_reference,
    tenantId: context.tenantId.toLowerCase(),
    categoryCode: context.categoryCode,
    manifestId: context.manifestId.toLowerCase(),
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

function completeInventoryEvidence(categoryCode = 'BUSINESS_DATA') {
  const now = new Date().toISOString();
  const manifestId = '28000000-0000-4000-8000-000000000099';
  const scope = {
    provider_references: ['provider.aws-account-001'],
    account_references: ['account.001'],
    project_references: ['project.factoryos'],
    region_references: ['region.ap-southeast-1'],
  };
  const scopeSha256 = createHash('sha256').update(JSON.stringify(scope), 'utf8').digest('hex');
  const trustedKeys = [];
  const sources = inventorySourceKinds.map((sourceKind) => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const keyId = 'collector.' + sourceKind.toLowerCase();
    const ownerReference = 'owner.collector.' + sourceKind.toLowerCase();
    trustedKeys.push({
      keyId,
      ownerReference,
      sourceKinds: [sourceKind],
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    const receipt = {
      source_kind: sourceKind,
      source_reference: 'discovery.' + sourceKind.toLowerCase(),
      collection_run_reference: 'collector-run.' + sourceKind.toLowerCase(),
      status: 'COMPLETE',
      pagination_exhausted: true,
      pages_fetched: 1,
      item_count: 0,
      result_sha256: createHash('sha256').update(sourceKind).digest('hex'),
      scope_sha256: scopeSha256,
      started_at: now,
      completed_at: now,
      attestation_key_id: keyId,
      attestation_owner_reference: ownerReference,
    };
    receipt.attestation_signature = sign(
      null,
      Buffer.from(sourceReceiptClaims(receipt, { tenantId, categoryCode, manifestId }), 'utf8'),
      privateKey,
    ).toString('base64url');
    return receipt;
  });
  return {
    bytes: Buffer.from(JSON.stringify({
      schema: 'factoryos.external-store-inventory/v2',
      manifest_id: manifestId,
      tenant_id: tenantId,
      category_code: categoryCode,
      generated_at: now,
      scope,
      scope_sha256: scopeSha256,
      inventory_complete: true,
      unclassified_store_count: 0,
      discovered_store_kinds: ['OBJECT_STORAGE', 'CACHE', 'BACKUP'],
      sources,
    }), 'utf8'),
    trustJson: JSON.stringify(trustedKeys),
  };
}

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
  const priorSourceTrust = process.env.FACTORYOS_EXTERNAL_INVENTORY_SOURCE_TRUSTED_KEYS_JSON;
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
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /complete, current, scope-bound external inventory manifest/);

    const completeEvidence = completeInventoryEvidence();
    process.env.FACTORYOS_EXTERNAL_INVENTORY_SOURCE_TRUSTED_KEYS_JSON = completeEvidence.trustJson;
    const invalidSourceManifest = JSON.parse(completeEvidence.bytes.toString('utf8'));
    invalidSourceManifest.sources[0].item_count = 7;
    const tamperedBytes = Buffer.from(JSON.stringify(invalidSourceManifest), 'utf8');
    writeFileSync(evidencePath, tamperedBytes);
    const acceptedPayload = {
      ...payload,
      disposition: 'NOT_APPLICABLE',
      evidence_sha256: createHash('sha256').update(tamperedBytes).digest('hex'),
    };
    writeFileSync(payloadPath, JSON.stringify(acceptedPayload));
    result = spawnSync(process.execPath, [
      script, '--payload', payloadPath, '--evidence-file', evidencePath,
      '--private-key-file', keyPath, '--tenant-id', tenantId,
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source receipt signature does not match its claims/);

    writeFileSync(evidencePath, completeEvidence.bytes);
    acceptedPayload.evidence_sha256 = createHash('sha256').update(completeEvidence.bytes).digest('hex');
    writeFileSync(payloadPath, JSON.stringify(acceptedPayload));
    delete process.env.FACTORYOS_EXTERNAL_INVENTORY_SOURCE_TRUSTED_KEYS_JSON;
    result = spawnSync(process.execPath, [
      script, '--payload', payloadPath, '--evidence-file', evidencePath,
      '--private-key-file', keyPath, '--tenant-id', tenantId,
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /independent source receipt trust is not configured/);

    process.env.FACTORYOS_EXTERNAL_INVENTORY_SOURCE_TRUSTED_KEYS_JSON = completeEvidence.trustJson;
    result = spawnSync(process.execPath, [
      script, '--payload', payloadPath, '--evidence-file', evidencePath,
      '--private-key-file', keyPath, '--tenant-id', tenantId,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).attestation_signature, /^[A-Za-z0-9_-]{86}$/);
  } finally {
    if (priorSourceTrust === undefined) delete process.env.FACTORYOS_EXTERNAL_INVENTORY_SOURCE_TRUSTED_KEYS_JSON;
    else process.env.FACTORYOS_EXTERNAL_INVENTORY_SOURCE_TRUSTED_KEYS_JSON = priorSourceTrust;
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
