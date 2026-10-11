BEGIN;

-- WP06: durable, redacted linkage from an agent task step to its execution.
ALTER TABLE agent_task_steps
  ADD COLUMN IF NOT EXISTS execution_evidence JSONB NOT NULL DEFAULT '{}'::JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_task_steps'::regclass
      AND conname = 'chk_agent_task_steps_execution_evidence_object'
  ) THEN
    ALTER TABLE agent_task_steps
      ADD CONSTRAINT chk_agent_task_steps_execution_evidence_object
      CHECK (jsonb_typeof(execution_evidence) = 'object');
  END IF;
END $$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('032_ai_agent_execution_evidence', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
