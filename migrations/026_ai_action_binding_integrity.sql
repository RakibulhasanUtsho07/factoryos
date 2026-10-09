BEGIN;

-- ============================================================
-- B17 / Enforce AI action tool-binding integrity
-- ============================================================
-- New action intents must be born with a non-empty tool_id and
-- tool_version, and action_type must equal tool_id.
--
-- Existing historical rows may remain unbound (both fields NULL).
-- Their tool binding may not be added retroactively, and an existing
-- binding may never be changed. Other updates to historical unbound
-- rows remain permitted.
-- ============================================================

CREATE OR REPLACE FUNCTION factoryos_enforce_ai_action_tool_binding_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.tool_id IS NULL
           OR LENGTH(BTRIM(NEW.tool_id)) = 0
           OR NEW.tool_version IS NULL
           OR LENGTH(BTRIM(NEW.tool_version)) = 0 THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'New AI action intents must include non-empty tool_id and tool_version';
        END IF;

        IF NEW.action_type IS DISTINCT FROM NEW.tool_id THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'AI action action_type must match its bound tool_id';
        END IF;

        RETURN NEW;
    END IF;

    -- A legacy NULL/NULL binding cannot be backfilled after migration,
    -- and a populated binding cannot be switched to another tool/version.
    IF OLD.tool_id IS DISTINCT FROM NEW.tool_id
       OR OLD.tool_version IS DISTINCT FROM NEW.tool_version THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'AI action tool binding is immutable after insertion';
    END IF;

    -- Do not permit action_type to drift away from the immutable tool ID.
    -- Historical rows with a NULL/NULL binding remain untouched by this rule.
    IF NEW.tool_id IS NOT NULL
       AND NEW.action_type IS DISTINCT FROM NEW.tool_id THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'AI action action_type must match its immutable tool_id';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_action_tool_binding_integrity
    ON ai_action_intents;

CREATE TRIGGER trg_ai_action_tool_binding_integrity
BEFORE INSERT OR UPDATE ON ai_action_intents
FOR EACH ROW
EXECUTE FUNCTION factoryos_enforce_ai_action_tool_binding_integrity();

COMMENT ON FUNCTION factoryos_enforce_ai_action_tool_binding_integrity() IS
    'B17: requires new AI action tool bindings and prevents binding mutation; preserves historical NULL/NULL bindings.';

INSERT INTO schema_migrations (
    version,
    checksum
)
VALUES (
    '026_ai_action_binding_integrity',
    NULL
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
