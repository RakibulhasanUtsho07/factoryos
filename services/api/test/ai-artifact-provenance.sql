\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  table_name TEXT;
  rls_enabled BOOLEAN;
  rls_forced BOOLEAN;
  trigger_count INTEGER;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ai_artifact_trusted_sources',
    'ai_artifact_registry',
    'ai_artifact_provenance_events',
    'ai_artifact_admission_events'
  ]
  LOOP
    SELECT c.relrowsecurity, c.relforcerowsecurity
      INTO rls_enabled, rls_forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relname = table_name;

    IF rls_enabled IS DISTINCT FROM TRUE OR rls_forced IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'RLS must be enabled and forced on %', table_name;
    END IF;
  END LOOP;

  SELECT COUNT(*) INTO trigger_count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relname = 'ai_artifact_trusted_sources'
     AND t.tgname = 'ai_artifact_trusted_sources_guard'
     AND NOT t.tgisinternal;
  IF trigger_count <> 1 THEN
    RAISE EXCEPTION 'Trusted source lifecycle guard trigger is missing';
  END IF;

  SELECT COUNT(*) INTO trigger_count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relname = 'ai_artifact_registry'
     AND t.tgname = 'ai_artifact_registry_guard'
     AND NOT t.tgisinternal;
  IF trigger_count <> 1 THEN
    RAISE EXCEPTION 'Artifact immutability/revocation guard trigger is missing';
  END IF;

  SELECT COUNT(*) INTO trigger_count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relname IN ('ai_artifact_provenance_events', 'ai_artifact_admission_events')
     AND t.tgname IN ('ai_artifact_provenance_events_immutable', 'ai_artifact_admission_events_immutable')
     AND NOT t.tgisinternal;
  IF trigger_count <> 2 THEN
    RAISE EXCEPTION 'Append-only artifact provenance/admission event triggers are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'ai_artifact_registry'::regclass
       AND conname = 'uq_ai_artifact_registry_version_identity'
  ) THEN
    RAISE EXCEPTION 'Artifact version identity must be unique per tenant';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'ai_artifact_registry'::regclass
       AND conname = 'fk_ai_artifact_source_tenant'
  ) THEN
    RAISE EXCEPTION 'Artifact source must be constrained to the same tenant';
  END IF;
END $$;

ROLLBACK;
