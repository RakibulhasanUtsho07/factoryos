-- PostgreSQL contract: source-backed Growth KPI baseline and actual provenance.
DO $$
DECLARE
  experiment_definition TEXT;
  outcome_definition TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='growth_experiment_result_kpis'
       AND column_name='baseline_evidence_ref'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='growth_outcome_kpi_measurements'
       AND column_name='baseline_evidence_ref'
  ) THEN
    RAISE EXCEPTION 'GROWTH_KPI_BASELINE_EVIDENCE_COLUMNS_MISSING';
  END IF;

  SELECT pg_get_functiondef('public.factoryos_guard_growth_experiment_result_kpi()'::regprocedure)
    INTO experiment_definition;
  IF experiment_definition NOT LIKE '%GROWTH_EXPERIMENT_KPI_SOURCE_REQUIRES_BOTH_BASELINE_AND_ACTUAL_OBSERVATIONS%'
     OR experiment_definition NOT LIKE '%GROWTH_EXPERIMENT_KPI_SOURCE_OBSERVATION_VALUE_UNIT_TIME_OR_VERSION_MISMATCH%'
     OR experiment_definition NOT LIKE '%baseline_evidence_ref%'
     OR experiment_definition NOT LIKE '%result_observed_at%' THEN
    RAISE EXCEPTION 'GROWTH_EXPERIMENT_KPI_BASELINE_PROVENANCE_GUARD_MISSING';
  END IF;

  SELECT pg_get_functiondef('public.factoryos_guard_growth_outcome_kpi_measurement()'::regprocedure)
    INTO outcome_definition;
  IF outcome_definition NOT LIKE '%GROWTH_OUTCOME_KPI_SOURCE_REQUIRES_BOTH_BASELINE_AND_ACTUAL_OBSERVATIONS%'
     OR outcome_definition NOT LIKE '%GROWTH_OUTCOME_KPI_SOURCE_OBSERVATION_VALUE_UNIT_TIME_OR_VERSION_MISMATCH%'
     OR outcome_definition NOT LIKE '%GROWTH_OUTCOME_KPI_BASELINE_EVIDENCE_NOT_LINKED_TO_OUTCOME%'
     OR outcome_definition NOT LIKE '%baseline_evidence_ref%' THEN
    RAISE EXCEPTION 'GROWTH_OUTCOME_KPI_BASELINE_PROVENANCE_GUARD_MISSING';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.growth_experiment_result_kpis'::regclass
        AND tgname='growth_experiment_result_kpi_guard' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.growth_outcome_kpi_measurements'::regclass
        AND tgname='growth_outcome_kpi_measurement_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'GROWTH_KPI_BASELINE_PROVENANCE_TRIGGERS_MISSING';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM schema_migrations
      WHERE version='179_growth_kpi_baseline_evidence_provenance') THEN
    RAISE EXCEPTION 'GROWTH_KPI_BASELINE_PROVENANCE_MIGRATION_NOT_REGISTERED';
  END IF;
END;
$$;
SELECT 'growth KPI baseline evidence provenance PostgreSQL contract passed' AS result;
