-- Advanced quality acceptance contracts: AQL, fabric rolls, supplier linkage and repeat-defect analytics.
BEGIN;

DO $$
DECLARE
  t TEXT;
  enabled BOOLEAN;
  forced BOOLEAN;
  required_tables TEXT[] := ARRAY[
    'quality_aql_profiles',
    'quality_fabric_scoring_profiles',
    'quality_sampling_profile_bindings',
    'quality_aql_sample_runs',
    'quality_fabric_roll_scores',
    'quality_defect_context_snapshots',
    'quality_supplier_quality_events'
  ];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version='164_quality_advanced_sampling_supplier_pareto'
  ) THEN RAISE EXCEPTION 'Advanced quality acceptance migration marker is missing'; END IF;

  FOREACH t IN ARRAY required_tables LOOP
    SELECT c.relrowsecurity,c.relforcerowsecurity INTO enabled,forced
    FROM pg_class c WHERE c.oid=to_regclass(t);
    IF COALESCE(enabled,FALSE) IS NOT TRUE OR COALESCE(forced,FALSE) IS NOT TRUE THEN
      RAISE EXCEPTION 'Advanced quality table % must force tenant RLS',t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=to_regclass(t)
      AND p.polname=t||'_tenant_isolation') THEN
      RAISE EXCEPTION 'Advanced quality tenant policy is missing for %',t;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_aql_profiles'::regclass
      AND tgname='trg_quality_aql_profile_lifecycle' AND NOT tgisinternal AND tgenabled<>'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_fabric_scoring_profiles'::regclass
      AND tgname='trg_quality_fabric_profile_lifecycle' AND NOT tgisinternal AND tgenabled<>'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_inspections'::regclass
      AND tgname='trg_quality_sampling_profile_binding' AND NOT tgisinternal AND tgenabled<>'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_aql_sample_runs'::regclass
      AND tgname='trg_quality_aql_sample_run_guard' AND NOT tgisinternal AND tgenabled<>'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_fabric_roll_scores'::regclass
      AND tgname='trg_quality_fabric_roll_score_guard' AND NOT tgisinternal AND tgenabled<>'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_inspections'::regclass
      AND tgname='trg_zz_quality_require_advanced_evidence' AND NOT tgisinternal AND tgenabled<>'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_defect_links'::regclass
      AND tgname='trg_quality_supplier_defect_link' AND NOT tgisinternal AND tgenabled<>'D') THEN
    RAISE EXCEPTION 'Advanced quality profile, decision, release or supplier guard is missing';
  END IF;

  IF to_regprocedure('factoryos_evaluate_aql_sample(integer,integer,integer)') IS NULL
    OR to_regprocedure('factoryos_guard_quality_advanced_profile()') IS NULL
    OR to_regprocedure('factoryos_guard_quality_aql_sample_run()') IS NULL
    OR to_regprocedure('factoryos_guard_quality_fabric_roll_score()') IS NULL
    OR to_regprocedure('factoryos_require_advanced_quality_evidence()') IS NULL
    OR to_regprocedure('factoryos_record_quality_supplier_defect()') IS NULL THEN
    RAISE EXCEPTION 'Advanced quality guard function is missing';
  END IF;

  IF factoryos_evaluate_aql_sample(0,1,3)<>'ACCEPT'
    OR factoryos_evaluate_aql_sample(1,1,3)<>'ACCEPT'
    OR factoryos_evaluate_aql_sample(2,1,3)<>'HOLD'
    OR factoryos_evaluate_aql_sample(3,1,3)<>'REJECT'
    OR factoryos_evaluate_aql_sample(2,2,2)<>'HOLD' THEN
    RAISE EXCEPTION 'AQL accept/reject/ambiguous decision oracle is inconsistent';
  END IF;

  -- Four-point score: 10 points on a 100-yard, 60-inch roll = 6 points / 100 square yards.
  IF round((10::numeric*3600)/(100::numeric*60),4)<>6.0000
    OR round((15.5::numeric*3600)/(50::numeric*60),4)<>18.6000 THEN
    RAISE EXCEPTION 'Fabric roll point-score arithmetic is inconsistent';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='quality_aql_sample_runs'::regclass
    AND conname='uq_quality_aql_run_per_inspection')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='quality_fabric_roll_scores'::regclass
    AND conname='uq_quality_fabric_roll_code')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='quality_supplier_quality_events'::regclass
    AND conname='uq_quality_supplier_event_source') THEN
    RAISE EXCEPTION 'Advanced quality duplicate-request/roll/source idempotency constraints are missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='quality_inspections'::regclass
    AND conname='fk_quality_inspection_aql_profile')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='quality_inspections'::regclass
    AND conname='fk_quality_inspection_fabric_profile') THEN
    RAISE EXCEPTION 'Inspection-to-approved-sampling-profile binding is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_sampling_profile_bindings'::regclass
    AND tgname='trg_quality_sampling_binding_immutable' AND NOT tgisinternal AND tgenabled<>'D') THEN
    RAISE EXCEPTION 'Sampling-profile binding evidence must be immutable';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_aql_sample_runs'::regclass
    AND tgname='trg_quality_aql_sample_run_immutable' AND NOT tgisinternal AND tgenabled<>'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_fabric_roll_scores'::regclass
    AND tgname='trg_quality_fabric_roll_score_immutable' AND NOT tgisinternal AND tgenabled<>'D')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='quality_supplier_quality_events'::regclass
    AND tgname='trg_quality_supplier_event_immutable' AND NOT tgisinternal AND tgenabled<>'D') THEN
    RAISE EXCEPTION 'AQL, roll scoring and supplier quality evidence must be append-only';
  END IF;

  IF position('AQL-bound inspection cannot pass without an ACCEPT sample decision'
      IN pg_get_functiondef('factoryos_require_advanced_quality_evidence()'::regprocedure))=0
    OR position('fabric-scored inspection requires the configured number of passing rolls'
      IN pg_get_functiondef('factoryos_require_advanced_quality_evidence()'::regprocedure))=0
    OR position('SUPPLIER_QUALITY_DEFECT_LINKED'
      IN pg_get_functiondef('factoryos_record_quality_supplier_defect()'::regprocedure))=0 THEN
    RAISE EXCEPTION 'Hold/release, minimum roll count or supplier audit linkage guard is incomplete';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM permissions WHERE code='quality.advanced.read')
    OR NOT EXISTS (SELECT 1 FROM permissions WHERE code='quality.advanced.manage') THEN
    RAISE EXCEPTION 'Advanced quality permissions are missing';
  END IF;

  RAISE NOTICE 'Advanced quality AQL, fabric scoring, supplier-linkage and release-gate contract passed';
END;
$$;

ROLLBACK;
