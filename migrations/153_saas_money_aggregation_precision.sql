BEGIN;

-- SaaS billing integrity: aggregates can outgrow one BIGINT even when each
-- individual metering event is valid. Use exact integer NUMERIC aggregates so
-- budget/reconciliation decisions and report hashes never pass through float.
ALTER TABLE saas_budget_evaluations
  ALTER COLUMN usage_cost_minor TYPE NUMERIC(30,0) USING usage_cost_minor::NUMERIC,
  ALTER COLUMN anomaly_window_cost_minor TYPE NUMERIC(30,0) USING anomaly_window_cost_minor::NUMERIC,
  ALTER COLUMN anomaly_baseline_hourly_minor TYPE NUMERIC(34,4) USING anomaly_baseline_hourly_minor::NUMERIC;

ALTER TABLE saas_budget_evaluations
  DROP CONSTRAINT IF EXISTS chk_saas_budget_eval_amounts;
ALTER TABLE saas_budget_evaluations
  ADD CONSTRAINT chk_saas_budget_eval_amounts
  CHECK (
    usage_cost_minor BETWEEN 0 AND 999999999999999999999999999999
    AND soft_limit_minor BETWEEN 0 AND 9000000000000000
    AND hard_limit_minor BETWEEN soft_limit_minor AND 9000000000000000
    AND anomaly_window_cost_minor BETWEEN 0 AND 999999999999999999999999999999
    AND anomaly_baseline_hourly_minor >= 0
  );

ALTER TABLE saas_usage_reconciliations
  ALTER COLUMN ledger_estimated_amount_minor TYPE NUMERIC(30,0) USING ledger_estimated_amount_minor::NUMERIC,
  ALTER COLUMN adjustment_amount_minor TYPE NUMERIC(30,0) USING adjustment_amount_minor::NUMERIC,
  ALTER COLUMN expected_amount_minor TYPE NUMERIC(30,0) USING expected_amount_minor::NUMERIC,
  ALTER COLUMN variance_minor TYPE NUMERIC(30,0) USING variance_minor::NUMERIC;

ALTER TABLE saas_provider_cost_reconciliations
  ALTER COLUMN ledger_provider_cost_minor TYPE NUMERIC(30,0) USING ledger_provider_cost_minor::NUMERIC,
  ALTER COLUMN variance_minor TYPE NUMERIC(30,0) USING variance_minor::NUMERIC;

COMMENT ON COLUMN saas_budget_evaluations.usage_cost_minor IS
  'Exact aggregate of metered minor currency units; NUMERIC prevents BIGINT aggregation overflow and floating-point rounding.';
COMMENT ON COLUMN saas_usage_reconciliations.expected_amount_minor IS
  'Exact expected minor-unit amount from the metering ledger plus signed adjustments; not an issued invoice.';
COMMENT ON COLUMN saas_provider_cost_reconciliations.ledger_provider_cost_minor IS
  'Exact aggregate of provider-reported minor currency units for the scoped invoice period.';

INSERT INTO schema_migrations(version,checksum)
VALUES('153_saas_money_aggregation_precision',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
