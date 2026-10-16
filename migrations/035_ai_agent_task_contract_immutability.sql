BEGIN;

-- Runtime task definitions are immutable once persisted; only execution state changes.
CREATE OR REPLACE FUNCTION factoryos_guard_agent_task_contract_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF ROW(
        NEW.id,
        NEW.tenant_id,
        NEW.factory_id,
        NEW.decision_id,
        NEW.parent_trace_id,
        NEW.actor_user_id,
        NEW.goal,
        NEW.max_steps,
        NEW.max_retries,
        NEW.max_tool_calls,
        NEW.timeout_ms,
        NEW.deadline_at,
        NEW.context_version,
        NEW.plan_version,
        NEW.context_hash,
        NEW.idempotency_key,
        NEW.request_hash,
        NEW.created_at
    ) IS DISTINCT FROM ROW(
        OLD.id,
        OLD.tenant_id,
        OLD.factory_id,
        OLD.decision_id,
        OLD.parent_trace_id,
        OLD.actor_user_id,
        OLD.goal,
        OLD.max_steps,
        OLD.max_retries,
        OLD.max_tool_calls,
        OLD.timeout_ms,
        OLD.deadline_at,
        OLD.context_version,
        OLD.plan_version,
        OLD.context_hash,
        OLD.idempotency_key,
        OLD.request_hash,
        OLD.created_at
    ) THEN
        RAISE EXCEPTION
            'AI agent task contract is immutable: definition fields cannot be updated'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_tasks_contract_immutable ON agent_tasks;
CREATE TRIGGER agent_tasks_contract_immutable
BEFORE UPDATE ON agent_tasks
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_agent_task_contract_immutable();

-- Step definitions (including action/tool/payload bindings) must remain unchanged
-- while execution status, attempts, approvals, evidence, output and error evolve.
CREATE OR REPLACE FUNCTION factoryos_guard_agent_task_step_contract_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF ROW(
        NEW.id,
        NEW.tenant_id,
        NEW.factory_id,
        NEW.task_id,
        NEW.step_key,
        NEW.step_index,
        NEW.agent_id,
        NEW.capability,
        NEW.input_schema,
        NEW.output_schema,
        NEW.tool_id,
        NEW.tool_version,
        NEW.action_type,
        NEW.target,
        NEW.payload,
        NEW.resource_type,
        NEW.resource_id,
        NEW.risk_class,
        NEW.timeout_ms,
        NEW.retry_limit,
        NEW.authority_level,
        NEW.depends_on,
        NEW.created_at
    ) IS DISTINCT FROM ROW(
        OLD.id,
        OLD.tenant_id,
        OLD.factory_id,
        OLD.task_id,
        OLD.step_key,
        OLD.step_index,
        OLD.agent_id,
        OLD.capability,
        OLD.input_schema,
        OLD.output_schema,
        OLD.tool_id,
        OLD.tool_version,
        OLD.action_type,
        OLD.target,
        OLD.payload,
        OLD.resource_type,
        OLD.resource_id,
        OLD.risk_class,
        OLD.timeout_ms,
        OLD.retry_limit,
        OLD.authority_level,
        OLD.depends_on,
        OLD.created_at
    ) THEN
        RAISE EXCEPTION
            'AI agent task step contract is immutable: definition fields cannot be updated'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_task_steps_contract_immutable ON agent_task_steps;
CREATE TRIGGER agent_task_steps_contract_immutable
BEFORE UPDATE ON agent_task_steps
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_agent_task_step_contract_immutable();

INSERT INTO schema_migrations (version, checksum)
VALUES ('035_ai_agent_task_contract_immutability', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
