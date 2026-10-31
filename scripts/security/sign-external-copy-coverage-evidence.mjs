#!/usr/bin/env node
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

const STORE_KINDS = new Set([
  'OBJECT_STORAGE', 'CACHE', 'SEARCH_INDEX', 'VECTOR_STORE',
  'LEARNING_ARTIFACT', 'EXTERNAL_PROVIDER', 'REPLICA', 'BACKUP', 'UNCLASSIFIED_EXTERNAL_STORE',
]);
const INVENTORY_SOURCE_KINDS = [
  'TENANT_SCOPE_CATALOG', 'RESOURCE_TYPE_CATALOG', 'IAM_WRITER_PRINCIPALS',
  'REPLICATION_AND_DELIVERY', 'SCHEDULED_AND_DELAYED_WRITERS',
  'RESTORE_AND_DR_PATHS', 'SECONDARY_EXTERNAL_STORES',
];
const INVENTORY_STORE_KINDS = new Set([
  'OBJECT_STORAGE', 'CACHE', 'SEARCH_INDEX', 'VECTOR_STORE',
  'LEARNING_ARTIFACT', 'EXTERNAL_PROVIDER', 'REPLICA', 'BACKUP',
]);
const SAFE_INVENTORY_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function validateExternalInventoryManifest(bytes, body, tenantId) {
  if (body.store_kind !== 'UNCLASSIFIED_EXTERNAL_STORE' || body.disposition !== 'NOT_APPLICABLE') return;
  const fail = (reason) => {
    throw new Error('UNCLASSIFIED_EXTERNAL_STORE NOT_APPLICABLE requires a complete, current, scope-bound external inventory manifest: ' + reason);
  };
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { fail('evidence is not valid JSON'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.schema !== 'factoryos.external-store-inventory/v2'
    || typeof manifest.tenant_id !== 'string' || manifest.tenant_id.toLowerCase() !== tenantId.toLowerCase()
    || manifest.category_code !== body.category_code) fail('schema, tenant or category mismatch');
  const now = Date.now();
  const validTime = (value) => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed <= now + 5 * 60 * 1000
      && parsed >= now - 30 * 24 * 60 * 60 * 1000 ? parsed : null;
  };
  if (validTime(manifest.generated_at) === null) fail('generated_at is stale or invalid');
  if (manifest.inventory_complete !== true || manifest.unclassified_store_count !== 0) fail('inventory is incomplete or contains an unclassified store');
  if (!Array.isArray(manifest.discovered_store_kinds)
    || manifest.discovered_store_kinds.some((kind) => typeof kind !== 'string' || !INVENTORY_STORE_KINDS.has(kind))
    || new Set(manifest.discovered_store_kinds).size !== manifest.discovered_store_kinds.length) fail('discovered store kinds are not a unique known catalog');
  const scope = manifest.scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) fail('scope must be an object');
  const normalizedScope = {};
  for (const field of ['provider_references', 'account_references', 'project_references', 'region_references']) {
    if (!Array.isArray(scope[field])) fail('scope.' + field + ' must be an array');
    const values = scope[field];
    if (values.some((value) => typeof value !== 'string' || !SAFE_INVENTORY_REFERENCE.test(value)
      || value.includes('://') || /(secret|password|credential|access[-_]?key|token)/i.test(value))
      || new Set(values).size !== values.length) fail('scope.' + field + ' contains an invalid or duplicate reference');
    normalizedScope[field] = [...values].sort();
  }
  if (normalizedScope.provider_references.length + normalizedScope.account_references.length
    + normalizedScope.project_references.length === 0) fail('scope does not identify a provider, account or project');
  const scopeDigest = createHash('sha256').update(JSON.stringify(normalizedScope), 'utf8').digest('hex');
  if (manifest.scope_sha256 !== scopeDigest) fail('canonical scope digest does not match');
  if (!Array.isArray(manifest.sources) || manifest.sources.length !== INVENTORY_SOURCE_KINDS.length) {
    fail('required discovery source set is incomplete');
  }
  const seen = new Set();
  for (const source of manifest.sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)
      || !INVENTORY_SOURCE_KINDS.includes(source.source_kind) || seen.has(source.source_kind)) {
      fail('discovery source is missing, duplicated or unsupported');
    }
    seen.add(source.source_kind);
    if (typeof source.source_reference !== 'string' || !SAFE_INVENTORY_REFERENCE.test(source.source_reference)
      || source.source_reference.includes('://') || /(secret|password|credential|access[-_]?key|token)/i.test(source.source_reference)
      || source.status !== 'COMPLETE' || source.pagination_exhausted !== true
      || !Number.isSafeInteger(source.pages_fetched) || source.pages_fetched < 1 || source.pages_fetched > 100000
      || !Number.isSafeInteger(source.item_count) || source.item_count < 0
      || typeof source.result_sha256 !== 'string' || !SHA256.test(source.result_sha256)
      || source.scope_sha256 !== scopeDigest) fail('discovery source is incomplete or not bound to the declared scope');
    const startedAt = validTime(source.started_at);
    const completedAt = validTime(source.completed_at);
    if (startedAt === null || completedAt === null || completedAt < startedAt) {
      fail('discovery source timestamps are invalid or incomplete');
    }
  }
  if (INVENTORY_SOURCE_KINDS.some((kind) => !seen.has(kind))) fail('required discovery source is missing');
}

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
  if (storeKind === 'UNCLASSIFIED_EXTERNAL_STORE' && disposition === 'SUPPORTED') {
    throw new Error('UNCLASSIFIED_EXTERNAL_STORE cannot be marked SUPPORTED; classify the discovered store and register its dedicated provider adapter');
  }

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
  const evidenceBytes = readFileSync(evidencePath);
  const evidenceDigest = createHash('sha256').update(evidenceBytes).digest('hex');
  if (evidenceDigest !== body.evidence_sha256) {
    throw new Error('Evidence pack digest does not match payload evidence_sha256; no signature was created');
  }

  validateExternalInventoryManifest(evidenceBytes, body, args.get('--tenant-id'));
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
