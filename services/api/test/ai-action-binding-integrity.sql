-- B17 SQL regression check.
-- Run only AFTER migrations/026_ai_action_binding_integrity.sql has been applied.
-- All test objects are temporary and the transaction is rolled back.

BEGIN;

CREATE TEMP TABLE ai_action_binding_integrity_probe (
    action_type  VARCHAR(200) NOT NULL,
    tool_id      VARCHAR(200),
    tool_version VARCHAR(100),
    harmless_note INTEGER NOT NULL DEFAULT 0
) ON COMMIT DROP;

-- Simulate a historical row that predates the B17 trigger.
INSERT INTO ai_action_binding_integrity_probe (
    action_type, tool_id, tool_version, harmless_note
) VALUES (
    'LEGACY.ACTION', NULL, NULL, 0
);

CREATE TRIGGER ai_action_binding_integrity_probe_guard
BEFORE INSERT OR UPDATE ON ai_action_binding_integrity_probe
FOR EACH ROW
EXECUTE FUNCTION factoryos_enforce_ai_action_tool_binding_integrity();

DO $$
DECLARE
    rejected BOOLEAN;
    observed_version VARCHAR(100);
    observed_count INTEGER;
BEGIN
    -- A valid, bound new action can be inserted.
    INSERT INTO ai_action_binding_integrity_probe (
        action_type, tool_id, tool_version
    ) VALUES (
        'AI.RUNTIME.NOOP', 'AI.RUNTIME.NOOP', '1.0.0'
    );

    -- Changing the version after insertion must fail with check_violation.
    rejected := FALSE;
    BEGIN
        UPDATE ai_action_binding_integrity_probe
        SET tool_version = '9.9.9'
        WHERE tool_id = 'AI.RUNTIME.NOOP';
    EXCEPTION WHEN SQLSTATE '23514' THEN
        rejected := TRUE;
    END;

    IF NOT rejected THEN
        RAISE EXCEPTION 'TEST FAILED: changing tool_version was not rejected';
    END IF;

    SELECT tool_version INTO observed_version
    FROM ai_action_binding_integrity_probe
    WHERE tool_id = 'AI.RUNTIME.NOOP';

    IF observed_version IS DISTINCT FROM '1.0.0' THEN
        RAISE EXCEPTION 'TEST FAILED: rejected update changed tool_version to %', observed_version;
    END IF;

    -- A new action without a complete binding must fail.
    rejected := FALSE;
    BEGIN
        INSERT INTO ai_action_binding_integrity_probe (
            action_type, tool_id, tool_version
        ) VALUES (
            'UNBOUND.NEW', NULL, NULL
        );
    EXCEPTION WHEN SQLSTATE '23514' THEN
        rejected := TRUE;
    END;

    IF NOT rejected THEN
        RAISE EXCEPTION 'TEST FAILED: new unbound action insert was not rejected';
    END IF;

    -- The action type and tool ID must agree on insertion.
    rejected := FALSE;
    BEGIN
        INSERT INTO ai_action_binding_integrity_probe (
            action_type, tool_id, tool_version
        ) VALUES (
            'AI.RUNTIME.NOOP', 'AUDIT_ONLY', '1.0.0'
        );
    EXCEPTION WHEN SQLSTATE '23514' THEN
        rejected := TRUE;
    END;

    IF NOT rejected THEN
        RAISE EXCEPTION 'TEST FAILED: mismatched action_type/tool_id insert was not rejected';
    END IF;

    -- Existing unbound rows may receive unrelated updates.
    UPDATE ai_action_binding_integrity_probe
    SET harmless_note = 1
    WHERE action_type = 'LEGACY.ACTION';

    -- But a legacy NULL/NULL binding cannot be backfilled after the fact.
    rejected := FALSE;
    BEGIN
        UPDATE ai_action_binding_integrity_probe
        SET tool_id = 'LEGACY.ACTION', tool_version = '1.0.0'
        WHERE action_type = 'LEGACY.ACTION';
    EXCEPTION WHEN SQLSTATE '23514' THEN
        rejected := TRUE;
    END;

    IF NOT rejected THEN
        RAISE EXCEPTION 'TEST FAILED: legacy unbound action was backfilled';
    END IF;

    SELECT COUNT(*) INTO observed_count
    FROM ai_action_binding_integrity_probe
    WHERE action_type = 'LEGACY.ACTION'
      AND tool_id IS NULL
      AND tool_version IS NULL
      AND harmless_note = 1;

    IF observed_count <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: legacy NULL/NULL binding was not preserved';
    END IF;

    RAISE NOTICE 'B17 AI action binding integrity checks passed';
END;
$$;

ROLLBACK;
