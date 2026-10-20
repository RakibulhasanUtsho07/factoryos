BEGIN;

-- Task 36 / SRS agent workflow reliability:
-- Persist retry eligibility instead of immediately re-queueing failed steps.
-- Retry timestamps are operational state, never part of the immutable step contract.

ALTER TABLE agent_task_steps
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'agent_task_steps'::regclass
      AND conname = 'chk_agent_task_steps_retry_schedule'
  ) THEN
    ALTER TABLE agent_task_steps
      ADD CONSTRAINT chk_agent_task_steps_retry_schedule
      CHECK (next_retry_at IS NULL OR status = 'PENDING');
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_agent_task_steps_due_retry
  ON agent_task_steps (tenant_id, factory_id, next_retry_at)
  WHERE status = 'PENDING' AND next_retry_at IS NOT NULL;

CREATE OR REPLACE FUNCTION factoryos_normalize_agent_task_step_retry_schedule()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- A due time is meaningful only while a step is pending. This keeps legacy
  -- cancellation/completion updates compatible and prevents stale due times.
  IF NEW.status <> 'PENDING' THEN
    NEW.next_retry_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_task_steps_retry_schedule_normalize
  ON agent_task_steps;

CREATE TRIGGER agent_task_steps_retry_schedule_normalize
BEFORE INSERT OR UPDATE ON agent_task_steps
FOR EACH ROW
EXECUTE FUNCTION factoryos_normalize_agent_task_step_retry_schedule();

COMMENT ON COLUMN agent_task_steps.next_retry_at IS
  'Earliest database time at which a bounded automatic retry may be claimed; NULL means immediately eligible or not scheduled.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('152_ai_agent_retry_backoff', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
