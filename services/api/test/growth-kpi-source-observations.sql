-- PostgreSQL contract for version-pinned source-of-record KPI observations.
DO $$
DECLARE definition TEXT;
BEGIN
  IF to_regclass('public.growth_kpi_source_sync_runs') IS NULL
     OR to_regclass('public.growth_kpi_source_observations') IS NULL
     OR to_regclass('public.growth_kpi_source_sync_items') IS NULL THEN
    RAISE EXCEPTION 'GROWTH_KPI_SOURCE_OBSERVATION_TABLES_MISSING';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY[
      'growth_kpi_source_sync_runs','growth_kpi_source_observations','growth_kpi_source_sync_items'
    ]) AS t(table_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('public.'||t.table_name)
        AND c.relrowsecurity AND c.relforcerowsecurity
    )
  ) THEN RAISE EXCEPTION 'GROWTH_KPI_SOURCE_RLS_NOT_FORCED'; END IF;

  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname='public'
         AND tablename IN ('growth_kpi_source_sync_runs','growth_kpi_source_observations','growth_kpi_source_sync_items')
         AND qual LIKE '%factoryos_current_tenant_id%'
         AND with_check LIKE '%factoryos_current_tenant_id%') <> 3 THEN
    RAISE EXCEPTION 'GROWTH_KPI_SOURCE_TENANT_POLICIES_MISSING';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_growth_kpi_observation_finance_source'
      AND conrelid='public.growth_kpi_source_observations'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_growth_kpi_observation_production_source'
      AND conrelid='public.growth_kpi_source_observations'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_growth_kpi_source_sync_idempotency'
      AND conrelid='public.growth_kpi_source_sync_runs'::regclass) THEN
    RAISE EXCEPTION 'GROWTH_KPI_SOURCE_LINEAGE_OR_IDEMPOTENCY_CONSTRAINTS_MISSING';
  END IF;

  SELECT pg_get_functiondef('public.factoryos_guard_growth_kpi_source_observation()'::regprocedure) INTO definition;
  IF definition NOT LIKE '%GROWTH_KPI_SOURCE_REQUIRES_ACTIVE_FINANCE_REPORTING_CONNECTOR%'
     OR definition NOT LIKE '%GROWTH_KPI_SOURCE_METRIC_FACT_TYPE_MISMATCH%'
     OR definition NOT LIKE '%GROWTH_KPI_SOURCE_OBSERVATION_DOES_NOT_MATCH_CANONICAL_SOURCE_ROW%'
     OR definition NOT LIKE '%GROWTH_KPI_SOURCE_OBSERVATION_EVIDENCE_MISMATCH%'
     OR definition NOT LIKE '%GROWTH_KPI_SOURCE_OBSERVATION_APPEND_ONLY%' THEN
    RAISE EXCEPTION 'GROWTH_KPI_SOURCE_CANONICAL_GUARD_INCOMPLETE';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.growth_kpi_source_observations'::regclass
        AND tgname='growth_kpi_source_observation_guard' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.growth_opportunity_evidence'::regclass
        AND tgname='growth_source_observation_evidence_link_guard' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.growth_opportunity_evidence'::regclass
        AND tgname='growth_source_observation_evidence_immutable' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'GROWTH_KPI_SOURCE_EVIDENCE_GUARDS_MISSING';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='177_growth_kpi_source_observations') THEN
    RAISE EXCEPTION 'GROWTH_KPI_SOURCE_MIGRATION_NOT_REGISTERED';
  END IF;
END;
$$;
SELECT 'growth KPI source-of-record PostgreSQL contract passed' AS result;
