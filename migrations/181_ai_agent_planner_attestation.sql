BEGIN;

-- Task 22 follow-up: planner metadata is trusted only when the provider signature
-- has been verified against the deployment-pinned Ed25519 public key.
ALTER TABLE agent_tasks
  ADD COLUMN IF NOT EXISTS plan_hash VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS planner_attestation JSONB NULL,
  ADD COLUMN IF NOT EXISTS planner_attestation_verified_at TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='agent_tasks'::regclass
      AND conname='chk_agent_tasks_plan_hash_sha256'
  ) THEN
    ALTER TABLE agent_tasks
      ADD CONSTRAINT chk_agent_tasks_plan_hash_sha256
      CHECK (plan_hash IS NULL OR plan_hash ~ '^[a-f0-9]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='agent_tasks'::regclass
      AND conname='chk_agent_tasks_planner_attestation_envelope'
  ) THEN
    ALTER TABLE agent_tasks
      ADD CONSTRAINT chk_agent_tasks_planner_attestation_envelope
      CHECK (
        (
          planner_attestation IS NULL
          AND plan_hash IS NULL
          AND planner_attestation_verified_at IS NULL
        )
        OR (
          planner_attestation IS NOT NULL
          AND plan_hash IS NOT NULL
          AND planner_attestation_verified_at IS NOT NULL
          AND COALESCE(jsonb_typeof(planner_attestation)='object',FALSE)
          AND COALESCE(jsonb_typeof(planner_attestation->'payload')='object',FALSE)
          AND COALESCE(planner_attestation->'payload'->>'attestation_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',FALSE)
          AND COALESCE(planner_attestation->>'signature' ~ '^[A-Za-z0-9_-]{86}$',FALSE)
          AND COALESCE(planner_attestation->'payload'->>'plan_hash' = plan_hash,FALSE)
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_tasks_planner_provenance
  ON agent_tasks (tenant_id,factory_id,agent_definition_id,planner_attestation_verified_at DESC)
  WHERE planner_attestation IS NOT NULL;

-- A signed plan receipt is single-use. Idempotent API retries replay the existing
-- task by request fingerprint before a second insert can be attempted.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_tasks_planner_attestation_id
  ON agent_tasks ((planner_attestation->'payload'->>'attestation_id'))
  WHERE planner_attestation IS NOT NULL;

CREATE OR REPLACE FUNCTION factoryos_guard_agent_task_planner_attestation_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.plan_hash,
    NEW.planner_attestation,
    NEW.planner_attestation_verified_at
  ) IS DISTINCT FROM ROW(
    OLD.plan_hash,
    OLD.planner_attestation,
    OLD.planner_attestation_verified_at
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE='23514',
      MESSAGE='AI agent planner provenance is immutable after task creation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_tasks_planner_attestation_immutable ON agent_tasks;
CREATE TRIGGER agent_tasks_planner_attestation_immutable
  BEFORE UPDATE ON agent_tasks
  FOR EACH ROW
  EXECUTE FUNCTION factoryos_guard_agent_task_planner_attestation_immutable();

INSERT INTO schema_migrations (version,checksum)
VALUES ('181_ai_agent_planner_attestation',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
