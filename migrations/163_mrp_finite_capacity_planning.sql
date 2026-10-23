BEGIN;

-- Finite-capacity planning consumes immutable MRP material snapshots and never commits stock or procurement actions.
INSERT INTO permissions (code, description)
VALUES
  ('mrp.capacity.read', 'Read dated work-centre capacity calendars and finite-capacity scenario snapshots'),
  ('mrp.capacity.write', 'Maintain dated work-centre, line and shift capacity calendars'),
  ('mrp.capacity.plan', 'Calculate non-committing finite-capacity schedules and compare planning scenarios')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('mrp.capacity.read', 'mrp.capacity.write', 'mrp.capacity.plan')
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- A finished-goods product definition represents a style/size identity. MRP and capacity plans
-- retain those labels alongside the effective product revision so style-size demand stays explainable.
ALTER TABLE product_definitions
  ADD COLUMN IF NOT EXISTS style_code VARCHAR(120),
  ADD COLUMN IF NOT EXISTS size_code VARCHAR(80);
ALTER TABLE mrp_plan_requirements
  ADD COLUMN IF NOT EXISTS style_code VARCHAR(120),
  ADD COLUMN IF NOT EXISTS size_code VARCHAR(80);

DO $style_size_constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'product_definitions'::regclass AND conname = 'chk_product_definition_style_code') THEN
    ALTER TABLE product_definitions ADD CONSTRAINT chk_product_definition_style_code
      CHECK (style_code IS NULL OR length(btrim(style_code)) BETWEEN 1 AND 120);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'product_definitions'::regclass AND conname = 'chk_product_definition_size_code') THEN
    ALTER TABLE product_definitions ADD CONSTRAINT chk_product_definition_size_code
      CHECK (size_code IS NULL OR length(btrim(size_code)) BETWEEN 1 AND 80);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'mrp_plan_requirements'::regclass AND conname = 'chk_mrp_requirement_style_code') THEN
    ALTER TABLE mrp_plan_requirements ADD CONSTRAINT chk_mrp_requirement_style_code
      CHECK (style_code IS NULL OR length(btrim(style_code)) BETWEEN 1 AND 120);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'mrp_plan_requirements'::regclass AND conname = 'chk_mrp_requirement_size_code') THEN
    ALTER TABLE mrp_plan_requirements ADD CONSTRAINT chk_mrp_requirement_size_code
      CHECK (size_code IS NULL OR length(btrim(size_code)) BETWEEN 1 AND 80);
  END IF;
END;
$style_size_constraints$;

CREATE OR REPLACE FUNCTION factoryos_guard_product_style_size_identity()
RETURNS TRIGGER LANGUAGE plpgsql AS $style_size_identity$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'style/size labels are retained with the product master and cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.style_code IS NOT NULL AND NEW.style_code IS DISTINCT FROM OLD.style_code THEN
    RAISE EXCEPTION 'style_code is immutable after it is assigned' USING ERRCODE = '55000';
  END IF;
  IF OLD.size_code IS NOT NULL AND NEW.size_code IS DISTINCT FROM OLD.size_code THEN
    RAISE EXCEPTION 'size_code is immutable after it is assigned' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$style_size_identity$;
DROP TRIGGER IF EXISTS trg_product_style_size_identity ON product_definitions;
CREATE TRIGGER trg_product_style_size_identity
BEFORE UPDATE OF style_code, size_code OR DELETE ON product_definitions
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_product_style_size_identity();

CREATE TABLE IF NOT EXISTS mrp_capacity_calendar (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  work_centre_id UUID NOT NULL,
  shift_template_id UUID NOT NULL,
  capacity_date DATE NOT NULL,
  line_code VARCHAR(100) NOT NULL,
  available_minutes SMALLINT NOT NULL,
  parallel_lines SMALLINT NOT NULL DEFAULT 1,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_mrp_capacity_calendar_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_mrp_capacity_calendar_business_slot
    UNIQUE (tenant_id, factory_id, work_centre_id, shift_template_id, capacity_date, line_code),
  CONSTRAINT uq_mrp_capacity_calendar_idempotency
    UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_mrp_capacity_calendar_factory
    FOREIGN KEY (factory_id, tenant_id) REFERENCES factories (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_capacity_calendar_work_centre
    FOREIGN KEY (work_centre_id, tenant_id, factory_id)
    REFERENCES manufacturing_work_centres (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_capacity_calendar_shift
    FOREIGN KEY (shift_template_id, tenant_id, factory_id)
    REFERENCES workforce_shift_templates (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_capacity_calendar_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_capacity_calendar_updater
    FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_mrp_capacity_calendar_line CHECK (length(btrim(line_code)) BETWEEN 1 AND 100),
  CONSTRAINT chk_mrp_capacity_calendar_minutes CHECK (available_minutes BETWEEN 0 AND 1440),
  CONSTRAINT chk_mrp_capacity_calendar_parallel_lines CHECK (parallel_lines BETWEEN 1 AND 100),
  CONSTRAINT chk_mrp_capacity_calendar_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT chk_mrp_capacity_calendar_version CHECK (row_version > 0),
  CONSTRAINT chk_mrp_capacity_calendar_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_mrp_capacity_calendar_planning
  ON mrp_capacity_calendar (tenant_id, factory_id, capacity_date, shift_template_id, work_centre_id, status);

CREATE TABLE IF NOT EXISTS mrp_capacity_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  source_mrp_plan_id UUID NOT NULL,
  plan_version INTEGER NOT NULL,
  scenario_name VARCHAR(120) NOT NULL,
  frozen_horizon_days SMALLINT NOT NULL DEFAULT 0,
  compare_to_capacity_plan_id UUID,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  request_id UUID,
  trace_id UUID,
  correlation_id UUID NOT NULL,
  created_by_user_id UUID NOT NULL,
  scenario_inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  exceptions JSONB NOT NULL DEFAULT '[]'::jsonb,
  frozen_horizon_diff JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_mrp_capacity_plan_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_mrp_capacity_plan_version UNIQUE (source_mrp_plan_id, plan_version),
  CONSTRAINT uq_mrp_capacity_plan_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_mrp_capacity_plan_source
    FOREIGN KEY (source_mrp_plan_id, tenant_id, factory_id)
    REFERENCES mrp_plans (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_capacity_plan_comparison
    FOREIGN KEY (compare_to_capacity_plan_id, tenant_id, factory_id)
    REFERENCES mrp_capacity_plans (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_capacity_plan_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_mrp_capacity_plan_version CHECK (plan_version > 0),
  CONSTRAINT chk_mrp_capacity_plan_scenario CHECK (length(btrim(scenario_name)) BETWEEN 3 AND 120),
  CONSTRAINT chk_mrp_capacity_plan_frozen_horizon CHECK (frozen_horizon_days BETWEEN 0 AND 365),
  CONSTRAINT chk_mrp_capacity_plan_idempotency CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_mrp_capacity_plan_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_mrp_capacity_plan_json CHECK (
    jsonb_typeof(scenario_inputs) = 'object'
    AND jsonb_typeof(summary) = 'object'
    AND jsonb_typeof(exceptions) = 'array'
    AND jsonb_typeof(frozen_horizon_diff) = 'array'
  ),
  CONSTRAINT chk_mrp_capacity_plan_no_self_comparison CHECK (compare_to_capacity_plan_id IS NULL OR compare_to_capacity_plan_id <> id)
);
CREATE INDEX IF NOT EXISTS idx_mrp_capacity_plan_source_version
  ON mrp_capacity_plans (tenant_id, factory_id, source_mrp_plan_id, plan_version DESC);

CREATE TABLE IF NOT EXISTS mrp_capacity_plan_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  capacity_plan_id UUID NOT NULL,
  order_id UUID NOT NULL,
  order_line_id UUID NOT NULL,
  product_id UUID NOT NULL,
  product_version_id UUID NOT NULL,
  routing_step_id UUID,
  step_number INTEGER NOT NULL,
  order_number VARCHAR(100) NOT NULL,
  order_line_number INTEGER NOT NULL,
  product_code VARCHAR(120) NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  style_code VARCHAR(120),
  size_code VARCHAR(80),
  product_version_number INTEGER NOT NULL,
  need_by_date DATE NOT NULL,
  planned_quantity NUMERIC(18,4) NOT NULL,
  operation_code VARCHAR(100) NOT NULL,
  operation_name VARCHAR(255) NOT NULL,
  work_centre_id UUID,
  work_centre_code VARCHAR(100),
  required_skill VARCHAR(120),
  setup_minutes NUMERIC(12,4) NOT NULL DEFAULT 0,
  run_minutes_per_unit NUMERIC(12,4) NOT NULL DEFAULT 0,
  capacity_units_per_hour NUMERIC(18,4),
  required_minutes NUMERIC(18,4) NOT NULL DEFAULT 0,
  scheduled_minutes NUMERIC(18,4) NOT NULL DEFAULT 0,
  planned_start_date DATE,
  planned_finish_date DATE,
  status VARCHAR(32) NOT NULL,
  conflict_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_mrp_capacity_operation_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_mrp_capacity_operation_step UNIQUE (capacity_plan_id, order_line_id, step_number),
  CONSTRAINT fk_mrp_capacity_operation_plan
    FOREIGN KEY (capacity_plan_id, tenant_id, factory_id)
    REFERENCES mrp_capacity_plans (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_capacity_operation_order_line
    FOREIGN KEY (order_line_id, order_id, tenant_id, factory_id)
    REFERENCES order_lines (id, order_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_capacity_operation_product
    FOREIGN KEY (product_id, tenant_id, factory_id)
    REFERENCES product_definitions (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_capacity_operation_version
    FOREIGN KEY (product_version_id, tenant_id, factory_id, product_id)
    REFERENCES product_versions (id, tenant_id, factory_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_capacity_operation_route
    FOREIGN KEY (routing_step_id, product_version_id, tenant_id, factory_id)
    REFERENCES product_routing_steps (id, product_version_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_capacity_operation_work_centre
    FOREIGN KEY (work_centre_id, tenant_id, factory_id)
    REFERENCES manufacturing_work_centres (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_mrp_capacity_operation_step CHECK (step_number >= 0 AND order_line_number > 0 AND product_version_number > 0),
  CONSTRAINT chk_mrp_capacity_operation_quantity CHECK (planned_quantity > 0),
  CONSTRAINT chk_mrp_capacity_operation_minutes CHECK (
    setup_minutes >= 0 AND run_minutes_per_unit >= 0
    AND required_minutes >= 0 AND scheduled_minutes >= 0 AND scheduled_minutes <= required_minutes
  ),
  CONSTRAINT chk_mrp_capacity_operation_dates CHECK (
    (planned_start_date IS NULL AND planned_finish_date IS NULL)
    OR (planned_start_date IS NOT NULL AND planned_finish_date IS NOT NULL AND planned_finish_date >= planned_start_date)
  ),
  CONSTRAINT chk_mrp_capacity_operation_status CHECK (
    status IN ('SCHEDULED', 'CAPACITY_CONFLICT', 'BLOCKED_MATERIAL', 'BLOCKED_ROUTING',
      'BLOCKED_PREDECESSOR', 'FROZEN_HORIZON_CONFLICT')
  ),
  CONSTRAINT chk_mrp_capacity_operation_conflicts CHECK (jsonb_typeof(conflict_codes) = 'array'),
  CONSTRAINT chk_mrp_capacity_operation_skill CHECK (required_skill IS NULL OR length(btrim(required_skill)) > 0),
  CONSTRAINT chk_mrp_capacity_operation_style CHECK (style_code IS NULL OR length(btrim(style_code)) BETWEEN 1 AND 120),
  CONSTRAINT chk_mrp_capacity_operation_size CHECK (size_code IS NULL OR length(btrim(size_code)) BETWEEN 1 AND 80)
);
CREATE INDEX IF NOT EXISTS idx_mrp_capacity_operations_order
  ON mrp_capacity_plan_operations (tenant_id, factory_id, capacity_plan_id, need_by_date, order_number, order_line_number, step_number);
CREATE INDEX IF NOT EXISTS idx_mrp_capacity_operations_resource
  ON mrp_capacity_plan_operations (tenant_id, factory_id, work_centre_id, planned_start_date, status);

CREATE TABLE IF NOT EXISTS mrp_capacity_plan_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  capacity_plan_id UUID NOT NULL,
  operation_id UUID NOT NULL,
  calendar_entry_id UUID NOT NULL,
  capacity_date DATE NOT NULL,
  shift_template_id UUID NOT NULL,
  shift_code VARCHAR(80) NOT NULL,
  work_centre_id UUID NOT NULL,
  line_code VARCHAR(100) NOT NULL,
  allocated_minutes NUMERIC(12,4) NOT NULL,
  required_skill VARCHAR(120),
  worker_allocations JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT fk_mrp_capacity_allocation_plan
    FOREIGN KEY (capacity_plan_id, tenant_id, factory_id)
    REFERENCES mrp_capacity_plans (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_capacity_allocation_operation
    FOREIGN KEY (operation_id, tenant_id, factory_id)
    REFERENCES mrp_capacity_plan_operations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_capacity_allocation_calendar
    FOREIGN KEY (calendar_entry_id, tenant_id, factory_id)
    REFERENCES mrp_capacity_calendar (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_capacity_allocation_shift
    FOREIGN KEY (shift_template_id, tenant_id, factory_id)
    REFERENCES workforce_shift_templates (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mrp_capacity_allocation_work_centre
    FOREIGN KEY (work_centre_id, tenant_id, factory_id)
    REFERENCES manufacturing_work_centres (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_mrp_capacity_allocation_minutes CHECK (allocated_minutes > 0),
  CONSTRAINT chk_mrp_capacity_allocation_line CHECK (length(btrim(line_code)) BETWEEN 1 AND 100),
  CONSTRAINT chk_mrp_capacity_allocation_workers CHECK (jsonb_typeof(worker_allocations) = 'array')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mrp_capacity_allocation_operation_slot
  ON mrp_capacity_plan_allocations (operation_id, calendar_entry_id);

CREATE OR REPLACE FUNCTION factoryos_guard_mrp_capacity_calendar()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'capacity calendar history cannot be deleted; deactivate the slot instead' USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.row_version <> 1
       OR NEW.updated_at < NEW.created_at
       OR NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'capacity calendar entries must start at version one under the authenticated actor' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.work_centre_id, NEW.shift_template_id,
         NEW.capacity_date, NEW.line_code, NEW.idempotency_key, NEW.request_hash,
         NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.work_centre_id, OLD.shift_template_id,
         OLD.capacity_date, OLD.line_code, OLD.idempotency_key, OLD.request_hash,
         OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'capacity calendar identity and creation provenance are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at <= OLD.updated_at
     OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'capacity calendar updates must increment version under the authenticated actor' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_mrp_capacity_calendar_guard ON mrp_capacity_calendar;
CREATE TRIGGER trg_mrp_capacity_calendar_guard
BEFORE INSERT OR UPDATE OR DELETE ON mrp_capacity_calendar
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_mrp_capacity_calendar();

CREATE OR REPLACE FUNCTION factoryos_guard_mrp_capacity_calendar_overlap()
RETURNS TRIGGER LANGUAGE plpgsql AS $capacity_overlap$
DECLARE
  v_timezone TEXT;
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  v_overlap BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' OR NEW.status <> 'ACTIVE' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- Serialize even direct SQL writes. The API takes the same factory calendar
  -- advisory lock before BEGIN, so cross-date overnight shifts cannot race.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('mrp-capacity-calendar:' || NEW.tenant_id::text || ':' || NEW.factory_id::text, 0)
  );

  SELECT timezone_name,
    ((NEW.capacity_date + starts_at_local) AT TIME ZONE timezone_name),
    ((NEW.capacity_date + ends_at_local
       + CASE WHEN ends_at_local <= starts_at_local THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END)
       AT TIME ZONE timezone_name)
  INTO v_timezone, v_start, v_end
  FROM workforce_shift_templates
  WHERE id = NEW.shift_template_id
    AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND status = 'ACTIVE';

  IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start THEN
    RAISE EXCEPTION 'capacity calendar entry requires an active shift with a valid interval'
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM mrp_capacity_calendar other
    JOIN workforce_shift_templates other_shift
      ON other_shift.id = other.shift_template_id
     AND other_shift.tenant_id = other.tenant_id
     AND other_shift.factory_id = other.factory_id
    CROSS JOIN LATERAL (
      SELECT
        ((other.capacity_date + other_shift.starts_at_local) AT TIME ZONE other_shift.timezone_name) AS starts_at,
        ((other.capacity_date + other_shift.ends_at_local
          + CASE WHEN other_shift.ends_at_local <= other_shift.starts_at_local
              THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END)
          AT TIME ZONE other_shift.timezone_name) AS ends_at
    ) other_window
    WHERE other.tenant_id = NEW.tenant_id
      AND other.factory_id = NEW.factory_id
      AND other.work_centre_id = NEW.work_centre_id
      AND lower(btrim(other.line_code)) = lower(btrim(NEW.line_code))
      AND other.status = 'ACTIVE'
      AND other.id IS DISTINCT FROM NEW.id
      AND other.capacity_date BETWEEN NEW.capacity_date - 1 AND NEW.capacity_date + 1
      AND tstzrange(other_window.starts_at, other_window.ends_at, '[)')
          && tstzrange(v_start, v_end, '[)')
  ) INTO v_overlap;

  IF v_overlap THEN
    RAISE EXCEPTION 'active capacity calendar slots for the same work-centre line cannot overlap across shifts'
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$capacity_overlap$;
DROP TRIGGER IF EXISTS trg_mrp_capacity_calendar_overlap ON mrp_capacity_calendar;
CREATE TRIGGER trg_mrp_capacity_calendar_overlap
BEFORE INSERT OR UPDATE OF work_centre_id, shift_template_id, capacity_date, line_code, status
ON mrp_capacity_calendar
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_mrp_capacity_calendar_overlap();

CREATE OR REPLACE FUNCTION factoryos_prevent_mrp_capacity_snapshot_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'finite-capacity planning snapshots are immutable; create a new scenario run' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS mrp_capacity_plans_immutable ON mrp_capacity_plans;
CREATE TRIGGER mrp_capacity_plans_immutable
BEFORE UPDATE OR DELETE ON mrp_capacity_plans
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_mrp_capacity_snapshot_mutation();
DROP TRIGGER IF EXISTS mrp_capacity_plan_operations_immutable ON mrp_capacity_plan_operations;
CREATE TRIGGER mrp_capacity_plan_operations_immutable
BEFORE UPDATE OR DELETE ON mrp_capacity_plan_operations
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_mrp_capacity_snapshot_mutation();
DROP TRIGGER IF EXISTS mrp_capacity_plan_allocations_immutable ON mrp_capacity_plan_allocations;
CREATE TRIGGER mrp_capacity_plan_allocations_immutable
BEFORE UPDATE OR DELETE ON mrp_capacity_plan_allocations
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_mrp_capacity_snapshot_mutation();

ALTER TABLE mrp_capacity_calendar ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrp_capacity_calendar FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mrp_capacity_calendar_tenant_isolation ON mrp_capacity_calendar;
CREATE POLICY mrp_capacity_calendar_tenant_isolation ON mrp_capacity_calendar
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE mrp_capacity_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrp_capacity_plans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mrp_capacity_plans_tenant_isolation ON mrp_capacity_plans;
CREATE POLICY mrp_capacity_plans_tenant_isolation ON mrp_capacity_plans
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE mrp_capacity_plan_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrp_capacity_plan_operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mrp_capacity_plan_operations_tenant_isolation ON mrp_capacity_plan_operations;
CREATE POLICY mrp_capacity_plan_operations_tenant_isolation ON mrp_capacity_plan_operations
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE mrp_capacity_plan_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrp_capacity_plan_allocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mrp_capacity_plan_allocations_tenant_isolation ON mrp_capacity_plan_allocations;
CREATE POLICY mrp_capacity_plan_allocations_tenant_isolation ON mrp_capacity_plan_allocations
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMENT ON TABLE mrp_capacity_calendar IS
  'Dated capacity by factory work centre, named line, and workforce shift; inactive slots remain retained.';
COMMENT ON TABLE mrp_capacity_plans IS
  'Immutable finite-capacity planning scenarios tied to one immutable MRP material snapshot; never posts reservations or purchase orders.';
COMMENT ON TABLE mrp_capacity_plan_operations IS
  'Routing step schedule snapshot per MRP order line, including finite-capacity/material/frozen-horizon conflicts.';
COMMENT ON TABLE mrp_capacity_plan_allocations IS
  'Immutable advisory minutes allocated to each dated line/shift capacity slot and qualified skill pool.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('163_mrp_finite_capacity_planning', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
