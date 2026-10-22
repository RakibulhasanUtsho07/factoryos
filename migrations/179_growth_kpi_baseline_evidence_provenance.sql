BEGIN;

ALTER TABLE growth_experiment_result_kpis
  ADD COLUMN IF NOT EXISTS baseline_evidence_ref TEXT;
ALTER TABLE growth_outcome_kpi_measurements
  ADD COLUMN IF NOT EXISTS baseline_evidence_ref TEXT;

ALTER TABLE growth_experiment_result_kpis
  DROP CONSTRAINT IF EXISTS chk_growth_experiment_result_kpi_baseline_evidence;
ALTER TABLE growth_experiment_result_kpis
  ADD CONSTRAINT chk_growth_experiment_result_kpi_baseline_evidence
  CHECK (baseline_evidence_ref IS NULL OR length(btrim(baseline_evidence_ref)) BETWEEN 1 AND 2000);

ALTER TABLE growth_outcome_kpi_measurements
  DROP CONSTRAINT IF EXISTS chk_growth_outcome_kpi_baseline_evidence;
ALTER TABLE growth_outcome_kpi_measurements
  ADD CONSTRAINT chk_growth_outcome_kpi_baseline_evidence
  CHECK (baseline_evidence_ref IS NULL OR length(btrim(baseline_evidence_ref)) BETWEEN 1 AND 2000);

CREATE OR REPLACE FUNCTION factoryos_guard_growth_experiment_result_kpi()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  result_pre JSONB;
  result_post JSONB;
  result_evidence JSONB;
  result_opportunity UUID;
  result_observed_at TIMESTAMPTZ;
  actual_observation RECORD;
  baseline_observation RECORD;
  evidence_prefix CONSTANT TEXT := 'factoryos://growth/source-observations/';
  actual_observation_id TEXT;
  baseline_observation_id TEXT;
BEGIN
 SELECT r.pre_measurements, r.post_measurements, r.evidence_refs, e.opportunity_id, r.observed_at
 INTO result_pre, result_post, result_evidence, result_opportunity, result_observed_at
 FROM growth_experiment_results r JOIN growth_experiments e
   ON e.id=r.experiment_id AND e.tenant_id=r.tenant_id AND e.factory_id=r.factory_id
 WHERE r.id=NEW.experiment_result_id AND r.tenant_id=NEW.tenant_id
   AND r.factory_id=NEW.factory_id AND r.experiment_id=NEW.experiment_id
 FOR KEY SHARE OF r,e;
 IF NOT FOUND OR result_opportunity IS DISTINCT FROM NEW.opportunity_id THEN
   RAISE EXCEPTION 'GROWTH_EXPERIMENT_KPI_RESULT_SCOPE_MISMATCH' USING ERRCODE='23503';
 END IF;
 IF jsonb_typeof(result_pre -> NEW.metric_key) IS DISTINCT FROM 'number'
    OR jsonb_typeof(result_post -> NEW.metric_key) IS DISTINCT FROM 'number' THEN
   RAISE EXCEPTION 'GROWTH_EXPERIMENT_KPI_REQUIRES_NUMERIC_PRE_AND_POST_VALUES' USING ERRCODE='23514';
 END IF;
 IF (result_pre ->> NEW.metric_key)::NUMERIC IS DISTINCT FROM NEW.baseline_value
    OR (result_post ->> NEW.metric_key)::NUMERIC IS DISTINCT FROM NEW.actual_value THEN
   RAISE EXCEPTION 'GROWTH_EXPERIMENT_KPI_VALUES_MUST_MATCH_RESULT_SNAPSHOT' USING ERRCODE='23514';
 END IF;
 IF NOT (result_evidence @> jsonb_build_array(NEW.evidence_ref)) THEN
   RAISE EXCEPTION 'GROWTH_EXPERIMENT_KPI_EVIDENCE_NOT_LINKED_TO_RESULT' USING ERRCODE='23514';
 END IF;
 IF NEW.baseline_evidence_ref IS NOT NULL
    AND NOT (result_evidence @> jsonb_build_array(NEW.baseline_evidence_ref)) THEN
   RAISE EXCEPTION 'GROWTH_EXPERIMENT_KPI_BASELINE_EVIDENCE_NOT_LINKED_TO_RESULT' USING ERRCODE='23514';
 END IF;

 IF NEW.evidence_ref LIKE evidence_prefix || '%'
    OR COALESCE(NEW.baseline_evidence_ref,'') LIKE evidence_prefix || '%' THEN
   IF NEW.evidence_ref NOT LIKE evidence_prefix || '%'
      OR NEW.baseline_evidence_ref IS NULL
      OR NEW.baseline_evidence_ref NOT LIKE evidence_prefix || '%' THEN
     RAISE EXCEPTION 'GROWTH_EXPERIMENT_KPI_SOURCE_REQUIRES_BOTH_BASELINE_AND_ACTUAL_OBSERVATIONS' USING ERRCODE='23514';
   END IF;
   IF NOT (result_evidence @> jsonb_build_array(NEW.baseline_evidence_ref)) THEN
     RAISE EXCEPTION 'GROWTH_EXPERIMENT_KPI_BASELINE_EVIDENCE_NOT_LINKED_TO_RESULT' USING ERRCODE='23514';
   END IF;
   actual_observation_id := substring(NEW.evidence_ref from length(evidence_prefix)+1);
   baseline_observation_id := substring(NEW.baseline_evidence_ref from length(evidence_prefix)+1);
   SELECT o.id::text AS id,o.source_kind,o.adapter_version,o.metric_key,o.unit,o.value,o.observed_at
     INTO actual_observation
     FROM growth_kpi_source_observations o
    WHERE o.id::text=actual_observation_id AND o.tenant_id=NEW.tenant_id
      AND o.factory_id=NEW.factory_id AND o.opportunity_id=NEW.opportunity_id
    FOR KEY SHARE;
   IF NOT FOUND THEN
     RAISE EXCEPTION 'GROWTH_EXPERIMENT_KPI_ACTUAL_SOURCE_OBSERVATION_NOT_FOUND' USING ERRCODE='23503';
   END IF;
   SELECT o.id::text AS id,o.source_kind,o.adapter_version,o.metric_key,o.unit,o.value,o.observed_at
     INTO baseline_observation
     FROM growth_kpi_source_observations o
    WHERE o.id::text=baseline_observation_id AND o.tenant_id=NEW.tenant_id
      AND o.factory_id=NEW.factory_id AND o.opportunity_id=NEW.opportunity_id
    FOR KEY SHARE;
   IF NOT FOUND THEN
     RAISE EXCEPTION 'GROWTH_EXPERIMENT_KPI_BASELINE_SOURCE_OBSERVATION_NOT_FOUND' USING ERRCODE='23503';
   END IF;
   IF actual_observation.metric_key IS DISTINCT FROM NEW.metric_key
      OR baseline_observation.metric_key IS DISTINCT FROM NEW.metric_key
      OR actual_observation.unit IS DISTINCT FROM NEW.unit
      OR baseline_observation.unit IS DISTINCT FROM NEW.unit
      OR actual_observation.value IS DISTINCT FROM NEW.actual_value
      OR baseline_observation.value IS DISTINCT FROM NEW.baseline_value
      OR actual_observation.source_kind IS DISTINCT FROM baseline_observation.source_kind
      OR actual_observation.adapter_version IS DISTINCT FROM 'factoryos.growth.source-of-record.v1'
      OR baseline_observation.adapter_version IS DISTINCT FROM 'factoryos.growth.source-of-record.v1'
      OR actual_observation.observed_at IS DISTINCT FROM result_observed_at
      OR baseline_observation.observed_at >= actual_observation.observed_at THEN
     RAISE EXCEPTION 'GROWTH_EXPERIMENT_KPI_SOURCE_OBSERVATION_VALUE_UNIT_TIME_OR_VERSION_MISMATCH' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION factoryos_guard_growth_outcome_kpi_measurement()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  realized JSONB;
  outcome_evidence JSONB;
  outcome_observed_at TIMESTAMPTZ;
  source_row RECORD;
  actual_observation RECORD;
  baseline_observation RECORD;
  evidence_prefix CONSTANT TEXT := 'factoryos://growth/source-observations/';
  actual_observation_id TEXT;
  baseline_observation_id TEXT;
BEGIN
 SELECT o.realized_metrics,o.evidence_refs,o.observed_at
   INTO realized,outcome_evidence,outcome_observed_at
   FROM growth_opportunity_outcomes o
  WHERE o.id=NEW.outcome_id AND o.tenant_id=NEW.tenant_id
    AND o.factory_id=NEW.factory_id AND o.opportunity_id=NEW.opportunity_id
  FOR KEY SHARE;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'GROWTH_OUTCOME_KPI_OUTCOME_SCOPE_MISMATCH' USING ERRCODE='23503';
 END IF;
 IF jsonb_typeof(realized -> NEW.metric_key) IS DISTINCT FROM 'number' THEN
   RAISE EXCEPTION 'GROWTH_OUTCOME_KPI_REQUIRES_NUMERIC_REALIZED_METRIC' USING ERRCODE='23514';
 END IF;
 IF (realized ->> NEW.metric_key)::NUMERIC IS DISTINCT FROM NEW.actual_value THEN
   RAISE EXCEPTION 'GROWTH_OUTCOME_KPI_VALUE_MUST_MATCH_REALIZED_METRICS' USING ERRCODE='23514';
 END IF;
 IF NOT (outcome_evidence @> jsonb_build_array(NEW.evidence_ref)) THEN
   RAISE EXCEPTION 'GROWTH_OUTCOME_KPI_EVIDENCE_NOT_LINKED_TO_OUTCOME' USING ERRCODE='23514';
 END IF;
 IF NEW.baseline_evidence_ref IS NOT NULL
    AND NOT (outcome_evidence @> jsonb_build_array(NEW.baseline_evidence_ref)) THEN
   RAISE EXCEPTION 'GROWTH_OUTCOME_KPI_BASELINE_EVIDENCE_NOT_LINKED_TO_OUTCOME' USING ERRCODE='23514';
 END IF;

 IF NEW.source_experiment_kpi_id IS NOT NULL THEN
   SELECT k.metric_key,k.unit,k.baseline_value,k.target_value,k.direction,k.baseline_evidence_ref
     INTO source_row
     FROM growth_experiment_result_kpis k
    WHERE k.id=NEW.source_experiment_kpi_id AND k.tenant_id=NEW.tenant_id
      AND k.factory_id=NEW.factory_id AND k.opportunity_id=NEW.opportunity_id
    FOR KEY SHARE;
   IF NOT FOUND OR source_row.metric_key IS DISTINCT FROM NEW.metric_key
      OR source_row.unit IS DISTINCT FROM NEW.unit
      OR source_row.baseline_value IS DISTINCT FROM NEW.baseline_value
      OR source_row.target_value IS DISTINCT FROM NEW.target_value
      OR source_row.direction IS DISTINCT FROM NEW.direction
      OR source_row.baseline_evidence_ref IS DISTINCT FROM NEW.baseline_evidence_ref THEN
     RAISE EXCEPTION 'GROWTH_OUTCOME_KPI_DOES_NOT_MATCH_EXPERIMENT_BASELINE_TARGET_DIRECTION_OR_BASELINE_EVIDENCE' USING ERRCODE='23514';
   END IF;
 END IF;

 IF NEW.evidence_ref LIKE evidence_prefix || '%'
    OR COALESCE(NEW.baseline_evidence_ref,'') LIKE evidence_prefix || '%' THEN
   IF NEW.evidence_ref NOT LIKE evidence_prefix || '%'
      OR NEW.baseline_evidence_ref IS NULL
      OR NEW.baseline_evidence_ref NOT LIKE evidence_prefix || '%' THEN
     RAISE EXCEPTION 'GROWTH_OUTCOME_KPI_SOURCE_REQUIRES_BOTH_BASELINE_AND_ACTUAL_OBSERVATIONS' USING ERRCODE='23514';
   END IF;
   actual_observation_id := substring(NEW.evidence_ref from length(evidence_prefix)+1);
   baseline_observation_id := substring(NEW.baseline_evidence_ref from length(evidence_prefix)+1);
   SELECT o.id::text AS id,o.source_kind,o.adapter_version,o.metric_key,o.unit,o.value,o.observed_at
     INTO actual_observation
     FROM growth_kpi_source_observations o
    WHERE o.id::text=actual_observation_id AND o.tenant_id=NEW.tenant_id
      AND o.factory_id=NEW.factory_id AND o.opportunity_id=NEW.opportunity_id
    FOR KEY SHARE;
   IF NOT FOUND THEN
     RAISE EXCEPTION 'GROWTH_OUTCOME_KPI_ACTUAL_SOURCE_OBSERVATION_NOT_FOUND' USING ERRCODE='23503';
   END IF;
   SELECT o.id::text AS id,o.source_kind,o.adapter_version,o.metric_key,o.unit,o.value,o.observed_at
     INTO baseline_observation
     FROM growth_kpi_source_observations o
    WHERE o.id::text=baseline_observation_id AND o.tenant_id=NEW.tenant_id
      AND o.factory_id=NEW.factory_id AND o.opportunity_id=NEW.opportunity_id
    FOR KEY SHARE;
   IF NOT FOUND THEN
     RAISE EXCEPTION 'GROWTH_OUTCOME_KPI_BASELINE_SOURCE_OBSERVATION_NOT_FOUND' USING ERRCODE='23503';
   END IF;
   IF actual_observation.metric_key IS DISTINCT FROM NEW.metric_key
      OR baseline_observation.metric_key IS DISTINCT FROM NEW.metric_key
      OR actual_observation.unit IS DISTINCT FROM NEW.unit
      OR baseline_observation.unit IS DISTINCT FROM NEW.unit
      OR actual_observation.value IS DISTINCT FROM NEW.actual_value
      OR baseline_observation.value IS DISTINCT FROM NEW.baseline_value
      OR actual_observation.source_kind IS DISTINCT FROM baseline_observation.source_kind
      OR actual_observation.adapter_version IS DISTINCT FROM 'factoryos.growth.source-of-record.v1'
      OR baseline_observation.adapter_version IS DISTINCT FROM 'factoryos.growth.source-of-record.v1'
      OR actual_observation.observed_at IS DISTINCT FROM outcome_observed_at
      OR baseline_observation.observed_at >= actual_observation.observed_at THEN
     RAISE EXCEPTION 'GROWTH_OUTCOME_KPI_SOURCE_OBSERVATION_VALUE_UNIT_TIME_OR_VERSION_MISMATCH' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END; $$;

INSERT INTO schema_migrations(version,checksum)
VALUES ('179_growth_kpi_baseline_evidence_provenance', NULL)
ON CONFLICT(version) DO NOTHING;
COMMIT;
