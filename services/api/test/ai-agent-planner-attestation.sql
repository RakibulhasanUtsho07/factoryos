-- PostgreSQL contract for trusted planner provenance and write-once evidence.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='agent_tasks' AND column_name='plan_hash'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='agent_tasks' AND column_name='planner_attestation'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='agent_tasks' AND column_name='planner_attestation_verified_at'
  ) THEN
    RAISE EXCEPTION 'AI_PLANNER_ATTESTATION_COLUMNS_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.agent_tasks'::regclass
      AND conname='chk_agent_tasks_plan_hash_sha256'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.agent_tasks'::regclass
      AND conname='chk_agent_tasks_planner_attestation_envelope'
  ) THEN
    RAISE EXCEPTION 'AI_PLANNER_ATTESTATION_CONSTRAINTS_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.agent_tasks'::regclass
      AND tgname='agent_tasks_planner_attestation_immutable'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'AI_PLANNER_ATTESTATION_IMMUTABILITY_TRIGGER_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version='181_ai_agent_planner_attestation'
  ) THEN
    RAISE EXCEPTION 'AI_PLANNER_ATTESTATION_MIGRATION_MARKER_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='idx_agent_tasks_planner_provenance'
  ) THEN
    RAISE EXCEPTION 'AI_PLANNER_ATTESTATION_LOOKUP_INDEX_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='uq_agent_tasks_planner_attestation_id'
  ) THEN
    RAISE EXCEPTION 'AI_PLANNER_ATTESTATION_SINGLE_USE_GUARD_MISSING';
  END IF;
END $$;
ROLLBACK;
SELECT 'AI trusted planner attestation PostgreSQL contract passed' AS result;
