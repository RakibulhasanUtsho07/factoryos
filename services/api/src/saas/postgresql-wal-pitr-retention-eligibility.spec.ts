import {
  evaluatePostgresqlWalPitrRetentionEligibility,
  POSTGRESQL_WAL_PITR_RETENTION_ELIGIBILITY_SCHEMA,
  REQUIRED_POSTGRESQL_WAL_PITR_RETENTION_SOURCES,
} from './postgresql-wal-pitr-retention-eligibility';

const now = Date.parse('2026-11-02T04:00:00.000Z');
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();

function eligibleEvidence() {
  return {
    schema: POSTGRESQL_WAL_PITR_RETENTION_ELIGIBILITY_SCHEMA,
    tenant_id: '31000000-0000-4000-8000-000000000001',
    evaluation_reference: 'retention-evaluation.run-001',
    evaluated_at: iso(now),
    inventory: {
      inventory_id: '31000000-0000-4000-8000-000000000002',
      generated_at: iso(now - 60 * 60 * 1000),
      manifest_sha256: 'a'.repeat(64),
      scope_sha256: 'b'.repeat(64),
      provider_audit_reference: 'audit.provider.query-001',
      provider_native_read_only_identity_verified: true,
      all_accounts_and_regions_enumerated: true,
      inventory_complete: true,
      pagination_exhausted: true,
      source_receipts_verified: true,
      source_kinds: [...REQUIRED_POSTGRESQL_WAL_PITR_RETENTION_SOURCES],
      unclassified_copy_count: 0,
      candidate_references: ['candidate.pg.archive.primary.segment-001'],
    },
    candidate: {
      candidate_reference: 'candidate.pg.archive.primary.segment-001',
      cluster_reference: 'pg.cluster.primary',
      system_identifier: '7656119800000000000',
      archive_reference: 'pg.archive.primary',
      object_reference: 'provider.object.wal.segment-001',
      generation_reference: 'provider.generation.0009',
      timeline_id: '00000001',
      segment_name: '000000010000000000000001',
      tenant_exclusive: true,
      tenant_isolation_evidence_reference: 'evidence.tenant-isolation.pg-wal-001',
      retention_expires_at: iso(now - 2 * 24 * 60 * 60 * 1000),
    },
    retention: {
      policy_reference: 'policy.pg.wal.retention.v3',
      policy_version: 3,
      data_owner_approval_reference: 'approval.data-owner.wal-001',
      infrastructure_owner_approval_reference: 'approval.infrastructure-owner.wal-001',
      legal_hold_status: 'NONE',
      minimum_recovery_horizon_end_at: iso(now - 3 * 24 * 60 * 60 * 1000),
    },
    dependencies: {
      inventory_complete: true,
      all_writer_principals_enumerated: true,
      writer_inventory_sha256: 'c'.repeat(64),
      pending_archive_retries: 0,
      replication_paths: [
        { path_reference: 'replication.pg.dr', candidate_dependency: 'NO' },
      ],
      restore_paths: [
        { path_reference: 'restore.pg.pitr', candidate_dependency: 'NO' },
      ],
      restore_rehearsal_status: 'PASS',
      tombstone_replay_status: 'VERIFIED',
      last_rehearsed_at: iso(now - 24 * 60 * 60 * 1000),
      rehearsal_evidence_reference: 'evidence.pitr.restore-and-tombstone.001',
    },
  };
}

function evaluate(value: unknown = eligibleEvidence()) {
  return evaluatePostgresqlWalPitrRetentionEligibility(value, now);
}

describe('PostgreSQL WAL/PITR retention eligibility evaluator', () => {
  it('returns REVIEW_ELIGIBLE only for a complete, fresh and tenant-exclusive provider candidate', () => {
    const result = evaluate();

    expect(result.status).toBe('REVIEW_ELIGIBLE');
    expect(result.blockers).toEqual([]);
    expect(result.candidate_reference).toBe('candidate.pg.archive.primary.segment-001');
    expect(result.candidate_identity_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('never authorizes a destructive action, even when every precondition is satisfied', () => {
    const result = evaluate();

    expect(result.destructive_action_permitted).toBe(false);
    expect(result.deletion_authorized).toBe(false);
    expect(result.requires_independent_review).toBe(true);
  });

  it('fails closed when provider-native read-only identity verification is absent', () => {
    const evidence = eligibleEvidence();
    evidence.inventory.provider_native_read_only_identity_verified = false;
    expect(evaluate(evidence).blockers).toContain(
      'Provider-enforced read-only collector identity is not independently verified.',
    );
  });

  it('fails closed when provider account or region discovery is incomplete', () => {
    const evidence = eligibleEvidence();
    evidence.inventory.all_accounts_and_regions_enumerated = false;
    expect(evaluate(evidence).status).toBe('BLOCKED');
  });

  it('rejects stale inventory even when source signatures are otherwise marked verified', () => {
    const evidence = eligibleEvidence();
    evidence.inventory.generated_at = iso(now - 25 * 60 * 60 * 1000);
    expect(evaluate(evidence).blockers).toContain(
      'Provider inventory is stale or has an invalid generation timestamp.',
    );
  });

  it('requires all six unique authenticated source kinds', () => {
    const missing = eligibleEvidence();
    missing.inventory.source_kinds.pop();
    expect(evaluate(missing).blockers).toContain(
      'The six required PostgreSQL WAL/PITR inventory sources are not all present exactly once.',
    );

    const duplicate = eligibleEvidence();
    duplicate.inventory.source_kinds[1] = duplicate.inventory.source_kinds[0];
    expect(evaluate(duplicate).status).toBe('BLOCKED');
  });

  it('rejects unclassified provider copies', () => {
    const evidence = eligibleEvidence();
    evidence.inventory.unclassified_copy_count = 1;
    expect(evaluate(evidence).blockers).toContain(
      'One or more discovered backup copies remain unclassified.',
    );
  });

  it('requires the exact immutable candidate generation to exist in the inventory', () => {
    const evidence = eligibleEvidence();
    evidence.inventory.candidate_references = [];
    expect(evaluate(evidence).blockers).toContain(
      'Exact candidate generation is not included in the verified provider inventory.',
    );
  });

  it('rejects a candidate that is not proven tenant-exclusive', () => {
    const evidence = eligibleEvidence();
    evidence.candidate.tenant_exclusive = false;
    expect(evaluate(evidence).blockers).toContain(
      'WAL object is not proven tenant-exclusive; shared cluster WAL must not be tenant-deleted.',
    );
  });

  it('rejects a missing immutable object generation identifier', () => {
    const evidence = eligibleEvidence();
    evidence.candidate.generation_reference = '';
    expect(evaluate(evidence).blockers).toContain(
      'Immutable object version/generation reference is required.',
    );
  });

  it('blocks active or unknown legal holds', () => {
    for (const legalHoldStatus of ['ACTIVE', 'UNKNOWN'] as const) {
      const evidence = eligibleEvidence();
      evidence.retention.legal_hold_status = legalHoldStatus;
      expect(evaluate(evidence).blockers).toContain(
        'A legal hold is active or its status is unknown.',
      );
    }
  });

  it('blocks retention expiry that has not elapsed', () => {
    const evidence = eligibleEvidence();
    evidence.candidate.retention_expires_at = iso(now + 1000);
    expect(evaluate(evidence).blockers).toContain(
      'Provider retention expiry has not elapsed or is invalid.',
    );
  });

  it('blocks expiry earlier than the minimum approved recovery horizon', () => {
    const evidence = eligibleEvidence();
    evidence.retention.minimum_recovery_horizon_end_at = iso(now - 24 * 60 * 60 * 1000);
    expect(evaluate(evidence).blockers).toContain(
      'Candidate expiry conflicts with the minimum recovery horizon.',
    );
  });

  it('blocks incomplete writer discovery and delayed archive retries', () => {
    const evidence = eligibleEvidence();
    evidence.dependencies.all_writer_principals_enumerated = false;
    evidence.dependencies.pending_archive_retries = 1;
    const result = evaluate(evidence);
    expect(result.blockers).toContain('Writer and dependency discovery is incomplete.');
    expect(result.blockers).toContain('Pending or delayed archive retries remain.');
  });

  it('blocks a replication path that depends on the candidate or has unknown dependency state', () => {
    for (const candidate_dependency of ['YES', 'UNKNOWN'] as const) {
      const evidence = eligibleEvidence();
      evidence.dependencies.replication_paths[0].candidate_dependency = candidate_dependency;
      expect(evaluate(evidence).blockers).toContain(
        'replication path depends on the candidate or has an unknown dependency result.',
      );
    }
  });

  it('blocks a restore path that depends on the candidate', () => {
    const evidence = eligibleEvidence();
    evidence.dependencies.restore_paths[0].candidate_dependency = 'YES';
    expect(evaluate(evidence).blockers).toContain(
      'restore path depends on the candidate or has an unknown dependency result.',
    );
  });

  it('requires a successful PITR restore rehearsal and verified tombstone replay', () => {
    const evidence = eligibleEvidence();
    evidence.dependencies.restore_rehearsal_status = 'UNKNOWN';
    evidence.dependencies.tombstone_replay_status = 'UNKNOWN';
    const result = evaluate(evidence);
    expect(result.blockers).toContain('A successful PITR restore rehearsal is not evidenced.');
    expect(result.blockers).toContain(
      'Application erasure tombstone replay is not verified on the restored copy.',
    );
  });

  it('rejects stale restore rehearsal evidence', () => {
    const evidence = eligibleEvidence();
    evidence.dependencies.last_rehearsed_at = iso(now - 31 * 24 * 60 * 60 * 1000);
    expect(evaluate(evidence).blockers).toContain(
      'PITR restore rehearsal evidence is stale or invalid.',
    );
  });

  it('rejects malformed candidate identifiers and timeline/segment mismatch', () => {
    const evidence = eligibleEvidence();
    evidence.candidate.segment_name = '000000020000000000000001';
    const result = evaluate(evidence);
    expect(result.status).toBe('BLOCKED');
    expect(result.blockers).toContain('WAL segment name does not match its declared timeline.');
  });

  it('rejects unsupported schema and malformed evaluation clocks without authorizing deletion', () => {
    const invalid = eligibleEvidence();
    invalid.schema = 'factoryos.unknown/v1' as typeof POSTGRESQL_WAL_PITR_RETENTION_ELIGIBILITY_SCHEMA;
    expect(evaluate(invalid).status).toBe('BLOCKED');
    const invalidClock = evaluatePostgresqlWalPitrRetentionEligibility(eligibleEvidence(), Number.NaN);
    expect(invalidClock.status).toBe('BLOCKED');
    expect(invalidClock.deletion_authorized).toBe(false);
  });

  it('deduplicates blocker messages for stable operator output', () => {
    const evidence = eligibleEvidence();
    evidence.inventory.inventory_complete = false;
    evidence.inventory.pagination_exhausted = false;
    const result = evaluate(evidence);
    expect(result.blockers.filter((item) => item ===
      'Provider inventory is incomplete or pagination is not exhausted.')).toHaveLength(1);
  });
});
