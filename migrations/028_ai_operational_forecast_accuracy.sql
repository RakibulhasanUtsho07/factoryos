BEGIN;

-- ============================================================
-- WP07 / Outcome-backed numeric forecast evaluation
-- ============================================================
-- Link calibration rows to authoritative, observed AI outcomes and retain
-- numeric prediction errors so forecasts can be evaluated beyond a binary
-- correct/incorrect label.

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_outcome_links_id_scope
    ON ai_outcome_links (id, tenant_id, factory_id);

ALTER TABLE ai_operational_evaluation_records
    ADD COLUMN IF NOT EXISTS source_outcome_id UUID,
    ADD COLUMN IF NOT EXISTS predicted_value NUMERIC,
    ADD COLUMN IF NOT EXISTS actual_value NUMERIC,
    ADD COLUMN IF NOT EXISTS absolute_error NUMERIC,
    ADD COLUMN IF NOT EXISTS absolute_percentage_error NUMERIC,
    ADD COLUMN IF NOT EXISTS tolerance NUMERIC;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_ai_operational_eval_source_outcome_scope'
          AND conrelid = 'ai_operational_evaluation_records'::regclass
    ) THEN
        ALTER TABLE ai_operational_evaluation_records
            ADD CONSTRAINT fk_ai_operational_eval_source_outcome_scope
            FOREIGN KEY (source_outcome_id, tenant_id, factory_id)
            REFERENCES ai_outcome_links (id, tenant_id, factory_id)
            ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_ai_operational_eval_numeric_tuple'
          AND conrelid = 'ai_operational_evaluation_records'::regclass
    ) THEN
        ALTER TABLE ai_operational_evaluation_records
            ADD CONSTRAINT chk_ai_operational_eval_numeric_tuple
            CHECK (
                (
                    source_outcome_id IS NULL
                    AND predicted_value IS NULL
                    AND actual_value IS NULL
                    AND absolute_error IS NULL
                    AND absolute_percentage_error IS NULL
                    AND tolerance IS NULL
                )
                OR (
                    source_outcome_id IS NOT NULL
                    AND predicted_value IS NOT NULL
                    AND actual_value IS NOT NULL
                    AND absolute_error IS NOT NULL
                    AND absolute_error >= 0
                    AND (absolute_percentage_error IS NULL OR absolute_percentage_error >= 0)
                    AND tolerance IS NOT NULL
                    AND tolerance >= 0
                )
            );
    END IF;
END;
$$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('028_ai_operational_forecast_accuracy', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
