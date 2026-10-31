import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const writer = fileURLToPath(new URL('./write-rehearsal-evidence.mjs', import.meta.url));
const signoff = fileURLToPath(new URL('./record-dr-operator-signoff.mjs', import.meta.url));

function run(command, args, env = {}) {
  return spawnSync(command, args, {
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
      erasureReplaySqlSha256: 'e'.repeat(64),
      erasureVerificationSqlSha256: 'f'.repeat(64),
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
      FACTORYOS_DR_ERASURE_REPLAY_SQL_SHA256: 'e'.repeat(64),
      FACTORYOS_DR_ERASURE_VERIFY_SQL_SHA256: 'f'.repeat(64),
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
    assert.equal(receipt.candidate.migrationManifestMode, 'PENDING');
    assert.equal(receipt.candidate.migrationManifestSha256, 'b'.repeat(64));
    assert.equal(receipt.candidate.migrationCount, 8);
    assert.equal(receipt.candidate.migrationStatus, 'PASS');
    assert.equal(receipt.candidate.failedTransactionRecoveryStatus, 'PASS');
    assert.equal(receipt.verification.migrationRecoveryStatus, 'PASS');
    assert.equal(receipt.databases.distinctIdentityVerified, true);
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
