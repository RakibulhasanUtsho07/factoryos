BEGIN;

-- ============================================================
-- WP06 / Persist agent-task request fingerprints
-- ============================================================
-- A scoped idempotency key must only replay the same logical request.
-- Existing rows remain NULL until a matching replay can be verified;
-- runtime rejects an unverifiable legacy replay rather than guessing.

ALTER TABLE agent_tasks
    ADD COLUMN IF NOT EXISTS request_hash VARCHAR(64);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_agent_tasks_request_hash_format'
          AND conrelid = 'agent_tasks'::regclass
    ) THEN
        ALTER TABLE agent_tasks
            ADD CONSTRAINT chk_agent_tasks_request_hash_format
            CHECK (
                request_hash IS NULL
                OR request_hash ~ '^[a-f0-9]{64}$'
            );
    END IF;
END;
$$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('026_ai_agent_task_request_fingerprint', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
