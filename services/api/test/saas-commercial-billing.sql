-- Task 24: commercial billing is isolated from usage estimates and all evidence is tenant-scoped/immutable.
DO $billing_contract$
DECLARE
  billing_relation_name text;
  rel_oid oid;
  trigger_name text;
  required_tables text[] := ARRAY[
    'saas_billing_provider_accounts',
    'saas_billing_provider_account_events',
    'saas_billing_close_runs',
    'saas_billing_close_events',
    'saas_billing_provider_webhook_events',
    'saas_billing_reconciliation_results'
  ];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version='185_saas_commercial_billing_provider'
  ) THEN
    RAISE EXCEPTION 'SAAS_COMMERCIAL_BILLING_MIGRATION_MARKER_MISSING';
  END IF;

  FOREACH billing_relation_name IN ARRAY required_tables LOOP
    rel_oid := to_regclass('public.' || quote_ident(billing_relation_name));
    IF rel_oid IS NULL THEN
      RAISE EXCEPTION 'SAAS_COMMERCIAL_BILLING_TABLE_MISSING: %', billing_relation_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c WHERE c.oid=rel_oid AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'SAAS_COMMERCIAL_BILLING_RLS_NOT_FORCED: %', billing_relation_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname='public' AND p.tablename=billing_relation_name
        AND p.policyname=billing_relation_name || '_tenant_isolation'
        AND COALESCE(p.qual,'') ILIKE '%factoryos_current_tenant_id%'
        AND COALESCE(p.with_check,'') ILIKE '%factoryos_current_tenant_id%'
    ) THEN
      RAISE EXCEPTION 'SAAS_COMMERCIAL_BILLING_TENANT_POLICY_MISSING: %', billing_relation_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname='public' AND p.tablename=billing_relation_name
        AND p.policyname='fo_privacy_scope_enforce' AND p.permissive='RESTRICTIVE'
        AND COALESCE(p.qual,'') ILIKE '%factoryos_current_tenant_id%'
        AND COALESCE(p.with_check,'') ILIKE '%factoryos_current_tenant_id%'
    ) THEN
      RAISE EXCEPTION 'SAAS_COMMERCIAL_BILLING_RESTRICTIVE_PRIVACY_FENCE_MISSING: %', billing_relation_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM factoryos_governance.tenant_relation_inventory i
      WHERE i.schema_name='public' AND i.relation_name=billing_relation_name
        AND i.scope_model='DIRECT_TENANT_ID' AND i.export_disposition='EXCLUDED'
        AND i.erasure_disposition='BLOCKED_FINANCE_REVIEW'
    ) THEN
      RAISE EXCEPTION 'SAAS_COMMERCIAL_BILLING_PRIVACY_INVENTORY_MISSING: %', billing_relation_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM factoryos_governance.tenant_relation_ownership_reviews r
      WHERE r.schema_name='public' AND r.relation_name=billing_relation_name
        AND r.ownership_class='DIRECT_TENANT' AND r.review_status='VERIFIED'
        AND r.erasure_disposition='BLOCKED_FINANCE_REVIEW'
    ) THEN
      RAISE EXCEPTION 'SAAS_COMMERCIAL_BILLING_OWNERSHIP_REVIEW_MISSING: %', billing_relation_name;
    END IF;
  END LOOP;

  FOREACH trigger_name IN ARRAY ARRAY[
    'saas_billing_provider_account_events_immutable',
    'saas_billing_close_runs_immutable',
    'saas_billing_close_events_immutable',
    'saas_billing_provider_webhook_events_immutable',
    'saas_billing_reconciliation_immutable'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgname=trigger_name AND NOT t.tgisinternal
        AND t.tgrelid IN (
          'public.saas_billing_provider_accounts'::regclass,
          'public.saas_billing_provider_account_events'::regclass,
          'public.saas_billing_close_runs'::regclass,
          'public.saas_billing_close_events'::regclass,
          'public.saas_billing_provider_webhook_events'::regclass,
          'public.saas_billing_reconciliation_results'::regclass
        )
    ) THEN
      RAISE EXCEPTION 'SAAS_COMMERCIAL_BILLING_IMMUTABILITY_TRIGGER_MISSING: %', trigger_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='fk_saas_billing_close_subscription'
      AND conrelid='public.saas_billing_close_runs'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='chk_saas_billing_close_subscription_snapshot'
      AND conrelid='public.saas_billing_close_runs'::regclass
  ) THEN
    RAISE EXCEPTION 'SAAS_BILLING_SUBSCRIPTION_SNAPSHOT_CONTRACT_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='uq_saas_billing_close_idempotency'
      AND conrelid='public.saas_billing_close_runs'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='uq_saas_billing_webhook_event'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='uq_saas_billing_close_idempotency'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='uq_saas_billing_reconciliation_idempotency'
  ) THEN
    RAISE EXCEPTION 'SAAS_COMMERCIAL_BILLING_IDEMPOTENCY_CONSTRAINTS_MISSING';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='saas_usage_events'
      AND column_name IN ('provider_invoice_id','issued_invoice_status','invoice_issued_at')
  ) THEN
    RAISE EXCEPTION 'USAGE_LEDGER_MUST_NOT_PRETEND_TO_BE_A_ISSUED_INVOICE';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM permissions WHERE code='saas.billing.close')
     OR NOT EXISTS (SELECT 1 FROM permissions WHERE code='saas.billing.issue')
     OR NOT EXISTS (SELECT 1 FROM permissions WHERE code='saas.billing.reconcile') THEN
    RAISE EXCEPTION 'SAAS_COMMERCIAL_BILLING_PERMISSIONS_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgname='saas_usage_events_billing_close_fence' AND NOT t.tgisinternal
      AND t.tgrelid='public.saas_usage_events'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgname='saas_usage_adjustments_billing_close_fence' AND NOT t.tgisinternal
      AND t.tgrelid='public.saas_usage_adjustments'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgname='saas_usage_reconciliations_billing_close_fence' AND NOT t.tgisinternal
      AND t.tgrelid='public.saas_usage_reconciliations'::regclass
  ) THEN
    RAISE EXCEPTION 'SAAS_BILLING_CLOSE_LEDGER_CONCURRENCY_FENCE_MISSING';
  END IF;
END $billing_contract$;

SELECT 'SaaS commercial billing provider, RLS, immutable evidence and idempotency contract passed' AS result;
