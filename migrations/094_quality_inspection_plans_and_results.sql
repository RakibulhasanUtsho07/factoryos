BEGIN;

INSERT INTO permissions (code, description)
VALUES ('quality.plans.manage', 'Create, activate and retire versioned factory inspection plans and acceptance criteria')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'quality.plans.manage'
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER', 'QUALITY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE quality_inspection_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  plan_code VARCHAR(100) NOT NULL,
  revision INTEGER NOT NULL,
  name VARCHAR(255) NOT NULL,
  inspection_type VARCHAR(20) NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'DRAFT',
  default_sample_quantity NUMERIC(18,4),
  notes TEXT,
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  activated_by_user_id UUID,
  activated_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_quality_plan_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_quality_plan_revision UNIQUE (tenant_id, factory_id, plan_code, revision),
  CONSTRAINT uq_quality_plan_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_quality_plan_factory FOREIGN KEY (factory_id, tenant_id)
    REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_plan_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_plan_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_plan_activator FOREIGN KEY (activated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_plan_code CHECK (length(btrim(plan_code)) > 0),
  CONSTRAINT chk_quality_plan_revision CHECK (revision > 0),
  CONSTRAINT chk_quality_plan_type CHECK (inspection_type IN ('INCOMING','IN_PROCESS','FINAL','INVENTORY','SUPPLIER')),
  CONSTRAINT chk_quality_plan_status CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  CONSTRAINT chk_quality_plan_sample CHECK (default_sample_quantity IS NULL OR default_sample_quantity > 0),
  CONSTRAINT chk_quality_plan_version CHECK (row_version > 0),
  CONSTRAINT chk_quality_plan_key CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_quality_plan_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_quality_plan_activation_evidence CHECK (
    (status = 'DRAFT' AND activated_by_user_id IS NULL AND activated_at IS NULL AND retired_at IS NULL)
    OR (status = 'ACTIVE' AND activated_by_user_id IS NOT NULL AND activated_at IS NOT NULL AND retired_at IS NULL)
    OR (status = 'RETIRED' AND activated_by_user_id IS NOT NULL AND activated_at IS NOT NULL AND retired_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX uq_quality_plan_code_ci
  ON quality_inspection_plans(tenant_id, factory_id, lower(plan_code), revision);
CREATE UNIQUE INDEX uq_quality_plan_single_active_revision
  ON quality_inspection_plans(tenant_id, factory_id, lower(plan_code), inspection_type)
  WHERE status = 'ACTIVE';
CREATE INDEX idx_quality_plan_queue
  ON quality_inspection_plans(tenant_id, factory_id, inspection_type, status, lower(plan_code), revision DESC);

CREATE TABLE quality_inspection_plan_criteria (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  plan_id UUID NOT NULL,
  criterion_code VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  value_type VARCHAR(12) NOT NULL,
  comparison_operator VARCHAR(8) NOT NULL,
  target_value TEXT,
  lower_limit NUMERIC(18,6),
  upper_limit NUMERIC(18,6),
  allowed_values JSONB NOT NULL DEFAULT '[]'::jsonb,
  unit VARCHAR(50),
  is_required BOOLEAN NOT NULL DEFAULT TRUE,
  is_critical BOOLEAN NOT NULL DEFAULT FALSE,
  sequence_number INTEGER NOT NULL,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_quality_plan_criterion_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_quality_plan_criterion_code UNIQUE (plan_id, criterion_code),
  CONSTRAINT uq_quality_plan_criterion_sequence UNIQUE (plan_id, sequence_number),
  CONSTRAINT fk_quality_plan_criterion_plan FOREIGN KEY (plan_id, tenant_id, factory_id)
    REFERENCES quality_inspection_plans(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_plan_criterion_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_plan_criterion_code CHECK (length(btrim(criterion_code)) > 0),
  CONSTRAINT chk_quality_plan_criterion_name CHECK (length(btrim(name)) > 0),
  CONSTRAINT chk_quality_plan_criterion_type CHECK (value_type IN ('NUMERIC','TEXT','BOOLEAN','ENUM')),
  CONSTRAINT chk_quality_plan_criterion_operator CHECK (comparison_operator IN ('EQ','NE','GT','GTE','LT','LTE','BETWEEN','IN','CONTAINS')),
  CONSTRAINT chk_quality_plan_criterion_range CHECK (
    (comparison_operator <> 'BETWEEN' OR (lower_limit IS NOT NULL AND upper_limit IS NOT NULL AND lower_limit <= upper_limit))
    AND (value_type = 'NUMERIC' OR comparison_operator NOT IN ('GT','GTE','LT','LTE','BETWEEN'))
    AND (comparison_operator <> 'CONTAINS' OR value_type = 'TEXT')
    AND (comparison_operator <> 'IN' OR jsonb_typeof(allowed_values) = 'array')
    AND (value_type <> 'ENUM' OR comparison_operator <> 'IN' OR jsonb_array_length(allowed_values) > 0)
  ),
  CONSTRAINT chk_quality_plan_criterion_allowed_values CHECK (jsonb_typeof(allowed_values) = 'array'),
  CONSTRAINT chk_quality_plan_criterion_sequence CHECK (sequence_number > 0),
  CONSTRAINT chk_quality_plan_criterion_unit CHECK (unit IS NULL OR length(btrim(unit)) > 0)
);
CREATE INDEX idx_quality_plan_criteria_order
  ON quality_inspection_plan_criteria(tenant_id, factory_id, plan_id, sequence_number, criterion_code);

ALTER TABLE quality_inspections
  ADD COLUMN plan_id UUID,
  ADD COLUMN plan_revision INTEGER,
  ADD COLUMN criteria_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT fk_quality_inspection_plan
    FOREIGN KEY (plan_id, tenant_id, factory_id)
    REFERENCES quality_inspection_plans(id, tenant_id, factory_id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_quality_inspection_plan_binding CHECK (
    (plan_id IS NULL AND plan_revision IS NULL AND criteria_snapshot = '[]'::jsonb)
    OR (plan_id IS NOT NULL AND plan_revision > 0 AND jsonb_typeof(criteria_snapshot) = 'array'
      AND jsonb_array_length(criteria_snapshot) > 0)
  );

CREATE TABLE quality_inspection_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  inspection_id UUID NOT NULL,
  plan_id UUID NOT NULL,
  plan_revision INTEGER NOT NULL,
  criterion_code VARCHAR(100) NOT NULL,
  criterion_snapshot JSONB NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  observed_value TEXT NOT NULL,
  outcome VARCHAR(20) NOT NULL,
  notes TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  actor_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_quality_inspection_result_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_quality_inspection_result_attempt UNIQUE (inspection_id, criterion_code, attempt),
  CONSTRAINT uq_quality_inspection_result_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_quality_inspection_result_inspection FOREIGN KEY (inspection_id, tenant_id, factory_id)
    REFERENCES quality_inspections(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_inspection_result_plan FOREIGN KEY (plan_id, tenant_id, factory_id)
    REFERENCES quality_inspection_plans(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_inspection_result_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_inspection_result_revision CHECK (plan_revision > 0),
  CONSTRAINT chk_quality_inspection_result_attempt CHECK (attempt > 0),
  CONSTRAINT chk_quality_inspection_result_value CHECK (length(btrim(observed_value)) > 0),
  CONSTRAINT chk_quality_inspection_result_outcome CHECK (outcome IN ('PASS','FAIL','NOT_APPLICABLE')),
  CONSTRAINT chk_quality_inspection_result_snapshot CHECK (jsonb_typeof(criterion_snapshot) = 'object'),
  CONSTRAINT chk_quality_inspection_result_evidence CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT chk_quality_inspection_result_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_quality_inspection_result_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_quality_inspection_results_latest
  ON quality_inspection_results(tenant_id, factory_id, inspection_id, criterion_code, attempt DESC);

CREATE OR REPLACE FUNCTION factoryos_evaluate_quality_criterion(p_criterion JSONB, p_observed TEXT)
RETURNS VARCHAR
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_type TEXT := p_criterion->>'value_type';
  v_operator TEXT := p_criterion->>'comparison_operator';
  v_target TEXT := p_criterion->>'target_value';
  v_observed_numeric NUMERIC;
  v_target_numeric NUMERIC;
  v_lower NUMERIC;
  v_upper NUMERIC;
BEGIN
  IF p_observed IS NULL OR length(btrim(p_observed)) = 0 THEN
    RAISE EXCEPTION 'observed quality value is required' USING ERRCODE = '23514';
  END IF;

  IF v_type = 'NUMERIC' THEN
    BEGIN
      v_observed_numeric := p_observed::numeric;
      v_target_numeric := NULLIF(v_target, '')::numeric;
      v_lower := NULLIF(p_criterion->>'lower_limit', '')::numeric;
      v_upper := NULLIF(p_criterion->>'upper_limit', '')::numeric;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'numeric quality criterion requires a numeric observed/target value' USING ERRCODE = '23514';
    END;
    CASE v_operator
      WHEN 'EQ' THEN RETURN CASE WHEN v_observed_numeric = v_target_numeric THEN 'PASS' ELSE 'FAIL' END;
      WHEN 'NE' THEN RETURN CASE WHEN v_observed_numeric <> v_target_numeric THEN 'PASS' ELSE 'FAIL' END;
      WHEN 'GT' THEN RETURN CASE WHEN v_observed_numeric > v_target_numeric THEN 'PASS' ELSE 'FAIL' END;
      WHEN 'GTE' THEN RETURN CASE WHEN v_observed_numeric >= v_target_numeric THEN 'PASS' ELSE 'FAIL' END;
      WHEN 'LT' THEN RETURN CASE WHEN v_observed_numeric < v_target_numeric THEN 'PASS' ELSE 'FAIL' END;
      WHEN 'LTE' THEN RETURN CASE WHEN v_observed_numeric <= v_target_numeric THEN 'PASS' ELSE 'FAIL' END;
      WHEN 'BETWEEN' THEN RETURN CASE WHEN v_observed_numeric BETWEEN v_lower AND v_upper THEN 'PASS' ELSE 'FAIL' END;
      WHEN 'IN' THEN RETURN CASE WHEN p_criterion->'allowed_values' ? p_observed THEN 'PASS' ELSE 'FAIL' END;
      ELSE RAISE EXCEPTION 'unsupported numeric quality operator' USING ERRCODE = '23514';
    END CASE;
  ELSIF v_type = 'BOOLEAN' THEN
    IF lower(p_observed) NOT IN ('true','false') OR v_operator NOT IN ('EQ','NE') OR lower(v_target) NOT IN ('true','false') THEN
      RAISE EXCEPTION 'boolean quality criteria require EQ/NE and true/false values' USING ERRCODE = '23514';
    END IF;
    IF (lower(p_observed) = lower(v_target)) = (v_operator = 'EQ') THEN RETURN 'PASS'; ELSE RETURN 'FAIL'; END IF;
  ELSIF v_type IN ('TEXT','ENUM') THEN
    CASE v_operator
      WHEN 'EQ' THEN RETURN CASE WHEN p_observed = v_target THEN 'PASS' ELSE 'FAIL' END;
      WHEN 'NE' THEN RETURN CASE WHEN p_observed <> v_target THEN 'PASS' ELSE 'FAIL' END;
      WHEN 'IN' THEN RETURN CASE WHEN p_criterion->'allowed_values' ? p_observed THEN 'PASS' ELSE 'FAIL' END;
      WHEN 'CONTAINS' THEN
        IF v_type <> 'TEXT' THEN RAISE EXCEPTION 'CONTAINS is only valid for text quality criteria' USING ERRCODE = '23514'; END IF;
        RETURN CASE WHEN position(COALESCE(v_target,'') IN p_observed) > 0 THEN 'PASS' ELSE 'FAIL' END;
      ELSE RAISE EXCEPTION 'unsupported text/enum quality operator' USING ERRCODE = '23514';
    END CASE;
  ELSE
    RAISE EXCEPTION 'unsupported quality criterion value type' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_quality_inspection_plan()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality inspection plans are versioned evidence and cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
      OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
      OR NEW.status <> 'DRAFT' OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'quality inspection plans must start DRAFT under the authenticated actor' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.plan_code, NEW.revision, NEW.name,
      NEW.inspection_type, NEW.default_sample_quantity, NEW.notes, NEW.idempotency_key,
      NEW.request_hash, NEW.created_by_user_id, NEW.correlation_id, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.plan_code, OLD.revision, OLD.name,
      OLD.inspection_type, OLD.default_sample_quantity, OLD.notes, OLD.idempotency_key,
      OLD.request_hash, OLD.created_by_user_id, OLD.correlation_id, OLD.created_at)
    OR NEW.row_version <> OLD.row_version + 1
    OR NEW.updated_at <= OLD.updated_at
    OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'quality inspection plan identity is immutable; create a new revision for changes' USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE' THEN
    IF NEW.activated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
      OR NEW.activated_at IS NULL OR NEW.retired_at IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM quality_inspection_plan_criteria c
        WHERE c.plan_id = NEW.id AND c.tenant_id = NEW.tenant_id AND c.factory_id = NEW.factory_id) THEN
      RAISE EXCEPTION 'a quality plan needs criteria and activation evidence' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED' THEN
    IF NEW.retired_at IS NULL OR NEW.activated_by_user_id IS DISTINCT FROM OLD.activated_by_user_id
      OR NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
      RAISE EXCEPTION 'retiring a quality plan requires terminal retirement evidence' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'quality plan lifecycle only allows DRAFT to ACTIVE and ACTIVE to RETIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_inspection_plan_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON quality_inspection_plans
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_inspection_plan();

CREATE OR REPLACE FUNCTION factoryos_guard_quality_plan_criterion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_status TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'quality inspection plan criteria are immutable; create a new plan revision' USING ERRCODE = '55000';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'quality criterion actor must match authenticated user' USING ERRCODE = '23514';
  END IF;
  SELECT status INTO v_status FROM quality_inspection_plans
  WHERE id = NEW.plan_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id FOR SHARE;
  IF NOT FOUND OR v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'criteria may only be added to a draft quality plan' USING ERRCODE = '23514';
  END IF;
  IF NEW.value_type = 'NUMERIC' AND NEW.comparison_operator NOT IN ('EQ','NE','GT','GTE','LT','LTE','BETWEEN','IN') THEN
    RAISE EXCEPTION 'unsupported numeric quality criterion operator' USING ERRCODE = '23514';
  END IF;
  IF NEW.value_type = 'NUMERIC' AND NEW.comparison_operator <> 'BETWEEN' AND NEW.comparison_operator <> 'IN'
    AND COALESCE(NEW.target_value, '') = '' THEN
    RAISE EXCEPTION 'numeric quality criterion requires target_value' USING ERRCODE = '23514';
  END IF;
  IF NEW.value_type = 'NUMERIC' AND NEW.comparison_operator = 'IN' AND jsonb_array_length(NEW.allowed_values) = 0 THEN
    RAISE EXCEPTION 'numeric IN quality criterion requires allowed_values' USING ERRCODE = '23514';
  END IF;
  IF NEW.comparison_operator = 'IN' AND jsonb_array_length(NEW.allowed_values) = 0 THEN
    RAISE EXCEPTION 'IN quality criterion requires non-empty allowed_values' USING ERRCODE = '23514';
  END IF;
  IF NEW.value_type = 'NUMERIC' AND NEW.comparison_operator = 'BETWEEN'
    AND (NEW.lower_limit IS NULL OR NEW.upper_limit IS NULL) THEN
    RAISE EXCEPTION 'BETWEEN quality criterion requires lower_limit and upper_limit' USING ERRCODE = '23514';
  END IF;
  IF NEW.value_type = 'TEXT' AND NEW.comparison_operator NOT IN ('EQ','NE','IN','CONTAINS') THEN
    RAISE EXCEPTION 'unsupported text quality criterion operator' USING ERRCODE = '23514';
  END IF;
  IF NEW.value_type = 'BOOLEAN' AND NEW.comparison_operator NOT IN ('EQ','NE') THEN
    RAISE EXCEPTION 'boolean quality criteria support only EQ and NE' USING ERRCODE = '23514';
  END IF;
  IF NEW.value_type IN ('TEXT','BOOLEAN') AND NEW.comparison_operator IN ('EQ','NE','CONTAINS')
    AND COALESCE(NEW.target_value, '') = '' THEN
    RAISE EXCEPTION 'quality criterion requires target_value' USING ERRCODE = '23514';
  END IF;
  IF NEW.value_type = 'ENUM' AND NEW.comparison_operator NOT IN ('EQ','NE','IN') THEN
    RAISE EXCEPTION 'enum criteria support EQ, NE or IN' USING ERRCODE = '23514';
  END IF;
  IF NEW.value_type = 'ENUM' AND NEW.comparison_operator <> 'IN' AND COALESCE(NEW.target_value, '') = '' THEN
    RAISE EXCEPTION 'enum quality criterion requires target_value' USING ERRCODE = '23514';
  END IF;
  IF NEW.value_type = 'BOOLEAN' AND lower(COALESCE(NEW.target_value, '')) NOT IN ('true','false') THEN
    RAISE EXCEPTION 'boolean quality criterion requires a true/false target_value' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_plan_criterion_guard
BEFORE INSERT OR UPDATE OR DELETE ON quality_inspection_plan_criteria
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_plan_criterion();

CREATE OR REPLACE FUNCTION factoryos_bind_quality_inspection_plan()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_plan quality_inspection_plans%ROWTYPE;
  v_criteria JSONB;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.plan_code, NEW.plan_id, NEW.plan_revision, NEW.criteria_snapshot)
      IS DISTINCT FROM ROW(OLD.plan_code, OLD.plan_id, OLD.plan_revision, OLD.criteria_snapshot) THEN
      RAISE EXCEPTION 'inspection plan selection and criteria snapshot are immutable after inspection creation' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.plan_code IS NULL OR length(btrim(NEW.plan_code)) = 0 THEN
    IF NEW.inspection_type IN ('INCOMING','IN_PROCESS','FINAL') THEN
      RAISE EXCEPTION 'incoming, in-process and final inspections require an active versioned inspection plan'
        USING ERRCODE = '23514';
    END IF;
    NEW.plan_id := NULL;
    NEW.plan_revision := NULL;
    NEW.criteria_snapshot := '[]'::jsonb;
    RETURN NEW;
  END IF;

  SELECT * INTO v_plan FROM quality_inspection_plans p
  WHERE p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id
    AND lower(p.plan_code) = lower(NEW.plan_code)
    AND p.inspection_type = NEW.inspection_type AND p.status = 'ACTIVE'
  ORDER BY p.revision DESC LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an ACTIVE inspection plan matching plan_code and inspection_type is required' USING ERRCODE = '23514';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'criterion_code', c.criterion_code, 'name', c.name, 'description', c.description,
    'value_type', c.value_type, 'comparison_operator', c.comparison_operator,
    'target_value', c.target_value, 'lower_limit', c.lower_limit, 'upper_limit', c.upper_limit,
    'allowed_values', c.allowed_values, 'unit', c.unit, 'is_required', c.is_required,
    'is_critical', c.is_critical, 'sequence_number', c.sequence_number
  ) ORDER BY c.sequence_number, c.criterion_code)
  INTO v_criteria
  FROM quality_inspection_plan_criteria c
  WHERE c.plan_id = v_plan.id AND c.tenant_id = NEW.tenant_id AND c.factory_id = NEW.factory_id;
  IF COALESCE(jsonb_array_length(v_criteria), 0) = 0 THEN
    RAISE EXCEPTION 'ACTIVE inspection plan has no criteria' USING ERRCODE = '23514';
  END IF;
  NEW.plan_id := v_plan.id;
  NEW.plan_revision := v_plan.revision;
  NEW.criteria_snapshot := v_criteria;
  IF NEW.sample_quantity IS NULL THEN NEW.sample_quantity := v_plan.default_sample_quantity; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_bind_inspection_plan
BEFORE INSERT OR UPDATE ON quality_inspections
FOR EACH ROW EXECUTE FUNCTION factoryos_bind_quality_inspection_plan();

CREATE OR REPLACE FUNCTION factoryos_guard_quality_inspection_result()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_inspection quality_inspections%ROWTYPE;
  v_criterion JSONB;
  v_expected VARCHAR;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'quality inspection results are immutable evidence' USING ERRCODE = '55000';
  END IF;
  IF NEW.actor_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'quality result actor must match authenticated user' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_inspection FROM quality_inspections qi
  WHERE qi.id = NEW.inspection_id AND qi.tenant_id = NEW.tenant_id AND qi.factory_id = NEW.factory_id
  FOR UPDATE;
  IF NOT FOUND OR v_inspection.status NOT IN ('OPEN','IN_PROGRESS') THEN
    RAISE EXCEPTION 'quality results may only be captured during an open inspection' USING ERRCODE = '23514';
  END IF;
  IF v_inspection.plan_id IS NULL OR NEW.plan_id IS DISTINCT FROM v_inspection.plan_id
    OR NEW.plan_revision IS DISTINCT FROM v_inspection.plan_revision THEN
    RAISE EXCEPTION 'quality result must match the inspection plan revision' USING ERRCODE = '23514';
  END IF;
  SELECT c INTO v_criterion FROM jsonb_array_elements(v_inspection.criteria_snapshot) c
  WHERE c->>'criterion_code' = NEW.criterion_code LIMIT 1;
  IF v_criterion IS NULL OR NEW.criterion_snapshot IS DISTINCT FROM v_criterion THEN
    RAISE EXCEPTION 'quality result criterion is missing from the pinned inspection plan snapshot' USING ERRCODE = '23514';
  END IF;
  IF NEW.outcome = 'NOT_APPLICABLE' THEN
    IF COALESCE((v_criterion->>'is_required')::boolean, TRUE)
      OR length(btrim(COALESCE(NEW.notes, ''))) = 0 THEN
      RAISE EXCEPTION 'NOT_APPLICABLE requires a non-required criterion and a reason' USING ERRCODE = '23514';
    END IF;
  ELSE
    v_expected := factoryos_evaluate_quality_criterion(v_criterion, NEW.observed_value);
    IF NEW.outcome IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'quality result outcome must match the pinned criterion acceptance rule' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_inspection_result_guard
BEFORE INSERT OR UPDATE OR DELETE ON quality_inspection_results
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_inspection_result();

CREATE OR REPLACE FUNCTION factoryos_require_quality_result_completeness()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_criterion JSONB;
  v_result RECORD;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'PASSED' AND NEW.plan_id IS NOT NULL THEN
    FOR v_criterion IN SELECT c FROM jsonb_array_elements(NEW.criteria_snapshot) c
      WHERE COALESCE((c->>'is_required')::boolean, TRUE)
    LOOP
      SELECT DISTINCT ON (r.criterion_code) r.outcome INTO v_result
      FROM quality_inspection_results r
      WHERE r.inspection_id = NEW.id AND r.tenant_id = NEW.tenant_id AND r.factory_id = NEW.factory_id
        AND r.criterion_code = v_criterion->>'criterion_code'
      ORDER BY r.criterion_code, r.attempt DESC, r.created_at DESC;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'all required inspection plan criteria need a result before PASS: %', v_criterion->>'criterion_code'
          USING ERRCODE = '23514';
      END IF;
      IF v_result.outcome <> 'PASS' THEN
        RAISE EXCEPTION 'required inspection plan criterion did not pass: %', v_criterion->>'criterion_code'
          USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_result_completeness
BEFORE UPDATE OF status ON quality_inspections
FOR EACH ROW EXECUTE FUNCTION factoryos_require_quality_result_completeness();

CREATE OR REPLACE FUNCTION factoryos_guard_quality_inspection_result_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM quality_audit_events a
    WHERE a.inspection_id = NEW.inspection_id AND a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id
      AND a.action_type = 'INSPECTION_RESULT_RECORDED' AND a.payload->>'result_id' = NEW.id::text)
    OR NOT EXISTS (SELECT 1 FROM outbox_events o
      WHERE o.tenant_id = NEW.tenant_id AND o.factory_id = NEW.factory_id
        AND o.aggregate_type = 'QUALITY_INSPECTION' AND o.aggregate_id = NEW.inspection_id
        AND o.event_type = 'QUALITY.INSPECTION_RESULT_RECORDED'
        AND o.payload->>'result_id' = NEW.id::text) THEN
    RAISE EXCEPTION 'quality inspection results require transactional audit and outbox evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ctr_quality_inspection_result_evidence
AFTER INSERT ON quality_inspection_results
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_inspection_result_evidence();

ALTER TABLE quality_inspection_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_inspection_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_inspection_plans_tenant_isolation ON quality_inspection_plans
  USING (tenant_id = factoryos_current_tenant_id()) WITH CHECK (tenant_id = factoryos_current_tenant_id());
ALTER TABLE quality_inspection_plan_criteria ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_inspection_plan_criteria FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_inspection_plan_criteria_tenant_isolation ON quality_inspection_plan_criteria
  USING (tenant_id = factoryos_current_tenant_id()) WITH CHECK (tenant_id = factoryos_current_tenant_id());
ALTER TABLE quality_inspection_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_inspection_results FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_inspection_results_tenant_isolation ON quality_inspection_results
  USING (tenant_id = factoryos_current_tenant_id()) WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations(version, checksum)
VALUES ('094_quality_inspection_plans_and_results', NULL)
ON CONFLICT (version) DO NOTHING;

COMMENT ON TABLE quality_inspection_plans IS
  'Versioned inspection plans for incoming, in-process, final, inventory and supplier quality checks.';
COMMENT ON TABLE quality_inspection_plan_criteria IS
  'Immutable acceptance criteria for each draft inspection-plan revision; activating a plan freezes its criteria.';
COMMENT ON TABLE quality_inspection_results IS
  'Append-only observed values and pass/fail outcomes tied to the immutable criteria snapshot selected when inspection started.';

COMMIT;
