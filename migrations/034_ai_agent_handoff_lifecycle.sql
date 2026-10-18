BEGIN;

-- Handoffs may leave PENDING only once, and terminal decisions cannot be reversed.
CREATE OR REPLACE FUNCTION factoryos_guard_agent_handoff_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF OLD.status <> 'PENDING'
           OR NEW.status NOT IN ('ACCEPTED', 'REJECTED', 'EXPIRED') THEN
            RAISE EXCEPTION
                'AI agent handoff lifecycle is terminal: invalid status transition % -> %',
                OLD.status,
                NEW.status
                USING ERRCODE = '55000';
        END IF;

        IF NEW.status = 'ACCEPTED'
           AND (NEW.accepted_by IS NULL OR NEW.accepted_at IS NULL) THEN
            RAISE EXCEPTION
                'AI agent handoff acceptance requires accepted_by and accepted_at'
                USING ERRCODE = '23514';
        END IF;

        IF NEW.status <> 'ACCEPTED'
           AND (NEW.accepted_by IS NOT NULL OR NEW.accepted_at IS NOT NULL) THEN
            RAISE EXCEPTION
                'Only an accepted handoff may carry acceptance metadata'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF ROW(NEW.accepted_by, NEW.accepted_at)
       IS DISTINCT FROM ROW(OLD.accepted_by, OLD.accepted_at)
       AND NOT (
           OLD.status = 'PENDING'
           AND NEW.status = 'ACCEPTED'
           AND OLD.accepted_by IS NULL
           AND OLD.accepted_at IS NULL
           AND NEW.accepted_by IS NOT NULL
           AND NEW.accepted_at IS NOT NULL
       ) THEN
        RAISE EXCEPTION
            'AI agent handoff acceptance metadata can only be set during PENDING -> ACCEPTED'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_handoffs_lifecycle_guard ON agent_handoffs;
CREATE TRIGGER agent_handoffs_lifecycle_guard
BEFORE UPDATE ON agent_handoffs
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_agent_handoff_lifecycle();

INSERT INTO schema_migrations (version, checksum)
VALUES ('034_ai_agent_handoff_lifecycle', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
