-- B18 database regression test.
-- Uses a transaction-scoped temporary table with the production columns,
-- constraints, and the production trigger function. No fixture is persisted.
BEGIN;

DO $$
DECLARE
    v_trigger_enabled "char";
    v_rls_enabled BOOLEAN;
    v_rls_forced BOOLEAN;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM schema_migrations
        WHERE version = '027_ai_execution_idempotency_claims'
    ) THEN
        RAISE EXCEPTION 'B18 migration marker is missing';
    END IF;

    SELECT tgenabled
      INTO v_trigger_enabled
      FROM pg_trigger
     WHERE tgrelid = 'ai_execution_claims'::regclass
       AND tgname = 'trg_ai_execution_claim_integrity'
       AND NOT tgisinternal;

    IF v_trigger_enabled IS DISTINCT FROM 'O' THEN
        RAISE EXCEPTION 'B18 execution claim integrity trigger is missing or disabled';
    END IF;

    SELECT relrowsecurity, relforcerowsecurity
      INTO v_rls_enabled, v_rls_forced
      FROM pg_class
     WHERE oid = 'ai_execution_claims'::regclass;

    IF v_rls_enabled IS DISTINCT FROM TRUE OR v_rls_forced IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'B18 execution claim table must enable and force RLS';
    END IF;
END;
$$;

CREATE TEMP TABLE b18_execution_claims_test
    (LIKE ai_execution_claims INCLUDING ALL);

CREATE TRIGGER b18_execution_claims_test_guard
BEFORE UPDATE OR DELETE ON b18_execution_claims_test
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_ai_execution_claim_mutation();

DO $$
DECLARE
    v_id UUID;
    v_failed_id UUID;
    v_rejected BOOLEAN;
    v_status TEXT;
    v_tenant_id UUID := gen_random_uuid();
    v_factory_id UUID := gen_random_uuid();
    v_action_id UUID := gen_random_uuid();
BEGIN
    INSERT INTO b18_execution_claims_test (
        tenant_id,
        factory_id,
        action_intent_id,
        execution_key,
        tool_version,
        inputs_hash,
        status
    ) VALUES (
        v_tenant_id,
        v_factory_id,
        v_action_id,
        'b18-key-complete',
        '1.0.0',
        repeat('a', 64),
        'CLAIMED'
    ) RETURNING id INTO v_id;

    -- One action intent may have only one claim.
    v_rejected := FALSE;
    BEGIN
        INSERT INTO b18_execution_claims_test (
            tenant_id, factory_id, action_intent_id, execution_key,
            tool_version, inputs_hash, status
        ) VALUES (
            v_tenant_id, v_factory_id, v_action_id, 'b18-key-duplicate-action',
            '1.0.0', repeat('a', 64), 'CLAIMED'
        );
    EXCEPTION WHEN unique_violation THEN
        v_rejected := TRUE;
    END;
    IF NOT v_rejected THEN
        RAISE EXCEPTION 'B18 allowed more than one claim for an action intent';
    END IF;

    -- An execution key is unique inside a tenant/factory scope.
    v_rejected := FALSE;
    BEGIN
        INSERT INTO b18_execution_claims_test (
            tenant_id, factory_id, action_intent_id, execution_key,
            tool_version, inputs_hash, status
        ) VALUES (
            v_tenant_id, v_factory_id, gen_random_uuid(), 'b18-key-complete',
            '1.0.0', repeat('a', 64), 'CLAIMED'
        );
    EXCEPTION WHEN unique_violation THEN
        v_rejected := TRUE;
    END;
    IF NOT v_rejected THEN
        RAISE EXCEPTION 'B18 allowed duplicate execution keys in one tenant/factory';
    END IF;

    v_rejected := FALSE;
    BEGIN
        UPDATE b18_execution_claims_test
           SET tool_version = '9.9.9'
         WHERE id = v_id;
    EXCEPTION WHEN check_violation THEN
        v_rejected := TRUE;
    END;
    IF NOT v_rejected THEN
        RAISE EXCEPTION 'B18 failed to reject mutation of a claimed tool version';
    END IF;

    -- The only allowed terminal transition is CLAIMED -> COMPLETED.
    UPDATE b18_execution_claims_test
       SET status = 'COMPLETED', completed_at = NOW()
     WHERE id = v_id;

    SELECT status INTO v_status
      FROM b18_execution_claims_test
     WHERE id = v_id;
    IF v_status <> 'COMPLETED' THEN
        RAISE EXCEPTION 'B18 failed to complete a valid execution claim';
    END IF;

    v_rejected := FALSE;
    BEGIN
        UPDATE b18_execution_claims_test
           SET status = 'FAILED', failure_code = 'LATE_FAILURE', completed_at = NOW()
         WHERE id = v_id;
    EXCEPTION WHEN check_violation THEN
        v_rejected := TRUE;
    END;
    IF NOT v_rejected THEN
        RAISE EXCEPTION 'B18 allowed mutation of a terminal execution claim';
    END IF;

    v_rejected := FALSE;
    BEGIN
        DELETE FROM b18_execution_claims_test
         WHERE id = v_id;
    EXCEPTION WHEN check_violation THEN
        v_rejected := TRUE;
    END;
    IF NOT v_rejected THEN
        RAISE EXCEPTION 'B18 allowed deletion of an execution claim';
    END IF;

    INSERT INTO b18_execution_claims_test (
        tenant_id,
        factory_id,
        action_intent_id,
        execution_key,
        tool_version,
        inputs_hash,
        status
    ) VALUES (
        gen_random_uuid(),
        gen_random_uuid(),
        gen_random_uuid(),
        'b18-key-failed',
        '2.0.0',
        repeat('b', 64),
        'CLAIMED'
    ) RETURNING id INTO v_failed_id;

    UPDATE b18_execution_claims_test
       SET status = 'FAILED',
           failure_code = 'TOOL_GATEWAY_ERROR',
           completed_at = NOW()
     WHERE id = v_failed_id;

    SELECT status INTO v_status
      FROM b18_execution_claims_test
     WHERE id = v_failed_id;
    IF v_status <> 'FAILED' THEN
        RAISE EXCEPTION 'B18 failed to persist a valid failed claim transition';
    END IF;

    RAISE NOTICE 'B18 AI execution idempotency checks passed';
END;
$$;

ROLLBACK;
