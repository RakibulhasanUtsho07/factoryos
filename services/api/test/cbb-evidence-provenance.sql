-- PostgreSQL contract checks for CBB Round 25 evidence provenance.
-- Run after migrations 001-131 and before the API integration suite.
DO $$
DECLARE
  required_column TEXT;
  missing_columns TEXT[] := ARRAY[]::TEXT[];
  required_name TEXT;
BEGIN
  IF to_regclass('public.business_evidence') IS NULL
     OR to_regclass('public.business_evidence_links') IS NULL
     OR to_regclass('public.business_conflicts') IS NULL
     OR to_regclass('public.business_conflict_history') IS NULL THEN
    RAISE EXCEPTION 'CBB_EVIDENCE_SCHEMA_TABLE_MISSING';
  END IF;

  FOREACH required_column IN ARRAY ARRAY[
    'business_evidence.source_key',
    'business_evidence.source_system',
    'business_evidence.source_record_id',
    'business_evidence.source_version',
    'business_evidence.source_uri',
    'business_evidence.supersedes_evidence_id',
    'business_evidence.revision_no',
    'business_evidence_links.blueprint_id',
    'business_evidence_links.blueprint_version_id',
    'business_conflicts.version',
    'business_conflicts.updated_at',
    'business_conflicts.resolution_reason',
    'business_conflicts.resolution_evidence_id',
    'business_conflict_history.conflict_id',
    'business_conflict_history.version',
    'business_conflict_history.action',
    'business_conflict_history.evidence_refs',
    'business_conflict_history.actor_user_id'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = split_part(required_column, '.', 1)
        AND a.attname = split_part(required_column, '.', 2)
        AND a.attnum > 0
        AND NOT a.attisdropped
    ) THEN
      missing_columns := array_append(missing_columns, required_column);
    END IF;
  END LOOP;
  IF cardinality(missing_columns) > 0 THEN
    RAISE EXCEPTION 'CBB_EVIDENCE_REQUIRED_COLUMNS_MISSING: %', array_to_string(missing_columns, ', ');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.oid='public.business_conflict_history'::regclass
      AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'CBB_CONFLICT_HISTORY_RLS_MUST_BE_ENABLED_AND_FORCED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public'
      AND tablename='business_conflict_history'
      AND policyname='business_conflict_history_tenant_isolation'
  ) THEN
    RAISE EXCEPTION 'CBB_CONFLICT_HISTORY_TENANT_POLICY_MISSING';
  END IF;

  FOREACH required_name IN ARRAY ARRAY[
    'uq_business_evidence_source_revision',
    'idx_business_evidence_source_history',
    'idx_business_evidence_links_blueprint_version',
    'idx_business_conflict_history_scope'
  ] LOOP
    IF to_regclass('public.' || required_name) IS NULL THEN
      RAISE EXCEPTION 'CBB_EVIDENCE_REQUIRED_INDEX_MISSING: %', required_name;
    END IF;
  END LOOP;

  FOREACH required_name IN ARRAY ARRAY[
    'business_evidence_revision_guard',
    'business_evidence_immutable',
    'business_evidence_links_validate',
    'business_evidence_links_immutable',
    'business_conflicts_guard_transition',
    'business_conflicts_record_history',
    'business_conflict_history_guard_insert',
    'business_conflict_history_immutable'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid IN (
        'public.business_evidence'::regclass,
        'public.business_evidence_links'::regclass,
        'public.business_conflicts'::regclass,
        'public.business_conflict_history'::regclass
      )
        AND t.tgname=required_name
        AND NOT t.tgisinternal
        AND t.tgenabled <> 'D'
    ) THEN
      RAISE EXCEPTION 'CBB_EVIDENCE_REQUIRED_TRIGGER_MISSING: %', required_name;
    END IF;
  END LOOP;

  FOREACH required_name IN ARRAY ARRAY[
    'fk_business_evidence_supersedes_scope',
    'fk_business_evidence_links_evidence_scope',
    'fk_business_evidence_links_blueprint_scope',
    'fk_business_evidence_links_version_scope',
    'fk_business_conflicts_resolution_evidence'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE connamespace='public'::regnamespace
        AND conname=required_name
        AND contype='f'
    ) THEN
      RAISE EXCEPTION 'CBB_EVIDENCE_REQUIRED_FOREIGN_KEY_MISSING: %', required_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version='131_cbb_evidence_provenance'
  ) THEN
    RAISE EXCEPTION 'CBB_EVIDENCE_MIGRATION_REGISTRATION_MISSING';
  END IF;

  IF position('CBB_EVIDENCE_PREDECESSOR_IS_NOT_LATEST' IN pg_get_functiondef('public.factoryos_cbb_guard_evidence_revision()'::regprocedure)) = 0
     OR position('CBB_EVIDENCE_TARGET_NOT_FOUND_IN_FACTORY' IN pg_get_functiondef('public.factoryos_cbb_validate_evidence_link()'::regprocedure)) = 0
     OR position('CBB_CONFLICT_EXPECTED_VERSION_MISMATCH' IN pg_get_functiondef('public.factoryos_cbb_guard_conflict_transition()'::regprocedure)) = 0
     OR position('CBB_CONFLICT_HISTORY_IS_APPEND_ONLY' IN pg_get_functiondef('public.factoryos_cbb_reject_conflict_history_update()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'CBB_EVIDENCE_GUARD_FUNCTIONS_INCOMPLETE';
  END IF;

  RAISE NOTICE 'CBB evidence provenance and conflict governance contract passed';
END
$$;
