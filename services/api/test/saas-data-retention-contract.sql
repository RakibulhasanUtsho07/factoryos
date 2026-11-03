DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'saas_tenant_data_retention_policies',
    'saas_tenant_data_legal_holds',
    'saas_tenant_data_erasure_requests',
    'saas_tenant_data_export_preservation_attestations',
    'saas_tenant_data_retention_runs',
    'saas_tenant_data_erasure_runs',
    'saas_tenant_finance_retention_policies',
    'saas_tenant_finance_retention_runs',
    'saas_usage_rate_cards',
    'saas_usage_events',
    'saas_usage_adjustments',
    'saas_usage_reconciliations',
    'saas_usage_budgets',
    'saas_budget_evaluations',
    'saas_budget_alerts',
    'saas_budget_alert_acknowledgements',
    'saas_workload_control_events',
    'saas_provider_cost_events',
    'saas_provider_cost_reconciliations',
    'saas_billing_provider_accounts',
    'saas_billing_provider_account_events',
    'saas_billing_close_runs',
    'saas_billing_close_events',
    'saas_billing_provider_webhook_events',
    'saas_billing_reconciliation_results'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      WHERE c.oid = format('public.%I', table_name)::regclass
        AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN RAISE EXCEPTION 'RLS must be enabled and forced for %', table_name; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = format('public.%I', table_name)::regclass
        AND COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%tenant_id%'
        AND COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%factoryos_current_tenant_id%'
        AND COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%tenant_id%'
        AND COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%factoryos_current_tenant_id%'
    ) THEN RAISE EXCEPTION 'tenant isolation policy is missing or not tenant-bound for %', table_name; END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='saas_retention_policy_immutable' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'retention policy immutability trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='saas_tenant_data_legal_hold_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'legal hold lifecycle trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='saas_tenant_data_erasure_request_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'erasure request governance trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='saas_export_preservation_attestation_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'independent export preservation attestation guard is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_saas_tenant_erasure_export') THEN
    RAISE EXCEPTION 'erasure request must reference an export manifest in the same tenant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_saas_export_preservation_transfer') THEN
    RAISE EXCEPTION 'export preservation evidence must bind to an exact tenant export version';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE code='saas.data_retention.approve') THEN
    RAISE EXCEPTION 'retention approval permission is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE code='saas.data_retention.execute') THEN
    RAISE EXCEPTION 'retention execution permission is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_saas_tenant_erasure_execution_run') THEN
    RAISE EXCEPTION 'verified erasure must reference a tenant-scoped immutable execution receipt';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_saas_retention_run_policy') THEN
    RAISE EXCEPTION 'retention runs must snapshot an exact versioned retention policy';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='saas_tenant_data_retention_runs_immutable' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'retention run evidence must be immutable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='saas_tenant_data_erasure_runs_immutable' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'erasure execution receipts must be immutable';
  END IF;

  -- The finance retention inventory adapter is read-only by design. All listed
  -- usage, budget, provider-cost and commercial-billing tables must retain forced
  -- tenant RLS and an enabled DELETE guard; no generic erasure may bypass them.
  FOREACH table_name IN ARRAY ARRAY[
    'saas_usage_rate_cards',
    'saas_usage_events',
    'saas_usage_adjustments',
    'saas_usage_reconciliations',
    'saas_usage_budgets',
    'saas_budget_evaluations',
    'saas_budget_alerts',
    'saas_budget_alert_acknowledgements',
    'saas_workload_control_events',
    'saas_provider_cost_events',
    'saas_provider_cost_reconciliations',
    'saas_billing_provider_accounts',
    'saas_billing_provider_account_events',
    'saas_billing_close_runs',
    'saas_billing_close_events',
    'saas_billing_provider_webhook_events',
    'saas_billing_reconciliation_results'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE n.nspname='public' AND c.relname=table_name
        AND NOT t.tgisinternal AND t.tgenabled <> 'D'
        AND pg_get_triggerdef(t.oid) ILIKE '%DELETE%'
        AND p.prosrc ILIKE '%RAISE EXCEPTION%'
    ) THEN
      RAISE EXCEPTION 'immutable DELETE guard is missing for finance ledger relation %', table_name;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='chk_saas_retention_run_mode'
      AND pg_get_constraintdef(oid) NOT LIKE '%DRY_RUN%'
  ) THEN
    RAISE EXCEPTION 'retention run mode contract is incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.proname='factoryos_guard_saas_retention_policy_version'
      AND p.prosrc ILIKE '%protected retention category requires REVIEW disposition%'
  ) THEN
    RAISE EXCEPTION 'protected audit, approval, effective-dated and IAM categories must require REVIEW disposition';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.proname='factoryos_guard_saas_tenant_data_erasure_request'
      AND p.prosrc ILIKE '%requested erasure category has no reviewed deletion adapter%'
  ) THEN
    RAISE EXCEPTION 'database must reject erasure categories without an approved deletion adapter';
  END IF;

END;
$$;
