import { createHash } from 'node:crypto';

export const POSTGRESQL_WAL_PITR_RETENTION_ELIGIBILITY_SCHEMA =
  'factoryos.postgresql-wal-pitr-retention-eligibility/v1';

export const REQUIRED_POSTGRESQL_WAL_PITR_RETENTION_SOURCES = [
  'POSTGRESQL_CLUSTER_CATALOG',
  'WAL_ARCHIVE_DESTINATION_CATALOG',
  'WAL_SEGMENT_CATALOG',
  'WAL_WRITER_PRINCIPAL_CATALOG',
  'WAL_REPLICATION_PATH_CATALOG',
  'PITR_RESTORE_PATH_CATALOG',
] as const;

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEGMENT = /^[A-F0-9]{24}$/;
const TIMELINE = /^[A-F0-9]{8}$/;
const MAX_INVENTORY_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_RESTORE_REHEARSAL_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export type PostgresqlWalPitrDependencyAnswer = 'NO' | 'YES' | 'UNKNOWN';

export interface PostgresqlWalPitrRetentionEligibilityInput {
  schema: typeof POSTGRESQL_WAL_PITR_RETENTION_ELIGIBILITY_SCHEMA;
  tenant_id: string;
  evaluation_reference: string;
  evaluated_at: string;
  inventory: {
    inventory_id: string;
    generated_at: string;
    manifest_sha256: string;
    scope_sha256: string;
    provider_audit_reference: string;
    provider_native_read_only_identity_verified: boolean;
    all_accounts_and_regions_enumerated: boolean;
    inventory_complete: boolean;
    pagination_exhausted: boolean;
    source_receipts_verified: boolean;
    source_kinds: string[];
    unclassified_copy_count: number;
    candidate_references: string[];
  };
  candidate: {
    candidate_reference: string;
    cluster_reference: string;
    system_identifier: string;
    archive_reference: string;
    object_reference: string;
    generation_reference: string;
    timeline_id: string;
    segment_name: string;
    tenant_exclusive: boolean;
    tenant_isolation_evidence_reference: string;
    retention_expires_at: string;
  };
  retention: {
    policy_reference: string;
    policy_version: number;
    data_owner_approval_reference: string;
    infrastructure_owner_approval_reference: string;
    legal_hold_status: 'NONE' | 'ACTIVE' | 'UNKNOWN';
    minimum_recovery_horizon_end_at: string;
  };
  dependencies: {
    inventory_complete: boolean;
    all_writer_principals_enumerated: boolean;
    writer_inventory_sha256: string;
    pending_archive_retries: number;
    replication_paths: Array<{ path_reference: string; candidate_dependency: PostgresqlWalPitrDependencyAnswer }>;
    restore_paths: Array<{ path_reference: string; candidate_dependency: PostgresqlWalPitrDependencyAnswer }>;
    restore_rehearsal_status: 'PASS' | 'FAIL' | 'UNKNOWN';
    tombstone_replay_status: 'VERIFIED' | 'FAILED' | 'UNKNOWN';
    last_rehearsed_at: string;
    rehearsal_evidence_reference: string;
  };
}

export interface PostgresqlWalPitrRetentionEligibilityResult {
  schema: typeof POSTGRESQL_WAL_PITR_RETENTION_ELIGIBILITY_SCHEMA;
  status: 'BLOCKED' | 'REVIEW_ELIGIBLE';
  evaluated_at: string;
  candidate_reference: string | null;
  candidate_identity_sha256: string | null;
  blockers: string[];
  destructive_action_permitted: false;
  deletion_authorized: false;
  requires_independent_review: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isReference(value: unknown): value is string {
  return typeof value === 'string' && SAFE_REFERENCE.test(value)
    && !value.includes('://')
    && !/(secret|password|credential|access[-_]?key|token)/i.test(value);
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null;
  return parsed;
}

function add(blockers: string[], condition: boolean, message: string): void {
  if (!condition) blockers.push(message);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'null', 'utf8').digest('hex');
}

/**
 * Non-destructive preflight for a provider-owned WAL/PITR object generation.
 *
 * This function does not delete, expire, or authorize deletion. REVIEW_ELIGIBLE
 * means only that supplied evidence satisfies the mechanical preconditions for
 * an independent human/provider-owner review. The caller must already have
 * authenticated source receipts and provider audit evidence.
 */
export function evaluatePostgresqlWalPitrRetentionEligibility(
  value: unknown,
  expectedTenantId: string,
  nowValue: Date | number = Date.now(),
): PostgresqlWalPitrRetentionEligibilityResult {
  const now = nowValue instanceof Date ? nowValue.getTime() : nowValue;
  const blockers: string[] = [];

  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) {
    return {
      schema: POSTGRESQL_WAL_PITR_RETENTION_ELIGIBILITY_SCHEMA,
      status: 'BLOCKED',
      evaluated_at: new Date(0).toISOString(),
      candidate_reference: null,
      candidate_identity_sha256: null,
      blockers: ['Evaluation clock is invalid.'],
      destructive_action_permitted: false,
      deletion_authorized: false,
      requires_independent_review: true,
    };
  }
  const evaluatedAt = new Date(now).toISOString();
  if (!isRecord(value) || value.schema !== POSTGRESQL_WAL_PITR_RETENTION_ELIGIBILITY_SCHEMA) {
    blockers.push('Eligibility evidence schema is missing or unsupported.');
  }

  const input = isRecord(value) ? value as unknown as PostgresqlWalPitrRetentionEligibilityInput : null;
  if (!input) {
    return {
      schema: POSTGRESQL_WAL_PITR_RETENTION_ELIGIBILITY_SCHEMA,
      status: 'BLOCKED',
      evaluated_at: evaluatedAt,
      candidate_reference: null,
      candidate_identity_sha256: null,
      blockers,
      destructive_action_permitted: false,
      deletion_authorized: false,
      requires_independent_review: true,
    };
  }

  add(blockers, typeof expectedTenantId === 'string' && UUID.test(expectedTenantId)
    && UUID.test(input.tenant_id) && input.tenant_id.toLowerCase() === expectedTenantId.toLowerCase(),
  'Evidence tenant does not match the authoritative expected tenant.');
  add(blockers, isReference(input.evaluation_reference), 'Evaluation reference is missing or invalid.');
  const declaredEvaluationTime = timestamp(input.evaluated_at);
  add(blockers, declaredEvaluationTime !== null
    && Math.abs(declaredEvaluationTime - now) <= CLOCK_SKEW_MS,
  'Evaluation timestamp is invalid, stale, or outside clock-skew tolerance.');

  const inventory = isRecord(input.inventory) ? input.inventory : null;
  if (!inventory) {
    blockers.push('Provider inventory evidence is missing.');
  } else {
    const generatedAt = timestamp(inventory.generated_at);
    add(blockers, isReference(inventory.inventory_id), 'Inventory identity is missing or invalid.');
    add(blockers, SHA256.test(String(inventory.manifest_sha256 ?? '')), 'Inventory manifest digest is invalid.');
    add(blockers, SHA256.test(String(inventory.scope_sha256 ?? '')), 'Inventory scope digest is invalid.');
    add(blockers, isReference(inventory.provider_audit_reference),
      'Provider-native query/audit reference is missing.');
    add(blockers, inventory.provider_native_read_only_identity_verified === true,
      'Provider-enforced read-only collector identity is not independently verified.');
    add(blockers, inventory.all_accounts_and_regions_enumerated === true,
      'Authoritative provider account/project and region discovery is incomplete.');
    add(blockers, inventory.inventory_complete === true && inventory.pagination_exhausted === true,
      'Provider inventory is incomplete or pagination is not exhausted.');
    add(blockers, inventory.source_receipts_verified === true,
      'All source receipts have not been independently authenticated.');
    const kinds = Array.isArray(inventory.source_kinds) ? inventory.source_kinds : [];
    add(blockers, kinds.length === REQUIRED_POSTGRESQL_WAL_PITR_RETENTION_SOURCES.length
      && new Set(kinds).size === kinds.length
      && REQUIRED_POSTGRESQL_WAL_PITR_RETENTION_SOURCES.every((kind) => kinds.includes(kind)),
    'The six required PostgreSQL WAL/PITR inventory sources are not all present exactly once.');
    add(blockers, Number.isSafeInteger(inventory.unclassified_copy_count)
      && inventory.unclassified_copy_count === 0,
    'One or more discovered backup copies remain unclassified.');
    add(blockers, generatedAt !== null && generatedAt <= now + CLOCK_SKEW_MS
      && generatedAt >= now - MAX_INVENTORY_AGE_MS,
    'Provider inventory is stale or has an invalid generation timestamp.');
    add(blockers, Array.isArray(inventory.candidate_references)
      && inventory.candidate_references.every(isReference),
    'Inventory candidate reference list is missing or malformed.');
  }

  const candidate = isRecord(input.candidate) ? input.candidate : null;
  let candidateIdentitySha256: string | null = null;
  let candidateReference: string | null = null;
  if (!candidate) {
    blockers.push('Exact provider object-generation candidate is missing.');
  } else {
    candidateReference = isReference(candidate.candidate_reference) ? candidate.candidate_reference : null;
    add(blockers, candidateReference !== null, 'Candidate reference is missing or invalid.');
    add(blockers, isReference(candidate.cluster_reference), 'PostgreSQL cluster reference is invalid.');
    add(blockers, /^\d{1,20}$/.test(String(candidate.system_identifier ?? '')),
      'PostgreSQL system identifier is invalid.');
    add(blockers, isReference(candidate.archive_reference), 'WAL archive reference is invalid.');
    add(blockers, isReference(candidate.object_reference), 'Provider object reference is invalid.');
    add(blockers, isReference(candidate.generation_reference), 'Immutable object version/generation reference is required.');
    add(blockers, TIMELINE.test(String(candidate.timeline_id ?? '')), 'WAL timeline identifier is invalid.');
    add(blockers, SEGMENT.test(String(candidate.segment_name ?? ''))
      && String(candidate.segment_name).startsWith(String(candidate.timeline_id ?? '')),
    'WAL segment name does not match its declared timeline.');
    add(blockers, candidate.tenant_exclusive === true,
      'WAL object is not proven tenant-exclusive; shared cluster WAL must not be tenant-deleted.');
    add(blockers, isReference(candidate.tenant_isolation_evidence_reference),
      'Independent tenant-isolation evidence reference is missing.');
    const candidateExpiry = timestamp(candidate.retention_expires_at);
    add(blockers, candidateExpiry !== null && candidateExpiry <= now,
      'Provider retention expiry has not elapsed or is invalid.');
    if (candidateReference && isReference(candidate.cluster_reference)
      && isReference(candidate.archive_reference) && isReference(candidate.object_reference)
      && isReference(candidate.generation_reference)) {
      candidateIdentitySha256 = digest({
        candidateReference,
        clusterReference: candidate.cluster_reference,
        systemIdentifier: candidate.system_identifier,
        archiveReference: candidate.archive_reference,
        objectReference: candidate.object_reference,
        generationReference: candidate.generation_reference,
        timelineId: candidate.timeline_id,
        segmentName: candidate.segment_name,
      });
    }
    add(blockers, inventory !== null && Array.isArray(inventory.candidate_references)
      && inventory.candidate_references.includes(candidateReference ?? ''),
    'Exact candidate generation is not included in the verified provider inventory.');
  }

  const retention = isRecord(input.retention) ? input.retention : null;
  if (!retention) {
    blockers.push('Retention policy evidence is missing.');
  } else {
    add(blockers, isReference(retention.policy_reference), 'Approved retention policy reference is missing.');
    add(blockers, Number.isSafeInteger(retention.policy_version) && retention.policy_version > 0,
      'Retention policy version is invalid.');
    add(blockers, isReference(retention.data_owner_approval_reference),
      'Data owner retention approval is missing.');
    add(blockers, isReference(retention.infrastructure_owner_approval_reference),
      'Infrastructure owner retention approval is missing.');
    add(blockers, retention.legal_hold_status === 'NONE',
      'A legal hold is active or its status is unknown.');
    const recoveryHorizonEnd = timestamp(retention.minimum_recovery_horizon_end_at);
    add(blockers, recoveryHorizonEnd !== null && recoveryHorizonEnd <= now,
      'Minimum approved PITR recovery horizon has not elapsed or is invalid.');
    const candidateExpiry = timestamp(candidate?.retention_expires_at);
    add(blockers, candidateExpiry !== null && recoveryHorizonEnd !== null
      && candidateExpiry >= recoveryHorizonEnd,
    'Candidate expiry conflicts with the minimum recovery horizon.');
  }

  const dependencies = isRecord(input.dependencies) ? input.dependencies : null;
  if (!dependencies) {
    blockers.push('Writer, replication and restore dependency evidence is missing.');
  } else {
    add(blockers, dependencies.inventory_complete === true
      && dependencies.all_writer_principals_enumerated === true,
    'Writer and dependency discovery is incomplete.');
    add(blockers, SHA256.test(String(dependencies.writer_inventory_sha256 ?? '')),
      'Writer-principal inventory digest is invalid.');
    add(blockers, Number.isSafeInteger(dependencies.pending_archive_retries)
      && dependencies.pending_archive_retries === 0,
    'Pending or delayed archive retries remain.');
    for (const [label, paths] of [
      ['replication', dependencies.replication_paths],
      ['restore', dependencies.restore_paths],
    ] as const) {
      add(blockers, Array.isArray(paths), label + ' dependency inventory is missing.');
      if (Array.isArray(paths)) {
        for (const path of paths) {
          add(blockers, isRecord(path) && isReference(path.path_reference),
            label + ' path has a missing or invalid reference.');
          add(blockers, isRecord(path) && path.candidate_dependency === 'NO',
            label + ' path depends on the candidate or has an unknown dependency result.');
        }
      }
    }
    add(blockers, dependencies.restore_rehearsal_status === 'PASS',
      'A successful PITR restore rehearsal is not evidenced.');
    add(blockers, dependencies.tombstone_replay_status === 'VERIFIED',
      'Application erasure tombstone replay is not verified on the restored copy.');
    const rehearsedAt = timestamp(dependencies.last_rehearsed_at);
    add(blockers, rehearsedAt !== null && rehearsedAt <= now + CLOCK_SKEW_MS
      && rehearsedAt >= now - MAX_RESTORE_REHEARSAL_AGE_MS,
    'PITR restore rehearsal evidence is stale or invalid.');
    add(blockers, isReference(dependencies.rehearsal_evidence_reference),
      'Independent PITR restore/tombstone rehearsal evidence reference is missing.');
  }

  const uniqueBlockers = [...new Set(blockers)];
  return {
    schema: POSTGRESQL_WAL_PITR_RETENTION_ELIGIBILITY_SCHEMA,
    status: uniqueBlockers.length === 0 ? 'REVIEW_ELIGIBLE' : 'BLOCKED',
    evaluated_at: evaluatedAt,
    candidate_reference: candidateReference,
    candidate_identity_sha256: candidateIdentitySha256,
    blockers: uniqueBlockers,
    destructive_action_permitted: false,
    deletion_authorized: false,
    requires_independent_review: true,
  };
}
