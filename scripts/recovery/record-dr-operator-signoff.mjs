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
if (args.decision === 'PASS') {
  if (!evidence.databases?.distinctIdentityVerified || !evidence.databases?.targetWasEmptyBeforeRestore) {
    fail('PASS sign-off requires proof of distinct source/restore identity and an empty target');
  }
  const checks = [
    ['status', evidence.status === 'TECHNICAL_PASS'],
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
    ['measured RPO', Number.isSafeInteger(evidence.measured?.observedRpoSeconds)],
    ['measured RTO', Number.isSafeInteger(evidence.measured?.observedRtoSeconds)],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) fail('PASS sign-off requires successful evidence for: ' + failed.join(', '));
  if (evidence.measured?.approvedTargets === true && evidence.measured?.targetAssessment !== 'WITHIN_APPROVED_TARGETS') {
    fail('approved RPO/RTO targets were not met');
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
