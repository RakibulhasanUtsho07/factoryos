-- PostgreSQL contract for experiment/outcome KPI evidence linkage.
DO $$
DECLARE table_name TEXT; trigger_name TEXT; definition TEXT;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['growth_experiment_result_kpis','growth_outcome_kpi_measurements'] LOOP
  IF to_regclass('public.'||table_name) IS NULL THEN RAISE EXCEPTION 'GROWTH_KPI_REQUIRED_TABLE_MISSING: %',table_name; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.'||table_name) AND relrowsecurity AND relforcerowsecurity) THEN RAISE EXCEPTION 'GROWTH_KPI_RLS_NOT_FORCED: %',table_name; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=table_name AND policyname=table_name||'_tenant_isolation' AND qual LIKE '%factoryos_current_tenant_id%' AND with_check LIKE '%factoryos_current_tenant_id%') THEN RAISE EXCEPTION 'GROWTH_KPI_TENANT_POLICY_MISSING: %',table_name; END IF;
 END LOOP;
 FOREACH trigger_name IN ARRAY ARRAY['growth_experiment_result_kpi_guard','growth_outcome_kpi_measurement_guard','growth_experiment_result_kpi_completeness_guard','growth_outcome_kpi_completeness_guard','growth_experiment_result_kpis_immutable','growth_outcome_kpi_measurements_immutable'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=trigger_name AND NOT tgisinternal) THEN RAISE EXCEPTION 'GROWTH_KPI_REQUIRED_TRIGGER_MISSING: %',trigger_name; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fk_growth_outcome_kpi_source' AND conrelid='public.growth_outcome_kpi_measurements'::regclass)
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fk_growth_outcome_kpi_outcome' AND conrelid='public.growth_outcome_kpi_measurements'::regclass) THEN RAISE EXCEPTION 'GROWTH_KPI_SCOPE_FOREIGN_KEYS_MISSING'; END IF;
 definition:=pg_get_functiondef('public.factoryos_guard_growth_experiment_result_kpi()'::regprocedure);
 IF position('pre_measurements' IN definition)=0 OR position('post_measurements' IN definition)=0 OR position('evidence_refs' IN definition)=0 OR position('GROWTH_EXPERIMENT_KPI_VALUES_MUST_MATCH_RESULT_SNAPSHOT' IN definition)=0 THEN RAISE EXCEPTION 'GROWTH_EXPERIMENT_KPI_RESULT_VALIDATION_INCOMPLETE'; END IF;
 definition:=pg_get_functiondef('public.factoryos_guard_growth_outcome_kpi_measurement()'::regprocedure);
 IF position('realized_metrics' IN definition)=0 OR position('GROWTH_OUTCOME_KPI_DOES_NOT_MATCH_EXPERIMENT_BASELINE_TARGET_OR_DIRECTION' IN definition)=0 THEN RAISE EXCEPTION 'GROWTH_OUTCOME_KPI_LINK_VALIDATION_INCOMPLETE'; END IF;
 definition:=pg_get_functiondef('public.factoryos_guard_growth_outcome_kpi_completeness()'::regprocedure);
 IF position('GROWTH_OUTCOME_MUST_LINK_EVERY_SOURCE_EXPERIMENT_KPI' IN definition)=0 THEN RAISE EXCEPTION 'GROWTH_OUTCOME_KPI_COMPLETENESS_GUARD_INCOMPLETE'; END IF;
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='146_growth_experiment_kpi_evidence_linkage') THEN RAISE EXCEPTION 'GROWTH_KPI_MIGRATION_NOT_REGISTERED'; END IF;
END; $$;
