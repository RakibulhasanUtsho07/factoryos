BEGIN;

CREATE TABLE growth_forecast_calibration_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  domain VARCHAR(24) NOT NULL,
  model_version VARCHAR(128) NOT NULL,
  metric_key VARCHAR(100) NOT NULL,
  unit VARCHAR(40) NOT NULL,
  policy_version INTEGER NOT NULL,
  minimum_sample_count INTEGER NOT NULL DEFAULT 10,
  max_mean_absolute_error NUMERIC(24,8) NOT NULL,
  max_root_mean_squared_error NUMERIC(24,8) NOT NULL,
  max_absolute_mean_error NUMERIC(24,8) NOT NULL,
  max_mean_symmetric_percentage_error_pct NUMERIC(8,4) NOT NULL,
  max_absolute_calibration_gap_pct_points NUMERIC(8,4) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING_REVIEW',
  created_by UUID NOT NULL,
  decided_by UUID,
  decided_at TIMESTAMPTZ,
  decision_reason VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_growth_calibration_policy_scope UNIQUE(id,tenant_id,factory_id),
  CONSTRAINT uq_growth_calibration_policy_version UNIQUE(tenant_id,factory_id,domain,model_version,metric_key,unit,policy_version),
  CONSTRAINT fk_growth_calibration_policy_factory FOREIGN KEY(factory_id,tenant_id)
    REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_calibration_policy_creator FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_calibration_policy_decider FOREIGN KEY(decided_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_calibration_policy_domain CHECK(domain IN ('FINANCE','PRODUCTION','QUALITY','DELIVERY','COMMERCIAL','OTHER')),
  CONSTRAINT chk_growth_calibration_policy_model CHECK(model_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_growth_calibration_policy_metric CHECK(metric_key ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  CONSTRAINT chk_growth_calibration_policy_unit CHECK(length(btrim(unit)) BETWEEN 1 AND 40),
  CONSTRAINT chk_growth_calibration_policy_version CHECK(policy_version BETWEEN 1 AND 1000000),
  CONSTRAINT chk_growth_calibration_policy_sample CHECK(minimum_sample_count BETWEEN 10 AND 1000000),
  CONSTRAINT chk_growth_calibration_policy_error_thresholds CHECK(
    max_mean_absolute_error BETWEEN 0 AND 1000000000000
    AND max_root_mean_squared_error BETWEEN 0 AND 1000000000000
    AND max_absolute_mean_error BETWEEN 0 AND 1000000000000
  ),
  CONSTRAINT chk_growth_calibration_policy_percentage_thresholds CHECK(
    max_mean_symmetric_percentage_error_pct BETWEEN 0 AND 200
    AND max_absolute_calibration_gap_pct_points BETWEEN 0 AND 100
  ),
  CONSTRAINT chk_growth_calibration_policy_status CHECK(status IN ('PENDING_REVIEW','APPROVED','REJECTED')),
  CONSTRAINT chk_growth_calibration_policy_decision CHECK(
    (status='PENDING_REVIEW' AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
    OR (status IN ('APPROVED','REJECTED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND length(btrim(COALESCE(decision_reason,''))) BETWEEN 8 AND 1000 AND decided_by<>created_by)
  )
);
CREATE INDEX idx_growth_calibration_policy_lookup
 ON growth_forecast_calibration_policies(tenant_id,factory_id,model_version,metric_key,unit,status,domain,policy_version DESC);

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
         NEW.created_by,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.tenant_id,OLD.factory_id,OLD.domain,OLD.model_version,OLD.metric_key,OLD.unit,
         OLD.policy_version,OLD.minimum_sample_count,OLD.max_mean_absolute_error,
         OLD.max_root_mean_squared_error,OLD.max_absolute_mean_error,
         OLD.max_mean_symmetric_percentage_error_pct,OLD.max_absolute_calibration_gap_pct_points,
         OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'GROWTH_CALIBRATION_POLICY_CONFIGURATION_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER growth_forecast_calibration_policy_guard
BEFORE INSERT OR UPDATE OR DELETE ON growth_forecast_calibration_policies
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_forecast_calibration_policy();

ALTER TABLE growth_forecast_calibration_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_forecast_calibration_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY growth_forecast_calibration_policies_tenant_isolation ON growth_forecast_calibration_policies
 USING(tenant_id=factoryos_current_tenant_id())
 WITH CHECK(tenant_id=factoryos_current_tenant_id());

INSERT INTO schema_migrations(version,checksum)
VALUES('178_growth_forecast_calibration_policies',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
