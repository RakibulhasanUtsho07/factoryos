#!/usr/bin/env node
import { createPrivateKey, sign } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

const SOURCE_KINDS = new Set([
  'TENANT_SCOPE_CATALOG', 'RESOURCE_TYPE_CATALOG', 'IAM_WRITER_PRINCIPALS',
  'REPLICATION_AND_DELIVERY', 'SCHEDULED_AND_DELAYED_WRITERS',
  'RESTORE_AND_DR_PATHS', 'SECONDARY_EXTERNAL_STORES',
]);
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_INPUT_BYTES = 1024 * 1024;

function usage() {
  throw new Error(
    'Usage: node scripts/security/sign-external-store-inventory-source-receipt.mjs --receipt <source-receipt.json> --private-key-file <collector-ed25519-private.pem>',
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
  if (result.size !== 2 || !result.has('--receipt') || !result.has('--private-key-file')) usage();
  return result;
}

function readRegularFile(path, label) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > MAX_INPUT_BYTES) {
    throw new Error(label + ' must be a regular, non-empty file no larger than 1 MiB');
  }
  return readFileSync(path);
}

function requiredReference(value, field) {
  if (typeof value !== 'string' || !SAFE_REFERENCE.test(value) || value.includes('://')
    || /(secret|password|credential|access[-_]?key|token)/i.test(value)) {
    throw new Error(field + ' must be a non-secret opaque reference');
  }
  return value;
}

function timestamp(value, field, now) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(field + ' must be an ISO timestamp');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > now + MAX_CLOCK_SKEW_MS || parsed < now - MAX_AGE_MS) {
    throw new Error(field + ' must be current and no more than 30 days old');
  }
  return parsed;
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

function validateReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('Source receipt must be a JSON object');
  }
  if (typeof receipt.tenant_id !== 'string' || !UUID.test(receipt.tenant_id)
    || typeof receipt.manifest_id !== 'string' || !UUID.test(receipt.manifest_id)) {
    throw new Error('tenant_id and manifest_id must be UUIDs');
  }
  if (typeof receipt.category_code !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(receipt.category_code)) {
    throw new Error('category_code is invalid');
  }
  if (typeof receipt.source_kind !== 'string' || !SOURCE_KINDS.has(receipt.source_kind)) {
    throw new Error('source_kind is not in the required discovery source catalog');
  }
  requiredReference(receipt.source_reference, 'source_reference');
  requiredReference(receipt.collection_run_reference, 'collection_run_reference');
  if (receipt.status !== 'COMPLETE' || receipt.pagination_exhausted !== true) {
    throw new Error('Only COMPLETE receipts with pagination_exhausted=true may be signed');
  }
  if (!Number.isSafeInteger(receipt.pages_fetched) || receipt.pages_fetched < 1 || receipt.pages_fetched > 100000
    || !Number.isSafeInteger(receipt.item_count) || receipt.item_count < 0) {
    throw new Error('pages_fetched and item_count are outside supported bounds');
  }
  if (!SHA256.test(receipt.result_sha256) || !SHA256.test(receipt.scope_sha256)) {
    throw new Error('result_sha256 and scope_sha256 must be lowercase SHA-256 digests');
  }
  if (!KEY_ID.test(receipt.attestation_key_id)) throw new Error('attestation_key_id is invalid');
  requiredReference(receipt.attestation_owner_reference, 'attestation_owner_reference');
  const now = Date.now();
  const startedAt = timestamp(receipt.started_at, 'started_at', now);
  const completedAt = timestamp(receipt.completed_at, 'completed_at', now);
  if (completedAt < startedAt) throw new Error('completed_at cannot precede started_at');
  if ('attestation_signature' in receipt) {
    throw new Error('Remove attestation_signature before signing a new source receipt');
  }
}

function main() {
  const args = argumentsMap(process.argv.slice(2));
  const receiptBytes = readRegularFile(args.get('--receipt'), '--receipt');
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString('utf8'));
  } catch {
    throw new Error('--receipt must contain valid JSON');
  }
  validateReceipt(receipt);
  const privateKey = createPrivateKey(readRegularFile(args.get('--private-key-file'), '--private-key-file').toString('utf8'));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Source receipt signing key must be Ed25519');
  }
  const signature = sign(null, Buffer.from(canonicalClaims(receipt), 'utf8'), privateKey).toString('base64url');
  process.stdout.write(JSON.stringify({ ...receipt, attestation_signature: signature }, null, 2) + '\n');
}

try {
  main();
} catch (error) {
  process.stderr.write('external inventory source receipt refused: '
    + (error instanceof Error ? error.message : 'unknown error') + '\n');
  process.exitCode = 1;
}
