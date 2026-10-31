\set ON_ERROR_STOP on
-- Read-only CI verifier. The harness runs this file in a READ ONLY transaction.
DO $$
DECLARE
  expected_tombstones integer;
  residual_rows integer;
BEGIN
  SELECT count(*) INTO expected_tombstones
  FROM public.factoryos_ci_erasure_replay_ledger
  WHERE tombstone_id = 'ci-tombstone-after-snapshot-001';
  SELECT count(*) INTO residual_rows
  FROM public.factoryos_ci_erasure_replay_fixture AS fixture
  JOIN public.factoryos_ci_erasure_replay_ledger AS ledger
    ON ledger.fixture_id = fixture.fixture_id
  WHERE ledger.tombstone_id = 'ci-tombstone-after-snapshot-001';
  IF expected_tombstones <> 1 OR residual_rows <> 0 THEN
    RAISE EXCEPTION 'synthetic erasure replay reconciliation failed: expected %, residual %', expected_tombstones, residual_rows;
  END IF;
END $$;
SELECT 'FACTORYOS_ERASURE_VERIFY_REPLAYED_REQUESTS=' || count(*)
FROM public.factoryos_ci_erasure_replay_ledger
WHERE tombstone_id = 'ci-tombstone-after-snapshot-001';
\echo FACTORYOS_ERASURE_VERIFY_STATUS=PASS
\echo FACTORYOS_ERASURE_VERIFY_LEDGER_SHA256=:ledger_sha256
\echo FACTORYOS_ERASURE_VERIFY_CANDIDATE_SHA=:candidate_sha
\echo FACTORYOS_ERASURE_VERIFY_TARGET_IDENTITY=:target_database_identity
\echo FACTORYOS_ERASURE_VERIFY_RESIDUALS=0
\echo FACTORYOS_ERASURE_VERIFY_METHOD=INDEPENDENT_READ_ONLY
