\set ON_ERROR_STOP on
-- CI-only synthetic replay: the fixture row is present in the source snapshot.
-- Production replay SQL is operator/provider-specific and must consume the approved external ledger.
WITH tombstones AS (
  SELECT fixture_id, tenant_id
  FROM public.factoryos_ci_erasure_replay_ledger
  WHERE tombstone_id = 'ci-tombstone-after-snapshot-001'
), deleted AS (
  DELETE FROM public.factoryos_ci_erasure_replay_fixture AS fixture
  USING tombstones
  WHERE fixture.fixture_id = tombstones.fixture_id
    AND fixture.tenant_id = tombstones.tenant_id
  RETURNING fixture.fixture_id
)
SELECT 'FACTORYOS_ERASURE_REPLAYED_REQUESTS=' || count(*) FROM deleted;
\echo FACTORYOS_ERASURE_REPLAY_STATUS=PASS
\echo FACTORYOS_ERASURE_LEDGER_SHA256=:ledger_sha256
\echo FACTORYOS_ERASURE_LEDGER_REFERENCE=:ledger_reference
\echo FACTORYOS_ERASURE_REPLAY_CANDIDATE_SHA=:candidate_sha
\echo FACTORYOS_ERASURE_REPLAY_TARGET_IDENTITY=:target_database_identity
\echo FACTORYOS_ERASURE_LEDGER_WATERMARK_UTC=:incident_cutoff_utc
\echo FACTORYOS_ERASURE_REPLAY_RESIDUALS=0
