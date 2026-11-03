#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, rm, mkdtemp, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import {
  parseCloudTrailValidateLogsOutput, reconcileAwsBackupCopyJobEvents, sha256,
} from '../audit/aws-backup-copy-job-audit-evidence.mjs';

const MAX_AWS_OUTPUT = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;
const MAX_OBJECTS = 5000;
const MAX_COMPRESSED_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_DECOMPRESSED_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_DECOMPRESSED_BYTES = 1024 * 1024 * 1024;
function fail(message) { throw new Error(message); }

async function runAws(args, timeoutMs = 120000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.env.AWS_CLI_PATH || 'aws', [...args, '--no-cli-pager'], {
      shell: false, windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let total = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('AWS CLI command timed out')); }, timeoutMs);
    const consume = (chunk, isError) => {
      total += chunk.length;
      if (total > MAX_AWS_OUTPUT) { child.kill('SIGKILL'); clearTimeout(timer); reject(new Error('AWS CLI output exceeded 16 MiB')); return; }
      if (isError) stderr += chunk.toString('utf8'); else stdout += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk) => consume(chunk, false));
    child.stderr.on('data', (chunk) => consume(chunk, true));
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('AWS CLI command failed (' + code + '): ' + stderr.slice(0, 2500)));
      else resolvePromise(stdout);
    });
  });
}
async function runJson(args, timeoutMs) {
  const raw = await runAws([...args, '--output', 'json'], timeoutMs);
  try { return JSON.parse(raw); } catch { fail('AWS CLI returned invalid JSON for ' + args.slice(0, 2).join(' ')); }
}
async function readRegular(path, label, maxBytes, allowEmpty = false) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (!allowEmpty && metadata.size < 1) || metadata.size > maxBytes) {
    fail(label + ' must be a regular file within the configured size bound');
  }
  return readFile(path);
}
function iso(value, name) {
  if (typeof value !== 'string' || !/Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail(name + ' must be a UTC ISO-8601 timestamp');
  return new Date(value).toISOString();
}
function arn(value, service, accountId, region, resourcePrefix) {
  if (typeof value !== 'string') fail('Invalid ' + service + ' ARN');
  const fields = value.split(':');
  if (fields.length < 6 || fields[0] !== 'arn' || fields[2] !== service
    || fields[4] !== accountId || (region && fields[3] !== region)
    || (resourcePrefix && !fields[5].startsWith(resourcePrefix))) fail('Invalid ' + service + ' ARN/scope');
}
function validateManifest(manifest, summary, captureBytes, manifestBytes, preflight, preflightBytes, replayReceipt, replayBytes) {
  if (!manifest || manifest.schema !== 'factoryos.aws-backup-copy-job-audit-input/v1') fail('Unsupported audit input manifest schema');
  if (!/^\d{12}$/.test(manifest.accountId || '') || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(manifest.region || '')) fail('accountId or event Region is invalid');
  arn(manifest.archiveArn, 'events', manifest.accountId, manifest.region, 'archive/');
  arn(manifest.replayArn, 'events', manifest.accountId, manifest.region, 'replay/');
  const trailArnParts = typeof manifest.trailArn === 'string' ? manifest.trailArn.split(':') : [];
  if (trailArnParts.length < 6 || trailArnParts[0] !== 'arn' || trailArnParts[2] !== 'cloudtrail'
    || trailArnParts[4] !== manifest.accountId || !trailArnParts[5].startsWith('trail/')) fail('CloudTrail trail ARN is invalid or outside account scope');
  if (manifest.trailHomeRegion !== trailArnParts[3]
    || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(manifest.trailHomeRegion || '')) fail('trailHomeRegion must match the CloudTrail trail ARN Region');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(manifest.replayName || '')
    || !manifest.replayArn.endsWith('/' + manifest.replayName)) fail('replayName/replayArn is invalid or inconsistent');
  if (typeof manifest.trailBucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(manifest.trailBucket)) fail('trailBucket is invalid');
  if (typeof manifest.trailS3KeyPrefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(manifest.trailS3KeyPrefix)
    || manifest.trailS3KeyPrefix.startsWith('/') || manifest.trailS3KeyPrefix.endsWith('/')
    || manifest.trailS3KeyPrefix.split('/').some((part) => part === '..')) fail('trailS3KeyPrefix is invalid');
  if (typeof manifest.cloudTrailKmsKeyArn !== 'string'
    || !manifest.cloudTrailKmsKeyArn.startsWith('arn:')
    || !manifest.cloudTrailKmsKeyArn.includes(':kms:' + manifest.trailHomeRegion + ':' + manifest.accountId + ':key/')) {
    fail('cloudTrailKmsKeyArn must be a customer-managed key in the trail account and home Region');
  }
  const startTime = iso(manifest.startTime, 'startTime');
  const endTime = iso(manifest.endTime, 'endTime');
  if (Date.parse(endTime) <= Date.parse(startTime)) fail('endTime must be later than startTime');

  if (preflight?.schema !== 'factoryos.aws-backup-copy-job-replay-preflight/v1'
    || replayReceipt?.schema !== 'factoryos.aws-backup-copy-job-replay-start/v1') fail('Preflight or replay receipt schema is invalid');
  if (sha256(manifestBytes) !== preflight.manifestSha256
    || preflight.accountId !== manifest.accountId || preflight.region !== manifest.region
    || preflight.archiveArn !== manifest.archiveArn || preflight.replayName !== manifest.replayName
    || Date.parse(preflight.eventStartTime) !== Date.parse(startTime)
    || Date.parse(preflight.eventEndTime) !== Date.parse(endTime)
    || preflight.replayDestination !== 'SOURCE_EVENT_BUS_FILTERED_TO_ONE_CAPTURE_RULE'
    || preflight.productionRulesSelected !== 0 || preflight.destructiveBackupActionsPermitted !== false
    || !Array.isArray(preflight.selectedFilterArns) || preflight.selectedFilterArns.length !== 1
    || preflight.selectedFilterArns[0] !== preflight.captureRuleArn) fail('Preflight does not bind the exact archive, time window and single replay filter');
  if (sha256(manifestBytes) !== replayReceipt.manifestSha256
    || sha256(preflightBytes) !== replayReceipt.preflightSha256
    || replayReceipt.accountId !== manifest.accountId || replayReceipt.region !== manifest.region
    || replayReceipt.archiveArn !== manifest.archiveArn || replayReceipt.replayArn !== manifest.replayArn
    || replayReceipt.replayName !== manifest.replayName
    || Date.parse(replayReceipt.eventStartTime) !== Date.parse(startTime)
    || Date.parse(replayReceipt.eventEndTime) !== Date.parse(endTime)
    || replayReceipt.destinationRuleCount !== 1 || replayReceipt.productionRulesSelected !== 0
    || replayReceipt.destructiveBackupActionsPerformed !== false
    || JSON.stringify(replayReceipt.filterArns) !== JSON.stringify([preflight.captureRuleArn])
    || !Number.isFinite(Date.parse(iso(preflight.checkedAt, 'preflight.checkedAt')))
    || !Number.isFinite(Date.parse(iso(replayReceipt.startedAt, 'replayReceipt.startedAt')))
    || Date.parse(preflight.checkedAt) >= Date.parse(replayReceipt.startedAt)) fail('Replay receipt is not linked to the exact preflighted single-rule replay');
  if (sha256(replayBytes) !== summary.replayReceiptSha256
    || sha256(preflightBytes) !== summary.preflightSha256
    || summary.schema !== 'factoryos.aws-backup-copy-job-replay-capture/v1'
    || summary.accountId !== manifest.accountId || summary.region !== manifest.region
    || summary.archiveArn !== manifest.archiveArn || summary.replayArn !== manifest.replayArn
    || summary.replayName !== manifest.replayName
    || summary.captureRuleName !== preflight.captureRuleName
    || summary.captureQueueArn !== preflight.captureQueueArn
    || Date.parse(summary.eventStartTime) !== Date.parse(startTime)
    || Date.parse(summary.eventEndTime) !== Date.parse(endTime)
    || summary.captureQueueDrained !== true || summary.queueAcknowledgementComplete !== true
    || summary.queueAcknowledgedCount !== summary.eventCount
    || summary.queueAcknowledgedOnlyAfterCaptureFsyncAndAtomicRename !== true
    || summary.queueAcknowledgementFailedCount !== 0
    || summary.captureQuietPolls < 15 || summary.minimumQuietWindowSeconds < 300
    || summary.captureQueuePostReadBackCounts?.available !== 0
    || summary.captureQueuePostReadBackCounts?.notVisible !== 0
    || summary.captureQueuePostReadBackCounts?.delayed !== 0
    || summary.deadLetterQueuePostReadBackCounts?.available !== 0
    || summary.deadLetterQueuePostReadBackCounts?.notVisible !== 0
    || summary.deadLetterQueuePostReadBackCounts?.delayed !== 0
    || !/^[a-f0-9]{64}$/.test(summary.captureQueuePostReadBackSha256 || '')
    || !/^[a-f0-9]{64}$/.test(summary.deadLetterQueuePostReadBackSha256 || '')
    || !/^[a-f0-9]{64}$/.test(summary.captureSha256 || '')
    || summary.manifestSha256 !== sha256(manifestBytes)) fail('Replay capture summary is incomplete or does not match the sealed audit scope');
  if (summary.captureBytes !== captureBytes.length || summary.captureSha256 !== sha256(captureBytes)) fail('EventBridge capture bytes do not match the capture receipt');
}
function parseS3Uri(uri, bucket, accountId, trailS3KeyPrefix, kind) {
  let parsed;
  try { parsed = new URL(uri); } catch { fail('CloudTrail validator returned an invalid S3 URI'); }
  if (parsed.protocol !== 's3:' || parsed.hostname !== bucket || parsed.search || parsed.hash) {
    fail('CloudTrail validator returned an S3 object outside the approved bucket');
  }
  let key;
  try { key = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')); } catch { fail('CloudTrail S3 key encoding is invalid'); }
  const accountPrefix = trailS3KeyPrefix + '/AWSLogs/' + accountId + '/';
  const kindPrefix = accountPrefix + (kind === 'DIGEST' ? 'CloudTrail-Digest/' : 'CloudTrail/');
  if (!key || key.includes('\0') || key.split('/').some((part) => part === '..')
    || !key.startsWith(kindPrefix)) {
    fail('CloudTrail validator returned an object outside the account-specific CloudTrail log/digest prefix');
  }
  return { uri, bucket, key };
}
async function headObject(object, snapshot, region, expectedKmsKeyArn) {
  const head = await runJson(['s3api', 'head-object', '--bucket', object.bucket, '--key', object.key, '--region', region]);
  if (typeof head.VersionId !== 'string' || !head.VersionId || head.VersionId === 'null'
    || head.ServerSideEncryption !== 'aws:kms' || head.SSEKMSKeyId !== expectedKmsKeyArn
    || !Number.isSafeInteger(head.ContentLength) || head.ContentLength < 1 || head.ContentLength > MAX_COMPRESSED_OBJECT_BYTES) {
    fail('CloudTrail audit object must have an immutable version, KMS encryption and bounded size: ' + object.uri);
  }
  const retention = await runJson(['s3api', 'get-object-retention', '--bucket', object.bucket, '--key', object.key, '--version-id', head.VersionId, '--region', region]);
  const legalHold = await runJson(['s3api', 'get-object-legal-hold', '--bucket', object.bucket, '--key', object.key, '--version-id', head.VersionId, '--region', region]);
  if (retention.Retention?.Mode !== 'COMPLIANCE' || !retention.Retention?.RetainUntilDate
    || Date.parse(retention.Retention.RetainUntilDate) <= Date.now()
    || !['ON', 'OFF'].includes(legalHold.LegalHold?.Status)) fail('CloudTrail object lacks active Compliance retention or readable legal-hold state: ' + object.uri);
  const current = {
    versionId: head.VersionId, etag: head.ETag || null, contentLength: head.ContentLength,
    lastModified: head.LastModified || null, encryption: head.ServerSideEncryption, kmsKeyArn: head.SSEKMSKeyId,
    retentionMode: retention.Retention.Mode, retainUntil: new Date(retention.Retention.RetainUntilDate).toISOString(),
    legalHoldStatus: legalHold.LegalHold.Status,
  };
  if (snapshot && (snapshot.versionId !== current.versionId || snapshot.etag !== current.etag
    || snapshot.contentLength !== current.contentLength || snapshot.retainUntil !== current.retainUntil
    || snapshot.kmsKeyArn !== current.kmsKeyArn)) fail('CloudTrail object version or retention changed during read-back');
  return current;
}
async function downloadVersion(object, snapshot, directory, index, region) {
  const localPath = join(directory, 'cloudtrail-object-' + index + '.gz');
  const response = await runJson(['s3api', 'get-object', '--bucket', object.bucket, '--key', object.key,
    '--version-id', snapshot.versionId, '--region', region, localPath]);
  if (response.VersionId !== snapshot.versionId || Number(response.ContentLength) !== snapshot.contentLength) fail('CloudTrail S3 version read-back did not match prevalidated version');
  const bytes = await readRegular(localPath, 'Downloaded CloudTrail object', MAX_COMPRESSED_OBJECT_BYTES);
  if (bytes.length !== snapshot.contentLength) fail('CloudTrail object size changed during read-back');
  let decoded;
  try { decoded = gunzipSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_OBJECT_BYTES }); }
  catch { fail('CloudTrail log/digest object is not a bounded, readable gzip document'); }
  return { bytes, decoded, sha256: sha256(bytes) };
}
function parseCloudTrailJson(bytes) {
  let document;
  try { document = JSON.parse(bytes.toString('utf8')); } catch { fail('CloudTrail log object does not contain valid JSON'); }
  if (!document || !Array.isArray(document.Records) || document.Records.length > 200000) fail('CloudTrail log Records array is missing or exceeds 200,000 records');
  return document.Records;
}
async function main() {
  const argv = process.argv.slice(2); const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || args.has(key)) fail('Invalid or duplicate argument');
    args.set(key, value);
  }
  const required = ['--manifest', '--preflight', '--replay-receipt', '--capture-summary', '--event-capture', '--output'];
  if (args.size !== required.length || required.some((key) => !args.has(key))) fail('Usage: node scripts/security/export-aws-backup-copy-job-audit-evidence.mjs --manifest <audit-input.json> --preflight <preflight.json> --replay-receipt <replay.json> --capture-summary <capture-summary.json> --event-capture <capture.ndjson> --output <audit-evidence.json>');
  const manifestBytes = await readRegular(args.get('--manifest'), 'Audit input manifest', MAX_MANIFEST_BYTES);
  const preflightBytes = await readRegular(args.get('--preflight'), 'Replay preflight receipt', MAX_MANIFEST_BYTES);
  const replayBytes = await readRegular(args.get('--replay-receipt'), 'Replay start receipt', MAX_MANIFEST_BYTES);
  const summaryBytes = await readRegular(args.get('--capture-summary'), 'Replay capture summary', MAX_MANIFEST_BYTES);
  const captureBytes = await readRegular(args.get('--event-capture'), 'EventBridge capture file', MAX_CAPTURE_BYTES, true);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const preflight = JSON.parse(preflightBytes.toString('utf8'));
  const replayReceipt = JSON.parse(replayBytes.toString('utf8'));
  const summary = JSON.parse(summaryBytes.toString('utf8'));
  validateManifest(manifest, summary, captureBytes, manifestBytes, preflight, preflightBytes, replayReceipt, replayBytes);
  const caller = await runJson(['sts', 'get-caller-identity', '--region', manifest.trailHomeRegion]);
  if (caller.Account !== manifest.accountId) fail('AWS caller account differs from the declared CloudTrail account');
  if (basename(resolve(args.get('--event-capture'))) !== summary.captureFile) fail('Capture filename differs from the capture receipt');
  const eventMessages = captureBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (eventMessages.length !== summary.eventCount) fail('EventBridge capture record count differs from its capture receipt');

  const temp = await mkdtemp(join(tmpdir(), 'factoryos-backup-audit-'));
  const cloudTrailObjects = []; const cloudTrailRecords = [];
  let totalDecompressed = 0; let outOfScopeBackupRecordCount = 0;
  let inScopeBackupRecordCount = 0;
  try {
    const trailResponse = await runJson([
      'cloudtrail', 'describe-trails', '--trail-name-list', manifest.trailArn,
      '--region', manifest.trailHomeRegion,
    ]);
    const trail = (trailResponse.TrailList || []).find((item) => item.TrailARN === manifest.trailArn);
    if (!trail || trail.HomeRegion !== manifest.trailHomeRegion
      || trail.S3BucketName !== manifest.trailBucket
      || trail.S3KeyPrefix !== manifest.trailS3KeyPrefix
      || trail.IsMultiRegionTrail !== true || trail.IncludeGlobalServiceEvents !== true
      || trail.LogFileValidationEnabled !== true
      || trail.KmsKeyId !== manifest.cloudTrailKmsKeyArn) {
      fail('Live CloudTrail trail home Region, bucket, multi-Region, log validation or KMS configuration differs from the approved manifest');
    }
    const eventSelectors = await runJson([
      'cloudtrail', 'get-event-selectors', '--trail-name', manifest.trailArn,
      '--region', manifest.trailHomeRegion,
    ]);
    if (!Array.isArray(eventSelectors.EventSelectors) || eventSelectors.EventSelectors.length !== 1
      || eventSelectors.EventSelectors[0].IncludeManagementEvents !== true
      || eventSelectors.EventSelectors[0].ReadWriteType !== 'All') {
      fail('Live CloudTrail event selectors do not include all read/write management events');
    }
    const trailStatus = await runJson([
      'cloudtrail', 'get-trail-status', '--name', manifest.trailArn,
      '--region', manifest.trailHomeRegion,
    ]);
    if (trailStatus.IsLogging !== true || trailStatus.LatestDeliveryError
      || trailStatus.LatestDigestDeliveryError || trailStatus.LatestNotificationError) {
      fail('Live CloudTrail trail is not logging cleanly or reports a recent delivery/digest/notification error');
    }
    const location = await runJson([
      's3api', 'get-bucket-location', '--bucket', manifest.trailBucket,
      '--region', manifest.trailHomeRegion,
    ]);
    const bucketRegion = location.LocationConstraint || 'us-east-1';
    const [versioning, lock, encryption, publicAccess, keyDescription] = await Promise.all([
      runJson(['s3api', 'get-bucket-versioning', '--bucket', manifest.trailBucket, '--region', manifest.trailHomeRegion]),
      runJson(['s3api', 'get-object-lock-configuration', '--bucket', manifest.trailBucket, '--region', manifest.trailHomeRegion]),
      runJson(['s3api', 'get-bucket-encryption', '--bucket', manifest.trailBucket, '--region', manifest.trailHomeRegion]),
      runJson(['s3api', 'get-public-access-block', '--bucket', manifest.trailBucket, '--region', manifest.trailHomeRegion]),
      runJson(['kms', 'describe-key', '--key-id', manifest.cloudTrailKmsKeyArn, '--region', manifest.trailHomeRegion]),
    ]);
    const block = publicAccess.PublicAccessBlockConfiguration || {};
    const encryptionRules = encryption.ServerSideEncryptionConfiguration?.Rules || [];
    const kmsRule = encryptionRules.find((rule) => rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm === 'aws:kms'
      && rule.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID === manifest.cloudTrailKmsKeyArn);
    const lockRule = lock.ObjectLockConfiguration?.Rule?.DefaultRetention;
    const keyMetadata = keyDescription.KeyMetadata || {};
    if (bucketRegion !== manifest.trailHomeRegion || versioning.Status !== 'Enabled'
      || lock.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled'
      || lockRule?.Mode !== 'COMPLIANCE' || !((Number.isInteger(lockRule.Days) && lockRule.Days > 0)
        || (Number.isInteger(lockRule.Years) && lockRule.Years > 0))
      || !kmsRule || block.BlockPublicAcls !== true || block.IgnorePublicAcls !== true
      || block.BlockPublicPolicy !== true || block.RestrictPublicBuckets !== true
      || keyMetadata.Arn !== manifest.cloudTrailKmsKeyArn || keyMetadata.KeyState !== 'Enabled'
      || keyMetadata.Enabled !== true || keyMetadata.KeyManager !== 'CUSTOMER') {
      fail('Live CloudTrail bucket versioning/Object Lock/KMS/public-access controls or key state failed independent read-back');
    }
    const bucketPolicyResponse = await runJson(['s3api', 'get-bucket-policy', '--bucket', manifest.trailBucket, '--region', manifest.trailHomeRegion]);
    let bucketPolicy;
    try { bucketPolicy = JSON.parse(bucketPolicyResponse.Policy || '{}'); } catch { fail('Live CloudTrail audit bucket policy is invalid JSON'); }
    const bucketArn = 'arn:' + manifest.trailArn.split(':')[1] + ':s3:::' + manifest.trailBucket;
    const aclStatement = bucketPolicy.Statement?.find((statement) => statement.Sid === 'AllowCloudTrailToReadBucketAclForThisTrail');
    const putStatement = bucketPolicy.Statement?.find((statement) => statement.Sid === 'AllowCloudTrailToWriteOnlyThisAccountsTrailObjects');
    const tlsStatement = bucketPolicy.Statement?.find((statement) => statement.Sid === 'DenyInsecureTransport');
    const expectedLogObjectArn = bucketArn + '/' + manifest.trailS3KeyPrefix + '/AWSLogs/' + manifest.accountId + '/*';
    if (bucketPolicy.Version !== '2012-10-17' || bucketPolicy.Statement?.length !== 3
      || aclStatement?.Effect !== 'Allow' || aclStatement.Principal?.Service !== 'cloudtrail.amazonaws.com'
      || aclStatement.Action !== 's3:GetBucketAcl' || aclStatement.Resource !== bucketArn
      || aclStatement.Condition?.StringEquals?.['aws:SourceArn'] !== manifest.trailArn
      || putStatement?.Effect !== 'Allow' || putStatement.Principal?.Service !== 'cloudtrail.amazonaws.com'
      || putStatement.Action !== 's3:PutObject' || putStatement.Resource !== expectedLogObjectArn
      || putStatement.Condition?.StringEquals?.['aws:SourceArn'] !== manifest.trailArn
      || putStatement.Condition?.StringEquals?.['s3:x-amz-acl'] !== 'bucket-owner-full-control'
      || tlsStatement?.Effect !== 'Deny' || tlsStatement.Principal !== '*'
      || tlsStatement.Action !== 's3:*'
      || JSON.stringify([...(tlsStatement.Resource || [])].sort()) !== JSON.stringify([bucketArn, bucketArn + '/*'].sort())
      || tlsStatement.Condition?.Bool?.['aws:SecureTransport'] !== 'false') {
      fail('Live CloudTrail bucket policy does not retain the exact CloudTrail-only writer and TLS boundary');
    }
    const validateArgs = ['cloudtrail', 'validate-logs', '--trail-arn', manifest.trailArn,
      '--start-time', manifest.startTime, '--end-time', manifest.endTime,
      '--s3-bucket', manifest.trailBucket, '--s3-prefix', manifest.trailS3KeyPrefix,
      '--verbose', '--region', manifest.trailHomeRegion];
    const firstOutput = await runAws(validateArgs, 900000);
    const first = parseCloudTrailValidateLogsOutput(firstOutput);
    if (Date.parse(first.reportedCoverage.requestedStartTime) !== Date.parse(manifest.startTime)
      || Date.parse(first.reportedCoverage.requestedEndTime) !== Date.parse(manifest.endTime)) fail('CloudTrail validate-logs returned a different requested time window');
    const objects = [
      ...first.digestUris.map((uri) => ({ ...parseS3Uri(uri, manifest.trailBucket, manifest.accountId, manifest.trailS3KeyPrefix, 'DIGEST'), kind: 'DIGEST' })),
      ...first.logUris.map((uri) => ({ ...parseS3Uri(uri, manifest.trailBucket, manifest.accountId, manifest.trailS3KeyPrefix, 'LOG'), kind: 'LOG' })),
    ];
    if (!objects.length || objects.length > MAX_OBJECTS) fail('CloudTrail validator returned no objects or exceeded the 5,000-object bound');
    const snapshots = [];
    for (const object of objects) snapshots.push(await headObject(object, null, manifest.trailHomeRegion, manifest.cloudTrailKmsKeyArn));
    const secondOutput = await runAws(validateArgs, 900000);
    const second = parseCloudTrailValidateLogsOutput(secondOutput);
    const same = (left, right) => [...left].sort().join('\n') === [...right].sort().join('\n');
    if (!same(first.digestUris, second.digestUris) || !same(first.logUris, second.logUris)
      || JSON.stringify(first.reportedCoverage) !== JSON.stringify(second.reportedCoverage)
      || first.requestedWindowFullyCovered !== second.requestedWindowFullyCovered
      || first.digestFilesValid !== second.digestFilesValid || first.digestFilesTotal !== second.digestFilesTotal
      || first.backfillDigestFilesValid !== second.backfillDigestFilesValid || first.backfillDigestFilesTotal !== second.backfillDigestFilesTotal
      || first.logFilesValid !== second.logFilesValid || first.logFilesTotal !== second.logFilesTotal) {
      fail('CloudTrail validation object set changed between verification passes; retry after delivery settles');
    }

    for (let index = 0; index < objects.length; index += 1) {
      const snapshot = await headObject(objects[index], snapshots[index], manifest.trailHomeRegion, manifest.cloudTrailKmsKeyArn);
      const downloaded = await downloadVersion(objects[index], snapshot, temp, index, manifest.trailHomeRegion);
      if (objects[index].kind === 'LOG') {
        totalDecompressed += downloaded.decoded.length;
        if (totalDecompressed > MAX_TOTAL_DECOMPRESSED_BYTES) fail('CloudTrail expanded data exceeded the 512 MiB global bound');
        for (const record of parseCloudTrailJson(downloaded.decoded)) {
          if (record?.eventSource !== 'backup.amazonaws.com') continue;
          const time = Date.parse(record.eventTime);
          if (!Number.isFinite(time)) fail('CloudTrail AWS Backup record has an invalid eventTime');
          if (time < Date.parse(manifest.startTime) || time > Date.parse(manifest.endTime)) continue;
          if (record.recipientAccountId !== manifest.accountId || record.awsRegion !== manifest.region) {
            outOfScopeBackupRecordCount += 1;
            continue;
          }
          inScopeBackupRecordCount += 1;
          cloudTrailRecords.push({
            record,
            sourceObjectReference: objects[index].uri + '#versionId=' + snapshot.versionId,
          });
          if (cloudTrailRecords.length > 500000) fail('CloudTrail AWS Backup records exceeded the 500,000-record bound');
        }
      }
      await headObject(objects[index], snapshot, manifest.trailHomeRegion, manifest.cloudTrailKmsKeyArn);
      cloudTrailObjects.push({
        kind: objects[index].kind, uri: objects[index].uri, versionId: snapshot.versionId,
        sha256: downloaded.sha256, sizeBytes: downloaded.bytes.length,
        encryption: snapshot.encryption, kmsKeyArn: snapshot.kmsKeyArn,
        retentionMode: snapshot.retentionMode, retainUntil: snapshot.retainUntil,
        legalHoldStatus: snapshot.legalHoldStatus,
      });
    }
    const reconciled = reconcileAwsBackupCopyJobEvents(eventMessages.map((message) => ({
      ...message, sourceObjectReference: 'sqs-message:' + message.messageId,
    })), cloudTrailRecords, { accountId: manifest.accountId, region: manifest.region, replayName: manifest.replayName });

    const evidence = {
      schema: 'factoryos.aws-backup-copy-job-audit-evidence/v1',
      createdAt: new Date().toISOString(),
      input: {
        manifestSha256: sha256(manifestBytes), preflightSha256: sha256(preflightBytes),
        replayReceiptSha256: sha256(replayBytes), captureSummarySha256: sha256(summaryBytes),
        eventCaptureSha256: sha256(captureBytes),
      },
      scope: {
        accountId: manifest.accountId, region: manifest.region, archiveArn: manifest.archiveArn,
        replayArn: manifest.replayArn, replayName: manifest.replayName, trailArn: manifest.trailArn,
        trailHomeRegion: manifest.trailHomeRegion, trailBucket: manifest.trailBucket, cloudTrailKmsKeyArn: manifest.cloudTrailKmsKeyArn, trailS3KeyPrefix: manifest.trailS3KeyPrefix,
      },
      period: { startTime: new Date(manifest.startTime).toISOString(), endTime: new Date(manifest.endTime).toISOString() },
      eventBridge: {
        captureFile: basename(resolve(args.get('--event-capture'))), captureSha256: sha256(captureBytes),
        captureBytes: captureBytes.length, replayCaptureRule: summary.captureRuleName,
        captureQueueArn: summary.captureQueueArn, replayStatus: 'COMPLETED',
        replayLastReplayedTime: summary.replayLastReplayedTime,
        replayObservedEventStartTime: summary.replayObservedEventStartTime,
        replayObservedEventEndTime: summary.replayObservedEventEndTime,
        quietPolls: summary.captureQuietPolls,
        minimumQuietWindowSeconds: summary.minimumQuietWindowSeconds,
        captureQueuePostReadBackCounts: summary.captureQueuePostReadBackCounts,
        deadLetterQueuePostReadBackCounts: summary.deadLetterQueuePostReadBackCounts,
        records: reconciled.eventBridge,
      },
      cloudTrail: {
        validationStatus: 'ALL_RETURNED_DIGESTS_AND_LOGS_VALID',
        trail: {
          homeRegion: trail.HomeRegion,
          isLogging: trailStatus.IsLogging,
          latestDeliveryTime: trailStatus.LatestDeliveryTime || null,
          latestDigestDeliveryTime: trailStatus.LatestDigestDeliveryTime || null,
          managementEventsReadWriteAll: true,
          eventSelectorsSha256: sha256(Buffer.from(JSON.stringify(eventSelectors.EventSelectors))),
          bucketRegion,
          bucketVersioning: versioning.Status,
          objectLockDefaultRetention: lockRule,
          kmsKeyArn: keyMetadata.Arn,
          kmsKeyState: keyMetadata.KeyState,
          publicAccessBlocked: true,
          cloudTrailWriterBucketPolicySha256: sha256(Buffer.from(JSON.stringify(bucketPolicy))),
        },
        validation: {
          digestFilesValid: second.digestFilesValid, digestFilesTotal: second.digestFilesTotal,
          backfillDigestFilesValid: second.backfillDigestFilesValid, backfillDigestFilesTotal: second.backfillDigestFilesTotal,
          logFilesValid: second.logFilesValid, logFilesTotal: second.logFilesTotal,
          reportedCoverage: second.reportedCoverage,
          requestedWindowFullyCovered: second.requestedWindowFullyCovered,
          validationOutputSha256: second.outputSha256, validationPasses: 2,
        },
        objects: cloudTrailObjects, records: reconciled.cloudTrail,
      },
      reconciliation: {
        algorithm: 'eventbridge-envelope-id-cloudtrail-event-id-and-copy-job-id-cross-source-correlation/v1',
        ...reconciled.counts, correlatedJobs: reconciled.correlatedJobs,
        outOfScopeCloudTrailAwsBackupRecordsExcluded: outOfScopeBackupRecordCount,
        inScopeCloudTrailAwsBackupRecords: inScopeBackupRecordCount,
        sourceRecordsRemainDistinct: true, missingCopyJobIdsRemainUncorrelated: true,
        absenceIsNotProofOfNoCopyJob: true,
      },
      assertions: {
        eventBridgeReplayCompleted: true,
        eventBridgeCaptureQueueDrained: summary.captureQueueDrained === true,
        eventBridgeCaptureQueueAcknowledgementComplete: summary.queueAcknowledgementComplete === true,
        eventBridgeCaptureQueueEmptyAfterReadBack: summary.captureQueuePostReadBackCounts?.available === 0
          && summary.captureQueuePostReadBackCounts?.notVisible === 0 && summary.captureQueuePostReadBackCounts?.delayed === 0,
        eventBridgeCaptureDeadLetterQueueEmptyAfterReadBack: summary.deadLetterQueuePostReadBackCounts?.available === 0
          && summary.deadLetterQueuePostReadBackCounts?.notVisible === 0 && summary.deadLetterQueuePostReadBackCounts?.delayed === 0,
        eventBridgeCaptureQuietWindowAtLeastFiveMinutes: summary.captureQuietPolls >= 15
          && summary.minimumQuietWindowSeconds >= 300,
        replaySideEffectsBlockedBySingleRuleFilter: true,
        cloudTrailDigestChainValid: true,
        cloudTrailSourceVersionReadBack: true,
        complianceRetentionReadBack: true,
        sourceDeliveryIsBestEffort: true,
        cloudTrailValidationRangeFullyCovered: second.requestedWindowFullyCovered,
        historicalLedgerComplete: false,
        exhaustiveCopyClassCoverage: false,
        destructiveActionsPerformed: false,
      },
    };
    const outputPath = resolve(args.get('--output'));
    const outputHandle = await open(outputPath, 'wx', 0o600);
    const outputBytes = Buffer.from(JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    try { await outputHandle.writeFile(outputBytes); await outputHandle.sync(); } finally { await outputHandle.close(); }
    process.stdout.write(JSON.stringify({
      schema: evidence.schema, outputFile: basename(outputPath), evidenceSha256: sha256(outputBytes),
      eventBridgeUnique: reconciled.counts.eventBridgeUnique,
      eventBridgeDuplicates: reconciled.counts.eventBridgeDuplicates,
      cloudTrailBackupEvents: reconciled.counts.cloudTrailAwsBackupUnique,
      outOfScopeCloudTrailBackupEvents: outOfScopeBackupRecordCount,
      correlatedCopyJobs: reconciled.counts.correlatedCopyJobs,
      copyJobsObservedInBothSources: reconciled.counts.copyJobsObservedInBothSources,
      digestFilesValid: second.digestFilesValid, digestFilesTotal: second.digestFilesTotal,
      backfillDigestFilesValid: second.backfillDigestFilesValid, backfillDigestFilesTotal: second.backfillDigestFilesTotal,
      logFilesValid: second.logFilesValid, logFilesTotal: second.logFilesTotal,
      requestedCloudTrailWindowFullyCovered: second.requestedWindowFullyCovered,
      signed: false, productionAccepted: false,
    }, null, 2) + '\n');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write('AWS Backup audit export refused: ' + (error instanceof Error ? error.message : 'unknown error') + '\n');
    process.exitCode = 1;
  });
}
