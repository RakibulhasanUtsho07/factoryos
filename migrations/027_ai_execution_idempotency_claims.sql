BEGIN;

-- ============================================================
-- B18 / Prevent duplicate AI tool execution under concurrency
-- ============================================================
-- A durable claim is inserted before the Tool Gateway is called.
-- Unique keys serialize concurrent calls across API instances.
-- CLAIMED rows are deliberately not automatically reclaimed after
-- a process crash because an external side effect may have occurred.
-- Such rows require reconciliation rather than unsafe replay.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_execution_claims (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,
    action_intent_id    UUID NOT NULL,
    execution_key       VARCHAR(255) NOT NULL,
    tool_version        VARCHAR(100) NOT NULL,
    inputs_hash         VARCHAR(64) NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'CLAIMED',
    failure_code        VARCHAR(100),
    claimed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,

    CONSTRAINT fk_ai_execution_claim_action_scope
        FOREIGN KEY (action_intent_id, tenant_id, factory_id)
        REFERENCES ai_action_intents (id, tenant_id, factory_id)
        ON DELETE RESTRICT,

    CONSTRAINT chk_ai_execution_claim_key
        CHECK (LENGTH(BTRIM(execution_key)) > 0),

    CONSTRAINT chk_ai_execution_claim_tool_version
        CHECK (LENGTH(BTRIM(tool_version)) > 0),

    CONSTRAINT chk_ai_execution_claim_hash
        CHECK (inputs_hash ~ '^[0-9a-fA-F]{64}$'),

    CONSTRAINT chk_ai_execution_claim_status
        CHECK (
            (status = 'CLAIMED' AND failure_code IS NULL AND completed_at IS NULL)
            OR
            (status = 'COMPLETED' AND failure_code IS NULL AND completed_at IS NOT NULL)
            OR
            (status = 'FAILED' AND failure_code IS NOT NULL
                AND LENGTH(BTRIM(failure_code)) > 0 AND completed_at IS NOT NULL)
        ),

    CONSTRAINT uq_ai_execution_claim_action_once
        UNIQUE (action_intent_id),

    CONSTRAINT uq_ai_execution_claim_execution_key
        UNIQUE (tenant_id, factory_id, execution_key)
);

CREATE INDEX IF NOT EXISTS idx_ai_execution_claims_status_claimed
    ON ai_execution_claims (tenant_id, factory_id, status, claimed_at);

CREATE OR REPLACE FUNCTION factoryos_guard_ai_execution_claim_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'AI execution claims cannot be deleted';
    END IF;

    IF OLD.id IS DISTINCT FROM NEW.id
       OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.factory_id IS DISTINCT FROM NEW.factory_id
       OR OLD.action_intent_id IS DISTINCT FROM NEW.action_intent_id
       OR OLD.execution_key IS DISTINCT FROM NEW.execution_key
       OR OLD.tool_version IS DISTINCT FROM NEW.tool_version
       OR OLD.inputs_hash IS DISTINCT FROM NEW.inputs_hash
       OR OLD.claimed_at IS DISTINCT FROM NEW.claimed_at THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'AI execution claim binding fields are immutable';
    END IF;

    IF OLD.status <> 'CLAIMED'
       OR NEW.status NOT IN ('COMPLETED', 'FAILED') THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'AI execution claim permits only CLAIMED to COMPLETED or FAILED transition';
    END IF;

    IF NEW.completed_at IS NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'A terminal AI execution claim requires completed_at';
    END IF;

    IF NEW.status = 'COMPLETED' AND NEW.failure_code IS NOT NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'A completed AI execution claim cannot contain failure_code';
    END IF;

    IF NEW.status = 'FAILED'
       AND (NEW.failure_code IS NULL OR LENGTH(BTRIM(NEW.failure_code)) = 0) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'A failed AI execution claim requires a non-empty failure_code';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_execution_claim_integrity
    ON ai_execution_claims;

CREATE TRIGGER trg_ai_execution_claim_integrity
BEFORE UPDATE OR DELETE ON ai_execution_claims
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_ai_execution_claim_mutation();

COMMENT ON TABLE ai_execution_claims IS
    'B18: durable per-action execution claim. A stuck CLAIMED record must be reconciled manually; do not automatically replay ambiguous side effects.';

ALTER TABLE ai_execution_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_execution_claims FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_execution_claims_tenant_isolation
    ON ai_execution_claims;

CREATE POLICY ai_execution_claims_tenant_isolation
ON ai_execution_claims
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations (version, checksum)
VALUES ('027_ai_execution_idempotency_claims', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
