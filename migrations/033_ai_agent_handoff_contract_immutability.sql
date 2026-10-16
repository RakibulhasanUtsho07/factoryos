BEGIN;

-- Handoff scope and authorization contract must not be rewritten after creation.
CREATE OR REPLACE FUNCTION factoryos_guard_agent_handoff_contract_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF ROW(
        NEW.id,
        NEW.tenant_id,
        NEW.factory_id,
        NEW.source_agent_id,
        NEW.target_agent_id,
        NEW.purpose,
        NEW.allowed_data_classes,
        NEW.permitted_tools,
        NEW.expires_at,
        NEW.parent_trace_id,
        NEW.expected_artifact,
        NEW.handoff_hash,
        NEW.created_at
    ) IS DISTINCT FROM ROW(
        OLD.id,
        OLD.tenant_id,
        OLD.factory_id,
        OLD.source_agent_id,
        OLD.target_agent_id,
        OLD.purpose,
        OLD.allowed_data_classes,
        OLD.permitted_tools,
        OLD.expires_at,
        OLD.parent_trace_id,
        OLD.expected_artifact,
        OLD.handoff_hash,
        OLD.created_at
    ) THEN
        RAISE EXCEPTION
            'AI agent handoff contract is immutable: contract fields cannot be updated'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_handoffs_contract_immutable ON agent_handoffs;
CREATE TRIGGER agent_handoffs_contract_immutable
BEFORE UPDATE ON agent_handoffs
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_agent_handoff_contract_immutable();

INSERT INTO schema_migrations (version, checksum)
VALUES ('033_ai_agent_handoff_contract_immutability', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
