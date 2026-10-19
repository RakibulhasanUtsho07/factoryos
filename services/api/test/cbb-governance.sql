-- PostgreSQL contract checks for CBB Round 26 governance.
DO $$
DECLARE
  required_table TEXT;
  required_index TEXT;
  required_trigger TEXT;
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'business_cbb_staleness_reviews',
    'business_terminology_aliases',
    'business_terminology_alias_history',
    'business_cbb_impact_links',
    'business_cbb_rollback_events',
    'business_acl_history'
  ] LOOP
    IF to_regclass('public.' || required_table) IS NULL THEN
      RAISE EXCEPTION 'CBB_GOVERNANCE_REQUIRED_TABLE_MISSING: %', required_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      WHERE c.oid = to_regclass('public.' || required_table)
        AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'CBB_GOVERNANCE_RLS_NOT_FORCED: %', required_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename=required_table
        AND policyname=required_table || '_tenant_isolation'
    ) THEN
      RAISE EXCEPTION 'CBB_GOVERNANCE_TENANT_POLICY_MISSING: %', required_table;
    END IF;
  END LOOP;

  FOREACH required_index IN ARRAY ARRAY[
    'uq_cbb_staleness_review_subject',
    'idx_cbb_staleness_open_scope',
    'uq_cbb_terminology_alias_scope',
    'idx_cbb_terminology_alias_context',
    'idx_cbb_terminology_canonical_scope',
    'idx_cbb_terminology_history_scope',
    'uq_cbb_impact_link',
    'idx_cbb_impact_source',
    'idx_cbb_impact_ref',
    'idx_cbb_rollback_scope',
    'idx_business_acl_history_scope'
  ] LOOP
    IF to_regclass('public.' || required_index) IS NULL THEN
      RAISE EXCEPTION 'CBB_GOVERNANCE_REQUIRED_INDEX_MISSING: %', required_index;
    END IF;
  END LOOP;

  FOREACH required_trigger IN ARRAY ARRAY[
    'business_acl_record_history',
    'business_acl_history_immutable',
    'business_terminology_alias_history_record',
    'business_terminology_alias_history_immutable',
    'business_cbb_rollback_events_immutable',
    'business_cbb_impact_links_immutable'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgname=required_trigger AND NOT t.tgisinternal AND t.tgenabled <> 'D'
    ) THEN
      RAISE EXCEPTION 'CBB_GOVERNANCE_REQUIRED_TRIGGER_MISSING: %', required_trigger;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version='132_cbb_governance'
  ) OR NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version='133_cbb_terminology_context'
  ) THEN
    RAISE EXCEPTION 'CBB_GOVERNANCE_MIGRATION_REGISTRATION_MISSING';
  END IF;

  IF position('language_code' IN pg_get_indexdef('public.uq_cbb_terminology_alias_scope'::regclass)) = 0
     OR position('source_system' IN pg_get_indexdef('public.uq_cbb_terminology_alias_scope'::regclass)) = 0 THEN
    RAISE EXCEPTION 'CBB_TERMINOLOGY_ALIAS_CONTEXT_UNIQUENESS_MISSING';
  END IF;

  IF position('CBB_GOVERNANCE_HISTORY_IS_APPEND_ONLY'
      IN pg_get_functiondef('public.factoryos_cbb_reject_governance_history_mutation()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'CBB_GOVERNANCE_APPEND_ONLY_GUARD_MISSING';
  END IF;

  RAISE NOTICE 'CBB governance access, staleness, terminology, impact and rollback contract passed';
END $$;
