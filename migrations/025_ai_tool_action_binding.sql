BEGIN;

-- ============================================================
-- B16 / Bind governed AI action intents to immutable tool versions
-- ============================================================
-- Existing historical rows remain unbound (both columns NULL).
-- New authorization flows must persist both values together.
-- Runtime execution fails closed for legacy/unbound action intents.

ALTER TABLE ai_action_intents
    ADD COLUMN IF NOT EXISTS tool_id VARCHAR(200),
    ADD COLUMN IF NOT EXISTS tool_version VARCHAR(100);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_ai_action_tool_binding_pair'
          AND conrelid = 'ai_action_intents'::regclass
    ) THEN
        ALTER TABLE ai_action_intents
            ADD CONSTRAINT chk_ai_action_tool_binding_pair
            CHECK (
                (tool_id IS NULL AND tool_version IS NULL)
                OR (
                    tool_id IS NOT NULL
                    AND LENGTH(BTRIM(tool_id)) > 0
                    AND tool_version IS NOT NULL
                    AND LENGTH(BTRIM(tool_version)) > 0
                )
            );
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_ai_action_tool_binding
    ON ai_action_intents (
        tenant_id,
        factory_id,
        tool_id,
        tool_version
    );

INSERT INTO schema_migrations (
    version,
    checksum
)
VALUES (
    '025_ai_tool_action_binding',
    NULL
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
