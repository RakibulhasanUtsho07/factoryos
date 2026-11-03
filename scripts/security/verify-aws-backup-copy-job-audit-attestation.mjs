#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyAuditAttestation } from '../audit/aws-backup-copy-job-audit-evidence.mjs';

const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function fail(message) { throw new Error(message); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || args.has(key)) fail('Invalid or duplicate argument');
    args.set(key, value);
  }
  const required = [
    '--evidence', '--attestation', '--public-key-file',
    '--expected-key-id', '--expected-owner-reference',
  ];
  if (args.size !== required.length || required.some((key) => !args.has(key))) {
    fail('Usage: node scripts/security/verify-aws-backup-copy-job-audit-attestation.mjs --evidence <audit.json> --attestation <audit.signature.json> --public-key-file <trusted-owner-ed25519-public.pem> --expected-key-id <key-id> --expected-owner-reference <owner-ref>');
  }
  return args;
}

async function readRegular(path, label, maxBytes) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || metadata.size < 1 || metadata.size > maxBytes) {
    fail(label + ' must be a single-link regular, non-empty file within the size bound');
  }
  return readFile(path);
}

function assertEvidenceClaims(evidence) {
  const assertions = evidence?.assertions;
  const counts = evidence?.cloudTrail?.validation;
  if (evidence?.schema !== 'factoryos.aws-backup-copy-job-audit-evidence/v1'
    || assertions?.cloudTrailDigestChainValid !== true
    || assertions?.cloudTrailSourceVersionReadBack !== true
    || assertions?.complianceRetentionReadBack !== true
    || assertions?.eventBridgeReplayCompleted !== true
    || assertions?.eventBridgeCaptureQueueDrained !== true
    || assertions?.eventBridgeCaptureQueueAcknowledgementComplete !== true
    || assertions?.eventBridgeCaptureQueueEmptyAfterReadBack !== true
    || assertions?.eventBridgeCaptureDeadLetterQueueEmptyAfterReadBack !== true
    || assertions?.eventBridgeCaptureQuietWindowAtLeastFiveMinutes !== true
    || assertions?.replaySideEffectsBlockedBySingleRuleFilter !== true
    || assertions?.sourceDeliveryIsBestEffort !== true
    || assertions?.historicalLedgerComplete !== false
    || assertions?.exhaustiveCopyClassCoverage !== false
    || assertions?.destructiveActionsPerformed !== false
    || !Number.isSafeInteger(counts?.digestFilesTotal) || counts.digestFilesTotal < 1
    || counts.digestFilesValid !== counts.digestFilesTotal
    || !Number.isSafeInteger(counts?.backfillDigestFilesTotal) || counts.backfillDigestFilesTotal < 0
    || counts.backfillDigestFilesValid !== counts.backfillDigestFilesTotal
    || !Number.isSafeInteger(counts?.logFilesTotal) || counts.logFilesTotal < 1
    || counts.logFilesValid !== counts.logFilesTotal
    || evidence?.cloudTrail?.validationStatus !== 'ALL_RETURNED_DIGESTS_AND_LOGS_VALID'
    || !Array.isArray(evidence.cloudTrail.objects) || evidence.cloudTrail.objects.length < 1
    || !Array.isArray(evidence.eventBridge?.records)
    || !Array.isArray(evidence.cloudTrail.records)) {
    fail('Evidence does not satisfy the bounded AWS Backup audit evidence contract');
  }
  for (const object of evidence.cloudTrail.objects) {
    if (!/^[a-f0-9]{64}$/.test(object?.sha256 || '')
      || typeof object.versionId !== 'string' || !object.versionId || object.versionId === 'null'
      || object.retentionMode !== 'COMPLIANCE'
      || !Number.isFinite(Date.parse(object.retainUntil))
      || Date.parse(object.retainUntil) <= Date.now()
      || !['ON', 'OFF'].includes(object.legalHoldStatus)) {
      fail('Evidence contains a CloudTrail object without an exact version, byte digest or active retention read-back');
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidenceBytes = await readRegular(args.get('--evidence'), 'Evidence file', MAX_EVIDENCE_BYTES);
  const attestationBytes = await readRegular(args.get('--attestation'), 'Attestation file', MAX_JSON_BYTES);
  const publicKeyBytes = await readRegular(args.get('--public-key-file'), 'Trusted public key', 64 * 1024);
  let evidence;
  let attestation;
  try {
    evidence = JSON.parse(evidenceBytes.toString('utf8'));
    attestation = JSON.parse(attestationBytes.toString('utf8'));
  } catch {
    fail('Evidence and attestation must be valid JSON');
  }
  assertEvidenceClaims(evidence);
  const expectedKeyId = args.get('--expected-key-id');
  const expectedOwnerReference = args.get('--expected-owner-reference');
  if (!SAFE.test(expectedKeyId) || !SAFE.test(expectedOwnerReference)) {
    fail('Expected key ID and owner reference must be safe opaque identifiers');
  }
  if (attestation.evidenceSha256 !== sha256(evidenceBytes)
    || attestation.attestationKeyId !== expectedKeyId
    || attestation.attestationOwnerReference !== expectedOwnerReference) {
    fail('Detached attestation evidence digest, signing key ID or owner reference does not match the trusted review input');
  }
  const publicKeyPem = publicKeyBytes.toString('utf8');
  verifyAuditAttestation(attestation, attestation.signature, publicKeyPem);
  process.stdout.write(JSON.stringify({
    schema: attestation.schema,
    signatureVerified: true,
    evidenceSha256: sha256(evidenceBytes),
    attestationKeyId: attestation.attestationKeyId,
    attestationOwnerReference: attestation.attestationOwnerReference,
    evidenceFile: basename(resolve(args.get('--evidence'))),
    attestationFile: basename(resolve(args.get('--attestation'))),
    historicalLedgerComplete: false,
    exhaustiveCopyClassCoverage: false,
  }, null, 2) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write('AWS Backup evidence attestation verification refused: '
      + (error instanceof Error ? error.message : 'unknown error') + '\n');
    process.exitCode = 1;
  });
}
