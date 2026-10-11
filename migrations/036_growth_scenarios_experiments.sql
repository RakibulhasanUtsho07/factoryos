BEGIN;
-- WP09-B: reproducible simulation snapshots and auditable experiment lifecycle.
-- Forecasts are simulations; only source-referenced measurements are observations.
INSERT INTO permissions (code, description) VALUES
 ('growth.scenarios.read','Read reproducible factory-scoped scenario snapshots'),
 ('growth.scenarios.write','Record immutable versioned strategy scenarios'),
 ('growth.experiments.read','Read experiment definitions, decisions and measurements'),
 ('growth.experiments.write','Register versioned bounded experiments'),
 ('growth.experiments.decisions.write','Approve and govern experiment lifecycle transitions'),
 ('growth.experiments.measurements.write','Record source-referenced experiment measurements')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='ORG_ADMIN' AND r.is_system=true AND p.code IN
 ('growth.scenarios.read','growth.scenarios.write','growth.experiments.read','growth.experiments.write',
  'growth.experiments.decisions.write','growth.experiments.measurements.write')
ON CONFLICT (role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS growth_scenario_snapshots (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, factory_id UUID NOT NULL,
 opportunity_id UUID NOT NULL, scenario_key VARCHAR(180) NOT NULL, scenario_version VARCHAR(60) NOT NULL,
 scenario_type VARCHAR(20) NOT NULL, model_version VARCHAR(120) NOT NULL, data_vintage_at TIMESTAMPTZ NOT NULL,
 input_snapshot_sha256 VARCHAR(64) NOT NULL, source_snapshot_refs JSONB NOT NULL, assumptions JSONB NOT NULL,
 impact_bands JSONB NOT NULL, constraints_violated JSONB NOT NULL, validation_questions JSONB NOT NULL,
 uncertainty JSONB NOT NULL, request_hash VARCHAR(64) NOT NULL, idempotency_key VARCHAR(128) NOT NULL,
 created_by UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_growth_scenario_opportunity FOREIGN KEY (opportunity_id,tenant_id,factory_id)
   REFERENCES growth_opportunity_registry (id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_growth_scenario_actor FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT uq_growth_scenario_scope_id UNIQUE (id,tenant_id,factory_id,opportunity_id),
 CONSTRAINT chk_growth_scenario_version CHECK (
   scenario_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,179}$'
   AND scenario_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,59}$'),
 CONSTRAINT chk_growth_scenario_type CHECK (scenario_type IN ('BASE','UPSIDE','DOWNSIDE','STRESS')),
 CONSTRAINT chk_growth_scenario_model_version CHECK (LENGTH(BTRIM(model_version)) BETWEEN 1 AND 120),
 CONSTRAINT chk_growth_scenario_input_hash CHECK (input_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
 CONSTRAINT chk_growth_scenario_source_refs CHECK (jsonb_typeof(source_snapshot_refs)='array' AND jsonb_array_length(source_snapshot_refs) BETWEEN 1 AND 100),
 CONSTRAINT chk_growth_scenario_assumptions CHECK (jsonb_typeof(assumptions)='array' AND jsonb_array_length(assumptions) BETWEEN 1 AND 100),
 CONSTRAINT chk_growth_scenario_impact_bands CHECK (jsonb_typeof(impact_bands)='object' AND impact_bands ? 'kpi' AND impact_bands ? 'cash' AND impact_bands ? 'margin' AND impact_bands ? 'capacity'),
 CONSTRAINT chk_growth_scenario_constraints CHECK (jsonb_typeof(constraints_violated)='array' AND jsonb_array_length(constraints_violated)<=100),
 CONSTRAINT chk_growth_scenario_questions CHECK (jsonb_typeof(validation_questions)='array' AND jsonb_array_length(validation_questions) BETWEEN 1 AND 100),
 CONSTRAINT chk_growth_scenario_uncertainty CHECK (jsonb_typeof(uncertainty)='object' AND uncertainty ? 'level' AND uncertainty ? 'limitations' AND uncertainty ? 'sensitivity_factors' AND uncertainty ? 'evidence_gaps'),
 CONSTRAINT chk_growth_scenario_request_hash CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT chk_growth_scenario_idempotency CHECK (idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_growth_scenario_scope_version ON growth_scenario_snapshots(tenant_id,factory_id,opportunity_id,scenario_key,scenario_version);
CREATE UNIQUE INDEX IF NOT EXISTS uq_growth_scenario_idempotency ON growth_scenario_snapshots(tenant_id,factory_id,idempotency_key);
CREATE INDEX IF NOT EXISTS idx_growth_scenario_history ON growth_scenario_snapshots(tenant_id,factory_id,opportunity_id,created_at DESC,id DESC);
ALTER TABLE growth_scenario_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_scenario_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS growth_scenario_snapshots_tenant_isolation ON growth_scenario_snapshots;
CREATE POLICY growth_scenario_snapshots_tenant_isolation ON growth_scenario_snapshots
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());
CREATE OR REPLACE FUNCTION reject_growth_scenario_snapshot_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Growth scenario snapshots are immutable; create a new version instead'; END; $$;
DROP TRIGGER IF EXISTS trg_growth_scenario_snapshot_immutable ON growth_scenario_snapshots;
CREATE TRIGGER trg_growth_scenario_snapshot_immutable BEFORE UPDATE OR DELETE ON growth_scenario_snapshots
 FOR EACH ROW EXECUTE FUNCTION reject_growth_scenario_snapshot_mutation();

CREATE TABLE IF NOT EXISTS growth_experiment_definitions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, factory_id UUID NOT NULL,
 opportunity_id UUID NOT NULL, scenario_snapshot_id UUID, experiment_key VARCHAR(180) NOT NULL,
 experiment_version VARCHAR(60) NOT NULL, hypothesis TEXT NOT NULL, objective TEXT NOT NULL,
 primary_metric VARCHAR(100) NOT NULL, baseline_definition JSONB NOT NULL, control_definition JSONB NOT NULL,
 treatment_definition JSONB NOT NULL, duration_days INTEGER NOT NULL, owner_role VARCHAR(100) NOT NULL,
 stop_conditions JSONB NOT NULL, sample_scope JSONB NOT NULL, request_hash VARCHAR(64) NOT NULL,
 idempotency_key VARCHAR(128) NOT NULL, created_by UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_growth_experiment_opportunity FOREIGN KEY(opportunity_id,tenant_id,factory_id)
   REFERENCES growth_opportunity_registry(id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_growth_experiment_scenario FOREIGN KEY(scenario_snapshot_id,tenant_id,factory_id,opportunity_id)
   REFERENCES growth_scenario_snapshots(id,tenant_id,factory_id,opportunity_id) ON DELETE RESTRICT,
 CONSTRAINT fk_growth_experiment_actor FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT uq_growth_experiment_scope_id UNIQUE(id,tenant_id,factory_id,opportunity_id),
 CONSTRAINT chk_growth_experiment_version CHECK (
   experiment_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,179}$'
   AND experiment_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,59}$'),
 CONSTRAINT chk_growth_experiment_text CHECK (
   LENGTH(BTRIM(hypothesis)) BETWEEN 1 AND 4000 AND LENGTH(BTRIM(objective)) BETWEEN 1 AND 2000
   AND primary_metric ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$'),
 CONSTRAINT chk_growth_experiment_definitions CHECK (
   jsonb_typeof(baseline_definition)='object' AND jsonb_typeof(control_definition)='object'
   AND jsonb_typeof(treatment_definition)='object' AND jsonb_typeof(sample_scope)='object'),
 CONSTRAINT chk_growth_experiment_duration CHECK(duration_days BETWEEN 1 AND 365),
 CONSTRAINT chk_growth_experiment_owner CHECK(owner_role ~ '^[A-Z][A-Z0-9_.:-]{1,99}$'),
 CONSTRAINT chk_growth_experiment_stop_conditions CHECK(jsonb_typeof(stop_conditions)='array' AND jsonb_array_length(stop_conditions) BETWEEN 1 AND 100),
 CONSTRAINT chk_growth_experiment_request_hash CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT chk_growth_experiment_idempotency CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_growth_experiment_scope_version ON growth_experiment_definitions(tenant_id,factory_id,opportunity_id,experiment_key,experiment_version);
CREATE UNIQUE INDEX IF NOT EXISTS uq_growth_experiment_idempotency ON growth_experiment_definitions(tenant_id,factory_id,idempotency_key);
CREATE INDEX IF NOT EXISTS idx_growth_experiment_history ON growth_experiment_definitions(tenant_id,factory_id,opportunity_id,created_at DESC,id DESC);
ALTER TABLE growth_experiment_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_experiment_definitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS growth_experiment_definitions_tenant_isolation ON growth_experiment_definitions;
CREATE POLICY growth_experiment_definitions_tenant_isolation ON growth_experiment_definitions
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());
CREATE OR REPLACE FUNCTION reject_growth_experiment_definition_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Growth experiment definitions are immutable; create a new version instead'; END; $$;
DROP TRIGGER IF EXISTS trg_growth_experiment_definition_immutable ON growth_experiment_definitions;
CREATE TRIGGER trg_growth_experiment_definition_immutable BEFORE UPDATE OR DELETE ON growth_experiment_definitions
 FOR EACH ROW EXECUTE FUNCTION reject_growth_experiment_definition_mutation();

CREATE TABLE IF NOT EXISTS growth_experiment_decisions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, factory_id UUID NOT NULL,
 opportunity_id UUID NOT NULL, experiment_id UUID NOT NULL, decision_number BIGINT NOT NULL DEFAULT 0,
 decision VARCHAR(20) NOT NULL, rationale TEXT NOT NULL, request_hash VARCHAR(64) NOT NULL,
 idempotency_key VARCHAR(128) NOT NULL, decided_by UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_growth_experiment_decision_scope FOREIGN KEY(experiment_id,tenant_id,factory_id,opportunity_id)
  REFERENCES growth_experiment_definitions(id,tenant_id,factory_id,opportunity_id) ON DELETE RESTRICT,
 CONSTRAINT fk_growth_experiment_decision_actor FOREIGN KEY(decided_by) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_growth_experiment_decision CHECK(decision IN('APPROVED','REJECTED','DEFERRED','STARTED','PAUSED','STOPPED','COMPLETED')),
 CONSTRAINT chk_growth_experiment_decision_rationale CHECK(LENGTH(BTRIM(rationale)) BETWEEN 1 AND 2000),
 CONSTRAINT chk_growth_experiment_decision_number CHECK(decision_number>=1),
 CONSTRAINT chk_growth_experiment_decision_hash CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT chk_growth_experiment_decision_idempotency CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_growth_experiment_decision_number ON growth_experiment_decisions(tenant_id,factory_id,experiment_id,decision_number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_growth_experiment_decision_idempotency ON growth_experiment_decisions(tenant_id,factory_id,idempotency_key);
CREATE INDEX IF NOT EXISTS idx_growth_experiment_decision_latest ON growth_experiment_decisions(tenant_id,factory_id,experiment_id,decision_number DESC);
ALTER TABLE growth_experiment_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_experiment_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS growth_experiment_decisions_tenant_isolation ON growth_experiment_decisions;
CREATE POLICY growth_experiment_decisions_tenant_isolation ON growth_experiment_decisions
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());
CREATE OR REPLACE FUNCTION enforce_growth_experiment_decision_transition() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE prior_decision VARCHAR(20); prior_number BIGINT;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.experiment_id::text,0));
 SELECT decision,decision_number INTO prior_decision,prior_number FROM growth_experiment_decisions
  WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND experiment_id=NEW.experiment_id
  ORDER BY decision_number DESC LIMIT 1;
 IF EXISTS(SELECT 1 FROM growth_experiment_decisions WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND idempotency_key=NEW.idempotency_key) THEN
  NEW.decision_number:=COALESCE(prior_number,0)+1; RETURN NEW;
 END IF;
 IF prior_decision IS NULL THEN
  IF NEW.decision NOT IN('APPROVED','REJECTED','DEFERRED') THEN
   RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Invalid growth experiment decision transition';
  END IF;
  NEW.decision_number:=1;
 ELSE
  IF NOT ((prior_decision='DEFERRED' AND NEW.decision IN('APPROVED','REJECTED','DEFERRED'))
    OR (prior_decision='APPROVED' AND NEW.decision IN('STARTED','STOPPED'))
    OR (prior_decision='STARTED' AND NEW.decision IN('PAUSED','STOPPED','COMPLETED'))
    OR (prior_decision='PAUSED' AND NEW.decision IN('STARTED','STOPPED'))) THEN
   RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Invalid growth experiment decision transition';
  END IF;
  NEW.decision_number:=prior_number+1;
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_growth_experiment_decision_transition ON growth_experiment_decisions;
CREATE TRIGGER trg_growth_experiment_decision_transition BEFORE INSERT ON growth_experiment_decisions
 FOR EACH ROW EXECUTE FUNCTION enforce_growth_experiment_decision_transition();
CREATE OR REPLACE FUNCTION reject_growth_experiment_decision_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Growth experiment decisions are append-only'; END; $$;
DROP TRIGGER IF EXISTS trg_growth_experiment_decisions_immutable ON growth_experiment_decisions;
CREATE TRIGGER trg_growth_experiment_decisions_immutable BEFORE UPDATE OR DELETE ON growth_experiment_decisions
 FOR EACH ROW EXECUTE FUNCTION reject_growth_experiment_decision_mutation();

CREATE TABLE IF NOT EXISTS growth_experiment_measurements (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, factory_id UUID NOT NULL,
 opportunity_id UUID NOT NULL, experiment_id UUID NOT NULL, measurement_stage VARCHAR(20) NOT NULL,
 metric_key VARCHAR(100) NOT NULL, actual_value NUMERIC(20,6) NOT NULL, metric_unit VARCHAR(40) NOT NULL,
 observed_at TIMESTAMPTZ NOT NULL, source_system VARCHAR(20) NOT NULL, source_record_ref VARCHAR(255) NOT NULL,
 source_snapshot_sha256 VARCHAR(64), request_hash VARCHAR(64) NOT NULL, idempotency_key VARCHAR(128) NOT NULL,
 recorded_by UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_growth_experiment_measurement_scope FOREIGN KEY(experiment_id,tenant_id,factory_id,opportunity_id)
  REFERENCES growth_experiment_definitions(id,tenant_id,factory_id,opportunity_id) ON DELETE RESTRICT,
 CONSTRAINT fk_growth_experiment_measurement_actor FOREIGN KEY(recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_growth_experiment_measurement_stage CHECK(measurement_stage IN('BASELINE','PRE','POST','REALIZED')),
 CONSTRAINT chk_growth_experiment_measurement_metric CHECK(metric_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$' AND metric_unit ~ '^[a-zA-Z0-9][a-zA-Z0-9._/%-]{0,39}$'),
 CONSTRAINT chk_growth_experiment_measurement_source CHECK(source_system IN('ERP','MES','CRM','FINANCE','QUALITY','MAINTENANCE','OTHER') AND LENGTH(BTRIM(source_record_ref)) BETWEEN 1 AND 255),
 CONSTRAINT chk_growth_experiment_measurement_sha CHECK(source_snapshot_sha256 IS NULL OR source_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
 CONSTRAINT chk_growth_experiment_measurement_hash CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT chk_growth_experiment_measurement_idempotency CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_growth_experiment_measurement_idempotency ON growth_experiment_measurements(tenant_id,factory_id,idempotency_key);
CREATE INDEX IF NOT EXISTS idx_growth_experiment_measurement_history ON growth_experiment_measurements(tenant_id,factory_id,experiment_id,observed_at DESC,id DESC);
ALTER TABLE growth_experiment_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_experiment_measurements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS growth_experiment_measurements_tenant_isolation ON growth_experiment_measurements;
CREATE POLICY growth_experiment_measurements_tenant_isolation ON growth_experiment_measurements
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());
CREATE OR REPLACE FUNCTION enforce_growth_experiment_measurement_stage() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE current_decision VARCHAR(20);
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.experiment_id::text,0));
 IF EXISTS(SELECT 1 FROM growth_experiment_measurements WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND idempotency_key=NEW.idempotency_key) THEN RETURN NEW; END IF;
 IF NEW.measurement_stage='BASELINE' THEN RETURN NEW; END IF;
 SELECT decision INTO current_decision FROM growth_experiment_decisions
  WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND experiment_id=NEW.experiment_id
  ORDER BY decision_number DESC LIMIT 1;
 IF NEW.measurement_stage='PRE' AND current_decision IS DISTINCT FROM 'APPROVED' THEN
  RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Growth experiment PRE measurement requires an APPROVED experiment';
 ELSIF NEW.measurement_stage='POST' AND current_decision IS DISTINCT FROM 'STARTED' THEN
  RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Growth experiment POST measurement requires a STARTED experiment';
 ELSIF NEW.measurement_stage='REALIZED' AND current_decision IS DISTINCT FROM 'COMPLETED' THEN
  RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Growth experiment REALIZED measurement requires a COMPLETED experiment';
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_growth_experiment_measurement_stage ON growth_experiment_measurements;
CREATE TRIGGER trg_growth_experiment_measurement_stage BEFORE INSERT ON growth_experiment_measurements
 FOR EACH ROW EXECUTE FUNCTION enforce_growth_experiment_measurement_stage();
CREATE OR REPLACE FUNCTION reject_growth_experiment_measurement_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Growth experiment measurements are append-only'; END; $$;
DROP TRIGGER IF EXISTS trg_growth_experiment_measurements_immutable ON growth_experiment_measurements;
CREATE TRIGGER trg_growth_experiment_measurements_immutable BEFORE UPDATE OR DELETE ON growth_experiment_measurements
 FOR EACH ROW EXECUTE FUNCTION reject_growth_experiment_measurement_mutation();

INSERT INTO schema_migrations(version,checksum) VALUES('036_growth_scenarios_experiments',NULL) ON CONFLICT(version) DO NOTHING;
COMMIT;
