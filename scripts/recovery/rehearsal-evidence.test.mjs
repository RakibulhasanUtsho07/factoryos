import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const writer = fileURLToPath(new URL('./write-rehearsal-evidence.mjs', import.meta.url));
const signoff = fileURLToPath(new URL('./record-dr-operator-signoff.mjs', import.meta.url));
const approvalVerifier = fileURLToPath(new URL('./verify-dr-environment-approval.mjs', import.meta.url));
const backupVerifier = fileURLToPath(new URL('./verify-approved-postgres-backup.mjs', import.meta.url));
const productionWorkflow = fileURLToPath(new URL('../../.github/workflows/production-dr-rehearsal.yml', import.meta.url));
const rehearsalScript = fileURLToPath(new URL('./postgres-backup-restore-rehearsal.sh', import.meta.url));

function run(command, args, env = {}) {
  const invocation = [...args];
  if (command === process.execPath && invocation[0] === signoff
    && invocation[invocation.indexOf('--decision') + 1] === 'PASS'
    && !invocation.includes('--approval-evidence')) {
    const evidencePath = invocation[invocation.indexOf('--evidence') + 1];
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    const operator = invocation[invocation.indexOf('--operator') + 1];
    const approver = invocation[invocation.indexOf('--approver') + 1];
    const approvalPath = evidencePath + '.approval-fixture.json';
    const workflowRunId = evidence.workflow.runId;
    writeFileSync(approvalPath, JSON.stringify({
      schema: 'factoryos.dr-environment-approval/v1',
      source: 'GITHUB_ACTIONS_WORKFLOW_RUN_APPROVALS_API',
      repository: evidence.workflow.repository,
      workflowRunId,
      candidateSha: evidence.candidate.commitSha,
      environment: 'production-dr-rehearsal',
      operator,
      approvedBy: approver,
      approvedById: 99,
      approvedAtDecision: 'approved',
      approvalHistoryUrl: `https://api.github.com/repos/${evidence.workflow.repository}/actions/runs/${workflowRunId}/approvals`,
      approvalHistorySha256: '1'.repeat(64),
      targetApproval: evidence.measured.approvedTargets
        ? { approved: true, rpoSeconds: evidence.measured.approvedRpoTargetSeconds, rtoSeconds: evidence.measured.approvedRtoTargetSeconds }
        : { approved: false, rpoSeconds: null, rtoSeconds: null },
      retrievedAtUtc: '2026-10-20T10:00:00Z',
    }, null, 2), { mode: 0o600 });
    invocation.push('--approval-evidence', approvalPath);
  }
  return spawnSync(command, invocation, {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', ...env },
  });
}

function sampleEvidence() {
  return {
    schema: 'factoryos.disaster-recovery-rehearsal/v1',
    runId: 'run-fixture-1',
    workflow: {
      repository: 'RakibulhasanUtsho07/factoryos',
      runId: 123456,
      runAttempt: 1,
      actor: 'DB Operator',
      environment: 'production-dr-rehearsal',
    },
    operatorSignoff: {
      status: 'PENDING_POST_RUN_REVIEW',
      operator: 'DB Operator',
      approver: 'Release Approver',
    },
    status: 'TECHNICAL_PASS',
    timestamps: {
      startedAtUtc: '2026-10-20T09:58:00Z',
      finishedAtUtc: '2026-10-20T10:02:00Z',
      sourceWatermarkUtc: '2026-10-20T09:59:50Z',
      restoredWatermarkUtc: '2026-10-20T09:59:50Z',
      simulatedIncidentAtUtc: '2026-10-20T10:00:25Z',
    },
    candidate: {
      commitSha: 'a'.repeat(40),
      migrationManifestPath: 'scripts/recovery/ci-candidate-migrations.txt',
      migrationManifestMode: 'PENDING',
      migrationManifestSha256: 'b'.repeat(64),
      migrationCount: 8,
      migrationStatus: 'PASS',
      failedTransactionRecoveryStatus: 'PASS',
    },
    databases: {
      sourceIdentity: 'factoryos_source|10.0.0.1|5432',
      restoreTargetIdentity: 'factoryos_restore|10.0.0.2|5432',
      distinctIdentityVerified: true,
      targetWasEmptyBeforeRestore: true,
    },
    backup: {
      sha256: 'c'.repeat(64),
      checksumVerified: true,
      encryption: 'ENCRYPTED_GPG',
      archiveReadability: 'READABLE',
      sourceMode: 'APPROVED_ARTIFACT',
      approvedManifestPath: '/secure/dr/approved-backup.manifest.json',
      approvedManifestSha256: '1'.repeat(64),
      approvedSignaturePath: '/secure/dr/approved-backup.manifest.sig',
      approvedSignatureSha256: '2'.repeat(64),
      approvedSignerFingerprint: 'A'.repeat(40),
      approvedBackupCreatedAtUtc: '2026-10-20T09:59:00Z',
      approvedBackupSourceDatabaseIdentity: 'factoryos_source|10.0.0.1|5432',
      approvedBackupSourceServerVersion: '16.10',
      approvedBackupRecipientFingerprint: 'B'.repeat(40),
      signatureVerification: 'VALID_PINNED_SIGNER',
    },
    verification: {
      restoreStatus: 'PASS',
      applicationSmokeStatus: 'PASS',
      schemaSmokeStatus: 'PASS',
      apiReadinessStatus: 'PASS',
      tenantIsolationStatus: 'PASS',
      auditContinuityStatus: 'PASS',
      erasureReplayStatus: 'PASS',
      erasureReplayLedgerReference: 'external-ledger-prod-2026-10-20',
      erasureReplayLedgerSha256: 'd'.repeat(64),
      erasureReplayLedgerWatermarkUtc: '2026-10-20T10:01:00Z',
      erasureReplayRequests: 3,
      erasureReplayResiduals: 0,
      erasureVerificationRequests: 3,
      erasureVerificationResiduals: 0,
      erasureReplaySqlSha256: 'e'.repeat(64),
      erasureVerificationSqlSha256: 'f'.repeat(64),
      erasureVerificationMethod: 'INDEPENDENT_READ_ONLY',
      migrationRecoveryStatus: 'PASS',
    },
    measured: {
      observedRpoSeconds: 35,
      observedRtoSeconds: 120,
      approvedTargets: false,
      approvedRpoTargetSeconds: null,
      approvedRtoTargetSeconds: null,
      targetAssessment: 'NOT_APPROVED_NOT_CONTRACTUAL',
    },
  };
}

test('evidence writer records measured outcomes without claiming operator sign-off', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-evidence-'));
  try {
    const output = join(directory, 'receipt.json');
    const result = run(process.execPath, [writer], {
      FACTORYOS_RECOVERY_EVIDENCE_JSON: output,
      FACTORYOS_DR_STATUS: 'TECHNICAL_PASS',
      FACTORYOS_DR_STARTED_AT_UTC: '2026-10-20T10:00:00Z',
      FACTORYOS_DR_FINISHED_AT_UTC: '2026-10-20T10:02:00Z',
      FACTORYOS_CANDIDATE_SHA: 'a'.repeat(40),
      FACTORYOS_DR_CANDIDATE_MIGRATION_MANIFEST: 'scripts/recovery/ci-candidate-migrations.txt',
      FACTORYOS_DR_MIGRATION_MANIFEST_MODE: 'PENDING',
      FACTORYOS_DR_CANDIDATE_MANIFEST_SHA256: 'b'.repeat(64),
      FACTORYOS_DR_CANDIDATE_MIGRATION_COUNT: '8',
      FACTORYOS_DR_CANDIDATE_MIGRATION_STATUS: 'PASS',
      FACTORYOS_DR_FAILURE_RECOVERY_STATUS: 'PASS',
      FACTORYOS_DR_SOURCE_IDENTITY: 'source|10.0.0.1|5432',
      FACTORYOS_DR_TARGET_IDENTITY: 'restore|10.0.0.2|5432',
      FACTORYOS_DR_DATABASE_IDENTITIES_DISTINCT: 'true',
      FACTORYOS_DR_TARGET_EMPTY: 'true',
      FACTORYOS_DR_BACKUP_SHA256: 'c'.repeat(64),
      FACTORYOS_DR_CHECKSUM_VERIFIED: 'true',
      FACTORYOS_DR_ENCRYPTION_STATUS: 'ENCRYPTED_GPG',
      FACTORYOS_DR_ARCHIVE_STATUS: 'READABLE',
      FACTORYOS_DR_RESTORE_STATUS: 'PASS',
      FACTORYOS_DR_APPLICATION_SMOKE_STATUS: 'PASS',
      FACTORYOS_DR_SCHEMA_SMOKE_STATUS: 'PASS',
      FACTORYOS_DR_API_READINESS_STATUS: 'PASS',
      FACTORYOS_DR_TENANT_ISOLATION_STATUS: 'PASS',
      FACTORYOS_DR_AUDIT_CONTINUITY_STATUS: 'PASS',
      FACTORYOS_DR_ERASURE_REPLAY_STATUS: 'PASS',
      FACTORYOS_DR_ERASURE_LEDGER_REFERENCE: 'external-ledger-prod-2026-10-20',
      FACTORYOS_DR_ERASURE_LEDGER_SHA256: 'd'.repeat(64),
      FACTORYOS_DR_ERASURE_LEDGER_WATERMARK_UTC: '2026-10-20T10:01:00Z',
      FACTORYOS_DR_ERASURE_REPLAYED_REQUESTS: '3',
      FACTORYOS_DR_ERASURE_REPLAY_RESIDUALS: '0',
      FACTORYOS_DR_ERASURE_VERIFIED_REQUESTS: '3',
      FACTORYOS_DR_ERASURE_VERIFICATION_RESIDUALS: '0',
      FACTORYOS_DR_ERASURE_REPLAY_SQL_SHA256: 'e'.repeat(64),
      FACTORYOS_DR_ERASURE_VERIFY_SQL_SHA256: 'f'.repeat(64),
      FACTORYOS_DR_ERASURE_VERIFY_METHOD: 'INDEPENDENT_READ_ONLY',
      FACTORYOS_DR_BACKUP_DURATION_SECONDS: '45',
      FACTORYOS_DR_RESTORE_DURATION_SECONDS: '120',
      FACTORYOS_DR_SOURCE_WATERMARK_UTC: '2026-10-20T09:59:50Z',
      FACTORYOS_DR_RESTORED_WATERMARK_UTC: '2026-10-20T09:59:50Z',
      FACTORYOS_DR_EVENT_TIME_UTC: '2026-10-20T10:00:25Z',
      FACTORYOS_DR_OBSERVED_RPO_SECONDS: '35',
      FACTORYOS_DR_OBSERVED_RTO_SECONDS: '120',
      FACTORYOS_DR_TARGET_ASSESSMENT: 'NOT_APPROVED_NOT_CONTRACTUAL',
      FACTORYOS_DR_OPERATOR: 'CI Operator',
      FACTORYOS_DR_APPROVER: 'CI Approver',
      FACTORYOS_DR_ENVIRONMENT: 'production-dr-rehearsal',
      GITHUB_REPOSITORY: 'RakibulhasanUtsho07/factoryos',
      GITHUB_RUN_ID: '888001',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_ACTOR: 'dr-ci-operator',
    });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(receipt.status, 'TECHNICAL_PASS');
    assert.equal(receipt.measured.observedRpoSeconds, 35);
    assert.equal(receipt.measured.observedRtoSeconds, 120);
    assert.equal(receipt.operatorSignoff.status, 'PENDING_POST_RUN_REVIEW');
    assert.equal(receipt.verification.schemaSmokeStatus, 'PASS');
    assert.equal(receipt.verification.apiReadinessStatus, 'PASS');
    assert.equal(receipt.verification.erasureReplayStatus, 'PASS');
    assert.equal(receipt.verification.erasureReplayLedgerSha256, 'd'.repeat(64));
    assert.equal(receipt.verification.erasureReplayRequests, 3);
    assert.equal(receipt.verification.erasureReplayResiduals, 0);
    assert.equal(receipt.verification.erasureVerificationRequests, 3);
    assert.equal(receipt.verification.erasureVerificationResiduals, 0);
    assert.equal(receipt.candidate.migrationManifestMode, 'PENDING');
    assert.equal(receipt.candidate.migrationManifestSha256, 'b'.repeat(64));
    assert.equal(receipt.candidate.migrationCount, 8);
    assert.equal(receipt.candidate.migrationStatus, 'PASS');
    assert.equal(receipt.candidate.failedTransactionRecoveryStatus, 'PASS');
    assert.equal(receipt.verification.migrationRecoveryStatus, 'PASS');
    assert.equal(receipt.databases.distinctIdentityVerified, true);
    assert.deepEqual(receipt.workflow, {
      repository: 'RakibulhasanUtsho07/factoryos',
      runId: 888001,
      runAttempt: 2,
      actor: 'dr-ci-operator',
      environment: 'production-dr-rehearsal',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('PASS sign-off must match the evidence digest and require independent operators', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-signoff-'));
  try {
    const evidencePath = join(directory, 'receipt.json');
    writeFileSync(evidencePath, JSON.stringify(sampleEvidence(), null, 2), { mode: 0o600 });
    const result = run(process.execPath, [signoff,
      '--evidence', evidencePath,
      '--decision', 'PASS',
      '--operator', 'DB Operator',
      '--approver', 'Release Approver',
      '--notes', 'Isolated restore evidence reviewed and accepted.',
      '--reference', 'CHG-DR-2026-104',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const signed = JSON.parse(readFileSync(evidencePath + '.signoff.json', 'utf8'));
    assert.equal(signed.decision, 'PASS');
    assert.equal(signed.evidenceSha256.length, 64);
    assert.equal(signed.operator, 'DB Operator');
    assert.equal(signed.approver, 'Release Approver');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('sign-off rejects the same person as operator and approver', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-signoff-separation-'));
  try {
    const evidencePath = join(directory, 'receipt.json');
    writeFileSync(evidencePath, JSON.stringify(sampleEvidence()), { mode: 0o600 });
    const result = run(process.execPath, [signoff,
      '--evidence', evidencePath,
      '--decision', 'PASS',
      '--operator', 'Same Person',
      '--approver', 'Same Person',
      '--notes', 'A long enough note for the contract test.',
      '--reference', 'CHG-DR-2026-105',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /operator and approver must be different people/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('PASS sign-off cannot promote a failed technical rehearsal', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-signoff-failed-'));
  try {
    const evidencePath = join(directory, 'receipt.json');
    const evidence = sampleEvidence();
    evidence.status = 'TECHNICAL_FAIL';
    writeFileSync(evidencePath, JSON.stringify(evidence), { mode: 0o600 });
    const result = run(process.execPath, [signoff,
      '--evidence', evidencePath,
      '--decision', 'PASS',
      '--operator', 'DB Operator',
      '--approver', 'Release Approver',
      '--notes', 'Attempted to approve failed technical evidence.',
      '--reference', 'CHG-DR-2026-106',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PASS sign-off requires successful evidence/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('FAIL sign-off can record an early failure before source/restore identity was established', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-signoff-early-failure-'));
  try {
    const evidencePath = join(directory, 'receipt.json');
    const evidence = sampleEvidence();
    evidence.status = 'TECHNICAL_FAIL';
    evidence.databases.distinctIdentityVerified = false;
    evidence.databases.targetWasEmptyBeforeRestore = false;
    evidence.failure = { exitCode: 1, stage: 'database_identity' };
    writeFileSync(evidencePath, JSON.stringify(evidence), { mode: 0o600 });
    const result = run(process.execPath, [signoff,
      '--evidence', evidencePath,
      '--decision', 'FAIL',
      '--operator', 'DB Operator',
      '--approver', 'Release Approver',
      '--notes', 'Rehearsal stopped before database identity could be verified.',
      '--reference', 'CHG-DR-2026-107',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const signed = JSON.parse(readFileSync(evidencePath + '.signoff.json', 'utf8'));
    assert.equal(signed.decision, 'FAIL');
    assert.equal(signed.evidenceSha256.length, 64);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('PASS sign-off rejects an idempotent CI replay receipt as a production migration receipt', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-signoff-ci-replay-'));
  try {
    const evidencePath = join(directory, 'receipt.json');
    const evidence = sampleEvidence();
    evidence.candidate.migrationManifestMode = 'IDEMPOTENT_REPLAY';
    writeFileSync(evidencePath, JSON.stringify(evidence), { mode: 0o600 });
    const result = run(process.execPath, [signoff,
      '--evidence', evidencePath,
      '--decision', 'PASS',
      '--operator', 'DB Operator',
      '--approver', 'Release Approver',
      '--notes', 'Attempted to use idempotent replay evidence for a production release.',
      '--reference', 'CHG-DR-2026-108',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pending release migration manifest/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});



test('PASS sign-off rejects restore evidence with unresolved erasure replay residuals', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-signoff-erasure-residuals-'));
  try {
    const evidencePath = join(directory, 'receipt.json');
    const evidence = sampleEvidence();
    evidence.verification.erasureReplayResiduals = 1;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    const result = run(process.execPath, [signoff,
      '--evidence', evidencePath,
      '--decision', 'PASS',
      '--operator', 'DB Operator',
      '--approver', 'Release Approver',
      '--notes', 'Restore erasure residual gate regression test.',
      '--reference', 'CHG-DR-ERASURE-101',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /zero erasure replay residuals/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('PASS sign-off rejects a missing or malformed candidate commit SHA', () => {
  for (const sha of [null, 'not-a-commit-sha', 'a'.repeat(39), 'g'.repeat(40)]) {
    const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-signoff-sha-'));
    try {
      const evidencePath = join(directory, 'receipt.json');
      const evidence = sampleEvidence();
      evidence.candidate.commitSha = sha;
      writeFileSync(evidencePath, JSON.stringify(evidence), { mode: 0o600 });
      const result = run(process.execPath, [signoff,
        '--evidence', evidencePath,
        '--decision', 'PASS',
        '--operator', 'DB Operator',
        '--approver', 'Release Approver',
        '--notes', 'Candidate SHA validation regression test.',
        '--reference', 'CHG-DR-2026-109',
      ]);
      assert.notEqual(result.status, 0, String(sha));
      assert.match(result.stderr, /exact candidate commit SHA/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('PASS sign-off rejects contradictory RPO and restored watermark evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-signoff-rpo-mismatch-'));
  try {
    const evidencePath = join(directory, 'receipt.json');
    const evidence = sampleEvidence();
    evidence.measured.observedRpoSeconds = 34;
    writeFileSync(evidencePath, JSON.stringify(evidence), { mode: 0o600 });
    const result = run(process.execPath, [signoff,
      '--evidence', evidencePath,
      '--decision', 'PASS',
      '--operator', 'DB Operator',
      '--approver', 'Release Approver',
      '--notes', 'RPO consistency regression test.',
      '--reference', 'CHG-DR-2026-110',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /RPO matches event cutoff and restored watermark/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('PASS sign-off rejects negative observed RPO/RTO values', () => {
  for (const measurement of ['observedRpoSeconds', 'observedRtoSeconds']) {
    const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-signoff-negative-metric-'));
    try {
      const evidencePath = join(directory, 'receipt.json');
      const evidence = sampleEvidence();
      evidence.measured[measurement] = -1;
      writeFileSync(evidencePath, JSON.stringify(evidence), { mode: 0o600 });
      const result = run(process.execPath, [signoff,
        '--evidence', evidencePath,
        '--decision', 'PASS',
        '--operator', 'DB Operator',
        '--approver', 'Release Approver',
        '--notes', 'Negative recovery metric regression test.',
        '--reference', 'CHG-DR-2026-111',
      ]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /non-negative measured/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('PASS sign-off enforces approved RPO/RTO thresholds from the measured values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-signoff-target-breach-'));
  try {
    const evidencePath = join(directory, 'receipt.json');
    const evidence = sampleEvidence();
    evidence.measured.approvedTargets = true;
    evidence.measured.approvedRpoTargetSeconds = 30;
    evidence.measured.approvedRtoTargetSeconds = 100;
    // Simulate a forged/inconsistent receipt that incorrectly claims the threshold was met.
    evidence.measured.targetAssessment = 'WITHIN_APPROVED_TARGETS';
    writeFileSync(evidencePath, JSON.stringify(evidence), { mode: 0o600 });
    const result = run(process.execPath, [signoff,
      '--evidence', evidencePath,
      '--decision', 'PASS',
      '--operator', 'DB Operator',
      '--approver', 'Release Approver',
      '--notes', 'Approved target enforcement regression test.',
      '--reference', 'CHG-DR-2026-112',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /observed RPO\/RTO exceed or do not satisfy approved targets/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


function writeApprovalHistory(directory, entries) {
  const approvalPath = join(directory, 'workflow-approvals.json');
  writeFileSync(approvalPath, JSON.stringify(entries, null, 2), { mode: 0o600 });
  return approvalPath;
}

function runApprovalVerifier(directory, entries, overrides = {}) {
  const approvalPath = writeApprovalHistory(directory, entries);
  const output = join(directory, 'github-environment-approval.json');
  const result = run(process.execPath, [approvalVerifier,
    '--approvals-json', approvalPath,
    '--output', output,
    '--environment', 'production-dr-rehearsal',
    '--approver', 'release-approver',
    '--operator', 'workflow-operator',
    '--candidate-sha', 'a'.repeat(40),
    '--run-id', '9001',
    '--repository', 'RakibulhasanUtsho07/factoryos',
    '--targets-approved', overrides.targetsApproved ?? 'false',
    '--rpo-target-seconds', overrides.rpoTargetSeconds ?? '',
    '--rto-target-seconds', overrides.rtoTargetSeconds ?? '',
  ]);
  return { result, output };
}

test('environment approval verifier binds the actual GitHub reviewer to the exact run and candidate', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-approval-'));
  try {
    const { result, output } = runApprovalVerifier(directory, [{
      state: 'approved',
      comment: 'DR rehearsal environment approved.',
      environments: [{ name: 'production-dr-rehearsal' }],
      user: { login: 'release-approver', id: 42 },
    }]);
    assert.equal(result.status, 0, result.stderr);
    const attestation = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(attestation.schema, 'factoryos.dr-environment-approval/v1');
    assert.equal(attestation.approvedBy, 'release-approver');
    assert.equal(attestation.operator, 'workflow-operator');
    assert.equal(attestation.workflowRunId, 9001);
    assert.equal(attestation.candidateSha, 'a'.repeat(40));
    assert.equal(attestation.environment, 'production-dr-rehearsal');
    assert.equal(attestation.approvalHistorySha256.length, 64);
    assert.equal(attestation.approvalHistoryUrl, 'https://api.github.com/repos/RakibulhasanUtsho07/factoryos/actions/runs/9001/approvals');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('environment approval verifier rejects a different reviewer, wrong environment and rejected review', () => {
  const cases = [
    [{ state: 'approved', environments: [{ name: 'production-dr-rehearsal' }], user: { login: 'someone-else' } }, /no approved decision/],
    [{ state: 'approved', environments: [{ name: 'staging' }], user: { login: 'release-approver' } }, /no approved decision/],
    [{ state: 'rejected', environments: [{ name: 'production-dr-rehearsal' }], user: { login: 'release-approver' } }, /no approved decision/],
  ];
  for (const [entry, expected] of cases) {
    const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-approval-reject-'));
    try {
      const { result } = runApprovalVerifier(directory, [entry]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('environment approval verifier rejects self-approval by the workflow operator', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-approval-self-'));
  try {
    const approvalPath = writeApprovalHistory(directory, [{
      state: 'approved',
      environments: [{ name: 'production-dr-rehearsal' }],
      user: { login: 'workflow-operator' },
    }]);
    const result = run(process.execPath, [approvalVerifier,
      '--approvals-json', approvalPath,
      '--output', join(directory, 'approval.json'),
      '--environment', 'production-dr-rehearsal',
      '--approver', 'workflow-operator',
      '--operator', 'workflow-operator',
      '--candidate-sha', 'a'.repeat(40),
      '--run-id', '9001',
      '--repository', 'RakibulhasanUtsho07/factoryos',
      '--targets-approved', 'false',
      '--rpo-target-seconds', '',
      '--rto-target-seconds', '',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be independent/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('environment approval requires an exact reviewer comment to approve non-contractual RPO/RTO targets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-target-approval-'));
  try {
    const entry = {
      state: 'approved',
      comment: 'Approved the DR rehearsal.',
      environments: [{ name: 'production-dr-rehearsal' }],
      user: { login: 'release-approver', id: 42 },
    };
    const missingMarker = runApprovalVerifier(directory, [entry], {
      targetsApproved: 'true', rpoTargetSeconds: '300', rtoTargetSeconds: '3600',
    });
    assert.notEqual(missingMarker.result.status, 0);
    assert.match(missingMarker.result.stderr, /exact owner target marker/);
    const validDirectory = mkdtempSync(join(tmpdir(), 'factoryos-dr-target-approval-valid-'));
    try {
      const approved = runApprovalVerifier(validDirectory, [{
        ...entry,
        comment: 'Reviewed workload target: FACTORYOS_DR_TARGETS_APPROVED:rpo=300;rto=3600',
      }], {
        targetsApproved: 'true', rpoTargetSeconds: '300', rtoTargetSeconds: '3600',
      });
      assert.equal(approved.result.status, 0, approved.result.stderr);
      const attestation = JSON.parse(readFileSync(approved.output, 'utf8'));
      assert.deepEqual(attestation.targetApproval, {
        approved: true,
        rpoSeconds: 300,
        rtoSeconds: 3600,
        exactCommentMarker: 'FACTORYOS_DR_TARGETS_APPROVED:rpo=300;rto=3600',
      });
    } finally {
      rmSync(validDirectory, { recursive: true, force: true });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('PASS sign-off rejects approval evidence whose GitHub reviewer does not match the named approver', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-signoff-approval-mismatch-'));
  try {
    const evidencePath = join(directory, 'receipt.json');
    const approvalPath = join(directory, 'approval.json');
    writeFileSync(evidencePath, JSON.stringify(sampleEvidence(), null, 2), { mode: 0o600 });
    writeFileSync(approvalPath, JSON.stringify({
      schema: 'factoryos.dr-environment-approval/v1',
      source: 'GITHUB_ACTIONS_WORKFLOW_RUN_APPROVALS_API',
      repository: 'RakibulhasanUtsho07/factoryos',
      workflowRunId: 123456,
      candidateSha: 'a'.repeat(40),
      environment: 'production-dr-rehearsal',
      operator: 'DB Operator',
      approvedBy: 'not-the-approver',
      approvalHistoryUrl: 'https://api.github.com/repos/RakibulhasanUtsho07/factoryos/actions/runs/123456/approvals',
      approvalHistorySha256: '1'.repeat(64),
      targetApproval: { approved: false, rpoSeconds: null, rtoSeconds: null },
    }), { mode: 0o600 });
    const result = run(process.execPath, [signoff,
      '--evidence', evidencePath,
      '--approval-evidence', approvalPath,
      '--decision', 'PASS',
      '--operator', 'DB Operator',
      '--approver', 'Release Approver',
      '--notes', 'Reviewer identity mismatch must fail.',
      '--reference', 'CHG-DR-APPROVAL-101',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /actual GitHub reviewer matches the named approver/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('DR release-gate workflow verifies signed approved backup, Environment review and private tmpfs', () => {
  const workflow = readFileSync(productionWorkflow, 'utf8');
  const script = readFileSync(rehearsalScript, 'utf8');
  assert.match(workflow, /permissions:[\s\S]*actions: read/);
  assert.match(workflow, /approved_backup_manifest_path/);
  assert.match(workflow, /FACTORYOS_DR_BACKUP_SIGNER_FINGERPRINT/);
  assert.match(workflow, /FACTORYOS_BACKUP_SOURCE_MODE=APPROVED_ARTIFACT/);
  assert.match(workflow, /verify-approved-postgres-backup\.mjs/);
  assert.match(workflow, /actions\/runs\/\$GITHUB_RUN_ID\/approvals/);
  assert.match(workflow, /verify-dr-environment-approval\.mjs/);
  assert.match(workflow, /FACTORYOS_DR_SECURE_TMPDIR/);
  assert.match(script, /findmnt[\s\S]*tmpfs/);
  assert.match(script, /secure_tmp_owner/);
});


test('PASS sign-off rejects a CI-generated live-source dump instead of an approved recovery-point artifact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-signoff-live-dump-'));
  try {
    const evidencePath = join(directory, 'receipt.json');
    const evidence = sampleEvidence();
    evidence.backup.sourceMode = 'LIVE_SOURCE_DUMP';
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    const result = run(process.execPath, [signoff,
      '--evidence', evidencePath,
      '--decision', 'PASS',
      '--operator', 'DB Operator',
      '--approver', 'Release Approver',
      '--notes', 'A CI-generated live dump must not satisfy the approved backup gate.',
      '--reference', 'CHG-DR-APPROVED-BACKUP-101',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /approved backup artifact source/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('PASS sign-off rejects missing approved backup signature and provenance evidence', () => {
  const mutations = [
    [evidence => { evidence.backup.signatureVerification = 'BAD_SIGNATURE'; }, /approved backup signature from pinned signer/],
    [evidence => { evidence.backup.approvedManifestSha256 = null; }, /approved backup manifest digest/],
    [evidence => { evidence.backup.approvedBackupSourceDatabaseIdentity = 'different-source'; }, /approved backup source identity/],
    [evidence => { evidence.backup.approvedBackupCreatedAtUtc = '2026-10-20T10:00:26Z'; }, /approved backup creation time precedes incident/],
  ];
  for (const [mutate, expected] of mutations) {
    const directory = mkdtempSync(join(tmpdir(), 'factoryos-dr-signoff-backup-provenance-'));
    try {
      const evidencePath = join(directory, 'receipt.json');
      const evidence = sampleEvidence();
      mutate(evidence);
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
      const result = run(process.execPath, [signoff,
        '--evidence', evidencePath,
        '--decision', 'PASS',
        '--operator', 'DB Operator',
        '--approver', 'Release Approver',
        '--notes', 'Approved backup provenance regression contract.',
        '--reference', 'CHG-DR-APPROVED-BACKUP-102',
      ]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});


function createApprovedBackupFixture(directory) {
  const home = join(directory, 'gnupg');
  const output = join(directory, 'backup-verification.json');
  const artifact = join(directory, 'approved-production.dump.gpg');
  const manifestPath = join(directory, 'approved-production.manifest.json');
  const signaturePath = join(directory, 'approved-production.manifest.json.sig');
  const recipientFingerprint = 'B'.repeat(40);
  const sourceDatabaseIdentity = 'factoryos_source|10.0.0.10|5432';
  const incidentCutoffUtc = '2026-10-20T10:00:00Z';
  require('node:fs').mkdirSync(home, { mode: 0o700 });
  chmodSync(home, 0o700);
  const gnupgEnv = { ...process.env, GNUPGHOME: home };
  execFileSync('gpg', [
    '--batch', '--pinentry-mode', 'loopback', '--passphrase', '',
    '--quick-generate-key', 'FactoryOS DR Backup Signer <dr-signer@example.invalid>',
    'ed25519', 'sign', '1d',
  ], { env: gnupgEnv, stdio: 'ignore' });
  const listing = execFileSync('gpg', ['--batch', '--with-colons', '--list-keys', 'dr-signer@example.invalid'], {
    env: gnupgEnv, encoding: 'utf8',
  });
  const signerFingerprint = listing.split(/\\r?\\n/)
    .find((line) => line.startsWith('fpr:'))?.split(':')[9];
  assert.match(signerFingerprint ?? '', /^[A-F0-9]{40}$/i);
  const artifactBytes = Buffer.from('synthetic encrypted PostgreSQL backup fixture');
  writeFileSync(artifact, artifactBytes, { mode: 0o600 });
  const manifest = {
    schema: 'factoryos.approved-postgresql-backup/v1',
    artifactFileName: 'approved-production.dump.gpg',
    artifactSha256: createHash('sha256').update(artifactBytes).digest('hex'),
    sourceDatabaseIdentity,
    backupCreatedAtUtc: '2026-10-20T09:55:00Z',
    backupTool: 'pg_dump',
    pgDumpVersion: 'pg_dump (PostgreSQL) 16.10',
    sourceServerVersion: '16.10',
    encryption: 'GPG',
    recipientFingerprint,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n', { mode: 0o600 });
  execFileSync('gpg', [
    '--batch', '--yes', '--local-user', signerFingerprint,
    '--detach-sign', '--output', signaturePath, manifestPath,
  ], { env: gnupgEnv });
  return {
    home, output, artifact, manifestPath, signaturePath,
    signerFingerprint, recipientFingerprint, sourceDatabaseIdentity, incidentCutoffUtc,
  };
}

function runApprovedBackupVerifier(fixture, overrides = {}) {
  const args = [
    backupVerifier,
    '--artifact', fixture.artifact,
    '--manifest', fixture.manifestPath,
    '--signature', fixture.signaturePath,
    '--signer-fingerprint', fixture.signerFingerprint,
    '--recipient-fingerprint', fixture.recipientFingerprint,
    '--source-database-identity', fixture.sourceDatabaseIdentity,
    '--incident-cutoff-utc', fixture.incidentCutoffUtc,
    '--output', fixture.output,
    ...(overrides.args ?? []),
  ];
  return run(process.execPath, args, { GNUPGHOME: fixture.home, ...overrides.env });
}

test('approved PostgreSQL backup verifier accepts a signed manifest, pinned signer, recipient and source identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-approved-backup-'));
  try {
    const fixture = createApprovedBackupFixture(directory);
    const result = runApprovedBackupVerifier(fixture);
    assert.equal(result.status, 0, result.stderr);
    const verification = JSON.parse(readFileSync(fixture.output, 'utf8'));
    assert.equal(verification.schema, 'factoryos.approved-postgresql-backup-verification/v1');
    assert.equal(verification.signatureStatus, 'VALID_PINNED_SIGNER');
    assert.equal(verification.signerFingerprint, fixture.signerFingerprint);
    assert.equal(verification.recipientFingerprint, fixture.recipientFingerprint);
    assert.equal(verification.sourceDatabaseIdentity, fixture.sourceDatabaseIdentity);
    assert.equal(verification.backupCreatedAtUtc, '2026-10-20T09:55:00Z');
    assert.equal(verification.artifactSha256.length, 64);
    assert.equal(verification.manifestSha256.length, 64);
    assert.equal(verification.signatureSha256.length, 64);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('approved PostgreSQL backup verifier rejects a different pinned signing key', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-approved-backup-signer-'));
  try {
    const fixture = createApprovedBackupFixture(directory);
    const result = runApprovedBackupVerifier(fixture, { args: ['--signer-fingerprint', 'C'.repeat(40)] });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /signature verification failed|pinned independent backup-controller fingerprint/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('approved PostgreSQL backup verifier rejects modified artifact bytes after signing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-approved-backup-digest-'));
  try {
    const fixture = createApprovedBackupFixture(directory);
    writeFileSync(fixture.artifact, 'tampered backup artifact', { mode: 0o600 });
    const result = runApprovedBackupVerifier(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /artifact SHA-256 does not match/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('approved PostgreSQL backup verifier rejects a different source database identity or recipient key', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-approved-backup-scope-'));
  try {
    const fixture = createApprovedBackupFixture(directory);
    const wrongSource = runApprovedBackupVerifier(fixture, {
      args: ['--source-database-identity', 'unrelated-db|10.0.0.11|5432'],
    });
    assert.notEqual(wrongSource.status, 0);
    assert.match(wrongSource.stderr, /source database identity does not match/);
    const wrongRecipient = runApprovedBackupVerifier(fixture, {
      args: ['--recipient-fingerprint', 'D'.repeat(40)],
    });
    assert.notEqual(wrongRecipient.status, 0);
    assert.match(wrongRecipient.stderr, /recipient does not match/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('approved PostgreSQL backup verifier rejects a recovery point newer than the incident cutoff', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factoryos-approved-backup-cutoff-'));
  try {
    const fixture = createApprovedBackupFixture(directory);
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8'));
    manifest.backupCreatedAtUtc = '2026-10-20T10:00:01Z';
    writeFileSync(fixture.manifestPath, JSON.stringify(manifest, null, 2) + '\\n', { mode: 0o600 });
    execFileSync('gpg', [
      '--batch', '--yes', '--local-user', fixture.signerFingerprint,
      '--detach-sign', '--output', fixture.signaturePath, fixture.manifestPath,
    ], { env: { ...process.env, GNUPGHOME: fixture.home } });
    const result = runApprovedBackupVerifier(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /created after the incident cutoff/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
