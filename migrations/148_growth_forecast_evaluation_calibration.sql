BEGIN;

CREATE TABLE IF NOT EXISTS growth_forecast_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  outcome_id UUID NOT NULL,
  model_version VARCHAR(128) NOT NULL,
  metric_key VARCHAR(100) NOT NULL,
  unit VARCHAR(40) NOT NULL,
  forecast_origin_at TIMESTAMPTZ NOT NULL,
  forecast_source_ref TEXT NOT NULL,
  forecast_value NUMERIC(24,8) NOT NULL,
  actual_value NUMERIC(24,8) NOT NULL,
  lower_bound NUMERIC(24,8),
  upper_bound NUMERIC(24,8),
  nominal_coverage_pct NUMERIC(5,2),
  signed_error NUMERIC(32,8) NOT NULL,
  absolute_error NUMERIC(32,8) NOT NULL,
  squared_error NUMERIC(40,8) NOT NULL,
  absolute_percentage_error NUMERIC(40,8),
  symmetric_percentage_error NUMERIC(12,8) NOT NULL,
  interval_hit BOOLEAN,
  interval_width NUMERIC(32,8),
  interval_semantics VARCHAR(32) NOT NULL,
  method_version VARCHAR(80) NOT NULL,
  input_hash VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  recorded_by UUID NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_growth_forecast_evaluation_idempotency
    UNIQUE (tenant_id, factory_id, opportunity_id, idempotency_key),
  CONSTRAINT uq_growth_forecast_evaluation_observation
    UNIQUE (tenant_id, factory_id, opportunity_id, outcome_id, model_version, metric_key),
  CONSTRAINT fk_growth_forecast_evaluation_opportunity
    FOREIGN KEY (opportunity_id, tenant_id, factory_id)
    REFERENCES growth_opportunities(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_forecast_evaluation_outcome_scope
    FOREIGN KEY (outcome_id, tenant_id, factory_id, opportunity_id)
    REFERENCES growth_opportunity_outcomes(id, tenant_id, factory_id, opportunity_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_forecast_evaluation_actor
    FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_forecast_evaluation_model
    CHECK (length(btrim(model_version)) BETWEEN 1 AND 128),
  CONSTRAINT chk_growth_forecast_evaluation_metric
    CHECK (metric_key ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  CONSTRAINT chk_growth_forecast_evaluation_unit
    CHECK (length(btrim(unit)) BETWEEN 1 AND 40),
  CONSTRAINT chk_growth_forecast_evaluation_source
    CHECK (length(btrim(forecast_source_ref)) BETWEEN 1 AND 2000),
  CONSTRAINT chk_growth_forecast_evaluation_values
    CHECK (abs(forecast_value) <= 1000000000000 AND abs(actual_value) <= 1000000000000\n      AND (lower_bound IS NULL OR (abs(lower_bound) <= 1000000000000 AND abs(upper_bound) <= 1000000000000))),
  CONSTRAINT chk_growth_forecast_evaluation_hash
    CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_growth_forecast_evaluation_idempotency
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  CONSTRAINT chk_growth_forecast_evaluation_coverage
    CHECK (nominal_coverage_pct IS NULL OR (nominal_coverage_pct BETWEEN 1 AND 99.99 AND lower_bound IS NOT NULL AND upper_bound IS NOT NULL)),
  CONSTRAINT chk_growth_forecast_evaluation_interval
    CHECK (
      (lower_bound IS NULL AND upper_bound IS NULL AND interval_hit IS NULL AND interval_width IS NULL
        AND nominal_coverage_pct IS NULL AND interval_semantics = 'NONE')
      OR
      (lower_bound IS NOT NULL AND upper_bound IS NOT NULL AND lower_bound <= upper_bound
        AND interval_hit IS NOT NULL AND interval_width IS NOT NULL
        AND interval_semantics IN ('HEURISTIC_RANGE', 'DECLARED_NOMINAL_COVERAGE')
        AND ((nominal_coverage_pct IS NULL AND interval_semantics = 'HEURISTIC_RANGE')
          OR (nominal_coverage_pct IS NOT NULL AND interval_semantics = 'DECLARED_NOMINAL_COVERAGE'))
      )
    ),
  CONSTRAINT chk_growth_forecast_evaluation_method
    CHECK (method_version = 'factoryos.growth.forecast-evaluation.v1')
);

CREATE INDEX IF NOT EXISTS idx_growth_forecast_evaluations_calibration
  ON growth_forecast_evaluations
    (tenant_id, factory_id, opportunity_id, model_version, metric_key, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_growth_forecast_evaluations_recent
  ON growth_forecast_evaluations (tenant_id, factory_id, opportunity_id, evaluated_at DESC, id DESC);

ALTER TABLE growth_forecast_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_forecast_evaluations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS growth_forecast_evaluations_tenant_isolation ON growth_forecast_evaluations;
CREATE POLICY growth_forecast_evaluations_tenant_isolation
  ON growth_forecast_evaluations
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_growth_forecast_evaluation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  saved_actual NUMERIC;
  saved_unit TEXT;
  outcome_observed_at TIMESTAMPTZ;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_EVALUATION_APPEND_ONLY'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.forecast_origin_at > clock_timestamp() THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_ORIGIN_CANNOT_BE_IN_THE_FUTURE'
      USING ERRCODE = '23514';
  END IF;

  SELECT o.observed_at, k.actual_value, k.unit
    INTO outcome_observed_at, saved_actual, saved_unit
    FROM growth_opportunity_outcomes o
    JOIN growth_outcome_kpi_measurements k
      ON k.outcome_id = o.id
     AND k.tenant_id = o.tenant_id
     AND k.factory_id = o.factory_id
     AND k.opportunity_id = o.opportunity_id
   WHERE o.id = NEW.outcome_id
     AND o.opportunity_id = NEW.opportunity_id
     AND o.tenant_id = NEW.tenant_id
     AND o.factory_id = NEW.factory_id
     AND k.metric_key = NEW.metric_key
   FOR KEY SHARE OF o, k;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_EVALUATION_OUTCOME_KPI_SCOPE_MISMATCH'
      USING ERRCODE = '23503';
  END IF;
  IF NEW.unit IS DISTINCT FROM saved_unit OR NEW.actual_value IS DISTINCT FROM saved_actual THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_EVALUATION_ACTUAL_MUST_MATCH_IMMUTABLE_OUTCOME_KPI'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.forecast_origin_at >= outcome_observed_at THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_ORIGIN_MUST_PRECEDE_OBSERVED_OUTCOME'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM growth_opportunity_evidence e
     WHERE e.opportunity_id = NEW.opportunity_id
       AND e.tenant_id = NEW.tenant_id
       AND e.factory_id = NEW.factory_id
       AND (btrim(COALESCE(e.reference_ref, '')) = NEW.forecast_source_ref
         OR btrim(COALESCE(e.citation_url, '')) = NEW.forecast_source_ref)
       AND e.captured_at <= NEW.forecast_origin_at
  ) THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_SOURCE_REFERENCE_NOT_ATTACHED_TO_OPPORTUNITY'
      USING ERRCODE = '23514';
  END IF;

  IF round(NEW.forecast_value - NEW.actual_value, 8) IS DISTINCT FROM NEW.signed_error
    OR round(abs(NEW.forecast_value - NEW.actual_value), 8) IS DISTINCT FROM NEW.absolute_error
    OR round((NEW.forecast_value - NEW.actual_value) * (NEW.forecast_value - NEW.actual_value), 8) IS DISTINCT FROM NEW.squared_error
  THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_ERROR_METRICS_NOT_DETERMINISTIC'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.actual_value = 0 THEN
    IF NEW.absolute_percentage_error IS NOT NULL THEN
      RAISE EXCEPTION 'GROWTH_FORECAST_APE_MUST_BE_NULL_WHEN_ACTUAL_IS_ZERO'
        USING ERRCODE = '23514';
    END IF;
  ELSIF round(100 * abs(NEW.forecast_value - NEW.actual_value) / abs(NEW.actual_value), 8)
    IS DISTINCT FROM NEW.absolute_percentage_error THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_APE_NOT_DETERMINISTIC'
      USING ERRCODE = '23514';
  END IF;

  IF round(
      CASE WHEN abs(NEW.forecast_value) + abs(NEW.actual_value) = 0 THEN 0
           ELSE 200 * abs(NEW.forecast_value - NEW.actual_value)
             / (abs(NEW.forecast_value) + abs(NEW.actual_value)) END, 8
    ) IS DISTINCT FROM NEW.symmetric_percentage_error THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_SMAPE_NOT_DETERMINISTIC'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.lower_bound IS NOT NULL AND (
       NEW.interval_hit IS DISTINCT FROM (NEW.actual_value BETWEEN NEW.lower_bound AND NEW.upper_bound)
       OR NEW.interval_width IS DISTINCT FROM round(NEW.upper_bound - NEW.lower_bound, 8)
  ) THEN
    RAISE EXCEPTION 'GROWTH_FORECAST_INTERVAL_METRICS_NOT_DETERMINISTIC'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS growth_forecast_evaluation_guard ON growth_forecast_evaluations;
CREATE TRIGGER growth_forecast_evaluation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON growth_forecast_evaluations
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_forecast_evaluation();

COMMIT;
