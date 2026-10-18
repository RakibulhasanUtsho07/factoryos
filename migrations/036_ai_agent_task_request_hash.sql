BEGIN;

-- The runtime fingerprints task definitions for safe idempotent replay.
-- Existing rows remain NULL and continue to fail closed on unverifiable replays.
ALTER TABLE agent_tasks
    ADD COLUMN IF NOT EXISTS request_hash VARCHAR(64) NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'agent_tasks'::regclass
          AND conname = 'chk_agent_task_request_hash_sha256'
    ) THEN
        ALTER TABLE agent_tasks
            ADD CONSTRAINT chk_agent_task_request_hash_sha256
            CHECK (
                request_hash IS NULL
                OR request_hash ~ '^[0-9a-f]{64}$'
            );
    END IF;
END $$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('036_ai_agent_task_request_hash', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
