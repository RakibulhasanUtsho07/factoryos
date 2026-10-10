BEGIN;

-- ============================================================
-- WP07 / Operational AI evaluation and calibration ledger
-- ============================================================
-- Append-only, tenant/factory-scoped labels for operational AI predictions.
-- Confidence means the predicted probability that the prediction is correct.
-- Calibration is computed from observed labels, never from model self-report.

CREATE TABLE IF NOT EXISTS ai_operational_evaluation_records (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,
    decision_id         UUID NOT NULL,
    evaluation_key      VARCHAR(255) NOT NULL,
    domain              VARCHAR(20) NOT NULL,
    metric_key          VARCHAR(100) NOT NULL,
    model_version       VARCHAR(100) NOT NULL,
    confidence          NUMERIC(7, 6) NOT NULL,
    prediction_correct  BOOLEAN NOT NULL,
    request_hash        VARCHAR(64) NOT NULL,
    created_by          UUID NOT NULL,
    observed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_ai_operational_eval_factory_scope
        FOREIGN KEY (factory_id, tenant_id)
        REFERENCES factories (id, tenant_id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_ai_operational_eval_decision_scope
        FOREIGN KEY (decision_id, tenant_id, factory_id)
        REFERENCES ai_decision_envelopes (id, tenant_id, factory_id)
        ON DELETE RESTRICT,

    CONSTRAINT chk_ai_operational_eval_domain
        CHECK (domain IN ('PLANNING', 'QUALITY', 'MAINTENANCE', 'FINANCE', 'ENERGY')),

    CONSTRAINT chk_ai_operational_eval_strings
        CHECK (
            LENGTH(BTRIM(evaluation_key)) > 0
            AND LENGTH(BTRIM(metric_key)) > 0
            AND LENGTH(BTRIM(model_version)) > 0
        ),

    CONSTRAINT chk_ai_operational_eval_confidence
        CHECK (confidence >= 0 AND confidence <= 1),

    CONSTRAINT chk_ai_operational_eval_request_hash
        CHECK (request_hash ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_operational_eval_idempotency
    ON ai_operational_evaluation_records (tenant_id, factory_id, evaluation_key);

CREATE INDEX IF NOT EXISTS idx_ai_operational_eval_calibration
    ON ai_operational_evaluation_records (
        tenant_id,
        factory_id,
        domain,
        metric_key,
        model_version,
        observed_at DESC
    );

ALTER TABLE ai_operational_evaluation_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_operational_evaluation_records FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = current_schema()
          AND tablename = 'ai_operational_evaluation_records'
          AND policyname = 'ai_operational_evaluation_tenant_isolation'
    ) THEN
        CREATE POLICY ai_operational_evaluation_tenant_isolation
            ON ai_operational_evaluation_records
            USING (tenant_id = factoryos_current_tenant_id())
            WITH CHECK (tenant_id = factoryos_current_tenant_id());
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION reject_ai_operational_evaluation_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'AI operational evaluation records are append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_operational_evaluation_immutable
    ON ai_operational_evaluation_records;

CREATE TRIGGER trg_ai_operational_evaluation_immutable
    BEFORE UPDATE OR DELETE ON ai_operational_evaluation_records
    FOR EACH ROW
    EXECUTE FUNCTION reject_ai_operational_evaluation_mutation();

INSERT INTO schema_migrations (version, checksum)
VALUES ('027_ai_operational_evaluation', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
