import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  AUDIT_ATTESTATION_SCHEMA, assertReplayCaptureRule, assertReplayDlqAttributes,
  assertReplayQueueAttributes, canonicalAuditAttestationClaims,
  parseCloudTrailValidateLogsOutput, reconcileAwsBackupCopyJobEvents,
  sha256, verifyAuditAttestation,
} from './aws-backup-copy-job-audit-evidence.mjs';

const root = new URL('../../', import.meta.url);
const accountId = '123456789012';
const region = 'us-east-1';
const replayName = 'audit-replay-20261102';
const ruleArn = 'arn:aws:events:' + region + ':' + accountId + ':rule/backup-replay-capture';
const queueArn = 'arn:aws:sqs:' + region + ':' + accountId + ':backup-replay-capture';
const dlqArn = 'arn:aws:sqs:' + region + ':' + accountId + ':backup-replay-capture-dlq';
const envelope = (id, detail = { copyJobId: 'copy-01', state: 'COMPLETED' }, overrides = {}) => ({
  id, account: accountId, region, time: '2026-11-02T10:00:00Z',
  source: 'aws.backup', 'detail-type': 'Copy Job State Change',
  'replay-name': replayName, detail, ...overrides,
});
const message = (event, messageId = 'sqs-message') => {
  const body = JSON.stringify(event);
  return { messageId, body, bodySha256: sha256(Buffer.from(body, 'utf8')) };
};
const cloudTrail = (eventID, copyJobId = 'copy-01', overrides = {}) => ({
  eventID, eventSource: 'backup.amazonaws.com', eventName: 'CopyJobCompleted',
  eventTime: '2026-11-02T10:01:00Z', awsRegion: region, recipientAccountId: accountId,
  responseElements: copyJobId ? { copyJobId } : {}, ...overrides,
});
function queueAttrs(arn, sourceArn, redrive) {
  return {
    QueueArn: arn, SqsManagedSseEnabled: 'true', MessageRetentionPeriod: '1209600',
    ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '0',
    ApproximateNumberOfMessagesDelayed: '0',
    RedrivePolicy: redrive ? JSON.stringify(redrive) : undefined,
    Policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' },
        Action: 'sqs:SendMessage', Resource: arn,
        Condition: { ArnEquals: { 'aws:SourceArn': sourceArn }, StringEquals: { 'aws:SourceAccount': accountId } },
      }],
    }),
  };
}

test('CloudTrail verbose parser requires all standard/backfill digest and log counts to validate', () => {
  const output = [
    'Digest file s3://audit-bucket/digest.json.gz valid',
    '(backfill) Digest file s3://audit-bucket/backfill.json.gz valid',
    'Log file s3://audit-bucket/log.json.gz valid',
    'Results requested for 2026-11-02T09:00:00Z to 2026-11-02T12:00:00Z',
    'Results found for 2026-11-02T08:00:00Z to 2026-11-02T13:00:00Z:',
    '1/1 digest files valid', '1/1 backfill digest files valid', '1/1 log files valid',
  ].join('\n');
  const parsed = parseCloudTrailValidateLogsOutput(output);
  assert.equal(parsed.digestFilesValid, 2);
  assert.equal(parsed.digestFilesTotal, 2);
  assert.equal(parsed.backfillDigestFilesTotal, 1);
  assert.equal(parsed.logFilesValid, 1);
  assert.equal(parsed.requestedWindowFullyCovered, true);
  const spacedCliOutput = output
    .replaceAll('2026-11-02T09:00:00Z', '2026-11-02 T09:00:00 Z')
    .replaceAll('2026-11-02T12:00:00Z', '2026-11-02 T12:00:00 Z')
    .replaceAll('2026-11-02T08:00:00Z', '2026-11-02 T08:00:00 Z')
    .replaceAll('2026-11-02T13:00:00Z', '2026-11-02 T13:00:00 Z');
  assert.equal(parseCloudTrailValidateLogsOutput(spacedCliOutput).requestedWindowFullyCovered, true);
  assert.throws(() => parseCloudTrailValidateLogsOutput(output.replace('1/1 digest files valid', '0/1 digest files valid')), /digest/i);
  assert.throws(() => parseCloudTrailValidateLogsOutput(output.replace('1/1 log files valid', '0/1 log files valid')), /log/i);
  assert.throws(() => parseCloudTrailValidateLogsOutput(output.replace('1/1 backfill digest files valid', '1/2 backfill digest files valid')), /summary counts/i);
  assert.throws(() => parseCloudTrailValidateLogsOutput(output.replace('1/1 backfill digest files valid', '1/1 backfill digest files INVALID')), /INVALID/i);
  assert.throws(() => parseCloudTrailValidateLogsOutput(output.replace('Results found for 2026-11-02T08:00:00Z to 2026-11-02T13:00:00Z:\n', '')), /time ranges/i);
  assert.throws(() => parseCloudTrailValidateLogsOutput(output.replace('s3://audit-bucket/digest.json.gz', 's3://audit-bucket/backfill.json.gz')), /duplicate/i);
});

test('reconciliation deduplicates by EventBridge id and CloudTrail eventID while preserving separate source observations', () => {
  const event1 = envelope('evt-1');
  const result = reconcileAwsBackupCopyJobEvents(
    [message(event1, 'msg-1'), message(event1, 'msg-duplicate'), message(envelope('evt-2', { state: 'CREATED' }), 'msg-2')],
    [
      { record: cloudTrail('ct-1') },
      { record: cloudTrail('ct-1') },
      { record: cloudTrail('ct-2', null) },
      { record: { eventSource: 's3.amazonaws.com', eventID: 'ignored' } },
    ],
    { accountId, region, replayName },
  );
  assert.deepEqual({
    eventUnique: result.counts.eventBridgeUnique,
    eventDupes: result.counts.eventBridgeDuplicates,
    eventMissingId: result.counts.eventBridgeMissingCopyJobId,
    trailUnique: result.counts.cloudTrailAwsBackupUnique,
    trailDupes: result.counts.cloudTrailDuplicates,
    trailMissingId: result.counts.cloudTrailMissingCopyJobId,
    both: result.counts.copyJobsObservedInBothSources,
  }, { eventUnique: 2, eventDupes: 1, eventMissingId: 1, trailUnique: 2, trailDupes: 1, trailMissingId: 1, both: 1 });
  assert.equal(result.eventBridge.length, 2);
  assert.equal(result.cloudTrail.length, 2);
  assert.equal(result.correlatedJobs[0].sourcePresence, 'BOTH_SOURCES');
  assert.throws(() => reconcileAwsBackupCopyJobEvents([
    message(event1), message(envelope('evt-1', { copyJobId: 'copy-02', state: 'FAILED' })),
  ], [], { accountId, region, replayName }), /Conflicting EventBridge/);
  assert.throws(() => reconcileAwsBackupCopyJobEvents([], [
    { record: cloudTrail('ct-conflict') },
    { record: cloudTrail('ct-conflict', 'copy-99') },
  ], { accountId, region, replayName }), /Conflicting CloudTrail/);
  assert.throws(() => reconcileAwsBackupCopyJobEvents([message(envelope('evt-3', {}, { region: 'us-west-2' }))], [],
    { accountId, region, replayName }), /outside the sealed/);
  assert.throws(() => reconcileAwsBackupCopyJobEvents([], [{ record: cloudTrail('ct-3', 'copy-01', { recipientAccountId: '999999999999' }) }],
    { accountId, region, replayName }), /outside the sealed/);
});

test('SQS capture resource policies are exact-account, exact-rule, encrypted, bounded and empty before replay', () => {
  const rule = {
    Name: 'backup-replay-capture', State: 'ENABLED', EventBusName: 'default', Arn: ruleArn,
    EventPattern: { source: ['aws.backup'], 'detail-type': ['Copy Job State Change'], 'replay-name': [{ exists: true }] },
  };
  const targets = [{
    Id: 'ReplayCaptureQueue', Arn: queueArn, DeadLetterConfig: { Arn: dlqArn },
    RetryPolicy: { MaximumEventAgeInSeconds: 86400, MaximumRetryAttempts: 185 },
  }];
  assertReplayCaptureRule(rule, targets, rule.Name, queueArn, dlqArn, accountId, region);
  assertReplayQueueAttributes(queueAttrs(queueArn, ruleArn, { deadLetterTargetArn: dlqArn, maxReceiveCount: 5 }),
    queueArn, dlqArn, ruleArn, accountId);
  assertReplayDlqAttributes(queueAttrs(dlqArn, ruleArn), dlqArn, ruleArn, accountId);
  const occupied = queueAttrs(queueArn, ruleArn, { deadLetterTargetArn: dlqArn, maxReceiveCount: 5 });
  occupied.ApproximateNumberOfMessages = '1';
  assert.throws(() => assertReplayQueueAttributes(occupied, queueArn, dlqArn, ruleArn, accountId), /must be empty/);
  assert.doesNotThrow(() => assertReplayQueueAttributes(occupied, queueArn, dlqArn, ruleArn, accountId, false));
  const widened = queueAttrs(queueArn, ruleArn, { deadLetterTargetArn: dlqArn, maxReceiveCount: 5 });
  const policy = JSON.parse(widened.Policy);
  policy.Statement[0].Condition.ArnEquals['aws:SourceArn'] = '*';
  widened.Policy = JSON.stringify(policy);
  assert.throws(() => assertReplayQueueAttributes(widened, queueArn, dlqArn, ruleArn, accountId), /exact EventBridge/);
  const missingCount = queueAttrs(queueArn, ruleArn, { deadLetterTargetArn: dlqArn, maxReceiveCount: 5 });
  delete missingCount.ApproximateNumberOfMessagesDelayed;
  assert.throws(() => assertReplayQueueAttributes(missingCount, queueArn, dlqArn, ruleArn, accountId), /unavailable/);
  assert.throws(() => assertReplayCaptureRule(rule, [...targets, targets[0]], rule.Name, queueArn, dlqArn, accountId, region), /only the declared SQS target/);
});

test('Ed25519 attestation binds the exact evidence digest and rejects tampering', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const claims = {
    schema: AUDIT_ATTESTATION_SCHEMA, attestationKeyId: 'backup-audit-key-2026',
    attestationOwnerReference: 'security-owner-approval-42',
    evidenceSha256: sha256(Buffer.from('exact evidence bytes')), signedAt: '2026-11-02T10:00:00.000Z',
  };
  const signature = sign(null, Buffer.from(canonicalAuditAttestationClaims(claims)), privateKey).toString('base64url');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.equal(verifyAuditAttestation(claims, signature, publicPem), true);
  assert.throws(() => verifyAuditAttestation({ ...claims, evidenceSha256: 'f'.repeat(64) }, signature, publicPem), /signature does not match/);
  assert.throws(() => verifyAuditAttestation({ ...claims, schema: 'wrong-schema' }, signature, publicPem), /schema is invalid/);
});

test('CloudFormation and CLI enforce a single replay filter, exact SQS targets and non-destructive backup boundaries', async () => {
  const template = JSON.parse(await readFile(new URL('deploy/aws/aws-backup-copy-job-replay-capture.template.json', root), 'utf8'));
  const resources = template.Resources;
  assert.equal(template.Parameters.CaptureRuleName.Type, 'String');
  assert.match(template.Parameters.CaptureRuleName.AllowedPattern, /1,64/);
  assert.equal(resources.ReplayCaptureRule.Properties.Targets.length, 1);
  assert.equal(resources.ReplayCaptureRule.Properties.Targets[0].DeadLetterConfig.Arn['Fn::GetAtt'][0], 'ReplayCaptureDeadLetterQueue');
  assert.equal(resources.ReplayCaptureRule.Properties.Targets[0].RetryPolicy.MaximumRetryAttempts, 185);
  assert.equal(resources.ReplayCaptureQueue.Properties.SqsManagedSseEnabled, true);
  assert.equal(resources.ReplayCaptureQueue.Properties.RedrivePolicy.maxReceiveCount, 5);
  assert.equal(resources.ReplayCaptureDeadLetterQueue.Properties.MessageRetentionPeriod, 1209600);
  assert.equal(resources.ReplayCaptureQueuePolicy.Properties.PolicyDocument.Statement[0].Condition.ArnEquals['aws:SourceArn']['Fn::GetAtt'][0], 'ReplayCaptureRule');
  assert.equal(resources.ReplayCaptureDeadLetterQueuePolicy.Properties.PolicyDocument.Statement[0].Condition.ArnEquals['aws:SourceArn']['Fn::GetAtt'][0], 'ReplayCaptureRule');
  const start = await readFile(new URL('scripts/security/start-aws-backup-copy-job-replay.mjs', root), 'utf8');
  const capture = await readFile(new URL('scripts/security/capture-aws-backup-copy-job-replay.mjs', root), 'utf8');
  const exporter = await readFile(new URL('scripts/security/export-aws-backup-copy-job-audit-evidence.mjs', root), 'utf8');
  const verifier = await readFile(new URL('scripts/security/verify-aws-backup-copy-job-audit-attestation.mjs', root), 'utf8');
  assert.match(start, /FilterArns:\s*\[verified\.ruleArn\]/);
  assert.match(start, /productionRulesSelected:\s*0/);
  assert.match(start, /Replay manifest bytes differ from the preflight receipt/);
  assert.match(start, /describe-archive/);
  assert.match(capture, /queueAcknowledgedOnlyAfterCaptureFsyncAndAtomicRename/);
  assert.match(capture, /replayDestination\.Arn !== preflight\.eventBusArn/);
  assert.match(capture, /eventTime < Date\.parse\(manifest\.eventStartTime\)/);
  assert.match(capture, /captureQueuePostReadBackSha256/);
  assert.match(capture, /deadLetterQueuePostReadBackCounts/);
  assert.match(capture, /captureQuietPolls/);
  assert.match(capture, /delete-message-batch/);
  assert.match(exporter, /cloudtrail',\s*'validate-logs/);
  assert.match(exporter, /cloudtrail',\s*'describe-trails/);
  assert.match(exporter, /cloudtrail',\s*'get-trail-status/);
  assert.match(exporter, /cloudtrail',\s*'get-event-selectors/);
  assert.match(exporter, /get-bucket-policy/);
  assert.match(exporter, /trail\.S3KeyPrefix !== manifest\.trailS3KeyPrefix/);
  assert.match(exporter, /get-object-lock-configuration/);
  assert.match(exporter, /get-bucket-versioning/);
  assert.match(exporter, /get-bucket-encryption/);
  assert.match(exporter, /const MAX_OBJECTS = 5000/);
  assert.match(exporter, /const MAX_TOTAL_DECOMPRESSED_BYTES = 1024 \* 1024 \* 1024/);
  assert.match(exporter, /kms',\s*'describe-key/);
  assert.match(verifier, /verifyAuditAttestation/);
  assert.match(verifier, /eventBridgeCaptureDeadLetterQueueEmptyAfterReadBack/);
  assert.match(verifier, /expected-key-id/);
  assert.match(verifier, /expected-owner-reference/);
  assert.match(exporter, /get-object-retention/);
  assert.match(exporter, /get-object-legal-hold/);
  assert.match(exporter, /--version-id/);
  assert.doesNotMatch(start + capture + exporter, /backup\s+(?:copy|restore|delete|start-backup-job|delete-backup-vault)/i);
});

test('operator documentation makes the coverage and deployment boundary explicit', async () => {
  const doc = await readFile(new URL('docs/aws-backup-copy-job-audit-reconciliation.md', root), 'utf8');
  assert.match(doc, /best effort/i);
  assert.match(doc, /FilterArns/);
  assert.match(doc, /backfill digest/i);
  assert.match(doc, /EventBridge envelope id/i);
  assert.match(doc, /CloudTrail eventID/i);
  assert.match(doc, /historicalLedgerComplete=false/);
  assert.match(doc, /No AWS stack has been deployed/i);
  assert.match(doc, /separate evidence reviewer/i);
  assert.match(doc, /trailS3KeyPrefix/);
  assert.match(doc, /5,000 S3 objects/);
});
