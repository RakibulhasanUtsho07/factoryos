#!/usr/bin/env node
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { lstat, readFile, open, chmod } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
function fail(message) { throw new Error(message); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || args.has(key)) fail('Invalid or duplicate argument');
    args.set(key, value);
  }
  const required = ['--evidence', '--private-key-file', '--key-id', '--owner-reference', '--signature-output'];
  if (args.size !== required.length || required.some((key) => !args.has(key))) {
    fail('Usage: node scripts/security/sign-aws-backup-copy-job-audit-evidence.mjs --evidence <audit.json> --private-key-file <ed25519.pem> --key-id <key-id> --owner-reference <owner-ref> --signature-output <audit.signature.json>');
  }
  return args;
}
async function readRegularFile(path, label, maxBytes, privateKey = false) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || metadata.size < 1 || metadata.size > maxBytes) fail(label + ' must be a single-link regular, non-empty file within the size bound');
  if (privateKey && (metadata.mode & 0o077) !== 0) fail('Ed25519 private key must use mode 0600 or stricter');
  return readFile(path);
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidenceBytes = await readRegularFile(args.get('--evidence'), 'Evidence file', MAX_EVIDENCE_BYTES);
  let evidence;
  try { evidence = JSON.parse(evidenceBytes.toString('utf8')); } catch { fail('Evidence file must contain valid JSON'); }
  const assertions = evidence?.assertions;
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
    || evidence.cloudTrail?.validationStatus !== 'ALL_RETURNED_DIGESTS_AND_LOGS_VALID'
    || !Number.isSafeInteger(evidence.cloudTrail?.validation?.digestFilesTotal)
    || evidence.cloudTrail.validation.digestFilesTotal < 1
    || evidence.cloudTrail.validation.digestFilesValid !== evidence.cloudTrail.validation.digestFilesTotal
    || !Number.isSafeInteger(evidence.cloudTrail.validation.backfillDigestFilesTotal)
    || evidence.cloudTrail.validation.backfillDigestFilesTotal < 0
    || evidence.cloudTrail.validation.backfillDigestFilesValid !== evidence.cloudTrail.validation.backfillDigestFilesTotal
    || !Number.isSafeInteger(evidence.cloudTrail.validation.logFilesTotal)
    || evidence.cloudTrail.validation.logFilesTotal < 1
    || evidence.cloudTrail.validation.logFilesValid !== evidence.cloudTrail.validation.logFilesTotal
    || !Array.isArray(evidence.cloudTrail.objects) || evidence.cloudTrail.objects.length < 1
    || !Array.isArray(evidence.eventBridge?.records) || !Array.isArray(evidence.cloudTrail.records)) {
    fail('Evidence lacks complete digest/log counts, a read-only capture, version/retention read-back or explicit scope limitation');
  }
  for (const object of evidence.cloudTrail.objects) {
    if (!/^[a-f0-9]{64}$/.test(object?.sha256 || '')
      || typeof object.versionId !== 'string' || !object.versionId || object.versionId === 'null'
      || object.retentionMode !== 'COMPLIANCE'
      || !Number.isFinite(Date.parse(object.retainUntil))
      || Date.parse(object.retainUntil) <= Date.now()
      || !['ON', 'OFF'].includes(object.legalHoldStatus)) {
      fail('Evidence contains a CloudTrail object without exact version/digest and active retention read-back');
    }
  }
  const keyId = args.get('--key-id'); const ownerReference = args.get('--owner-reference');
  if (!SAFE.test(keyId) || !SAFE.test(ownerReference)) fail('key-id and owner-reference must be safe opaque identifiers');
  const keyBytes = await readRegularFile(args.get('--private-key-file'), 'Private key', 64 * 1024, true);
  const privateKey = createPrivateKey(keyBytes);
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('Audit evidence must be signed using Ed25519');
  const signedAt = new Date().toISOString();
  const claims = {
    schema: 'factoryos.aws-backup-copy-job-audit-attestation/v1',
    attestationKeyId: keyId,
    attestationOwnerReference: ownerReference,
    evidenceSha256: sha256(evidenceBytes),
    signedAt,
  };
  const signature = sign(null, Buffer.from(JSON.stringify(claims), 'utf8'), privateKey).toString('base64url');
  const document = { ...claims, signature };
  const output = resolve(args.get('--signature-output'));
  const handle = await open(output, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(document, null, 2) + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await chmod(output, 0o600);
  process.stdout.write(JSON.stringify({
    schema: claims.schema, evidenceSha256: claims.evidenceSha256,
    attestationKeyId: keyId, attestationOwnerReference: ownerReference,
    signatureOutput: basename(output), signatureBytes: Buffer.byteLength(signature),
  }, null, 2) + '\n');
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write('AWS Backup audit signing refused: ' + (error instanceof Error ? error.message : 'unknown error') + '\n');
    process.exitCode = 1;
  });
}
