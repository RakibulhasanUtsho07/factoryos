BEGIN;

-- ============================================================
-- WP07 / Forecast numeric consistency invariants
-- ============================================================
-- Score fields must be derived from the authoritative metric values, not
-- supplied independently or calculated with lossy JavaScript arithmetic.
-- Existing records are immutable; NOT VALID preserves legacy rows while
-- PostgreSQL enforces this constraint for every new row.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_ai_operational_eval_forecast_consistency'
          AND conrelid = 'ai_operational_evaluation_records'::regclass
    ) THEN
        ALTER TABLE ai_operational_evaluation_records
            ADD CONSTRAINT chk_ai_operational_eval_forecast_consistency
            CHECK (
                source_outcome_id IS NULL
                OR (
                    predicted_value IS NOT NULL
                    AND actual_value IS NOT NULL
                    AND absolute_error = ABS(predicted_value - actual_value)
                    AND (
                        (actual_value = 0 AND absolute_percentage_error IS NULL)
                        OR (
                            actual_value <> 0
                            AND absolute_percentage_error =
                                absolute_error / ABS(actual_value)
                        )
                    )
                    AND prediction_correct = (absolute_error <= tolerance)
                )
            ) NOT VALID;
    END IF;
END;
$$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('057_ai_operational_forecast_numeric_consistency', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
