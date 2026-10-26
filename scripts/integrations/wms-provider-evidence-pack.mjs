#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_EVIDENCE_FILE_BYTES = 25 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const RELEASE_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REQUIRED_EVIDENCE_KINDS = [
  'carrier-callback',
  'carrier-retry-replay',
  'carrier-conflicting-replay',
  'storage-independent-readback',
  'storage-effective-iam',
  'storage-credential-rotation',
  'owner-signoffs',
];
const REQUIRED_REVIEW_ITEMS = [
  'bucket_policy',
  'permissions_boundary',
  'organization_policy',
  'session_policy',
  'kms_policy',
];
const REQUIRED_APPROVAL_ROLES = [
  'carrier_integration_owner',
  'storage_security_owner',
  'wms_process_owner',
];
const FORBIDDEN_FIELD = /(authorization|access[_-]?key(_id)?|secret(_value)?|token(_value)?|password|private[_-]?key|raw[_-]?signature|signature[_-]?value|credential[_-]?value)/i;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value, max = 500) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isSha256(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function isTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function scanForbiddenFields(value, addIssue, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForbiddenFields(entry, addIssue, path + '[' + index + ']'));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = path + '.' + key;
    if (FORBIDDEN_FIELD.test(key)) addIssue('FORBIDDEN_SECRET_FIELD_NAME', nextPath);
    scanForbiddenFields(entry, addIssue, nextPath);
  }
}

function requireString(value, path, addIssue, max = 500) {
  if (!isNonEmptyString(value, max)) addIssue('INVALID_REQUIRED_STRING', path);
}

function requireTimestamp(value, path, addIssue) {
  if (!isTimestamp(value)) addIssue('INVALID_TIMESTAMP', path);
}

function requireHash(value, path, addIssue) {
  if (!isSha256(value)) addIssue('INVALID_SHA256', path);
}

function validateManifestShape(manifest, expectedReleaseSha, addIssue) {
  if (!isRecord(manifest)) {
    addIssue('INVALID_MANIFEST', '$');
    return null;
  }
  if (manifest.schema !== 'factoryos.wms.external-certification-evidence/v1') {
    addIssue('UNSUPPORTED_SCHEMA', '$.schema');
  }
  if (!['sandbox', 'staging'].includes(manifest.environment)) {
    addIssue('NON_PRODUCTION_ENVIRONMENT_REQUIRED', '$.environment');
  }
  if (!RELEASE_SHA.test(String(manifest.release_sha ?? ''))) {
    addIssue('INVALID_RELEASE_SHA', '$.release_sha');
  }
  if (expectedReleaseSha !== undefined &&
      (!RELEASE_SHA.test(String(expectedReleaseSha)) ||
       String(manifest.release_sha).toLowerCase() !== String(expectedReleaseSha).toLowerCase())) {
    addIssue('RELEASE_SHA_MISMATCH', '$.release_sha');
  }
  requireTimestamp(manifest.tested_at, '$.tested_at', addIssue);

  const carrier = manifest.carrier;
  if (!isRecord(carrier)) {
    addIssue('INVALID_CARRIER_SECTION', '$.carrier');
  } else {
    requireString(carrier.provider_name, '$.carrier.provider_name', addIssue, 200);
    requireString(carrier.account_reference, '$.carrier.account_reference', addIssue, 200);
    requireString(carrier.tracking_reference, '$.carrier.tracking_reference', addIssue, 255);
    const callback = carrier.callback;
    if (!isRecord(callback)) {
      addIssue('INVALID_CARRIER_CALLBACK', '$.carrier.callback');
    } else {
      if (callback.origin !== 'PROVIDER_NATIVE') addIssue('CARRIER_ORIGIN_NOT_PROVIDER_NATIVE', '$.carrier.callback.origin');
      if (callback.signature_validation !== 'PASS') addIssue('CARRIER_SIGNATURE_NOT_VERIFIED', '$.carrier.callback.signature_validation');
      requireString(callback.adapter, '$.carrier.callback.adapter', addIssue, 200);
      requireString(callback.signature_algorithm, '$.carrier.callback.signature_algorithm', addIssue, 100);
      if (/factoryos|synthetic|test-hmac/i.test(String(callback.adapter) + ' ' + String(callback.signature_algorithm))) {
        addIssue('SYNTHETIC_FACTORYOS_SIGNATURE_NOT_ACCEPTED', '$.carrier.callback');
      }
      requireString(callback.provider_request_id, '$.carrier.callback.provider_request_id', addIssue, 255);
      requireString(callback.provider_event_id, '$.carrier.callback.provider_event_id', addIssue, 255);
      requireHash(callback.payload_sha256, '$.carrier.callback.payload_sha256', addIssue);
      requireTimestamp(callback.received_at, '$.carrier.callback.received_at', addIssue);
      if (!isRecord(callback.retry)) {
        addIssue('INVALID_CARRIER_RETRY_EVIDENCE', '$.carrier.callback.retry');
      } else {
        if (!Number.isSafeInteger(callback.retry.attempt_count) || callback.retry.attempt_count < 2) {
          addIssue('PROVIDER_RETRY_NOT_PROVEN', '$.carrier.callback.retry.attempt_count');
        }
        for (const field of ['same_provider_event_id', 'same_payload_sha256',
          'initial_attempt_transient_failure', 'stored_receipt_reused']) {
          if (callback.retry[field] !== true) addIssue('PROVIDER_RETRY_ASSERTION_MISSING', '$.carrier.callback.retry.' + field);
        }
        if (callback.retry.persisted_delivery_event_count !== 1) {
          addIssue('DUPLICATE_DELIVERY_EVENT_COUNT_NOT_ONE', '$.carrier.callback.retry.persisted_delivery_event_count');
        }
      }
      if (!isRecord(callback.conflicting_replay)) {
        addIssue('INVALID_CONFLICTING_REPLAY_EVIDENCE', '$.carrier.callback.conflicting_replay');
      } else {
        if (callback.conflicting_replay.same_provider_event_id !== true ||
            callback.conflicting_replay.payload_sha256_differs !== true ||
            callback.conflicting_replay.accepted !== false ||
            ![400, 409].includes(callback.conflicting_replay.http_status) ||
            callback.conflicting_replay.persisted_delivery_event_count !== 1) {
          addIssue('CONFLICTING_REPLAY_NOT_REJECTED_OR_RECONCILED', '$.carrier.callback.conflicting_replay');
        }
      }
    }
  }

  const storage = manifest.storage;
  if (!isRecord(storage)) {
    addIssue('INVALID_STORAGE_SECTION', '$.storage');
  } else {
    requireString(storage.provider_name, '$.storage.provider_name', addIssue, 200);
    requireString(storage.account_reference, '$.storage.account_reference', addIssue, 200);
    requireString(storage.bucket, '$.storage.bucket', addIssue, 255);
    if (!isNonEmptyString(storage.prefix, 500) || !storage.prefix.startsWith('pod/') ||
        !storage.prefix.endsWith('/') || storage.prefix.includes('..') ||
        storage.prefix.includes('//')) {
      addIssue('INVALID_STORAGE_PREFIX', '$.storage.prefix');
    }
    requireHash(storage.runtime_principal_sha256, '$.storage.runtime_principal_sha256', addIssue);
    requireHash(storage.policy_sha256, '$.storage.policy_sha256', addIssue);
    if (storage.effective_permissions_review !== 'PASS') {
      addIssue('EFFECTIVE_IAM_REVIEW_NOT_PASSED', '$.storage.effective_permissions_review');
    }
    if (!isRecord(storage.review_items)) {
      addIssue('INVALID_IAM_REVIEW_ITEMS', '$.storage.review_items');
    } else {
      for (const item of REQUIRED_REVIEW_ITEMS) {
        if (!['PASS', 'NOT_APPLICABLE_WITH_REASON'].includes(storage.review_items[item]?.status)) {
          addIssue('IAM_REVIEW_ITEM_NOT_CLOSED', '$.storage.review_items.' + item);
        }
        if (storage.review_items[item]?.status === 'NOT_APPLICABLE_WITH_REASON' &&
            !isNonEmptyString(storage.review_items[item]?.reason, 1000)) {
          addIssue('IAM_NOT_APPLICABLE_REQUIRES_REASON', '$.storage.review_items.' + item + '.reason');
        }
      }
    }

    const upload = storage.upload;
    const readback = storage.readback;
    if (!isRecord(upload)) {
      addIssue('INVALID_STORAGE_UPLOAD_EVIDENCE', '$.storage.upload');
    } else {
      requireHash(upload.sha256, '$.storage.upload.sha256', addIssue);
      requireString(upload.request_id, '$.storage.upload.request_id', addIssue, 255);
      if (!Number.isSafeInteger(upload.byte_length) || upload.byte_length <= 0) {
        addIssue('INVALID_STORAGE_UPLOAD_BYTE_LENGTH', '$.storage.upload.byte_length');
      }
      if (upload.method !== 'FACTORYOS_STORAGE_ADAPTER') {
        addIssue('UPLOAD_METHOD_NOT_FACTORYOS_STORAGE_ADAPTER', '$.storage.upload.method');
      }
    }
    if (!isRecord(readback)) {
      addIssue('INVALID_INDEPENDENT_READBACK_EVIDENCE', '$.storage.readback');
    } else {
      if (!['DIRECT_PROVIDER_SDK', 'DIRECT_PROVIDER_API', 'PROVIDER_CLI'].includes(readback.method)) {
        addIssue('READBACK_NOT_DIRECT_TO_PROVIDER', '$.storage.readback.method');
      }
      if (readback.factoryos_api_used !== false) {
        addIssue('READBACK_MUST_BYPASS_FACTORYOS_API', '$.storage.readback.factoryos_api_used');
      }
      requireHash(readback.sha256, '$.storage.readback.sha256', addIssue);
      requireHash(readback.principal_fingerprint_sha256, '$.storage.readback.principal_fingerprint_sha256', addIssue);
      requireString(readback.request_id, '$.storage.readback.request_id', addIssue, 255);
      if (isRecord(upload) && isSha256(upload.sha256) && isSha256(readback.sha256) &&
          upload.sha256 !== readback.sha256) {
        addIssue('UPLOAD_READBACK_DIGEST_MISMATCH', '$.storage.readback.sha256');
      }
      if (isRecord(upload) && Number.isSafeInteger(upload.byte_length) &&
          Number.isSafeInteger(readback.byte_length) && upload.byte_length !== readback.byte_length) {
        addIssue('UPLOAD_READBACK_BYTE_LENGTH_MISMATCH', '$.storage.readback.byte_length');
      }
      if (!Number.isSafeInteger(readback.byte_length) || readback.byte_length <= 0) {
        addIssue('INVALID_STORAGE_READBACK_BYTE_LENGTH', '$.storage.readback.byte_length');
      }
    }
    if (!isNonEmptyString(storage.object_key, 1024) ||
        !isNonEmptyString(storage.prefix, 500) ||
        !String(storage.object_key).startsWith(storage.prefix) ||
        String(storage.object_key).includes('..') ||
        String(storage.object_key).includes('//')) {
      addIssue('OBJECT_KEY_OUTSIDE_APPROVED_PREFIX', '$.storage.object_key');
    }

    const rotation = storage.credential_rotation;
    if (!isRecord(rotation)) {
      addIssue('INVALID_CREDENTIAL_ROTATION_EVIDENCE', '$.storage.credential_rotation');
    } else {
      requireTimestamp(rotation.rotated_at, '$.storage.credential_rotation.rotated_at', addIssue);
      if (rotation.old_credential_denied !== true ||
          rotation.new_credential_put_get_pass !== true) {
        addIssue('CREDENTIAL_ROTATION_NOT_PROVEN', '$.storage.credential_rotation');
      }
      requireHash(rotation.old_credential_fingerprint_sha256, '$.storage.credential_rotation.old_credential_fingerprint_sha256', addIssue);
      requireHash(rotation.new_credential_fingerprint_sha256, '$.storage.credential_rotation.new_credential_fingerprint_sha256', addIssue);
      if (isSha256(rotation.old_credential_fingerprint_sha256) &&
          rotation.old_credential_fingerprint_sha256 === rotation.new_credential_fingerprint_sha256) {
        addIssue('CREDENTIAL_FINGERPRINTS_MUST_DIFFER', '$.storage.credential_rotation');
      }
    }
  }

  const approvals = manifest.approvals;
  if (!Array.isArray(approvals)) {
    addIssue('APPROVALS_REQUIRED', '$.approvals');
  } else {
    const seenRoles = new Set();
    const seenIdentities = new Set();
    for (const [index, approval] of approvals.entries()) {
      const path = '$.approvals[' + index + ']';
      if (!isRecord(approval)) {
        addIssue('INVALID_APPROVAL', path);
        continue;
      }
      if (!REQUIRED_APPROVAL_ROLES.includes(approval.role) || seenRoles.has(approval.role)) {
        addIssue('UNKNOWN_OR_DUPLICATE_APPROVAL_ROLE', path + '.role');
      }
      seenRoles.add(approval.role);
      requireString(approval.identity_reference, path + '.identity_reference', addIssue, 255);
      if (isNonEmptyString(approval.identity_reference) && seenIdentities.has(approval.identity_reference)) {
        addIssue('APPROVERS_MUST_BE_DISTINCT', path + '.identity_reference');
      }
      seenIdentities.add(approval.identity_reference);
      if (approval.decision !== 'APPROVED') addIssue('OWNER_APPROVAL_MISSING', path + '.decision');
      requireTimestamp(approval.approved_at, path + '.approved_at', addIssue);
      if (String(approval.release_sha ?? '').toLowerCase() !== String(manifest.release_sha ?? '').toLowerCase()) {
        addIssue('APPROVAL_RELEASE_SHA_MISMATCH', path + '.release_sha');
      }
    }
    for (const role of REQUIRED_APPROVAL_ROLES) {
      if (!seenRoles.has(role)) addIssue('REQUIRED_APPROVAL_ROLE_MISSING', '$.approvals.' + role);
    }
  }
  return manifest;
}

async function validateEvidenceFiles(manifest, evidenceRoot, addIssue) {
  if (!Array.isArray(manifest.evidence_files)) {
    addIssue('EVIDENCE_FILES_REQUIRED', '$.evidence_files');
    return 0;
  }
  const byKind = new Map();
  const seenPaths = new Set();
  for (const [index, entry] of manifest.evidence_files.entries()) {
    const path = '$.evidence_files[' + index + ']';
    if (!isRecord(entry)) {
      addIssue('INVALID_EVIDENCE_FILE_ENTRY', path);
      continue;
    }
    if (!REQUIRED_EVIDENCE_KINDS.includes(entry.kind)) {
      addIssue('UNKNOWN_EVIDENCE_KIND', path + '.kind');
    } else if (byKind.has(entry.kind)) {
      addIssue('DUPLICATE_EVIDENCE_KIND', path + '.kind');
    } else {
      byKind.set(entry.kind, entry);
    }
    requireHash(entry.sha256, path + '.sha256', addIssue);
    if (!isNonEmptyString(entry.path, 500) || isAbsolute(String(entry.path)) ||
        String(entry.path).includes('\\') ||
        String(entry.path).split('/').some((part) => !part || part === '.' || part === '..')) {
      addIssue('UNSAFE_EVIDENCE_PATH', path + '.path');
      continue;
    }
    if (seenPaths.has(entry.path)) addIssue('DUPLICATE_EVIDENCE_PATH', path + '.path');
    seenPaths.add(entry.path);
  }
  for (const kind of REQUIRED_EVIDENCE_KINDS) {
    if (!byKind.has(kind)) addIssue('REQUIRED_EVIDENCE_KIND_MISSING', '$.evidence_files.' + kind);
  }
  if (!isNonEmptyString(evidenceRoot, 1000)) {
    addIssue('EVIDENCE_ROOT_REQUIRED', '$.evidence_files');
    return 0;
  }

  let root;
  try {
    root = await realpath(resolve(evidenceRoot));
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) throw new Error('not a directory');
  } catch {
    addIssue('EVIDENCE_ROOT_UNAVAILABLE', '$.evidence_files');
    return 0;
  }

  let checked = 0;
  for (const entry of byKind.values()) {
    if (!isNonEmptyString(entry.path, 500) || isAbsolute(String(entry.path)) ||
        String(entry.path).includes('\\') ||
        String(entry.path).split('/').some((part) => !part || part === '.' || part === '..')) continue;
    const candidate = resolve(root, ...entry.path.split('/'));
    let canonical;
    let stat;
    let bytes;
    try {
      canonical = await realpath(candidate);
      if (!canonical.startsWith(root + sep)) throw new Error('outside evidence root');
      stat = await lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular evidence file');
      if (stat.size > MAX_EVIDENCE_FILE_BYTES) throw new Error('evidence file too large');
      bytes = await readFile(candidate);
    } catch {
      addIssue('EVIDENCE_FILE_UNAVAILABLE_OR_UNSAFE', '$.evidence_files.' + entry.kind);
      continue;
    }
    checked += 1;
    if (isSha256(entry.sha256) && hash(bytes) !== entry.sha256) {
      addIssue('EVIDENCE_FILE_DIGEST_MISMATCH', '$.evidence_files.' + entry.kind);
    }
  }
  return checked;
}

/**
 * Validates evidence-bundle completeness, attachment integrity and release binding.
 * It cannot prove that attached provider evidence is truthful or independently signed.
 */
export async function validateExternalCertificationManifest(manifest, {
  evidenceRoot,
  expectedReleaseSha,
} = {}) {
  const issues = [];
  const addIssue = (code, path) => issues.push({ code, path });
  scanForbiddenFields(manifest, addIssue);
  const validated = validateManifestShape(manifest, expectedReleaseSha, addIssue);
  let evidenceFilesChecked = 0;
  if (validated) evidenceFilesChecked = await validateEvidenceFiles(validated, evidenceRoot, addIssue);
  const deduplicated = issues.filter((issue, index) =>
    issues.findIndex((candidate) => candidate.code === issue.code && candidate.path === issue.path) === index,
  );
  return {
    pass: deduplicated.length === 0,
    result: deduplicated.length === 0
      ? 'PASS_EVIDENCE_BUNDLE_COMPLETE'
      : 'FAIL_EXTERNAL_CERTIFICATION_EVIDENCE',
    release_sha: isRecord(manifest) && RELEASE_SHA.test(String(manifest.release_sha ?? ''))
      ? String(manifest.release_sha).toLowerCase()
      : null,
    evidence_files_checked: evidenceFilesChecked,
    required_evidence_kinds: REQUIRED_EVIDENCE_KINDS,
    required_approval_roles: REQUIRED_APPROVAL_ROLES,
    issues: deduplicated,
    limitations: [
      'This check verifies manifest completeness, release binding, and local attachment digests; it does not prove provider evidence is truthful or cryptographically signed by the provider.',
      'A carrier/storage owner must independently inspect native provider records and approve the exact tested release SHA.',
      'The evidence directory can contain sensitive provider records; review and redact files before sharing them outside the approved security process.',
    ],
  };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--manifest', '--evidence-root', '--release-sha'].includes(key)) {
      throw new Error('Usage: node scripts/integrations/wms-provider-evidence-pack.mjs --manifest <manifest.json> --evidence-root <private-evidence-dir> --release-sha <tested-release-sha>');
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for ' + key);
    values[key] = value;
    index += 1;
  }
  if (!values['--manifest'] || !values['--evidence-root'] || !values['--release-sha']) {
    throw new Error('Usage: node scripts/integrations/wms-provider-evidence-pack.mjs --manifest <manifest.json> --evidence-root <private-evidence-dir> --release-sha <tested-release-sha>');
  }
  return values;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const manifestBytes = await readFile(args['--manifest']);
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error('Manifest exceeds the 1 MiB safety limit');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('Manifest must contain valid JSON');
  }
  const report = await validateExternalCertificationManifest(manifest, {
    evidenceRoot: args['--evidence-root'],
    expectedReleaseSha: args['--release-sha'],
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error('External certification evidence check failed: ' + (error instanceof Error ? error.message : 'unknown error'));
    process.exitCode = 1;
  });
}
