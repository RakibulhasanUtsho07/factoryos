-- Task 37 / monetary exactness for usage pricing, budgets and invoice reconciliation.
DO $$
DECLARE
  t RECORD;
BEGIN
  SELECT data_type,numeric_precision,numeric_scale INTO t
    FROM information_schema.columns
   WHERE table_schema=current_schema() AND table_name='saas_budget_evaluations'
     AND column_name='usage_cost_minor';
  IF NOT FOUND OR t.data_type <> 'numeric' OR t.numeric_precision <> 30 OR t.numeric_scale <> 0 THEN
    RAISE EXCEPTION 'SaaS money precision: budget usage aggregate must be NUMERIC(30,0)';
  END IF;

  SELECT data_type,numeric_precision,numeric_scale INTO t
    FROM information_schema.columns
   WHERE table_schema=current_schema() AND table_name='saas_usage_reconciliations'
     AND column_name='expected_amount_minor';
  IF NOT FOUND OR t.data_type <> 'numeric' OR t.numeric_precision <> 30 OR t.numeric_scale <> 0 THEN
    RAISE EXCEPTION 'SaaS money precision: expected usage invoice amount must be NUMERIC(30,0)';
  END IF;

  SELECT data_type,numeric_precision,numeric_scale INTO t
    FROM information_schema.columns
   WHERE table_schema=current_schema() AND table_name='saas_provider_cost_reconciliations'
     AND column_name='ledger_provider_cost_minor';
  IF NOT FOUND OR t.data_type <> 'numeric' OR t.numeric_precision <> 30 OR t.numeric_scale <> 0 THEN
    RAISE EXCEPTION 'SaaS money precision: provider ledger aggregate must be NUMERIC(30,0)';
  END IF;

  SELECT data_type,numeric_precision,numeric_scale INTO t
    FROM information_schema.columns
   WHERE table_schema=current_schema() AND table_name='saas_budget_evaluations'
     AND column_name='anomaly_baseline_hourly_minor';
  IF NOT FOUND OR t.data_type <> 'numeric' OR t.numeric_precision <> 34 OR t.numeric_scale <> 4 THEN
    RAISE EXCEPTION 'SaaS money precision: hourly anomaly baseline must be NUMERIC(34,4)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='saas_budget_evaluations'::regclass
      AND conname='chk_saas_budget_eval_amounts'
  ) THEN
    RAISE EXCEPTION 'SaaS money precision: budget aggregate constraint is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version='153_saas_money_aggregation_precision'
  ) THEN
    RAISE EXCEPTION 'SaaS money precision: migration history registration is missing';
  END IF;
END
$$;
