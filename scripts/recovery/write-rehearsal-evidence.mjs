import { createHash, randomUUID } from 'node:crypto';
import { link, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const env = process.env;
const output = env.FACTORYOS_RECOVERY_EVIDENCE_JSON;
if (!output) {
  console.error('FACTORYOS_RECOVERY_EVIDENCE_JSON is required to write the rehearsal evidence receipt');
  process.exit(2);
}

const required = (name) => env[name] && env[name].trim() ? env[name].trim() : null;
const bool = (name) => env[name] === 'true';
const numberOrNull = (name) => {
  const value = env[name];
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
};
const status = required('FACTORYOS_DR_STATUS') ?? 'TECHNICAL_FAIL';
const candidateManifestPath = required('FACTORYOS_DR_CANDIDATE_MIGRATION_MANIFEST') ?? required('FACTORYOS_CANDIDATE_MIGRATION_MANIFEST');
const artifactPath = required('FACTORYOS_BACKUP_OUTPUT');
const checksumPath = artifactPath ? artifactPath + '.sha256' : null;

const receipt = {
  schema: 'factoryos.disaster-recovery-rehearsal/v1',
  runId: randomUUID(),
  candidate: {
    commitSha: required('FACTORYOS_CANDIDATE_SHA') ?? required('GITHUB_SHA'),
    migrationManifestPath: candidateManifestPath,
    migrationManifestMode: required('FACTORYOS_DR_MIGRATION_MANIFEST_MODE') ?? required('FACTORYOS_MIGRATION_MANIFEST_MODE') ?? 'NOT_SET',
    migrationManifestSha256: required('FACTORYOS_DR_CANDIDATE_MANIFEST_SHA256') ?? required('FACTORYOS_CANDIDATE_MANIFEST_SHA256'),
    migrationCount: numberOrNull('FACTORYOS_DR_CANDIDATE_MIGRATION_COUNT') ?? numberOrNull('FACTORYOS_CANDIDATE_MIGRATION_COUNT'),
    migrationStatus: required('FACTORYOS_DR_CANDIDATE_MIGRATION_STATUS') ?? required('FACTORYOS_CANDIDATE_MIGRATION_STATUS') ?? 'NOT_RUN',
    failedTransactionRecoveryStatus: required('FACTORYOS_DR_FAILURE_RECOVERY_STATUS') ?? required('FACTORYOS_FAILURE_RECOVERY_STATUS') ?? 'NOT_RUN',
  },
  status,
  failedStage: status === 'TECHNICAL_PASS' ? null : required('FACTORYOS_DR_STAGE'),
  timestamps: {
    startedAtUtc: required('FACTORYOS_DR_STARTED_AT_UTC'),
    finishedAtUtc: required('FACTORYOS_DR_FINISHED_AT_UTC'),
    sourceWatermarkUtc: required('FACTORYOS_DR_SOURCE_WATERMARK_UTC'),
    restoredWatermarkUtc: required('FACTORYOS_DR_RESTORED_WATERMARK_UTC'),
    simulatedIncidentAtUtc: required('FACTORYOS_DR_EVENT_TIME_UTC'),
  },
  databases: {
    sourceIdentity: required('FACTORYOS_DR_SOURCE_IDENTITY'),
    restoreTargetIdentity: required('FACTORYOS_DR_TARGET_IDENTITY'),
    distinctIdentityVerified: bool('FACTORYOS_DR_DATABASE_IDENTITIES_DISTINCT'),
    targetWasEmptyBeforeRestore: bool('FACTORYOS_DR_TARGET_EMPTY'),
  },
  backup: {
    encryptedArtifactPath: artifactPath,
    checksumPath,
    sha256: required('FACTORYOS_DR_BACKUP_SHA256'),
    checksumVerified: bool('FACTORYOS_DR_CHECKSUM_VERIFIED'),
    encryption: required('FACTORYOS_DR_ENCRYPTION_STATUS') ?? 'NOT_RUN',
    archiveReadability: required('FACTORYOS_DR_ARCHIVE_STATUS') ?? 'NOT_RUN',
    sourcePgDumpVersion: required('FACTORYOS_DR_PG_DUMP_VERSION'),
    restorePgRestoreVersion: required('FACTORYOS_DR_PG_RESTORE_VERSION'),
    serverVersion: required('FACTORYOS_DR_SERVER_VERSION'),
    gpgVersion: required('FACTORYOS_DR_GPG_VERSION'),
  },
  verification: {
    restoreStatus: required('FACTORYOS_DR_RESTORE_STATUS') ?? 'NOT_RUN',
    applicationSmokeStatus: required('FACTORYOS_DR_APPLICATION_SMOKE_STATUS') ?? 'NOT_REPORTED',
    schemaSmokeStatus: required('FACTORYOS_DR_SCHEMA_SMOKE_STATUS') ?? 'NOT_REPORTED',
    apiReadinessStatus: required('FACTORYOS_DR_API_READINESS_STATUS') ?? 'NOT_REPORTED',
    tenantIsolationStatus: required('FACTORYOS_DR_TENANT_ISOLATION_STATUS') ?? 'NOT_REPORTED',
    auditContinuityStatus: required('FACTORYOS_DR_AUDIT_CONTINUITY_STATUS') ?? 'NOT_REPORTED',
    erasureReplayStatus: required('FACTORYOS_DR_ERASURE_REPLAY_STATUS') ?? 'NOT_RUN',
    erasureReplayLedgerReference: required('FACTORYOS_DR_ERASURE_LEDGER_REFERENCE'),
    erasureReplayLedgerSha256: required('FACTORYOS_DR_ERASURE_LEDGER_SHA256'),
    erasureReplayLedgerWatermarkUtc: required('FACTORYOS_DR_ERASURE_LEDGER_WATERMARK_UTC'),
    erasureReplayRequests: numberOrNull('FACTORYOS_DR_ERASURE_REPLAYED_REQUESTS'),
    erasureReplayResiduals: numberOrNull('FACTORYOS_DR_ERASURE_REPLAY_RESIDUALS'),
    erasureReplaySqlSha256: required('FACTORYOS_DR_ERASURE_REPLAY_SQL_SHA256'),
    erasureVerificationSqlSha256: required('FACTORYOS_DR_ERASURE_VERIFY_SQL_SHA256'),
    erasureVerificationMethod: required('FACTORYOS_DR_ERASURE_VERIFY_METHOD'),
    migrationRecoveryStatus: required('FACTORYOS_DR_FAILURE_RECOVERY_STATUS') ?? required('FACTORYOS_FAILURE_RECOVERY_STATUS') ?? 'NOT_RUN',
  },
  measured: {
    backupDurationSeconds: numberOrNull('FACTORYOS_DR_BACKUP_DURATION_SECONDS'),
    restoreAndVerificationDurationSeconds: numberOrNull('FACTORYOS_DR_RESTORE_DURATION_SECONDS'),
    observedRpoSeconds: numberOrNull('FACTORYOS_DR_OBSERVED_RPO_SECONDS'),
    observedRtoSeconds: numberOrNull('FACTORYOS_DR_OBSERVED_RTO_SECONDS'),
    approvedTargets: bool('FACTORYOS_DR_TARGETS_APPROVED'),
    approvedRpoTargetSeconds: numberOrNull('FACTORYOS_DR_RPO_TARGET_SECONDS'),
    approvedRtoTargetSeconds: numberOrNull('FACTORYOS_DR_RTO_TARGET_SECONDS'),
    targetAssessment: required('FACTORYOS_DR_TARGET_ASSESSMENT') ?? 'OWNER_APPROVAL_REQUIRED',
  },
  operatorSignoff: {
    status: 'PENDING_POST_RUN_REVIEW',
    operator: required('FACTORYOS_DR_OPERATOR'),
    approver: required('FACTORYOS_DR_APPROVER'),
    note: 'Automated test results are not operator approval. Create a separate sign-off receipt after reviewing this evidence.',
  },
  failure: {
    exitCode: numberOrNull('FACTORYOS_DR_EXIT_CODE') ?? 0,
    stage: status === 'TECHNICAL_PASS' ? null : required('FACTORYOS_DR_STAGE'),
  },
};

const serialized = JSON.stringify(receipt, null, 2) + '\n';
const absoluteOutput = resolve(output);
const temporaryOutput = absoluteOutput + '.partial-' + process.pid;
await writeFile(temporaryOutput, serialized, { flag: 'wx', mode: 0o600 });
try {
  // Hard-link creation fails when the destination exists, so a rerun cannot overwrite evidence.
  await link(temporaryOutput, absoluteOutput);
} finally {
  await unlink(temporaryOutput).catch(() => undefined);
}
console.log('dr_evidence_receipt=' + absoluteOutput);
console.log('dr_evidence_sha256=' + createHash('sha256').update(serialized).digest('hex'));
