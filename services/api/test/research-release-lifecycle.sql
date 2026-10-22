-- PostgreSQL contract for immutable Research release history and active-version rollback.
DO $$
DECLARE
  required_table TEXT;
  required_constraint TEXT;
  required_trigger TEXT;
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'research_release_channels',
    'research_release_lifecycle_events'
  ] LOOP
    IF to_regclass('public.' || required_table) IS NULL THEN
      RAISE EXCEPTION 'RESEARCH_RELEASE_LIFECYCLE_REQUIRED_TABLE_MISSING: %', required_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid = to_regclass('public.' || required_table)
        AND relrowsecurity AND relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'RESEARCH_RELEASE_LIFECYCLE_RLS_NOT_FORCED: %', required_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = required_table
        AND policyname = required_table || '_tenant_isolation'
        AND qual LIKE '%factoryos_current_tenant_id%'
        AND with_check LIKE '%factoryos_current_tenant_id%'
    ) THEN
      RAISE EXCEPTION 'RESEARCH_RELEASE_LIFECYCLE_TENANT_POLICY_MISSING: %', required_table;
    END IF;
  END LOOP;

  FOREACH required_constraint IN ARRAY ARRAY[
    'uq_research_release_lifecycle_identity',
    'pk_research_release_channels',
    'fk_research_release_channel_active_release',
    'pk_research_release_lifecycle_events',
    'fk_research_release_lifecycle_release',
    'fk_research_release_lifecycle_related_release',
    'chk_research_release_lifecycle_event_type'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = required_constraint) THEN
      RAISE EXCEPTION 'RESEARCH_RELEASE_LIFECYCLE_REQUIRED_CONSTRAINT_MISSING: %', required_constraint;
    END IF;
  END LOOP;

  FOREACH required_trigger IN ARRAY ARRAY[
    'research_release_version_sequence_guard',
    'research_release_channel_guard',
    'research_release_lifecycle_events_guard',
    'research_source_zzzz_retract_stale_releases'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = required_trigger AND NOT tgisinternal
    ) THEN
      RAISE EXCEPTION 'RESEARCH_RELEASE_LIFECYCLE_REQUIRED_TRIGGER_MISSING: %', required_trigger;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '142_research_release_lifecycle'
  ) OR NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version='174_research_release_retraction'
  ) OR NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version='175_research_source_change_release_withdrawal'
  ) THEN
    RAISE EXCEPTION 'RESEARCH_RELEASE_LIFECYCLE_MIGRATION_NOT_REGISTERED';
  END IF;

  IF position('RESEARCH_RELEASE_VERSION_MUST_INCREMENT_BY_ONE'
      IN pg_get_functiondef('public.factoryos_guard_research_release_version_sequence()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'RESEARCH_RELEASE_MONOTONIC_VERSION_GUARD_MISSING';
  END IF;

  IF position('RESEARCH_RELEASE_CHANNEL_REQUIRES_A_NEW_TARGET_AND_NEXT_REVISION'
      IN pg_get_functiondef('public.factoryos_guard_research_release_channel()'::regprocedure)) = 0
     OR position('RESEARCH_RELEASE_CHANNEL_REQUIRES_CURRENT_APPROVED_CLAIMS_AND_SOURCE_RIGHTS'
      IN pg_get_functiondef('public.factoryos_guard_research_release_channel()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'RESEARCH_RELEASE_ACTIVE_POINTER_GUARD_MISSING';
  END IF;

  IF position('RESEARCH_RELEASE_CHANNEL_EMPTY_TARGET_REQUIRES_RETRACTION'
      IN pg_get_functiondef('public.factoryos_guard_research_release_channel()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'RESEARCH_RELEASE_RETRACTION_CHANNEL_GUARD_MISSING';
  END IF;

  IF position('RETRACTED' IN pg_get_constraintdef((
      SELECT oid FROM pg_constraint WHERE conname='chk_research_release_lifecycle_event_type'
    ))) = 0
     OR position('RESEARCH_RELEASE_RETRACTION_CHANNEL_NOT_EMPTY'
      IN pg_get_functiondef('public.factoryos_guard_research_release_lifecycle_event()'::regprocedure)) = 0
     OR position('RESEARCH_RELEASE_RETRACTION_REQUIRES_RECENT_ACTIVE_EVENT'
      IN pg_get_functiondef('public.factoryos_guard_research_release_lifecycle_event()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'RESEARCH_RELEASE_RETRACTION_HISTORY_GUARDS_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version='174_research_release_retraction'
  ) THEN
    RAISE EXCEPTION 'RESEARCH_RELEASE_RETRACTION_MIGRATION_NOT_REGISTERED';
  END IF;

  IF position('RESEARCH_RELEASE_LIFECYCLE_EVENTS_ARE_APPEND_ONLY'
      IN pg_get_functiondef('public.factoryos_guard_research_release_lifecycle_event()'::regprocedure)) = 0
     OR position('RESEARCH_RELEASE_LIFECYCLE_EVENT_TARGET_IS_NOT_ACTIVE'
      IN pg_get_functiondef('public.factoryos_guard_research_release_lifecycle_event()'::regprocedure)) = 0
     OR position('RESEARCH_RELEASE_LIFECYCLE_EVENT_SUCCESSOR_IS_NOT_ACTIVE'
      IN pg_get_functiondef('public.factoryos_guard_research_release_lifecycle_event()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'RESEARCH_RELEASE_LIFECYCLE_IMMUTABILITY_OR_POINTER_GUARD_MISSING';
  END IF;

  IF position('RESEARCH_SOURCE_REVISION_CHANGE_REQUIRES_AUTHENTICATED_TENANT_ACTOR'
      IN pg_get_functiondef('public.factoryos_research_retract_stale_active_releases()'::regprocedure)) = 0
     OR position('RESEARCH.RELEASE_RETRACTED'
      IN pg_get_functiondef('public.factoryos_research_retract_stale_active_releases()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'RESEARCH_SOURCE_REVISION_RELEASE_WITHDRAWAL_GUARD_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'research_knowledge_releases'
      AND indexname = 'uq_research_release_tenant_version'
  ) THEN
    RAISE EXCEPTION 'RESEARCH_RELEASE_VERSION_IDENTITY_INDEX_MISSING';
  END IF;

  RAISE NOTICE 'Research release approval, versioning, supersession and rollback contract passed';
END;
$$;
