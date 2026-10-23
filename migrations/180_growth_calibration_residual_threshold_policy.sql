BEGIN;

ALTER TABLE growth_forecast_calibration_policies
  ADD COLUMN IF NOT EXISTS residual_coverage_target_pct NUMERIC(5,2);
ALTER TABLE growth_forecast_calibration_policies
  ADD COLUMN IF NOT EXISTS max_empirical_absolute_residual NUMERIC(24,8);

ALTER TABLE growth_forecast_calibration_policies
  DROP CONSTRAINT IF EXISTS chk_growth_calibration_policy_residual_configuration;
ALTER TABLE growth_forecast_calibration_policies
  ADD CONSTRAINT chk_growth_calibration_policy_residual_configuration CHECK (
    (residual_coverage_target_pct IS NULL AND max_empirical_absolute_residual IS NULL)
    OR (
      residual_coverage_target_pct BETWEEN 50 AND 99.99
      AND max_empirical_absolute_residual BETWEEN 0 AND 1000000000000
    )
  );

CREATE OR REPLACE FUNCTION factoryos_guard_growth_forecast_calibration_policy()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'GROWTH_CALIBRATION_POLICY_APPEND_ONLY' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'PENDING_REVIEW' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL
       OR NEW.decision_reason IS NOT NULL THEN
      RAISE EXCEPTION 'GROWTH_CALIBRATION_POLICY_MUST_START_PENDING' USING ERRCODE='23514';
    END IF;
    IF NEW.residual_coverage_target_pct IS NULL OR NEW.max_empirical_absolute_residual IS NULL THEN
      RAISE EXCEPTION 'GROWTH_CALIBRATION_POLICY_RESIDUAL_CONFIGURATION_REQUIRED' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status<>'PENDING_REVIEW' THEN
    RAISE EXCEPTION 'GROWTH_CALIBRATION_POLICY_FINAL_DECISION_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF NEW.status NOT IN ('APPROVED','REJECTED')
     OR NEW.decided_by IS NULL OR NEW.decided_at IS NULL
     OR NEW.decided_by=OLD.created_by
     OR length(btrim(COALESCE(NEW.decision_reason,'')))<8 THEN
    RAISE EXCEPTION 'GROWTH_CALIBRATION_POLICY_REQUIRES_INDEPENDENT_REASONED_REVIEW' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.id,NEW.tenant_id,NEW.factory_id,NEW.domain,NEW.model_version,NEW.metric_key,NEW.unit,
         NEW.policy_version,NEW.minimum_sample_count,NEW.max_mean_absolute_error,
         NEW.max_root_mean_squared_error,NEW.max_absolute_mean_error,
         NEW.max_mean_symmetric_percentage_error_pct,NEW.max_absolute_calibration_gap_pct_points,
         NEW.residual_coverage_target_pct,NEW.max_empirical_absolute_residual,
         NEW.created_by,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.tenant_id,OLD.factory_id,OLD.domain,OLD.model_version,OLD.metric_key,OLD.unit,
         OLD.policy_version,OLD.minimum_sample_count,OLD.max_mean_absolute_error,
         OLD.max_root_mean_squared_error,OLD.max_absolute_mean_error,
         OLD.max_mean_symmetric_percentage_error_pct,OLD.max_absolute_calibration_gap_pct_points,
         OLD.residual_coverage_target_pct,OLD.max_empirical_absolute_residual,
         OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'GROWTH_CALIBRATION_POLICY_CONFIGURATION_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

INSERT INTO schema_migrations(version,checksum)
VALUES ('180_growth_calibration_residual_threshold_policy', NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
