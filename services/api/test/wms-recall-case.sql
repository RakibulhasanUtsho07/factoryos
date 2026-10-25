DO $$
BEGIN
  IF to_regclass('public.wms_traceability_recall_cases') IS NULL
     OR to_regclass('public.wms_traceability_recall_case_units') IS NULL THEN
    RAISE EXCEPTION 'WMS traceability recall case tables are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid='public.wms_traceability_recall_cases'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid='public.wms_traceability_recall_case_units'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'Recall cases and case-unit membership must FORCE tenant RLS';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='wms_traceability_recall_cases'
      AND policyname='wms_traceability_recall_cases_tenant_isolation'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='wms_traceability_recall_case_units'
      AND policyname='wms_traceability_recall_case_units_tenant_isolation'
  ) THEN
    RAISE EXCEPTION 'Recall case tenant isolation policies are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.wms_traceability_recall_cases'::regclass
      AND conname='uq_wms_traceability_recall_case_idempotency'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.wms_traceability_recall_case_units'::regclass
      AND conname='uq_wms_traceability_recall_case_unit'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.wms_traceability_recall_case_units'::regclass
      AND conname='chk_wms_traceability_recall_unit_action'
  ) THEN
    RAISE EXCEPTION 'Recall idempotency, unique membership and status-action constraints are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.wms_traceability_recall_cases'::regclass
      AND tgname='trg_wms_traceability_recall_case_guard' AND tgenabled='O'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.wms_traceability_recall_case_units'::regclass
      AND tgname='trg_wms_traceability_recall_case_unit_guard' AND tgenabled='O'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.wms_traceability_recall_cases'::regclass
      AND tgname='ctr_wms_traceability_recall_case_evidence' AND tgenabled='O'
  ) THEN
    RAISE EXCEPTION 'Recall append-only or deferred audit/outbox guards are missing or disabled';
  END IF;

  IF to_regprocedure('public.factoryos_assert_wms_traceability_recall_case()') IS NULL
     OR to_regprocedure('public.factoryos_guard_wms_traceability_recall_case()') IS NULL
     OR to_regprocedure('public.factoryos_guard_wms_traceability_recall_case_unit()') IS NULL THEN
    RAISE EXCEPTION 'Recall database guard functions are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version='205_wms_traceability_recall_execution'
  ) THEN
    RAISE EXCEPTION 'Recall migration version is not registered';
  END IF;
END;
$$;