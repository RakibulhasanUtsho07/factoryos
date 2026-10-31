#!/usr/bin/env node
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

const STORE_KINDS = new Set([
  'OBJECT_STORAGE', 'CACHE', 'SEARCH_INDEX', 'VECTOR_STORE',
  'LEARNING_ARTIFACT', 'EXTERNAL_PROVIDER', 'REPLICA', 'BACKUP',
]);

function usage() {
  throw new Error(
    'Usage: node scripts/security/sign-external-copy-coverage-evidence.mjs --payload <api-body.json> --evidence-file <evidence-pack> --private-key-file <ed25519-private.pem> --tenant-id <tenant-uuid>',
  );
}

function argumentsMap(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value || result.has(name)) usage();
    result.set(name, value);
  }
  for (const name of ['--payload', '--evidence-file', '--private-key-file', '--tenant-id']) {
    if (!result.has(name)) usage();
  }
  if (result.size !== 4) usage();
  return result;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error(`Payload field ${name} must be a non-empty, unpadded string`);
  }
  return value;
}

function canonicalClaims(body, tenantId) {
  const keyId = requiredString(body.attestation_key_id, 'attestation_key_id');
  const ownerReference = requiredString(body.attestation_owner_reference, 'attestation_owner_reference');
  const dataOwnerReference = requiredString(body.data_owner_reference, 'data_owner_reference');
  const infrastructureOwnerReference = requiredString(body.infrastructure_owner_reference, 'infrastructure_owner_reference');
  if (ownerReference !== dataOwnerReference && ownerReference !== infrastructureOwnerReference) {
    throw new Error('attestation_owner_reference must equal the declared data or infrastructure owner');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(keyId)) throw new Error('Invalid attestation_key_id');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw new Error('--tenant-id must be a UUID');
  }
  if (!/^[a-f0-9]{64}$/.test(requiredString(body.evidence_sha256, 'evidence_sha256'))) {
    throw new Error('evidence_sha256 must be a lowercase SHA-256 digest');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(requiredString(body.evidence_reference, 'evidence_reference'))) {
    throw new Error('evidence_reference must be a single opaque artifact identifier, not a URL or path');
  }
  const evidenceDate = new Date(requiredString(body.evidence_at, 'evidence_at'));
  if (!Number.isFinite(evidenceDate.getTime())) throw new Error('evidence_at must be a valid timestamp');
  const age = Date.now() - evidenceDate.getTime();
  if (age < -5 * 60 * 1000 || age > 30 * 24 * 60 * 60 * 1000) {
    throw new Error('evidence_at must be current and no more than 30 days old');
  }
  const storeKind = requiredString(body.store_kind, 'store_kind');
  if (!STORE_KINDS.has(storeKind)) throw new Error('store_kind is not in the required external-store catalog');
  const disposition = requiredString(body.disposition, 'disposition');
  if (!['SUPPORTED', 'NOT_APPLICABLE', 'UNRESOLVED'].includes(disposition)) throw new Error('Invalid disposition');

  return {
    schema: 'factoryos.external-copy-coverage-evidence-attestation/v1',
    attestationKeyId: keyId,
    attestationOwnerReference: ownerReference,
    tenantId: tenantId.toLowerCase(),
    categoryCode: requiredString(body.category_code, 'category_code'),
    storeKind,
    disposition,
    evidenceReference: body.evidence_reference,
    evidenceSha256: body.evidence_sha256,
    evidenceAt: evidenceDate.toISOString(),
    dataOwnerReference,
    infrastructureOwnerReference,
    policyReference: requiredString(body.policy_reference, 'policy_reference'),
    reason: requiredString(body.reason, 'reason').trim(),
  };
}

function main() {
  const args = argumentsMap(process.argv.slice(2));
  const body = JSON.parse(readFileSync(args.get('--payload'), 'utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Payload must be a JSON object');
  if ('attestation_signature' in body) throw new Error('Remove attestation_signature before signing a new evidence claim');

  const evidencePath = args.get('--evidence-file');
  if (!lstatSync(evidencePath).isFile()) throw new Error('--evidence-file must be a regular file, not a symlink');
  const evidenceDigest = createHash('sha256').update(readFileSync(evidencePath)).digest('hex');
  if (evidenceDigest !== body.evidence_sha256) {
    throw new Error('Evidence pack digest does not match payload evidence_sha256; no signature was created');
  }

  const privateKey = createPrivateKey(readFileSync(args.get('--private-key-file'), 'utf8'));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Evidence signing key must be Ed25519');
  const claims = canonicalClaims(body, args.get('--tenant-id'));
  const signature = sign(null, Buffer.from(JSON.stringify(claims), 'utf8'), privateKey).toString('base64url');
  process.stdout.write(JSON.stringify({ ...body, attestation_signature: signature }, null, 2) + '\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(`external-copy-coverage attestation refused: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
}
