import { createHash, createPublicKey, verify } from 'node:crypto';

export const AUDIT_EVIDENCE_SCHEMA = 'factoryos.aws-backup-copy-job-audit-evidence/v1';
export const AUDIT_ATTESTATION_SCHEMA = 'factoryos.aws-backup-copy-job-audit-attestation/v1';
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
function requireString(value, name, pattern = null) {
  if (typeof value !== 'string' || value.length < 1 || value.trim() !== value || (pattern && !pattern.test(value))) {
    throw new Error(name + ' is invalid');
  }
  return value;
}
function normalizeCloudTrailCliTimestamp(value) {
  return value.trim().replace(/\s*T\s*/, 'T').replace(/\s+Z$/, 'Z');
}
function requireIso(value, name) {
  requireString(value, name);
  const normalized = normalizeCloudTrailCliTimestamp(value);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed) || !/[zZ]|[+-]\d\d:\d\d$/.test(normalized)) {
    throw new Error(name + ' must be an offset-aware ISO-8601 timestamp');
  }
  return new Date(parsed).toISOString();
}

export function parseCloudTrailValidateLogsOutput(output) {
  if (typeof output !== 'string' || output.length < 1 || output.length > 16 * 1024 * 1024) {
    throw new Error('CloudTrail validate-logs output is missing or exceeds 16 MiB');
  }
  if (/\bINVALID\b|\bERROR\b/i.test(output)) {
    throw new Error('CloudTrail digest/log validation reported an INVALID or ERROR result');
  }
  const digestUris = [];
  const logUris = [];
  for (const line of output.split(/\r?\n/)) {
    const digest = line.match(/^\s*(?:\(backfill\)\s*)?Digest file\s+(s3:\/\/\S+)\s+valid\s*$/i);
    const log = line.match(/^\s*Log file\s+(s3:\/\/\S+)\s+valid\s*$/i);
    if (digest) digestUris.push(digest[1]);
    if (log) logUris.push(log[1]);
  }
  const digestSummaries = [...output.matchAll(/(\d+)\s*\/\s*(\d+)\s+(backfill\s+)?digest files valid\b/gi)];
  const logSummaries = [...output.matchAll(/(\d+)\s*\/\s*(\d+)\s+log files valid\b/gi)];
  const sum = (rows) => rows.reduce((acc, row) => ({
    valid: acc.valid + Number(row[1]), total: acc.total + Number(row[2]),
    backfillValid: acc.backfillValid + (row[3] ? Number(row[1]) : 0),
    backfillTotal: acc.backfillTotal + (row[3] ? Number(row[2]) : 0),
  }), { valid: 0, total: 0, backfillValid: 0, backfillTotal: 0 });
  const digests = sum(digestSummaries);
  const logs = sum(logSummaries);
  if (!digestSummaries.length || digests.total < 1 || digests.valid !== digests.total) {
    throw new Error('CloudTrail standard/backfill digest validation is incomplete or did not validate every digest file');
  }
  if (!logSummaries.length || logs.valid !== logs.total) {
    throw new Error('CloudTrail log validation summary is absent or incomplete');
  }
  if (digestUris.length !== digests.total || logUris.length !== logs.total) {
    throw new Error('CloudTrail verbose file list does not match the digest/log validation summary counts');
  }
  if (new Set(digestUris).size !== digestUris.length || new Set(logUris).size !== logUris.length) {
    throw new Error('CloudTrail validation output contains duplicate object references');
  }
  const cliTime = String.raw`(\d{4}-\d{2}-\d{2}\s*T\s*\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*Z)`;
  const found = output.match(new RegExp('Results found for\\s+' + cliTime + '\\s+to\\s+' + cliTime + ':', 'i'));
  const requested = output.match(new RegExp('Results requested for\\s+' + cliTime + '\\s+to\\s+' + cliTime, 'i'));
  if (!found || !requested) {
    throw new Error('CloudTrail validation output does not declare requested and found time ranges');
  }
  const coverage = {
    startTime: requireIso(found[1], 'CloudTrail found-range start'),
    endTime: requireIso(found[2].replace(/:$/, ''), 'CloudTrail found-range end'),
    requestedStartTime: requireIso(requested[1], 'CloudTrail requested-range start'),
    requestedEndTime: requireIso(requested[2], 'CloudTrail requested-range end'),
  };
  return {
    digestFilesValid: digests.valid, digestFilesTotal: digests.total,
    backfillDigestFilesValid: digests.backfillValid, backfillDigestFilesTotal: digests.backfillTotal,
    logFilesValid: logs.valid, logFilesTotal: logs.total,
    digestUris, logUris, reportedCoverage: coverage,
    requestedWindowFullyCovered: Date.parse(coverage.startTime) <= Date.parse(coverage.requestedStartTime)
      && Date.parse(coverage.endTime) >= Date.parse(coverage.requestedEndTime),
    outputSha256: sha256(Buffer.from(output, 'utf8')),
  };
}

export function assertReplayCaptureRule(rule, targets, captureRuleName, captureQueueArn, captureDlqArn, accountId, region) {
  if (!rule || rule.Name !== captureRuleName || rule.State !== 'ENABLED' || rule.EventBusName !== 'default') {
    throw new Error('Replay capture rule is missing, disabled or not on the default event bus');
  }
  const pattern = typeof rule.EventPattern === 'string' ? JSON.parse(rule.EventPattern) : rule.EventPattern;
  if (!pattern || JSON.stringify(pattern.source) !== JSON.stringify(['aws.backup'])
    || JSON.stringify(pattern['detail-type']) !== JSON.stringify(['Copy Job State Change'])
    || JSON.stringify(pattern['replay-name']) !== JSON.stringify([{ exists: true }])) {
    throw new Error('Replay capture rule must exclusively match replayed AWS Backup Copy Job State Change events');
  }
  const arnParts = typeof rule.Arn === 'string' ? rule.Arn.split(':') : [];
  if (arnParts[2] !== 'events' || arnParts[3] !== region || arnParts[4] !== accountId
    || !rule.Arn.endsWith('/' + captureRuleName)) {
    throw new Error('Capture rule ARN is outside the exact account/Region/name scope');
  }
  if (!Array.isArray(targets) || targets.length !== 1 || targets[0]?.Id !== 'ReplayCaptureQueue'
    || targets[0]?.Arn !== captureQueueArn || targets[0]?.DeadLetterConfig?.Arn !== captureDlqArn
    || targets[0]?.RetryPolicy?.MaximumEventAgeInSeconds !== 86400
    || targets[0]?.RetryPolicy?.MaximumRetryAttempts !== 185) {
    throw new Error('Capture rule must have only the declared SQS target and bounded retry/DLQ policy');
  }
  return {
    ruleName: captureRuleName, ruleArn: rule.Arn,
    rulePatternSha256: sha256(Buffer.from(JSON.stringify(pattern))),
    targetsSha256: sha256(Buffer.from(JSON.stringify(targets))),
  };
}

function parseQueuePolicy(raw, resourceArn, ruleArn, accountId, label) {
  let policy;
  try { policy = JSON.parse(raw || '{}'); } catch { throw new Error(label + ' policy is invalid JSON'); }
  const statements = policy.Statement;
  if (policy.Version !== '2012-10-17' || !Array.isArray(statements) || statements.length !== 1
    || statements[0].Effect !== 'Allow' || statements[0].Principal?.Service !== 'events.amazonaws.com'
    || statements[0].Action !== 'sqs:SendMessage' || statements[0].Resource !== resourceArn
    || statements[0].Condition?.ArnEquals?.['aws:SourceArn'] !== ruleArn
    || statements[0].Condition?.StringEquals?.['aws:SourceAccount'] !== accountId) {
    throw new Error(label + ' policy does not authorize only the exact EventBridge capture rule and account');
  }
  return policy;
}
function assertQueueEmpty(attributes, label) {
  for (const key of ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed']) {
    if (!Object.hasOwn(attributes, key) || Number(attributes[key]) !== 0) {
      throw new Error(label + ' must be empty before or after the approved replay; ' + key + ' is non-zero or unavailable');
    }
  }
}
export function assertReplayQueueAttributes(attributes, queueArn, dlqArn, ruleArn, accountId, requireEmpty = true) {
  if (!attributes || attributes.QueueArn !== queueArn || attributes.SqsManagedSseEnabled !== 'true'
    || Number(attributes.MessageRetentionPeriod) !== 1209600) {
    throw new Error('Replay capture queue must use the declared ARN, SQS encryption and 14-day message retention');
  }
  if (requireEmpty) assertQueueEmpty(attributes, 'Replay capture queue');
  let redrive;
  try { redrive = JSON.parse(attributes.RedrivePolicy || '{}'); } catch {
    throw new Error('Replay capture queue redrive policy is invalid JSON');
  }
  if (redrive.deadLetterTargetArn !== dlqArn || Number(redrive.maxReceiveCount) !== 5) {
    throw new Error('Replay capture queue SQS redrive configuration is invalid');
  }
  const policy = parseQueuePolicy(attributes.Policy, queueArn, ruleArn, accountId, 'Replay capture queue');
  return {
    queueArn, sse: attributes.SqsManagedSseEnabled, messageRetentionPeriod: Number(attributes.MessageRetentionPeriod),
    redrivePolicy: redrive, queuePolicySha256: sha256(Buffer.from(JSON.stringify(policy))),
  };
}
export function assertReplayDlqAttributes(attributes, dlqArn, ruleArn, accountId, requireEmpty = true) {
  if (!attributes || attributes.QueueArn !== dlqArn || attributes.SqsManagedSseEnabled !== 'true'
    || Number(attributes.MessageRetentionPeriod) !== 1209600) {
    throw new Error('Replay dead-letter queue must use the declared ARN, SQS encryption and 14-day retention');
  }
  if (requireEmpty) assertQueueEmpty(attributes, 'Replay dead-letter queue');
  const policy = parseQueuePolicy(attributes.Policy, dlqArn, ruleArn, accountId, 'Replay dead-letter queue');
  return {
    queueArn: dlqArn, sse: attributes.SqsManagedSseEnabled, messageRetentionPeriod: Number(attributes.MessageRetentionPeriod),
    queuePolicySha256: sha256(Buffer.from(JSON.stringify(policy))),
  };
}

export function reconcileAwsBackupCopyJobEvents(eventMessages, cloudTrailRecords, scope) {
  const accountId = requireString(scope.accountId, 'scope.accountId', /^\d{12}$/);
  const region = requireString(scope.region, 'scope.region', /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/);
  const replayName = requireString(scope.replayName, 'scope.replayName', SAFE_ID);
  if (!Array.isArray(eventMessages) || eventMessages.length > 500000) throw new Error('EventBridge capture list is absent or oversized');
  if (!Array.isArray(cloudTrailRecords) || cloudTrailRecords.length > 500000) throw new Error('CloudTrail record list is absent or oversized');
  const eventIds = new Map();
  const eventBridge = [];
  let eventBridgeDuplicateCount = 0;
  let eventBridgeMissingJobIdCount = 0;
  for (const message of eventMessages) {
    if (!message || typeof message !== 'object' || typeof message.body !== 'string') throw new Error('EventBridge capture contains a malformed SQS message');
    const bodyDigest = sha256(Buffer.from(message.body, 'utf8'));
    if (message.bodySha256 !== bodyDigest) throw new Error('EventBridge capture body digest mismatch');
    let envelope;
    try { envelope = JSON.parse(message.body); } catch { throw new Error('EventBridge capture contains invalid JSON'); }
    requireString(envelope.id, 'EventBridge envelope id', SAFE_ID);
    if (envelope.account !== accountId || envelope.region !== region || envelope.source !== 'aws.backup'
      || envelope['detail-type'] !== 'Copy Job State Change' || envelope['replay-name'] !== replayName) {
      throw new Error('EventBridge replay message is outside the sealed account/Region/source/replay scope');
    }
    if (!envelope.detail || typeof envelope.detail !== 'object' || Array.isArray(envelope.detail)) {
      throw new Error('EventBridge copy-job detail is malformed');
    }
    const copyJobId = typeof envelope.detail.copyJobId === 'string' && envelope.detail.copyJobId.trim()
      ? envelope.detail.copyJobId : null;
    const normalized = {
      source: 'EVENTBRIDGE', eventId: envelope.id, copyJobId,
      state: typeof envelope.detail.state === 'string' ? envelope.detail.state : null,
      eventTime: requireIso(envelope.time, 'EventBridge event time'),
      accountId, region, replayName, bodySha256: bodyDigest,
      sourceObjectReference: typeof message.sourceObjectReference === 'string' ? message.sourceObjectReference : null,
    };
    const prior = eventIds.get(envelope.id);
    if (prior) {
      if (prior !== bodyDigest) throw new Error('Conflicting EventBridge payloads share envelope id ' + envelope.id);
      eventBridgeDuplicateCount += 1; continue;
    }
    eventIds.set(envelope.id, bodyDigest);
    if (!copyJobId) eventBridgeMissingJobIdCount += 1;
    eventBridge.push(normalized);
  }

  const cloudTrailIds = new Map();
  const cloudTrail = [];
  let cloudTrailDuplicateCount = 0;
  let cloudTrailMissingJobIdCount = 0;
  for (const entry of cloudTrailRecords) {
    if (!entry || typeof entry !== 'object' || !entry.record || typeof entry.record !== 'object') {
      throw new Error('CloudTrail source contains a malformed record wrapper');
    }
    const record = entry.record;
    if (record.eventSource !== 'backup.amazonaws.com') continue;
    requireString(record.eventID, 'CloudTrail eventID', SAFE_ID);
    const eventDigest = sha256(Buffer.from(JSON.stringify(record), 'utf8'));
    if (entry.recordSha256 && entry.recordSha256 !== eventDigest) throw new Error('CloudTrail record digest mismatch');
    if (record.recipientAccountId !== accountId || record.awsRegion !== region) {
      throw new Error('CloudTrail AWS Backup event is outside the sealed account/Region scope');
    }
    const copyJobId = typeof record.responseElements?.copyJobId === 'string' ? record.responseElements.copyJobId
      : typeof record.requestParameters?.copyJobId === 'string' ? record.requestParameters.copyJobId : null;
    const normalized = {
      source: 'CLOUDTRAIL', eventId: record.eventID, copyJobId,
      eventName: requireString(record.eventName, 'CloudTrail eventName', SAFE_ID),
      eventTime: requireIso(record.eventTime, 'CloudTrail event time'),
      accountId, region, recordSha256: eventDigest,
      sourceObjectReference: typeof entry.sourceObjectReference === 'string' ? entry.sourceObjectReference : null,
    };
    const prior = cloudTrailIds.get(record.eventID);
    if (prior) {
      if (prior !== eventDigest) throw new Error('Conflicting CloudTrail payloads share eventID ' + record.eventID);
      cloudTrailDuplicateCount += 1; continue;
    }
    cloudTrailIds.set(record.eventID, eventDigest);
    if (!copyJobId) cloudTrailMissingJobIdCount += 1;
    cloudTrail.push(normalized);
  }
  const jobs = new Map();
  const add = (source, record) => {
    if (!record.copyJobId) return;
    const current = jobs.get(record.copyJobId) || {
      copyJobId: record.copyJobId, eventBridgeEventIds: [], cloudTrailEventIds: [],
    };
    current[source === 'EVENTBRIDGE' ? 'eventBridgeEventIds' : 'cloudTrailEventIds'].push(record.eventId);
    jobs.set(record.copyJobId, current);
  };
  eventBridge.forEach((record) => add('EVENTBRIDGE', record));
  cloudTrail.forEach((record) => add('CLOUDTRAIL', record));
  const correlated = [...jobs.values()].map((job) => ({
    ...job, sourcePresence: job.eventBridgeEventIds.length && job.cloudTrailEventIds.length
      ? 'BOTH_SOURCES' : job.eventBridgeEventIds.length ? 'EVENTBRIDGE_ONLY' : 'CLOUDTRAIL_ONLY',
  })).sort((a, b) => a.copyJobId.localeCompare(b.copyJobId));
  return {
    eventBridge, cloudTrail, correlatedJobs: correlated,
    counts: {
      eventBridgeReceived: eventMessages.length, eventBridgeUnique: eventBridge.length,
      eventBridgeDuplicates: eventBridgeDuplicateCount, eventBridgeMissingCopyJobId: eventBridgeMissingJobIdCount,
      cloudTrailAwsBackupUnique: cloudTrail.length, cloudTrailDuplicates: cloudTrailDuplicateCount,
      cloudTrailMissingCopyJobId: cloudTrailMissingJobIdCount, correlatedCopyJobs: correlated.length,
      copyJobsObservedInBothSources: correlated.filter((job) => job.sourcePresence === 'BOTH_SOURCES').length,
      copyJobsOnlyInEventBridge: correlated.filter((job) => job.sourcePresence === 'EVENTBRIDGE_ONLY').length,
      copyJobsOnlyInCloudTrail: correlated.filter((job) => job.sourcePresence === 'CLOUDTRAIL_ONLY').length,
    },
  };
}

export function canonicalAuditAttestationClaims(payload) {
  return JSON.stringify({
    schema: AUDIT_ATTESTATION_SCHEMA, attestationKeyId: payload.attestationKeyId,
    attestationOwnerReference: payload.attestationOwnerReference,
    evidenceSha256: payload.evidenceSha256, signedAt: payload.signedAt,
  });
}
export function verifyAuditAttestation(payload, signatureValue, trustedPublicKeyPem) {
  if (payload?.schema !== AUDIT_ATTESTATION_SCHEMA) throw new Error('attestation schema is invalid');
  requireString(payload.attestationKeyId, 'attestationKeyId', SAFE_ID);
  requireString(payload.attestationOwnerReference, 'attestationOwnerReference', SAFE_ID);
  if (!SHA256.test(payload.evidenceSha256)) throw new Error('evidenceSha256 is invalid');
  requireIso(payload.signedAt, 'signedAt');
  if (typeof signatureValue !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signatureValue)) {
    throw new Error('signature is not a canonical Ed25519 base64url value');
  }
  const key = createPublicKey(trustedPublicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('trusted audit key must be Ed25519');
  const signature = Buffer.from(signatureValue, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== signatureValue) throw new Error('signature encoding is not canonical');
  const message = Buffer.from(canonicalAuditAttestationClaims(payload), 'utf8');
  if (!verify(null, message, key, signature)) throw new Error('AWS Backup audit attestation signature does not match');
  return true;
}
