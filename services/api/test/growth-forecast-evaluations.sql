-- PostgreSQL contract for immutable operational forecast evaluation and calibration.
DO $$
DECLARE
  definition TEXT;
BEGIN
  IF to_regclass('public.growth_forecast_evaluations') IS NULL THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_EVALUATION_TABLE_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid = to_regclass('public.growth_forecast_evaluations')
       AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_EVALUATION_RLS_NOT_FORCED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'growth_forecast_evaluations'
       AND policyname = 'growth_forecast_evaluations_tenant_isolation'
       AND qual LIKE '%factoryos_current_tenant_id%'
       AND with_check LIKE '%factoryos_current_tenant_id%'
  ) THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_EVALUATION_TENANT_POLICY_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE version = '151_growth_forecast_evaluation_calibration'
  ) THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_EVALUATION_MIGRATION_NOT_REGISTERED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'uq_growth_forecast_evaluation_idempotency'
       AND conrelid = 'public.growth_forecast_evaluations'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'uq_growth_forecast_evaluation_observation'
       AND conrelid = 'public.growth_forecast_evaluations'::regclass
  ) THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_EVALUATION_IDEMPOTENCY_CONSTRAINTS_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_growth_forecast_evaluation_outcome_kpi'
       AND conrelid = 'public.growth_forecast_evaluations'::regclass
  ) THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_EVALUATION_OUTCOME_KPI_FK_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_growth_forecast_evaluation_outcome_kpi'
       AND conrelid = 'public.growth_forecast_evaluations'::regclass
  ) THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_EVALUATION_OUTCOME_KPI_FK_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_growth_forecast_evaluation_source_evidence'
       AND conrelid = 'public.growth_forecast_evaluations'::regclass
  ) THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_EVALUATION_SOURCE_EVIDENCE_FK_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.growth_forecast_evaluations'::regclass
       AND tgname = 'growth_forecast_evaluation_guard'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_EVALUATION_GUARD_TRIGGER_MISSING';
  END IF;

  SELECT pg_get_functiondef('public.factoryos_guard_growth_forecast_evaluation()'::regprocedure)
    INTO definition;
  IF definition NOT LIKE '%GROWTH_FORECAST_EVALUATION_ACTUAL_MUST_MATCH_IMMUTABLE_OUTCOME_KPI%'
     OR definition NOT LIKE '%GROWTH_FORECAST_SOURCE_REFERENCE_NOT_ATTACHED_TO_OPPORTUNITY%'
     OR definition NOT LIKE '%NEW.forecast_source_evidence_id%'
     OR definition NOT LIKE '%GROWTH_FORECAST_EVALUATION_ACTUAL_EVIDENCE_REF_MISMATCH%'
     OR definition NOT LIKE '%NEW.outcome_kpi_measurement_id%'
     OR definition NOT LIKE '%NEW.outcome_kpi_measurement_id%'
     OR definition NOT LIKE '%NEW.actual_evidence_ref IS DISTINCT FROM saved_evidence_ref%'
     OR definition NOT LIKE '%GROWTH_FORECAST_EVALUATION_ACTUAL_EVIDENCE_REF_MISMATCH%'
     OR definition NOT LIKE '%GROWTH_FORECAST_ERROR_METRICS_NOT_DETERMINISTIC%'
     OR definition NOT LIKE '%GROWTH_FORECAST_INTERVAL_METRICS_NOT_DETERMINISTIC%'
     OR definition NOT LIKE '%GROWTH_FORECAST_EVALUATION_APPEND_ONLY%' THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_EVALUATION_GUARD_CONTRACT_INCOMPLETE';
  END IF;
END;
$$;

SELECT 'growth forecast evaluation PostgreSQL contract passed' AS result;
