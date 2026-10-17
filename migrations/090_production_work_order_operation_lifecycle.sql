BEGIN;

INSERT INTO permissions (code, description)
VALUES
  ('production.workorders.read', 'Read production work orders, routing operations and shop-floor event history in the authorized factory'),
  ('production.workorders.write', 'Create idempotent production work orders from authorized sales-order lines'),
  ('production.workorders.release', 'Release or cancel production work orders in the authorized factory'),
  ('production.operations.operate', 'Start, pause, hold, resume, complete and report WIP, downtime or rework for production operations'),
  ('production.output.report', 'Report work-order good output and scrap with immutable order-level production evidence')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'production.workorders.read',
  'production.workorders.write',
  'production.workorders.release',
  'production.operations.operate',
  'production.output.report'
)
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE work_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  work_order_number VARCHAR(100) NOT NULL,
  source_order_id UUID NOT NULL,
  source_order_line_id UUID NOT NULL,
  product_id UUID NOT NULL,
  product_version_id UUID NOT NULL,
  finished_item_id UUID NOT NULL,
  target_quantity NUMERIC(18,4) NOT NULL,
  planned_start_date DATE NOT NULL,
  due_date DATE NOT NULL,
  priority SMALLINT NOT NULL DEFAULT 3,
  status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  notes TEXT,
  hold_reason TEXT,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  released_by_user_id UUID,
  released_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_by_user_id UUID,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_work_order_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_work_order_line_scope UNIQUE (id, source_order_line_id, tenant_id, factory_id),
  CONSTRAINT uq_work_order_number UNIQUE (tenant_id, factory_id, work_order_number),
  CONSTRAINT uq_work_order_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_work_order_factory_scope
    FOREIGN KEY (factory_id, tenant_id) REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_source_order
    FOREIGN KEY (source_order_id, tenant_id, factory_id) REFERENCES orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_source_line
    FOREIGN KEY (source_order_line_id, source_order_id, tenant_id, factory_id)
    REFERENCES order_lines(id, order_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_product_scope
    FOREIGN KEY (product_id, tenant_id, factory_id) REFERENCES product_definitions(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_product_version
    FOREIGN KEY (product_version_id, tenant_id, factory_id, product_id)
    REFERENCES product_versions(id, tenant_id, factory_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_finished_item
    FOREIGN KEY (finished_item_id, tenant_id, factory_id) REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_releaser FOREIGN KEY (released_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_canceller FOREIGN KEY (cancelled_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_work_order_quantity CHECK (target_quantity > 0),
  CONSTRAINT chk_work_order_priority CHECK (priority BETWEEN 1 AND 5),
  CONSTRAINT chk_work_order_status CHECK (status IN ('DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED')),
  CONSTRAINT chk_work_order_version CHECK (row_version > 0),
  CONSTRAINT chk_work_order_idempotency_key CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_work_order_request_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_work_order_release_evidence CHECK (
    (status = 'DRAFT' AND released_by_user_id IS NULL AND released_at IS NULL)
    OR (status IN ('RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED')
      AND released_by_user_id IS NOT NULL AND released_at IS NOT NULL)
    OR (status = 'CANCELLED' AND (
      (released_by_user_id IS NULL AND released_at IS NULL)
      OR (released_by_user_id IS NOT NULL AND released_at IS NOT NULL)
    ))
  ),
  CONSTRAINT chk_work_order_completion_evidence CHECK (
    (status = 'COMPLETED' AND completed_at IS NOT NULL) OR (status <> 'COMPLETED' AND completed_at IS NULL)
  ),
  CONSTRAINT chk_work_order_cancellation_evidence CHECK (
    (status = 'CANCELLED' AND cancelled_by_user_id IS NOT NULL AND cancelled_at IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_by_user_id IS NULL AND cancelled_at IS NULL)
  )
);

CREATE INDEX idx_work_orders_factory_status_due
  ON work_orders (tenant_id, factory_id, status, due_date, priority, created_at DESC);
CREATE INDEX idx_work_orders_source_line
  ON work_orders (tenant_id, factory_id, source_order_id, source_order_line_id, status);
CREATE INDEX idx_work_orders_product_revision
  ON work_orders (tenant_id, factory_id, product_id, product_version_id, planned_start_date);

CREATE TABLE work_order_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  work_order_id UUID NOT NULL,
  product_id UUID NOT NULL,
  product_version_id UUID NOT NULL,
  product_routing_step_id UUID NOT NULL,
  step_number INTEGER NOT NULL,
  operation_code VARCHAR(100) NOT NULL,
  operation_name VARCHAR(255) NOT NULL,
  work_centre_id UUID NOT NULL,
  setup_minutes NUMERIC(12,4) NOT NULL DEFAULT 0,
  run_minutes_per_unit NUMERIC(12,4) NOT NULL DEFAULT 0,
  queue_minutes NUMERIC(12,4) NOT NULL DEFAULT 0,
  transfer_minutes NUMERIC(12,4) NOT NULL DEFAULT 0,
  required_skill VARCHAR(120),
  instructions TEXT,
  is_quality_gate BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(20) NOT NULL DEFAULT 'PLANNED',
  started_at TIMESTAMPTZ,
  active_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  downtime_started_at TIMESTAMPTZ,
  actual_run_minutes NUMERIC(12,4) NOT NULL DEFAULT 0,
  downtime_minutes NUMERIC(12,4) NOT NULL DEFAULT 0,
  wip_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_work_order_operation_scope UNIQUE (id, work_order_id, tenant_id, factory_id),
  CONSTRAINT uq_work_order_operation_number UNIQUE (work_order_id, step_number),
  CONSTRAINT fk_work_order_operation_work_order
    FOREIGN KEY (work_order_id, tenant_id, factory_id) REFERENCES work_orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_operation_routing_snapshot
    FOREIGN KEY (product_routing_step_id, product_version_id, tenant_id, factory_id)
    REFERENCES product_routing_steps(id, product_version_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_operation_version
    FOREIGN KEY (product_version_id, tenant_id, factory_id, product_id)
    REFERENCES product_versions(id, tenant_id, factory_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_operation_work_centre
    FOREIGN KEY (work_centre_id, tenant_id, factory_id)
    REFERENCES manufacturing_work_centres(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_work_order_operation_step CHECK (step_number > 0),
  CONSTRAINT chk_work_order_operation_code CHECK (length(btrim(operation_code)) > 0),
  CONSTRAINT chk_work_order_operation_name CHECK (length(btrim(operation_name)) > 0),
  CONSTRAINT chk_work_order_operation_duration CHECK (
    setup_minutes >= 0 AND run_minutes_per_unit >= 0 AND queue_minutes >= 0 AND transfer_minutes >= 0
  ),
  CONSTRAINT chk_work_order_operation_status CHECK (status IN ('PLANNED', 'READY', 'IN_PROGRESS', 'PAUSED', 'ON_HOLD', 'COMPLETED', 'SKIPPED')),
  CONSTRAINT chk_work_order_operation_version CHECK (row_version > 0),
  CONSTRAINT chk_work_order_operation_actuals CHECK (actual_run_minutes >= 0 AND downtime_minutes >= 0),
  CONSTRAINT chk_work_order_operation_wip_quantity CHECK (wip_quantity >= 0),
  CONSTRAINT chk_work_order_operation_active_timer CHECK (
    (status = 'IN_PROGRESS' AND completed_at IS NULL AND (
      (active_started_at IS NOT NULL AND downtime_started_at IS NULL)
      OR (active_started_at IS NULL AND downtime_started_at IS NOT NULL)
    ))
    OR (status <> 'IN_PROGRESS' AND active_started_at IS NULL AND downtime_started_at IS NULL)
  ),
  CONSTRAINT chk_work_order_operation_completion CHECK (
    (status = 'COMPLETED' AND completed_at IS NOT NULL)
    OR (status <> 'COMPLETED' AND completed_at IS NULL)
  ),
  CONSTRAINT chk_work_order_operation_downtime CHECK (downtime_started_at IS NULL OR status = 'IN_PROGRESS')
);

CREATE INDEX idx_work_order_operations_sequence
  ON work_order_operations (tenant_id, factory_id, work_order_id, step_number);
CREATE INDEX idx_work_order_operations_centre_status
  ON work_order_operations (tenant_id, factory_id, work_centre_id, status, step_number);

CREATE UNIQUE INDEX uq_work_order_single_in_progress_operation
  ON work_order_operations (tenant_id, factory_id, work_order_id)
  WHERE status = 'IN_PROGRESS';

CREATE TABLE work_order_material_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  work_order_id UUID NOT NULL,
  product_id UUID NOT NULL,
  product_version_id UUID NOT NULL,
  bom_line_id UUID NOT NULL,
  component_item_id UUID NOT NULL,
  line_number INTEGER NOT NULL,
  component_sku VARCHAR(100) NOT NULL,
  component_name VARCHAR(255) NOT NULL,
  component_unit VARCHAR(50) NOT NULL,
  base_quantity_per NUMERIC(18,4) NOT NULL,
  expected_yield_percent NUMERIC(7,4) NOT NULL,
  wastage_percent NUMERIC(7,4) NOT NULL,
  required_quantity NUMERIC(18,4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_work_order_material_requirement_scope
    UNIQUE (id, work_order_id, tenant_id, factory_id),
  CONSTRAINT uq_work_order_material_requirement_bom
    UNIQUE (work_order_id, bom_line_id),
  CONSTRAINT fk_work_order_material_requirement_work_order
    FOREIGN KEY (work_order_id, tenant_id, factory_id)
    REFERENCES work_orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_material_requirement_product_version
    FOREIGN KEY (product_version_id, tenant_id, factory_id, product_id)
    REFERENCES product_versions(id, tenant_id, factory_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_material_requirement_bom_line
    FOREIGN KEY (bom_line_id, product_version_id, tenant_id, factory_id)
    REFERENCES product_bom_lines(id, product_version_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_material_requirement_component
    FOREIGN KEY (component_item_id, tenant_id, factory_id)
    REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_work_order_material_line CHECK (line_number > 0),
  CONSTRAINT chk_work_order_material_sku CHECK (length(btrim(component_sku)) > 0),
  CONSTRAINT chk_work_order_material_name CHECK (length(btrim(component_name)) > 0),
  CONSTRAINT chk_work_order_material_unit CHECK (length(btrim(component_unit)) > 0),
  CONSTRAINT chk_work_order_material_base_quantity CHECK (base_quantity_per > 0),
  CONSTRAINT chk_work_order_material_yield CHECK (expected_yield_percent > 0 AND expected_yield_percent <= 100),
  CONSTRAINT chk_work_order_material_wastage CHECK (wastage_percent >= 0 AND wastage_percent <= 100),
  CONSTRAINT chk_work_order_material_required_quantity CHECK (required_quantity > 0)
);

CREATE INDEX idx_work_order_material_requirement_item
  ON work_order_material_requirements (tenant_id, factory_id, component_item_id, work_order_id, line_number);

CREATE TABLE work_order_material_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  work_order_id UUID NOT NULL,
  requirement_id UUID NOT NULL,
  reservation_id UUID NOT NULL,
  item_id UUID NOT NULL,
  quantity NUMERIC(18,4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_work_order_material_reservation_scope
    UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_work_order_material_reservation_inventory
    UNIQUE (reservation_id),
  CONSTRAINT fk_work_order_material_reservation_work_order
    FOREIGN KEY (work_order_id, tenant_id, factory_id)
    REFERENCES work_orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_material_reservation_requirement
    FOREIGN KEY (requirement_id, work_order_id, tenant_id, factory_id)
    REFERENCES work_order_material_requirements(id, work_order_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_material_reservation_inventory
    FOREIGN KEY (reservation_id, tenant_id, factory_id)
    REFERENCES inventory_reservations(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_material_reservation_item
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_work_order_material_reservation_quantity CHECK (quantity > 0)
);

CREATE INDEX idx_work_order_material_reservations_work_order
  ON work_order_material_reservations (tenant_id, factory_id, work_order_id, requirement_id);

CREATE TABLE work_order_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  work_order_id UUID NOT NULL,
  operation_id UUID,
  event_type VARCHAR(40) NOT NULL,
  from_status VARCHAR(24),
  to_status VARCHAR(24),
  event_source VARCHAR(32) NOT NULL DEFAULT 'API',
  device_id VARCHAR(255),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  actor_user_id UUID NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT uq_work_order_event_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_work_order_event_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_work_order_event_work_order
    FOREIGN KEY (work_order_id, tenant_id, factory_id) REFERENCES work_orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_event_operation
    FOREIGN KEY (operation_id, work_order_id, tenant_id, factory_id)
    REFERENCES work_order_operations(id, work_order_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_work_order_event_type CHECK (event_type IN (
    'WORK_ORDER_CREATED', 'WORK_ORDER_RELEASED', 'WORK_ORDER_HELD', 'WORK_ORDER_RESUMED',
    'WORK_ORDER_CANCELLED', 'WORK_ORDER_COMPLETED', 'WORK_ORDER_STARTED',
    'OPERATION_READY', 'OPERATION_STARTED', 'OPERATION_PAUSED',
    'OPERATION_HELD', 'OPERATION_RESUMED', 'OPERATION_COMPLETED', 'OPERATION_SKIPPED',
    'DOWNTIME_STARTED', 'DOWNTIME_ENDED', 'WIP_REPORTED', 'WIP_TRANSFERRED', 'REWORK_REPORTED', 'OUTPUT_REPORTED'
  )),
  CONSTRAINT chk_work_order_event_source CHECK (event_source IN ('API', 'HMI', 'MES', 'PLC', 'MOBILE', 'IMPORT')),
  CONSTRAINT chk_work_order_event_key CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_work_order_event_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_work_order_event_payload CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT chk_work_order_event_device CHECK (device_id IS NULL OR length(btrim(device_id)) > 0)
);

CREATE INDEX idx_work_order_events_history
  ON work_order_events (tenant_id, factory_id, work_order_id, recorded_at, id);
CREATE INDEX idx_work_order_events_operation_history
  ON work_order_events (tenant_id, factory_id, operation_id, recorded_at, id)
  WHERE operation_id IS NOT NULL;

-- Optional links preserve legacy order-production reports while making shop-floor output
-- traceable to the exact work order and final operation that submitted it.
ALTER TABLE order_production_reports
  ADD COLUMN work_order_id UUID,
  ADD COLUMN work_order_operation_id UUID;

ALTER TABLE order_production_reports
  ADD CONSTRAINT fk_order_production_report_work_order
    FOREIGN KEY (work_order_id, tenant_id, factory_id)
    REFERENCES work_orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_order_production_report_work_order_operation
    FOREIGN KEY (work_order_operation_id, work_order_id, tenant_id, factory_id)
    REFERENCES work_order_operations(id, work_order_id, tenant_id, factory_id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_order_production_report_work_order_pair
    CHECK ((work_order_id IS NULL AND work_order_operation_id IS NULL)
      OR (work_order_id IS NOT NULL AND work_order_operation_id IS NOT NULL));

CREATE INDEX idx_order_production_reports_work_order
  ON order_production_reports (tenant_id, factory_id, work_order_id, created_at, id)
  WHERE work_order_id IS NOT NULL;

CREATE OR REPLACE FUNCTION factoryos_guard_work_order_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'work orders are retained; use the cancellation lifecycle'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.row_version <> 1
      OR NEW.released_by_user_id IS NOT NULL OR NEW.released_at IS NOT NULL
      OR NEW.completed_at IS NOT NULL OR NEW.cancelled_by_user_id IS NOT NULL
      OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'work orders must be created as draft version one without lifecycle evidence'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.work_order_number,
         NEW.source_order_id, NEW.source_order_line_id, NEW.product_id, NEW.product_version_id,
         NEW.finished_item_id, NEW.target_quantity, NEW.planned_start_date, NEW.due_date, NEW.priority,
         NEW.idempotency_key, NEW.request_hash, NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.work_order_number,
         OLD.source_order_id, OLD.source_order_line_id, OLD.product_id, OLD.product_version_id,
         OLD.finished_item_id, OLD.target_quantity, OLD.planned_start_date, OLD.due_date, OLD.priority,
         OLD.idempotency_key, OLD.request_hash, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'released-work-order planning identity and target are immutable; create a replacement draft instead'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'work-order updates must increment row_version and updated_at'
      USING ERRCODE = '23514';
  END IF;

  IF (OLD.released_at IS NOT NULL AND
      ROW(NEW.released_by_user_id, NEW.released_at) IS DISTINCT FROM ROW(OLD.released_by_user_id, OLD.released_at))
    OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
    OR (OLD.cancelled_at IS NOT NULL AND
      ROW(NEW.cancelled_by_user_id, NEW.cancelled_at) IS DISTINCT FROM ROW(OLD.cancelled_by_user_id, OLD.cancelled_at)) THEN
    RAISE EXCEPTION 'work-order release, completion and cancellation evidence is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'DRAFT' AND NEW.status IN ('RELEASED', 'CANCELLED'))
    OR (OLD.status = 'RELEASED' AND NEW.status IN ('IN_PROGRESS', 'ON_HOLD', 'CANCELLED'))
    OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('ON_HOLD', 'COMPLETED', 'CANCELLED'))
    OR (OLD.status = 'ON_HOLD' AND NEW.status IN ('IN_PROGRESS', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'invalid work-order lifecycle transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'RELEASED' AND (NEW.released_by_user_id IS NULL OR NEW.released_at IS NULL) THEN
    RAISE EXCEPTION 'releasing a work order requires actor and timestamp evidence'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'COMPLETED' AND NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'completing a work order requires completion timestamp'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'COMPLETED' AND EXISTS (
    SELECT 1 FROM work_order_operations op
    WHERE op.work_order_id = NEW.id AND op.tenant_id = NEW.tenant_id AND op.factory_id = NEW.factory_id
      AND (
        (op.status <> 'COMPLETED' AND op.status <> 'SKIPPED')
        OR op.wip_quantity > 0
        OR (op.is_quality_gate AND op.status = 'SKIPPED')
      )
  ) THEN
    RAISE EXCEPTION 'a work order cannot complete with unfinished operations or non-zero operation WIP'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'CANCELLED' AND (NEW.cancelled_by_user_id IS NULL OR NEW.cancelled_at IS NULL) THEN
    RAISE EXCEPTION 'cancelling a work order requires actor and timestamp evidence'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_work_order_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON work_orders
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_work_order_lifecycle();

CREATE OR REPLACE FUNCTION factoryos_guard_work_order_operation_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_work_order_product_id UUID;
  v_work_order_product_version_id UUID;
  v_work_order_target_quantity NUMERIC(18,4);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'work-order operations are retained; use an explicit skip event before release or completion'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT product_id, product_version_id
      INTO v_work_order_product_id, v_work_order_product_version_id
    FROM work_orders
    WHERE id = NEW.work_order_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
    IF NOT FOUND OR NEW.product_id <> v_work_order_product_id OR NEW.product_version_id <> v_work_order_product_version_id THEN
      RAISE EXCEPTION 'operation route snapshot must match the parent work-order product revision'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'PLANNED' OR NEW.row_version <> 1 OR NEW.wip_quantity <> 0
      OR NEW.started_at IS NOT NULL OR NEW.active_started_at IS NOT NULL
      OR NEW.completed_at IS NOT NULL OR NEW.downtime_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'routing operations must be copied into a work order as planned version-one snapshots'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.work_order_id, NEW.product_id, NEW.product_version_id, NEW.product_routing_step_id,
         NEW.step_number, NEW.operation_code, NEW.operation_name, NEW.work_centre_id, NEW.setup_minutes,
         NEW.run_minutes_per_unit, NEW.queue_minutes, NEW.transfer_minutes, NEW.required_skill,
         NEW.instructions, NEW.is_quality_gate, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.work_order_id, OLD.product_id, OLD.product_version_id, OLD.product_routing_step_id,
         OLD.step_number, OLD.operation_code, OLD.operation_name, OLD.work_centre_id, OLD.setup_minutes,
         OLD.run_minutes_per_unit, OLD.queue_minutes, OLD.transfer_minutes, OLD.required_skill,
         OLD.instructions, OLD.is_quality_gate, OLD.created_at) THEN
    RAISE EXCEPTION 'work-order operation routing snapshots are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'operation updates must increment row_version and updated_at'
      USING ERRCODE = '23514';
  END IF;

  SELECT target_quantity INTO v_work_order_target_quantity
  FROM work_orders
  WHERE id = NEW.work_order_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;

  IF NOT FOUND OR NEW.wip_quantity > v_work_order_target_quantity THEN
    RAISE EXCEPTION 'reported operation WIP cannot exceed the work-order target quantity'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.is_quality_gate AND NEW.status = 'SKIPPED' THEN
    RAISE EXCEPTION 'quality-gate operations cannot be skipped by any persistence path'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('COMPLETED', 'SKIPPED') AND NEW.wip_quantity > 0 THEN
    RAISE EXCEPTION 'an operation cannot finish or skip while its current WIP snapshot is non-zero'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'PLANNED' AND NEW.status IN ('READY', 'SKIPPED'))
    OR (OLD.status = 'READY' AND NEW.status IN ('IN_PROGRESS', 'ON_HOLD', 'SKIPPED'))
    OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('PAUSED', 'ON_HOLD', 'COMPLETED'))
    OR (OLD.status = 'PAUSED' AND NEW.status IN ('IN_PROGRESS', 'ON_HOLD', 'COMPLETED'))
    OR (OLD.status = 'ON_HOLD' AND NEW.status IN ('READY', 'PAUSED'))
  ) THEN
    RAISE EXCEPTION 'invalid operation lifecycle transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_work_order_operation_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON work_order_operations
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_work_order_operation_lifecycle();

CREATE OR REPLACE FUNCTION factoryos_prevent_work_order_material_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'work-order material requirements and reservation links are immutable production evidence'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_work_order_material_requirements_immutable
BEFORE UPDATE OR DELETE ON work_order_material_requirements
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_work_order_material_snapshot_mutation();

CREATE TRIGGER trg_work_order_material_reservations_immutable
BEFORE UPDATE OR DELETE ON work_order_material_reservations
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_work_order_material_snapshot_mutation();

CREATE OR REPLACE FUNCTION factoryos_block_terminal_order_with_open_work_orders()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
    AND NEW.status IN ('COMPLETED', 'CANCELLED')
    AND EXISTS (
      SELECT 1 FROM work_orders wo
      WHERE wo.source_order_id = NEW.id
        AND wo.tenant_id = NEW.tenant_id
        AND wo.factory_id = NEW.factory_id
        AND wo.status IN ('DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD')
    ) THEN
    RAISE EXCEPTION 'all work orders must be completed or explicitly cancelled before the sales order can become terminal'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_order_terminal_work_order_guard
BEFORE UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION factoryos_block_terminal_order_with_open_work_orders();

CREATE OR REPLACE FUNCTION factoryos_prevent_work_order_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'shop-floor work-order events are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_work_order_events_immutable
BEFORE UPDATE OR DELETE ON work_order_events
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_work_order_event_mutation();

CREATE OR REPLACE FUNCTION factoryos_guard_work_order_event_payload()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_quantity TEXT;
  v_current_wip NUMERIC(18,4);
  v_operation_row_version BIGINT;
  v_source_step INTEGER;
  v_target_step INTEGER;
  v_target_wip NUMERIC(18,4);
  v_target_row_version BIGINT;
  v_target_operation_id UUID;
  v_work_order_target NUMERIC(18,4);
  v_source_before NUMERIC(18,4);
  v_source_after NUMERIC(18,4);
  v_target_before NUMERIC(18,4);
  v_target_after NUMERIC(18,4);
BEGIN
  IF NEW.event_source IN ('HMI', 'MES', 'PLC', 'MOBILE')
    AND (NEW.device_id IS NULL OR length(btrim(NEW.device_id)) = 0) THEN
    RAISE EXCEPTION 'device_id is required for HMI, MES, PLC and mobile shop-floor events'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.occurred_at > clock_timestamp() + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'shop-floor event occurrence time cannot be more than five minutes in the future'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.event_type IN ('WIP_REPORTED', 'WIP_TRANSFERRED', 'REWORK_REPORTED') THEN
    v_quantity := NEW.payload->>'quantity';
    IF v_quantity IS NULL OR v_quantity !~ '^[0-9]+(\.[0-9]{1,4})?$' THEN
      RAISE EXCEPTION 'WIP, transfer and rework events require a four-decimal quantity'
        USING ERRCODE = '23514';
    END IF;
    IF (NEW.event_type = 'WIP_REPORTED' AND v_quantity::numeric < 0)
      OR (NEW.event_type IN ('WIP_TRANSFERRED', 'REWORK_REPORTED') AND v_quantity::numeric <= 0) THEN
      RAISE EXCEPTION 'WIP cannot be negative and transfer/rework quantities must be positive'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.event_type = 'WIP_REPORTED' THEN
    SELECT wip_quantity, row_version INTO v_current_wip, v_operation_row_version
    FROM work_order_operations
    WHERE id = NEW.operation_id AND work_order_id = NEW.work_order_id
      AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'WIP event must reference an operation in its work order and factory'
        USING ERRCODE = '23503';
    END IF;
    IF v_quantity::numeric IS DISTINCT FROM v_current_wip
      OR (NEW.payload->>'wip_quantity')::numeric IS DISTINCT FROM v_current_wip
      OR (NEW.payload->>'operation_row_version')::bigint IS DISTINCT FROM v_operation_row_version THEN
      RAISE EXCEPTION 'WIP event quantity and operation version must match the persisted WIP snapshot'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.event_type = 'WIP_TRANSFERRED' THEN
    SELECT op.wip_quantity, op.row_version, op.step_number
      INTO v_current_wip, v_operation_row_version, v_source_step
    FROM work_order_operations op
    WHERE op.id = NEW.operation_id AND op.work_order_id = NEW.work_order_id
      AND op.tenant_id = NEW.tenant_id AND op.factory_id = NEW.factory_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'WIP transfer source must reference an operation in this work order and factory'
        USING ERRCODE = '23503';
    END IF;

    v_target_operation_id := NULLIF(NEW.payload #>> '{wip_transfer,target_operation_id}', '')::uuid;
    IF v_target_operation_id IS NULL THEN
      RAISE EXCEPTION 'WIP transfer requires a target operation'
        USING ERRCODE = '23514';
    END IF;

    SELECT op.wip_quantity, op.row_version, op.step_number
      INTO v_target_wip, v_target_row_version, v_target_step
    FROM work_order_operations op
    WHERE op.id = v_target_operation_id AND op.work_order_id = NEW.work_order_id
      AND op.tenant_id = NEW.tenant_id AND op.factory_id = NEW.factory_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'WIP transfer target must belong to the same work order and factory'
        USING ERRCODE = '23503';
    END IF;

    SELECT target_quantity INTO v_work_order_target
    FROM work_orders WHERE id = NEW.work_order_id
      AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;

    v_source_before := (NEW.payload #>> '{wip_transfer,source_wip_before}')::numeric;
    v_source_after := (NEW.payload #>> '{wip_transfer,source_wip_after}')::numeric;
    v_target_before := (NEW.payload #>> '{wip_transfer,target_wip_before}')::numeric;
    v_target_after := (NEW.payload #>> '{wip_transfer,target_wip_after}')::numeric;

    IF v_source_after IS DISTINCT FROM v_current_wip
      OR v_target_after IS DISTINCT FROM v_target_wip
      OR (NEW.payload #>> '{wip_transfer,source_operation_row_version}')::bigint IS DISTINCT FROM v_operation_row_version
      OR (NEW.payload #>> '{wip_transfer,target_operation_row_version}')::bigint IS DISTINCT FROM v_target_row_version
      OR v_source_before - v_quantity::numeric IS DISTINCT FROM v_source_after
      OR v_target_before + v_quantity::numeric IS DISTINCT FROM v_target_after
      OR v_source_after < 0 OR v_target_after > v_work_order_target THEN
      RAISE EXCEPTION 'WIP transfer must conserve quantity and match both persisted operation snapshots'
        USING ERRCODE = '23514';
    END IF;

    IF v_target_step <> (
      SELECT min(op.step_number)
      FROM work_order_operations op
      WHERE op.work_order_id = NEW.work_order_id AND op.tenant_id = NEW.tenant_id
        AND op.factory_id = NEW.factory_id AND op.step_number > v_source_step
    ) THEN
      RAISE EXCEPTION 'WIP may only transfer to the immediate next routing operation'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.event_type IN (
    'WORK_ORDER_HELD', 'WORK_ORDER_CANCELLED', 'OPERATION_HELD',
    'OPERATION_SKIPPED', 'DOWNTIME_STARTED', 'REWORK_REPORTED'
  ) AND length(btrim(COALESCE(NEW.payload->>'reason', ''))) = 0 THEN
    RAISE EXCEPTION 'hold, cancel, skip, downtime-start and rework events require a reason'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_work_order_event_payload_guard
BEFORE INSERT ON work_order_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_work_order_event_payload();

CREATE OR REPLACE FUNCTION factoryos_require_wip_snapshot_event_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.wip_quantity IS DISTINCT FROM OLD.wip_quantity AND NOT EXISTS (
    SELECT 1 FROM work_order_events e
    WHERE e.work_order_id = NEW.work_order_id AND e.operation_id = NEW.id
      AND e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
      AND e.event_type = 'WIP_REPORTED'
      AND (e.payload->>'quantity')::numeric = NEW.wip_quantity
      AND (e.payload->>'wip_quantity')::numeric = NEW.wip_quantity
      AND (e.payload->>'operation_row_version')::bigint = NEW.row_version
  ) THEN
    RAISE EXCEPTION 'changing current operation WIP requires a matching immutable WIP_REPORTED event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_work_order_wip_snapshot_event_evidence
AFTER UPDATE OF wip_quantity ON work_order_operations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_require_wip_snapshot_event_evidence();

CREATE OR REPLACE FUNCTION factoryos_guard_work_order_production_output()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_order_id UUID;
  v_source_order_line_id UUID;
  v_target_quantity NUMERIC(18,4);
  v_work_order_status VARCHAR(24);
  v_operation_step INTEGER;
  v_last_step INTEGER;
  v_operation_status VARCHAR(20);
  v_active_started_at TIMESTAMPTZ;
  v_downtime_started_at TIMESTAMPTZ;
  v_prior_processed NUMERIC(18,4);
BEGIN
  IF NEW.work_order_id IS NULL AND NEW.work_order_operation_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT source_order_id, source_order_line_id, target_quantity, status
    INTO v_source_order_id, v_source_order_line_id, v_target_quantity, v_work_order_status
  FROM work_orders
  WHERE id = NEW.work_order_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'work-order output does not reference a work order in this factory'
      USING ERRCODE = '23503';
  END IF;
  IF NEW.order_id <> v_source_order_id OR NEW.order_line_id <> v_source_order_line_id THEN
    RAISE EXCEPTION 'work-order output must match its source sales order and line'
      USING ERRCODE = '23514';
  END IF;
  IF v_work_order_status <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'work-order output is allowed only while the work order is in progress'
      USING ERRCODE = '23514';
  END IF;

  SELECT step_number, status, active_started_at, downtime_started_at
    INTO v_operation_step, v_operation_status, v_active_started_at, v_downtime_started_at
  FROM work_order_operations
  WHERE id = NEW.work_order_operation_id
    AND work_order_id = NEW.work_order_id
    AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id
  FOR UPDATE;

  IF NOT FOUND OR v_operation_status <> 'IN_PROGRESS'
    OR v_active_started_at IS NULL OR v_downtime_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'output must be reported against the actively running final operation outside downtime'
      USING ERRCODE = '23514';
  END IF;

  SELECT max(step_number) INTO v_last_step
  FROM work_order_operations
  WHERE work_order_id = NEW.work_order_id
    AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
  IF v_operation_step <> v_last_step THEN
    RAISE EXCEPTION 'finished output can only be reported against the final routing operation'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(good_quantity + scrap_quantity), 0)
    INTO v_prior_processed
  FROM order_production_reports
  WHERE work_order_id = NEW.work_order_id
    AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;

  IF v_prior_processed + NEW.good_quantity + NEW.scrap_quantity > v_target_quantity THEN
    RAISE EXCEPTION 'cumulative work-order processed output cannot exceed its target quantity'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_order_production_report_work_order_guard
BEFORE INSERT ON order_production_reports
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_work_order_production_output();

ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY work_orders_tenant_isolation ON work_orders
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE work_order_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY work_order_operations_tenant_isolation ON work_order_operations
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE work_order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_events FORCE ROW LEVEL SECURITY;
CREATE POLICY work_order_events_tenant_isolation ON work_order_events
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE work_order_material_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_material_requirements FORCE ROW LEVEL SECURITY;
CREATE POLICY work_order_material_requirements_tenant_isolation ON work_order_material_requirements
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE work_order_material_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_material_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY work_order_material_reservations_tenant_isolation ON work_order_material_reservations
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMENT ON TABLE work_orders IS
  'Version-pinned production work orders created from factory-scoped sales-order lines; status changes require actor, version and immutable shop-floor event evidence.';
COMMENT ON TABLE work_order_operations IS
  'Immutable snapshots of the released product routing with guarded operation status, actual run time and downtime evidence.';
COMMENT ON TABLE work_order_events IS
  'Append-only shop-floor event log carrying source timestamp actor/device and idempotency evidence for start stop output WIP downtime hold release rework and scrap.';
COMMENT ON TABLE work_order_material_requirements IS
  'Immutable component requirements calculated from the work-order target, pinned BOM base-quantity snapshots, expected yield and wastage.';
COMMENT ON TABLE work_order_material_reservations IS
  'Immutable links from BOM material requirements to inventory reservations made at release and released/consumed on terminal disposition.';
COMMENT ON COLUMN work_orders.target_quantity IS
  'Planned units to process; reported good plus scrap quantities cannot exceed this value, while only good quantity fulfils the sales order.';
COMMENT ON COLUMN work_order_operations.actual_run_minutes IS
  'Server-measured accumulated active time across start/resume/pause/hold/complete intervals, excluding recorded downtime.';
COMMENT ON COLUMN work_order_operations.downtime_minutes IS
  'Server-measured accumulated downtime, recorded as matched downtime start/end events.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('090_production_work_order_operation_lifecycle', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
