-- PostgreSQL contract for maker-checker, versioned domain calibration policies.
DO $$
DECLARE definition TEXT;
BEGIN
  IF to_regclass('public.growth_forecast_calibration_policies') IS NULL THEN
    RAISE EXCEPTION 'GROWTH_CALIBRATION_POLICY_TABLE_MISSING';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class
      WHERE oid='public.growth_forecast_calibration_policies'::regclass
        AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'GROWTH_CALIBRATION_POLICY_RLS_NOT_FORCED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename='growth_forecast_calibration_policies'
        AND policyname='growth_forecast_calibration_policies_tenant_isolation'
        AND COALESCE(qual,'') LIKE '%factoryos_current_tenant_id%'
        AND COALESCE(with_check,qual,'') LIKE '%factoryos_current_tenant_id%') THEN
    RAISE EXCEPTION 'GROWTH_CALIBRATION_POLICY_TENANT_POLICY_MISSING';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid='public.growth_forecast_calibration_policies'::regclass
        AND conname='uq_growth_calibration_policy_version')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid='public.growth_forecast_calibration_policies'::regclass
        AND conname='chk_growth_calibration_policy_sample')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid='public.growth_forecast_calibration_policies'::regclass
        AND conname='chk_growth_calibration_policy_decision') THEN
    RAISE EXCEPTION 'GROWTH_CALIBRATION_POLICY_VERSION_OR_REVIEW_CONSTRAINTS_MISSING';
  END IF;
  SELECT pg_get_functiondef('public.factoryos_guard_growth_forecast_calibration_policy()'::regprocedure) INTO definition;
  IF definition NOT LIKE '%GROWTH_CALIBRATION_POLICY_CONFIGURATION_IMMUTABLE%'
     OR definition NOT LIKE '%GROWTH_CALIBRATION_POLICY_REQUIRES_INDEPENDENT_REASONED_REVIEW%'
     OR definition NOT LIKE '%GROWTH_CALIBRATION_POLICY_APPEND_ONLY%'
     OR definition NOT LIKE '%GROWTH_CALIBRATION_POLICY_FINAL_DECISION_IMMUTABLE%' THEN
    RAISE EXCEPTION 'GROWTH_CALIBRATION_POLICY_GUARD_INCOMPLETE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.growth_forecast_calibration_policies'::regclass
        AND tgname='growth_forecast_calibration_policy_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'GROWTH_CALIBRATION_POLICY_TRIGGER_MISSING';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='178_growth_forecast_calibration_policies') THEN
    RAISE EXCEPTION 'GROWTH_CALIBRATION_POLICY_MIGRATION_NOT_REGISTERED';
  END IF;
END;
$$;
SELECT 'growth calibration policy PostgreSQL contract passed' AS result;
