-- Task 36 / persisted bounded retry scheduling contract.
-- This file is run after the ordered migration set in API PostgreSQL CI.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'agent_task_steps'
      AND column_name = 'next_retry_at'
      AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'Task 36: agent_task_steps.next_retry_at is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'agent_task_steps'::regclass
      AND conname = 'chk_agent_task_steps_retry_schedule'
  ) THEN
    RAISE EXCEPTION 'Task 36: retry schedule consistency constraint is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'agent_task_steps'
      AND indexname = 'idx_agent_task_steps_due_retry'
  ) THEN
    RAISE EXCEPTION 'Task 36: due retry lookup index is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'agent_task_steps'::regclass
      AND tgname = 'agent_task_steps_retry_schedule_normalize'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Task 36: retry schedule normalization trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM schema_migrations
    WHERE version = '152_ai_agent_retry_backoff'
  ) THEN
    RAISE EXCEPTION 'Task 36: migration history entry is missing';
  END IF;
END
$$;
