import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function fail(message) {
  console.error('DR operator sign-off rejected: ' + message);
  process.exit(2);
}

function argumentsMap(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--') || i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      fail('expected --name value arguments');
    }
    if (values[key.slice(2)] !== undefined) fail('duplicate argument: ' + key);
    values[key.slice(2)] = argv[++i];
  }
  return values;
}

const args = argumentsMap(process.argv.slice(2));
for (const key of ['evidence', 'decision', 'operator', 'approver', 'notes', 'reference']) {
  if (!args[key] || !args[key].trim()) fail('missing required --' + key);
}
if (!['PASS', 'FAIL'].includes(args.decision)) fail('--decision must be PASS or FAIL');
if (args.operator.trim() === args.approver.trim()) fail('operator and approver must be different people');
if (args.notes.trim().length < 10) fail('--notes must contain at least 10 characters');
if (args.reference.trim().length < 3) fail('--reference must identify an approved change/incident record');

const evidencePath = resolve(args.evidence);
const evidenceBytes = await readFile(evidencePath).catch(() => fail('evidence file is missing or unreadable'));
const evidenceSha256 = createHash('sha256').update(evidenceBytes).digest('hex');
let evidence;
try {
  evidence = JSON.parse(evidenceBytes.toString('utf8'));
} catch {
  fail('evidence file is not valid JSON');
}
if (evidence.schema !== 'factoryos.disaster-recovery-rehearsal/v1') fail('unsupported evidence schema');

let approvalEvidencePath = null;
let approvalEvidenceSha256 = null;
let approvalEvidence = null;
if (args.decision === 'PASS') {
  if (!args['approval-evidence']?.trim()) fail('PASS sign-off requires --approval-evidence from the authenticated GitHub Environment approval step');
  approvalEvidencePath = resolve(args['approval-evidence']);
  const approvalStat = await lstat(approvalEvidencePath).catch(() => fail('GitHub Environment approval evidence is missing or unreadable'));
  if (!approvalStat.isFile() || approvalStat.isSymbolicLink() || (approvalStat.mode & 0o022) !== 0) {
    fail('GitHub Environment approval evidence must be a protected regular file, not a symlink');
  }
  const approvalBytes = await readFile(approvalEvidencePath).catch(() => fail('GitHub Environment approval evidence could not be read'));
  approvalEvidenceSha256 = createHash('sha256').update(approvalBytes).digest('hex');
  try {
    approvalEvidence = JSON.parse(approvalBytes.toString('utf8'));
  } catch {
    fail('GitHub Environment approval evidence is not valid JSON');
  }
  const workflowRunId = evidence.workflow?.runId;
  const repository = evidence.workflow?.repository;
  const expectedApprovalUrl = typeof repository === 'string' && Number.isSafeInteger(workflowRunId)
    ? `https://api.github.com/repos/${repository}/actions/runs/${workflowRunId}/approvals`
    : null;
  const approvalIdentityMatches = typeof approvalEvidence.approvedBy === 'string'
    && approvalEvidence.approvedBy.toLowerCase() === args.approver.trim().toLowerCase();
  const operatorIdentityMatches = typeof approvalEvidence.operator === 'string'
    && approvalEvidence.operator.toLowerCase() === args.operator.trim().toLowerCase()
    && typeof evidence.workflow?.actor === 'string'
    && evidence.workflow.actor.toLowerCase() === args.operator.trim().toLowerCase();
  const targetApprovalMatches = approvalEvidence.targetApproval?.approved === (evidence.measured?.approvedTargets === true)
    && (evidence.measured?.approvedTargets !== true
      || (approvalEvidence.targetApproval?.rpoSeconds === evidence.measured?.approvedRpoTargetSeconds
        && approvalEvidence.targetApproval?.rtoSeconds === evidence.measured?.approvedRtoTargetSeconds));
  const approvalChecks = [
    ['approval attestation schema', approvalEvidence.schema === 'factoryos.dr-environment-approval/v1'],
    ['approval attestation source', approvalEvidence.source === 'GITHUB_ACTIONS_WORKFLOW_RUN_APPROVALS_API'],
    ['approval repository matches the evidence', approvalEvidence.repository === repository && typeof repository === 'string'],
    ['approval workflow run matches the evidence', approvalEvidence.workflowRunId === workflowRunId && Number.isSafeInteger(workflowRunId) && workflowRunId > 0],
    ['approval history URL is canonical for this run', approvalEvidence.approvalHistoryUrl === expectedApprovalUrl],
    ['approval history digest', /^[a-f0-9]{64}$/.test(approvalEvidence.approvalHistorySha256 ?? '')],
    ['approval environment', approvalEvidence.environment === 'production-dr-rehearsal' && evidence.workflow?.environment === 'production-dr-rehearsal'],
    ['approval candidate matches the evidence', approvalEvidence.candidateSha === evidence.candidate?.commitSha],
    ['actual GitHub reviewer matches the named approver', approvalIdentityMatches],
    ['actual GitHub operator matches the evidence', operatorIdentityMatches],
    ['approval is independent of the operator', approvalIdentityMatches && operatorIdentityMatches && approvalEvidence.approvedBy.toLowerCase() !== approvalEvidence.operator.toLowerCase()],
    ['RPO/RTO owner approval matches measured targets', targetApprovalMatches],
  ];
  const failedApprovalChecks = approvalChecks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failedApprovalChecks.length) fail('PASS sign-off requires verified GitHub Environment approval evidence for: ' + failedApprovalChecks.join(', '));
}

function utcEpochSeconds(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
}

if (args.decision === 'PASS') {
  if (!evidence.databases?.distinctIdentityVerified || !evidence.databases?.targetWasEmptyBeforeRestore) {
    fail('PASS sign-off requires proof of distinct source/restore identity and an empty target');
  }
  const startedAt = utcEpochSeconds(evidence.timestamps?.startedAtUtc);
  const finishedAt = utcEpochSeconds(evidence.timestamps?.finishedAtUtc);
  const sourceWatermark = utcEpochSeconds(evidence.timestamps?.sourceWatermarkUtc);
  const restoredWatermark = utcEpochSeconds(evidence.timestamps?.restoredWatermarkUtc);
  const eventAt = utcEpochSeconds(evidence.timestamps?.simulatedIncidentAtUtc);
  const approvedBackupCreatedAt = utcEpochSeconds(evidence.backup?.approvedBackupCreatedAtUtc);
  const erasureLedgerWatermark = utcEpochSeconds(evidence.verification?.erasureReplayLedgerWatermarkUtc);
  const erasureLedgerWatermarkMs = Date.parse(evidence.verification?.erasureReplayLedgerWatermarkUtc ?? '');
  const eventAtMs = Date.parse(evidence.timestamps?.simulatedIncidentAtUtc ?? '');
  const finishedAtMs = Date.parse(evidence.timestamps?.finishedAtUtc ?? '');
  const candidateManifestPath = evidence.candidate?.migrationManifestPath;
  const manifestPathIsSafe = typeof candidateManifestPath === 'string'
    && candidateManifestPath.length > 0
    && candidateManifestPath === candidateManifestPath.trim()
    && !candidateManifestPath.startsWith('/')
    && !candidateManifestPath.includes('\\')
    && !candidateManifestPath.split('/').includes('..');

  const checks = [
    ['GitHub Environment reviewer approval evidence', approvalEvidence !== null],
    ['workflow actor and named operator', evidence.workflow?.actor?.toLowerCase() === args.operator.trim().toLowerCase()],
    ['named reviewer and evidence approver', evidence.operatorSignoff?.approver?.toLowerCase() === args.approver.trim().toLowerCase()],
    ['status', evidence.status === 'TECHNICAL_PASS'],
    ['exact candidate commit SHA', typeof evidence.candidate?.commitSha === 'string' && /^[a-f0-9]{40}$/.test(evidence.candidate.commitSha)],
    ['relative candidate migration manifest path', manifestPathIsSafe],
    ['source database identity', typeof evidence.databases?.sourceIdentity === 'string' && evidence.databases.sourceIdentity.trim().length > 0],
    ['restore target database identity', typeof evidence.databases?.restoreTargetIdentity === 'string' && evidence.databases.restoreTargetIdentity.trim().length > 0],
    ['UTC rehearsal timestamps', startedAt !== null && finishedAt !== null && sourceWatermark !== null && restoredWatermark !== null && eventAt !== null && finishedAt >= startedAt && finishedAt >= eventAt],
    ['non-negative measured RPO', Number.isSafeInteger(evidence.measured?.observedRpoSeconds) && evidence.measured.observedRpoSeconds >= 0],
    ['RPO matches event cutoff and restored watermark', eventAt !== null && restoredWatermark !== null && restoredWatermark <= eventAt && evidence.measured?.observedRpoSeconds === eventAt - restoredWatermark],
    ['non-negative measured RTO', Number.isSafeInteger(evidence.measured?.observedRtoSeconds) && evidence.measured.observedRtoSeconds >= 0],
    ['measured approved backup creation duration', Number.isSafeInteger(evidence.measured?.backupDurationSeconds) && evidence.measured.backupDurationSeconds >= 0],
    ['measured backup artifact verification duration', Number.isSafeInteger(evidence.measured?.backupArtifactVerificationDurationSeconds) && evidence.measured.backupArtifactVerificationDurationSeconds >= 0],
    ['measured restore and verification duration', Number.isSafeInteger(evidence.measured?.restoreAndVerificationDurationSeconds) && evidence.measured.restoreAndVerificationDurationSeconds >= 0],
    ['encrypted backup', evidence.backup?.encryption === 'ENCRYPTED_GPG'],
    ['approved backup artifact source', evidence.backup?.sourceMode === 'APPROVED_ARTIFACT'],
    ['approved backup manifest path', typeof evidence.backup?.approvedManifestPath === 'string' && evidence.backup.approvedManifestPath.startsWith('/')],
    ['approved backup manifest digest', /^[a-f0-9]{64}$/.test(evidence.backup?.approvedManifestSha256 ?? '')],
    ['approved backup detached signature path', typeof evidence.backup?.approvedSignaturePath === 'string' && evidence.backup.approvedSignaturePath.startsWith('/')],
    ['approved backup detached signature digest', /^[a-f0-9]{64}$/.test(evidence.backup?.approvedSignatureSha256 ?? '')],
    ['approved backup signature from pinned signer', evidence.backup?.signatureVerification === 'VALID_PINNED_SIGNER' && /^[A-F0-9]{40}([A-F0-9]{24})?$/.test(evidence.backup?.approvedSignerFingerprint ?? '')],
    ['approved backup source identity', evidence.backup?.approvedBackupSourceDatabaseIdentity === evidence.databases?.sourceIdentity],
    ['approved backup creation time precedes incident', approvedBackupCreatedAt !== null && eventAt !== null && approvedBackupCreatedAt <= eventAt],
    ['approved backup encryption recipient fingerprint', /^[A-F0-9]{40}([A-F0-9]{24})?$/.test(evidence.backup?.approvedBackupRecipientFingerprint ?? '')],
    ['approved backup source PostgreSQL version', typeof evidence.backup?.approvedBackupSourceServerVersion === 'string' && evidence.backup.approvedBackupSourceServerVersion.trim().length > 0],
    ['checksum', evidence.backup?.checksumVerified === true && /^[a-f0-9]{64}$/.test(evidence.backup?.sha256 ?? '')],
    ['archive readability', evidence.backup?.archiveReadability === 'READABLE'],
    ['restore', evidence.verification?.restoreStatus === 'PASS'],
    ['pending release migration manifest', evidence.candidate?.migrationManifestMode === 'PENDING' && evidence.candidate?.migrationStatus === 'PASS' && Number.isSafeInteger(evidence.candidate?.migrationCount) && evidence.candidate.migrationCount >= 0 && /^[a-f0-9]{64}$/.test(evidence.candidate?.migrationManifestSha256 ?? '')],
    ['failed-transaction recovery', evidence.verification?.migrationRecoveryStatus === 'PASS'],
    ['restored schema smoke', evidence.verification?.schemaSmokeStatus === 'PASS'],
    ['running candidate API readiness', evidence.verification?.apiReadinessStatus === 'PASS'],
    ['application smoke', evidence.verification?.applicationSmokeStatus === 'PASS'],
    ['tenant isolation', evidence.verification?.tenantIsolationStatus === 'PASS'],
    ['audit continuity', evidence.verification?.auditContinuityStatus === 'PASS'],
    ['restore-time erasure tombstone replay', evidence.verification?.erasureReplayStatus === 'PASS'],
    ['opaque erasure ledger reference', typeof evidence.verification?.erasureReplayLedgerReference === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(evidence.verification.erasureReplayLedgerReference)],
    ['erasure ledger digest', /^[a-f0-9]{64}$/.test(evidence.verification?.erasureReplayLedgerSha256 ?? '')],
    ['erasure replay SQL digest', /^[a-f0-9]{64}$/.test(evidence.verification?.erasureReplaySqlSha256 ?? '')],
    ['erasure verification SQL digest', /^[a-f0-9]{64}$/.test(evidence.verification?.erasureVerificationSqlSha256 ?? '')],
    ['read-only erasure verification method', evidence.verification?.erasureVerificationMethod === 'INDEPENDENT_READ_ONLY'],
    ['erasure ledger watermark covers incident cutoff', erasureLedgerWatermark !== null && Number.isFinite(eventAtMs) && Number.isFinite(finishedAtMs) && Number.isFinite(erasureLedgerWatermarkMs) && erasureLedgerWatermarkMs >= eventAtMs && erasureLedgerWatermarkMs <= finishedAtMs],
    ['erasure replay request count', Number.isSafeInteger(evidence.verification?.erasureReplayRequests) && evidence.verification.erasureReplayRequests >= 0],
    ['independent verifier request count matches replay', Number.isSafeInteger(evidence.verification?.erasureVerificationRequests) && evidence.verification.erasureVerificationRequests === evidence.verification?.erasureReplayRequests],
    ['zero independent verification residuals', evidence.verification?.erasureVerificationResiduals === 0],
    ['zero erasure replay residuals', evidence.verification?.erasureReplayResiduals === 0],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) fail('PASS sign-off requires successful evidence for: ' + failed.join(', '));
  if (evidence.measured?.approvedTargets === true) {
    const rpoTarget = evidence.measured?.approvedRpoTargetSeconds;
    const rtoTarget = evidence.measured?.approvedRtoTargetSeconds;
    if (!Number.isSafeInteger(rpoTarget) || rpoTarget < 0 || !Number.isSafeInteger(rtoTarget) || rtoTarget < 0) {
      fail('approved RPO/RTO targets must be non-negative integer seconds');
    }
    if (evidence.measured.observedRpoSeconds > rpoTarget || evidence.measured.observedRtoSeconds > rtoTarget
      || evidence.measured.targetAssessment !== 'WITHIN_APPROVED_TARGETS') {
      fail('observed RPO/RTO exceed or do not satisfy approved targets');
    }
  } else if (evidence.measured?.targetAssessment !== 'NOT_APPROVED_NOT_CONTRACTUAL') {
    fail('unapproved RPO/RTO values must not be labelled contractual or within approved targets');
  }
}
const output = evidencePath + '.signoff.json';
const signoff = {
  schema: 'factoryos.disaster-recovery-operator-signoff/v1',
  decision: args.decision,
  signedAtUtc: new Date().toISOString(),
  operator: args.operator.trim(),
  approver: args.approver.trim(),
  approvalReference: args.reference.trim(),
  notes: args.notes.trim(),
  evidencePath,
  evidenceSha256,
  candidateCommitSha: evidence.candidate?.commitSha ?? null,
  evidenceRunId: evidence.runId ?? null,
  observedRpoSeconds: evidence.measured?.observedRpoSeconds ?? null,
  observedRtoSeconds: evidence.measured?.observedRtoSeconds ?? null,
  targetAssessment: evidence.measured?.targetAssessment ?? 'UNKNOWN',
  approvalEvidencePath,
  approvalEvidenceSha256,
  githubEnvironmentApproval: approvalEvidence ? {
    environment: approvalEvidence.environment,
    workflowRunId: approvalEvidence.workflowRunId,
    approvedBy: approvalEvidence.approvedBy,
    approvalHistoryUrl: approvalEvidence.approvalHistoryUrl,
    approvalHistorySha256: approvalEvidence.approvalHistorySha256,
    targetApproval: approvalEvidence.targetApproval,
  } : null,
};
await writeFile(output, JSON.stringify(signoff, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  .catch((error) => fail(error.code === 'EEXIST' ? 'sign-off receipt already exists; never overwrite approval evidence' : 'could not write sign-off receipt'));
console.log('dr_signoff_receipt=' + output);
console.log('dr_evidence_sha256=' + evidenceSha256);
console.log('dr_operator_decision=' + args.decision);
