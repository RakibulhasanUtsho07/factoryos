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
  CONSTRAINT chk_work_order_dates CHECK (due_date >= planned_start_date),
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
  CONSTRAINT chk_work_order_operation_active_timer CHECK (
    (status = 'IN_PROGRESS' AND active_started_at IS NOT NULL AND completed_at IS NULL AND downtime_started_at IS NULL)
    OR (status <> 'IN_PROGRESS' AND active_started_at IS NULL)
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
    'WORK_ORDER_CANCELLED', 'WORK_ORDER_COMPLETED', 'OPERATION_STARTED', 'OPERATION_PAUSED',
    'OPERATION_HELD', 'OPERATION_RESUMED', 'OPERATION_COMPLETED', 'OPERATION_SKIPPED',
    'DOWNTIME_STARTED', 'DOWNTIME_ENDED', 'WIP_REPORTED', 'REWORK_REPORTED', 'OUTPUT_REPORTED'
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
AS $
DECLARE
  v_work_order_product_id UUID;
  v_work_order_product_version_id UUID;
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
    IF NEW.status <> 'PLANNED' OR NEW.row_version <> 1
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

  SELECT step_number, status INTO v_operation_step, v_operation_status
  FROM work_order_operations
  WHERE id = NEW.work_order_operation_id
    AND work_order_id = NEW.work_order_id
    AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id
  FOR UPDATE;

  IF NOT FOUND OR v_operation_status <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'output must be reported against the active final operation'
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

COMMENT ON TABLE work_orders IS
  'Version-pinned production work orders created from factory-scoped sales-order lines; status changes require actor, version and immutable shop-floor event evidence.';
COMMENT ON TABLE work_order_operations IS
  'Immutable snapshots of the released product routing with guarded operation status, actual run time and downtime evidence.';
COMMENT ON TABLE work_order_events IS
  'Append-only shop-floor event log carrying source timestamp actor/device and idempotency evidence for start stop output WIP downtime hold release rework and scrap.';
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
