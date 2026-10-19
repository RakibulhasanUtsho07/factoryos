BEGIN;
ALTER TABLE growth_experiments ADD CONSTRAINT uq_growth_experiment_opportunity_scope UNIQUE (id, tenant_id, factory_id, opportunity_id);
ALTER TABLE growth_experiment_results ADD CONSTRAINT uq_growth_result_experiment_scope UNIQUE (id, tenant_id, factory_id, experiment_id);
ALTER TABLE growth_opportunity_outcomes ADD CONSTRAINT uq_growth_outcome_opportunity_scope UNIQUE (id, tenant_id, factory_id, opportunity_id);

CREATE TABLE growth_experiment_result_kpis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL, experiment_id UUID NOT NULL, experiment_result_id UUID NOT NULL,
  metric_key VARCHAR(100) NOT NULL, baseline_value NUMERIC(24,8) NOT NULL, actual_value NUMERIC(24,8) NOT NULL,
  target_value NUMERIC(24,8), unit VARCHAR(40) NOT NULL, direction VARCHAR(12) NOT NULL,
  evidence_ref TEXT NOT NULL, recorded_by UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_growth_experiment_result_kpi_key UNIQUE (experiment_result_id, metric_key),
  CONSTRAINT uq_growth_experiment_result_kpi_link UNIQUE (id, tenant_id, factory_id, opportunity_id, metric_key, unit),
  CONSTRAINT fk_growth_experiment_result_kpi_scope FOREIGN KEY (experiment_result_id, tenant_id, factory_id, experiment_id)
    REFERENCES growth_experiment_results(id, tenant_id, factory_id, experiment_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_experiment_result_kpi_experiment FOREIGN KEY (experiment_id, tenant_id, factory_id, opportunity_id)
    REFERENCES growth_experiments(id, tenant_id, factory_id, opportunity_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_experiment_result_kpi_actor FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_experiment_result_kpi_key CHECK (metric_key ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  CONSTRAINT chk_growth_experiment_result_kpi_values CHECK (abs(baseline_value) <= 1000000000000 AND abs(actual_value) <= 1000000000000 AND (target_value IS NULL OR abs(target_value) <= 1000000000000)),
  CONSTRAINT chk_growth_experiment_result_kpi_unit CHECK (length(btrim(unit)) BETWEEN 1 AND 40),
  CONSTRAINT chk_growth_experiment_result_kpi_direction CHECK (direction IN ('INCREASE', 'DECREASE', 'TARGET')),
  CONSTRAINT chk_growth_experiment_result_kpi_evidence CHECK (length(btrim(evidence_ref)) BETWEEN 1 AND 2000)
);
CREATE INDEX idx_growth_experiment_result_kpis_lookup ON growth_experiment_result_kpis (tenant_id, factory_id, opportunity_id, experiment_result_id, metric_key);

CREATE TABLE growth_outcome_kpi_measurements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, factory_id UUID NOT NULL,
  opportunity_id UUID NOT NULL, outcome_id UUID NOT NULL, source_experiment_kpi_id UUID,
  metric_key VARCHAR(100) NOT NULL, baseline_value NUMERIC(24,8) NOT NULL, actual_value NUMERIC(24,8) NOT NULL,
  target_value NUMERIC(24,8), unit VARCHAR(40) NOT NULL, direction VARCHAR(12) NOT NULL,
  evidence_ref TEXT NOT NULL, recorded_by UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_growth_outcome_kpi_key UNIQUE (outcome_id, metric_key),
  CONSTRAINT fk_growth_outcome_kpi_outcome FOREIGN KEY (outcome_id, tenant_id, factory_id, opportunity_id)
    REFERENCES growth_opportunity_outcomes(id, tenant_id, factory_id, opportunity_id) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_outcome_kpi_source FOREIGN KEY (source_experiment_kpi_id, tenant_id, factory_id, opportunity_id, metric_key, unit)
    REFERENCES growth_experiment_result_kpis(id, tenant_id, factory_id, opportunity_id, metric_key, unit) ON DELETE RESTRICT,
  CONSTRAINT fk_growth_outcome_kpi_actor FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_growth_outcome_kpi_key CHECK (metric_key ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  CONSTRAINT chk_growth_outcome_kpi_values CHECK (abs(baseline_value) <= 1000000000000 AND abs(actual_value) <= 1000000000000 AND (target_value IS NULL OR abs(target_value) <= 1000000000000)),
  CONSTRAINT chk_growth_outcome_kpi_unit CHECK (length(btrim(unit)) BETWEEN 1 AND 40),
  CONSTRAINT chk_growth_outcome_kpi_direction CHECK (direction IN ('INCREASE', 'DECREASE', 'TARGET')),
  CONSTRAINT chk_growth_outcome_kpi_evidence CHECK (length(btrim(evidence_ref)) BETWEEN 1 AND 2000)
);
CREATE INDEX idx_growth_outcome_kpis_lookup ON growth_outcome_kpi_measurements (tenant_id, factory_id, opportunity_id, outcome_id, metric_key);

CREATE OR REPLACE FUNCTION factoryos_guard_growth_experiment_result_kpi()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE result_pre JSONB; result_post JSONB; result_evidence JSONB; result_opportunity UUID;
BEGIN
 SELECT r.pre_measurements, r.post_measurements, r.evidence_refs, e.opportunity_id
 INTO result_pre, result_post, result_evidence, result_opportunity
 FROM growth_experiment_results r JOIN growth_experiments e ON e.id=r.experiment_id AND e.tenant_id=r.tenant_id AND e.factory_id=r.factory_id
 WHERE r.id=NEW.experiment_result_id AND r.tenant_id=NEW.tenant_id AND r.factory_id=NEW.factory_id AND r.experiment_id=NEW.experiment_id
 FOR KEY SHARE OF r,e;
 IF NOT FOUND OR result_opportunity IS DISTINCT FROM NEW.opportunity_id THEN
   RAISE EXCEPTION 'GROWTH_EXPERIMENT_KPI_RESULT_SCOPE_MISMATCH' USING ERRCODE='23503';
 END IF;
 IF jsonb_typeof(result_pre -> NEW.metric_key) IS DISTINCT FROM 'number' OR jsonb_typeof(result_post -> NEW.metric_key) IS DISTINCT FROM 'number' THEN
   RAISE EXCEPTION 'GROWTH_EXPERIMENT_KPI_REQUIRES_NUMERIC_PRE_AND_POST_VALUES' USING ERRCODE='23514';
 END IF;
 IF (result_pre ->> NEW.metric_key)::NUMERIC IS DISTINCT FROM NEW.baseline_value OR (result_post ->> NEW.metric_key)::NUMERIC IS DISTINCT FROM NEW.actual_value THEN
   RAISE EXCEPTION 'GROWTH_EXPERIMENT_KPI_VALUES_MUST_MATCH_RESULT_SNAPSHOT' USING ERRCODE='23514';
 END IF;
 IF NOT (result_evidence @> jsonb_build_array(NEW.evidence_ref)) THEN
   RAISE EXCEPTION 'GROWTH_EXPERIMENT_KPI_EVIDENCE_NOT_LINKED_TO_RESULT' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER growth_experiment_result_kpi_guard BEFORE INSERT ON growth_experiment_result_kpis FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_experiment_result_kpi();

CREATE OR REPLACE FUNCTION factoryos_guard_growth_outcome_kpi_measurement()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE realized JSONB; outcome_evidence JSONB; source_row RECORD;
BEGIN
 SELECT o.realized_metrics,o.evidence_refs INTO realized,outcome_evidence FROM growth_opportunity_outcomes o
 WHERE o.id=NEW.outcome_id AND o.tenant_id=NEW.tenant_id AND o.factory_id=NEW.factory_id AND o.opportunity_id=NEW.opportunity_id FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GROWTH_OUTCOME_KPI_OUTCOME_SCOPE_MISMATCH' USING ERRCODE='23503'; END IF;
 IF jsonb_typeof(realized -> NEW.metric_key) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'GROWTH_OUTCOME_KPI_REQUIRES_NUMERIC_REALIZED_METRIC' USING ERRCODE='23514'; END IF;
 IF (realized ->> NEW.metric_key)::NUMERIC IS DISTINCT FROM NEW.actual_value THEN RAISE EXCEPTION 'GROWTH_OUTCOME_KPI_VALUE_MUST_MATCH_REALIZED_METRICS' USING ERRCODE='23514'; END IF;
 IF NOT (outcome_evidence @> jsonb_build_array(NEW.evidence_ref)) THEN RAISE EXCEPTION 'GROWTH_OUTCOME_KPI_EVIDENCE_NOT_LINKED_TO_OUTCOME' USING ERRCODE='23514'; END IF;
 IF NEW.source_experiment_kpi_id IS NOT NULL THEN
   SELECT k.metric_key,k.unit,k.baseline_value,k.target_value,k.direction INTO source_row FROM growth_experiment_result_kpis k
   WHERE k.id=NEW.source_experiment_kpi_id AND k.tenant_id=NEW.tenant_id AND k.factory_id=NEW.factory_id AND k.opportunity_id=NEW.opportunity_id FOR KEY SHARE;
   IF NOT FOUND OR source_row.metric_key IS DISTINCT FROM NEW.metric_key OR source_row.unit IS DISTINCT FROM NEW.unit
     OR source_row.baseline_value IS DISTINCT FROM NEW.baseline_value OR source_row.target_value IS DISTINCT FROM NEW.target_value
     OR source_row.direction IS DISTINCT FROM NEW.direction THEN
     RAISE EXCEPTION 'GROWTH_OUTCOME_KPI_DOES_NOT_MATCH_EXPERIMENT_BASELINE_TARGET_OR_DIRECTION' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER growth_outcome_kpi_measurement_guard BEFORE INSERT ON growth_outcome_kpi_measurements FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_outcome_kpi_measurement();

CREATE OR REPLACE FUNCTION factoryos_guard_growth_experiment_result_kpi_completeness()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE metric_count INTEGER;
BEGIN
 SELECT COUNT(*)::INTEGER INTO metric_count FROM growth_experiment_result_kpis WHERE experiment_result_id=NEW.id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
 IF metric_count<1 THEN RAISE EXCEPTION 'GROWTH_EXPERIMENT_RESULT_REQUIRES_LINKED_KPI_MEASUREMENTS' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER growth_experiment_result_kpi_completeness_guard AFTER INSERT ON growth_experiment_results DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_experiment_result_kpi_completeness();

CREATE OR REPLACE FUNCTION factoryos_guard_growth_outcome_kpi_completeness()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE outcome_kpi_count INTEGER; source_kpi_count INTEGER; linked_source_count INTEGER;
BEGIN
 SELECT COUNT(*)::INTEGER INTO outcome_kpi_count FROM growth_outcome_kpi_measurements WHERE outcome_id=NEW.id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND opportunity_id=NEW.opportunity_id;
 IF outcome_kpi_count<1 THEN RAISE EXCEPTION 'GROWTH_OUTCOME_REQUIRES_LINKED_KPI_MEASUREMENTS' USING ERRCODE='23514'; END IF;
 IF NEW.experiment_result_id IS NOT NULL THEN
   SELECT COUNT(*)::INTEGER INTO source_kpi_count FROM growth_experiment_result_kpis WHERE experiment_result_id=NEW.experiment_result_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND opportunity_id=NEW.opportunity_id;
   SELECT COUNT(*)::INTEGER INTO linked_source_count FROM growth_outcome_kpi_measurements WHERE outcome_id=NEW.id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND opportunity_id=NEW.opportunity_id AND source_experiment_kpi_id IS NOT NULL;
   IF source_kpi_count<1 OR outcome_kpi_count<>source_kpi_count OR linked_source_count<>source_kpi_count THEN
     RAISE EXCEPTION 'GROWTH_OUTCOME_MUST_LINK_EVERY_SOURCE_EXPERIMENT_KPI' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER growth_outcome_kpi_completeness_guard AFTER INSERT ON growth_opportunity_outcomes DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_outcome_kpi_completeness();

CREATE TRIGGER growth_experiment_result_kpis_immutable BEFORE UPDATE OR DELETE ON growth_experiment_result_kpis FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_growth_snapshot_mutation();
CREATE TRIGGER growth_outcome_kpi_measurements_immutable BEFORE UPDATE OR DELETE ON growth_outcome_kpi_measurements FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_growth_snapshot_mutation();
DO $$ DECLARE table_name TEXT;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['growth_experiment_result_kpis','growth_outcome_kpi_measurements'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id())',table_name||'_tenant_isolation',table_name);
 END LOOP;
END; $$;
INSERT INTO schema_migrations(version,checksum) VALUES('146_growth_experiment_kpi_evidence_linkage',NULL) ON CONFLICT(version) DO NOTHING;
COMMIT;
