import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
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
    ['status', evidence.status === 'TECHNICAL_PASS'],
    ['exact candidate commit SHA', typeof evidence.candidate?.commitSha === 'string' && /^[a-f0-9]{40}$/.test(evidence.candidate.commitSha)],
    ['relative candidate migration manifest path', manifestPathIsSafe],
    ['source database identity', typeof evidence.databases?.sourceIdentity === 'string' && evidence.databases.sourceIdentity.trim().length > 0],
    ['restore target database identity', typeof evidence.databases?.restoreTargetIdentity === 'string' && evidence.databases.restoreTargetIdentity.trim().length > 0],
    ['UTC rehearsal timestamps', startedAt !== null && finishedAt !== null && sourceWatermark !== null && restoredWatermark !== null && eventAt !== null && finishedAt >= startedAt && finishedAt >= eventAt],
    ['non-negative measured RPO', Number.isSafeInteger(evidence.measured?.observedRpoSeconds) && evidence.measured.observedRpoSeconds >= 0],
    ['RPO matches event cutoff and restored watermark', eventAt !== null && restoredWatermark !== null && restoredWatermark <= eventAt && evidence.measured?.observedRpoSeconds === eventAt - restoredWatermark],
    ['non-negative measured RTO', Number.isSafeInteger(evidence.measured?.observedRtoSeconds) && evidence.measured.observedRtoSeconds >= 0],
    ['encrypted backup', evidence.backup?.encryption === 'ENCRYPTED_GPG'],
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
};
await writeFile(output, JSON.stringify(signoff, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  .catch((error) => fail(error.code === 'EEXIST' ? 'sign-off receipt already exists; never overwrite approval evidence' : 'could not write sign-off receipt'));
console.log('dr_signoff_receipt=' + output);
console.log('dr_evidence_sha256=' + evidenceSha256);
console.log('dr_operator_decision=' + args.decision);
