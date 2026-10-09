BEGIN;

-- ============================================================
-- B19 / Operator-led recovery for stale AI execution claims
-- ============================================================
-- Ambiguous executions are never retried automatically. This migration adds
-- an authenticated, auditable operator path to mark a stale CLAIMED row as
-- terminal after recording the decision, reason, and evidence reference.
-- The operation never executes tools and never reopens a claim.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_execution_claim_scope
    ON ai_execution_claims (id, tenant_id, factory_id);

INSERT INTO permissions (code, description)
VALUES
  ('ai.execution.claims.read', 'List stale AI execution claims within a factory scope'),
  ('ai.execution.claims.reconcile', 'Reconcile stale AI execution claims with evidence')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
  AND p.code IN (
    'ai.execution.claims.read',
    'ai.execution.claims.reconcile'
  )
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_execution_claim_reconciliations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,
    claim_id            UUID NOT NULL,
    actor_user_id       UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    decision            VARCHAR(40) NOT NULL,
    prior_status        VARCHAR(20) NOT NULL DEFAULT 'CLAIMED',
    resulting_status    VARCHAR(20) NOT NULL,
    reason              TEXT NOT NULL,
    evidence_ref        VARCHAR(255) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_ai_execution_claim_reconciliation_scope
      FOREIGN KEY (claim_id, tenant_id, factory_id)
      REFERENCES ai_execution_claims (id, tenant_id, factory_id)
      ON DELETE RESTRICT,

    CONSTRAINT chk_ai_execution_claim_reconciliation_decision
      CHECK (
        (decision = 'CONFIRMED_COMPLETED' AND resulting_status = 'COMPLETED')
        OR
        (decision = 'CONFIRMED_FAILED' AND resulting_status = 'FAILED')
      ),

    CONSTRAINT chk_ai_execution_claim_reconciliation_prior_status
      CHECK (prior_status = 'CLAIMED'),

    CONSTRAINT chk_ai_execution_claim_reconciliation_reason
      CHECK (LENGTH(BTRIM(reason)) >= 15),

    CONSTRAINT chk_ai_execution_claim_reconciliation_evidence
      CHECK (LENGTH(BTRIM(evidence_ref)) > 0),

    CONSTRAINT uq_ai_execution_claim_reconciliation_once
      UNIQUE (claim_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_execution_claim_reconciliations_scope_created
    ON ai_execution_claim_reconciliations (tenant_id, factory_id, created_at DESC);

CREATE OR REPLACE FUNCTION factoryos_block_ai_execution_claim_reconciliation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'AI execution claim reconciliation records are append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_execution_claim_reconciliation_immutable
    ON ai_execution_claim_reconciliations;

CREATE TRIGGER trg_ai_execution_claim_reconciliation_immutable
BEFORE UPDATE OR DELETE ON ai_execution_claim_reconciliations
FOR EACH ROW
EXECUTE FUNCTION factoryos_block_ai_execution_claim_reconciliation_mutation();

ALTER TABLE ai_execution_claim_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_execution_claim_reconciliations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_execution_claim_reconciliations_tenant_isolation
    ON ai_execution_claim_reconciliations;

CREATE POLICY ai_execution_claim_reconciliations_tenant_isolation
ON ai_execution_claim_reconciliations
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMENT ON TABLE ai_execution_claim_reconciliations IS
  'B19: append-only evidence trail for operator reconciliation of stale AI execution claims; reconciliation never permits automatic replay.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('028_ai_execution_claim_reconciliation', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
