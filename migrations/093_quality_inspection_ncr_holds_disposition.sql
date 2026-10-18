BEGIN;

INSERT INTO permissions (code, description)
VALUES
  ('quality.inspections.read', 'Read factory-scoped quality inspections, defects, NCRs, holds and dispositions'),
  ('quality.inspections.write', 'Create and run incoming, in-process, final and inventory quality inspections'),
  ('quality.defects.write', 'Record defects and defect disposition evidence'),
  ('quality.disposition.decide', 'Decide quality holds, release, rework, scrap and supplier-return disposition'),
  ('quality.ncr.manage', 'Record containment, corrective and preventive actions and close non-conformance reports')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'quality.inspections.read', 'quality.inspections.write', 'quality.defects.write',
  'quality.disposition.decide', 'quality.ncr.manage'
)
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER', 'QUALITY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE quality_inspections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  inspection_type VARCHAR(20) NOT NULL,
  target_type VARCHAR(24) NOT NULL,
  target_id UUID NOT NULL,
  inventory_item_id UUID,
  traceability_unit_id UUID,
  plan_code VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  sample_quantity NUMERIC(18,4),
  notes TEXT,
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_quality_inspection_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_quality_inspection_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_quality_inspection_item FOREIGN KEY (inventory_item_id, tenant_id, factory_id)
    REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_inspection_traceability_unit FOREIGN KEY (traceability_unit_id, tenant_id, factory_id)
    REFERENCES traceability_units(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_inspection_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_inspection_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_inspection_type CHECK (inspection_type IN ('INCOMING', 'IN_PROCESS', 'FINAL', 'INVENTORY', 'SUPPLIER')),
  CONSTRAINT chk_quality_inspection_target_type CHECK (target_type IN ('INVENTORY_ITEM', 'TRACEABILITY_UNIT', 'GOODS_RECEIPT_LINE', 'PRODUCTION_REPORT', 'WORK_ORDER')),
  CONSTRAINT chk_quality_inspection_status CHECK (status IN ('OPEN', 'IN_PROGRESS', 'PASSED', 'FAILED', 'ON_HOLD', 'DISPOSITIONED', 'CANCELLED')),
  CONSTRAINT chk_quality_inspection_sample_quantity CHECK (sample_quantity IS NULL OR sample_quantity > 0),
  CONSTRAINT chk_quality_inspection_target_binding CHECK (
    (target_type = 'INVENTORY_ITEM' AND inventory_item_id = target_id AND traceability_unit_id IS NULL)
    OR (target_type = 'TRACEABILITY_UNIT' AND traceability_unit_id = target_id)
    OR (target_type IN ('GOODS_RECEIPT_LINE', 'PRODUCTION_REPORT', 'WORK_ORDER') AND traceability_unit_id IS NULL)
  ),
  CONSTRAINT chk_quality_inspection_plan_code CHECK (plan_code IS NULL OR length(btrim(plan_code)) > 0),
  CONSTRAINT chk_quality_inspection_version CHECK (row_version > 0),
  CONSTRAINT chk_quality_inspection_key CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  CONSTRAINT chk_quality_inspection_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_quality_inspection_queue
  ON quality_inspections (tenant_id, factory_id, status, inspection_type, created_at DESC);
CREATE INDEX idx_quality_inspection_target
  ON quality_inspections (tenant_id, factory_id, target_type, target_id, created_at DESC);

CREATE TABLE quality_inspection_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  inspection_id UUID NOT NULL,
  version BIGINT NOT NULL,
  from_status VARCHAR(20),
  to_status VARCHAR(20) NOT NULL,
  action VARCHAR(24) NOT NULL,
  reason TEXT,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  actor_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_quality_inspection_event_version UNIQUE (inspection_id, version),
  CONSTRAINT uq_quality_inspection_event_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_quality_inspection_event_inspection FOREIGN KEY (inspection_id, tenant_id, factory_id)
    REFERENCES quality_inspections(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_inspection_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_inspection_event_action CHECK (action IN ('CREATED', 'START', 'PASS', 'FAIL', 'HOLD', 'CANCEL', 'DISPOSITION', 'REWORK_RESTART')),
  CONSTRAINT chk_quality_inspection_event_target_status CHECK (to_status IN ('OPEN', 'IN_PROGRESS', 'PASSED', 'FAILED', 'ON_HOLD', 'DISPOSITIONED', 'CANCELLED')),
  CONSTRAINT chk_quality_inspection_event_reason CHECK (reason IS NULL OR length(btrim(reason)) > 0),
  CONSTRAINT chk_quality_inspection_event_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_quality_inspection_event_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE quality_defects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  inspection_id UUID NOT NULL,
  defect_code VARCHAR(100) NOT NULL,
  severity VARCHAR(16) NOT NULL,
  affected_quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
  description TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  reported_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_quality_defect_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_quality_defect_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_quality_defect_inspection FOREIGN KEY (inspection_id, tenant_id, factory_id)
    REFERENCES quality_inspections(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_defect_reporter FOREIGN KEY (reported_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_defect_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_defect_severity CHECK (severity IN ('CRITICAL', 'MAJOR', 'MINOR')),
  CONSTRAINT chk_quality_defect_quantity CHECK (affected_quantity > 0),
  CONSTRAINT chk_quality_defect_evidence CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT chk_quality_defect_status CHECK (status IN ('OPEN', 'ACCEPTED', 'REWORK', 'RESOLVED', 'SCRAPPED', 'RETURNED')),
  CONSTRAINT chk_quality_defect_version CHECK (row_version > 0),
  CONSTRAINT chk_quality_defect_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_quality_defect_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_quality_defects_inspection_status
  ON quality_defects (tenant_id, factory_id, inspection_id, status, severity);

CREATE TABLE quality_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  inspection_id UUID NOT NULL,
  inventory_item_id UUID,
  traceability_unit_id UUID,
  work_order_id UUID,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  quarantined_by_quality BOOLEAN NOT NULL DEFAULT FALSE,
  reason TEXT NOT NULL,
  created_by_user_id UUID NOT NULL,
  released_by_user_id UUID,
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_quality_hold_inspection UNIQUE (inspection_id),
  CONSTRAINT uq_quality_hold_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT fk_quality_hold_inspection FOREIGN KEY (inspection_id, tenant_id, factory_id)
    REFERENCES quality_inspections(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_hold_item FOREIGN KEY (inventory_item_id, tenant_id, factory_id)
    REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_hold_traceability_unit FOREIGN KEY (traceability_unit_id, tenant_id, factory_id)
    REFERENCES traceability_units(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_hold_work_order FOREIGN KEY (work_order_id, tenant_id, factory_id)
    REFERENCES work_orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_hold_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_hold_releaser FOREIGN KEY (released_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_hold_target CHECK (inventory_item_id IS NOT NULL OR traceability_unit_id IS NOT NULL OR work_order_id IS NOT NULL),
  CONSTRAINT chk_quality_hold_status CHECK (status IN ('ACTIVE', 'RELEASED', 'DISPOSED')),
  CONSTRAINT chk_quality_hold_reason CHECK (length(btrim(reason)) > 0),
  CONSTRAINT chk_quality_hold_release_evidence CHECK (
    (status = 'ACTIVE' AND released_by_user_id IS NULL AND released_at IS NULL AND release_reason IS NULL)
    OR (status IN ('RELEASED', 'DISPOSED') AND released_by_user_id IS NOT NULL AND released_at IS NOT NULL AND length(btrim(COALESCE(release_reason, ''))) > 0)
  )
);

CREATE INDEX idx_quality_holds_active_item
  ON quality_holds (tenant_id, factory_id, inventory_item_id, status)
  WHERE status = 'ACTIVE';
CREATE INDEX idx_quality_holds_active_unit
  ON quality_holds (tenant_id, factory_id, traceability_unit_id, status)
  WHERE status = 'ACTIVE';

CREATE TABLE quality_dispositions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  inspection_id UUID NOT NULL,
  hold_id UUID,
  inventory_item_id UUID,
  action VARCHAR(24) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'RECORDED',
  quantity NUMERIC(18,4),
  reason TEXT NOT NULL,
  inventory_movement_id UUID,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT uq_quality_disposition_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_quality_disposition_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_quality_disposition_inspection FOREIGN KEY (inspection_id, tenant_id, factory_id)
    REFERENCES quality_inspections(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_disposition_hold FOREIGN KEY (hold_id, tenant_id, factory_id)
    REFERENCES quality_holds(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_disposition_item FOREIGN KEY (inventory_item_id, tenant_id, factory_id)
    REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_disposition_movement FOREIGN KEY (inventory_movement_id, tenant_id, factory_id)
    REFERENCES inventory_movements(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_disposition_actor FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_disposition_action CHECK (action IN ('RELEASE', 'USE_AS_IS', 'REWORK', 'SCRAP', 'RETURN_TO_SUPPLIER')),
  CONSTRAINT chk_quality_disposition_status CHECK (status IN ('RECORDED', 'PENDING_INVENTORY', 'COMPLETED')),
  CONSTRAINT chk_quality_disposition_quantity CHECK (
    (action IN ('SCRAP', 'RETURN_TO_SUPPLIER') AND quantity IS NOT NULL AND quantity > 0 AND inventory_item_id IS NOT NULL)
    OR (action NOT IN ('SCRAP', 'RETURN_TO_SUPPLIER') AND quantity IS NULL)
  ),
  CONSTRAINT chk_quality_disposition_inventory_evidence CHECK (
    (status = 'PENDING_INVENTORY' AND inventory_movement_id IS NULL AND completed_at IS NULL
      AND action IN ('SCRAP', 'RETURN_TO_SUPPLIER'))
    OR (status = 'RECORDED' AND inventory_movement_id IS NULL AND completed_at IS NULL
      AND action IN ('RELEASE', 'USE_AS_IS', 'REWORK'))
    OR (status = 'COMPLETED' AND inventory_movement_id IS NOT NULL AND completed_at IS NOT NULL
      AND action IN ('SCRAP', 'RETURN_TO_SUPPLIER'))
  ),
  CONSTRAINT chk_quality_disposition_reason CHECK (length(btrim(reason)) > 0),
  CONSTRAINT chk_quality_disposition_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_quality_disposition_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE quality_ncrs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  inspection_id UUID NOT NULL,
  ncr_number VARCHAR(100) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  severity VARCHAR(16) NOT NULL,
  title VARCHAR(255) NOT NULL,
  summary TEXT NOT NULL,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_by_user_id UUID NOT NULL,
  closed_by_user_id UUID,
  closed_at TIMESTAMPTZ,
  closure_reason TEXT,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_quality_ncr_inspection UNIQUE (inspection_id),
  CONSTRAINT uq_quality_ncr_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_quality_ncr_number UNIQUE (tenant_id, factory_id, ncr_number),
  CONSTRAINT fk_quality_ncr_inspection FOREIGN KEY (inspection_id, tenant_id, factory_id)
    REFERENCES quality_inspections(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_ncr_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_ncr_closer FOREIGN KEY (closed_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_ncr_status CHECK (status IN ('OPEN', 'IN_PROGRESS', 'CLOSED')),
  CONSTRAINT chk_quality_ncr_severity CHECK (severity IN ('CRITICAL', 'MAJOR', 'MINOR')),
  CONSTRAINT chk_quality_ncr_version CHECK (row_version > 0),
  CONSTRAINT chk_quality_ncr_closure CHECK (
    (status = 'CLOSED' AND closed_by_user_id IS NOT NULL AND closed_at IS NOT NULL AND length(btrim(COALESCE(closure_reason, ''))) > 0)
    OR (status <> 'CLOSED' AND closed_by_user_id IS NULL AND closed_at IS NULL AND closure_reason IS NULL)
  )
);

CREATE TABLE quality_ncr_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  ncr_id UUID NOT NULL,
  action_type VARCHAR(20) NOT NULL,
  action_text TEXT NOT NULL,
  responsible_user_id UUID,
  due_date DATE,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  recorded_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_quality_ncr_action_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_quality_ncr_action_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT uq_quality_ncr_action_type UNIQUE (ncr_id, action_type),
  CONSTRAINT fk_quality_ncr_action_ncr FOREIGN KEY (ncr_id, tenant_id, factory_id)
    REFERENCES quality_ncrs(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_ncr_action_responsible FOREIGN KEY (responsible_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_ncr_action_recorder FOREIGN KEY (recorded_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_ncr_action_type CHECK (action_type IN ('CONTAINMENT', 'CORRECTIVE', 'PREVENTIVE')),
  CONSTRAINT chk_quality_ncr_action_text CHECK (length(btrim(action_text)) > 0),
  CONSTRAINT chk_quality_ncr_action_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_quality_ncr_action_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE quality_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  inspection_id UUID,
  defect_id UUID,
  hold_id UUID,
  disposition_id UUID,
  ncr_id UUID,
  action_type VARCHAR(40) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_quality_audit_inspection FOREIGN KEY (inspection_id, tenant_id, factory_id)
    REFERENCES quality_inspections(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_audit_defect FOREIGN KEY (defect_id, tenant_id, factory_id)
    REFERENCES quality_defects(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_audit_hold FOREIGN KEY (hold_id, tenant_id, factory_id)
    REFERENCES quality_holds(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_audit_disposition FOREIGN KEY (disposition_id, tenant_id, factory_id)
    REFERENCES quality_dispositions(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_audit_ncr FOREIGN KEY (ncr_id, tenant_id, factory_id)
    REFERENCES quality_ncrs(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_audit_payload CHECK (jsonb_typeof(payload) = 'object')
);

CREATE OR REPLACE FUNCTION factoryos_guard_quality_inspection_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_item UUID;
  v_unit UUID;
  v_receipt_status VARCHAR(16);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.inspection_type, NEW.target_type, NEW.target_id,
      NEW.inventory_item_id, NEW.traceability_unit_id, NEW.plan_code, NEW.sample_quantity, NEW.notes,
      NEW.idempotency_key, NEW.request_hash, NEW.created_by_user_id, NEW.correlation_id, NEW.created_at)
      IS DISTINCT FROM
      ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.inspection_type, OLD.target_type, OLD.target_id,
      OLD.inventory_item_id, OLD.traceability_unit_id, OLD.plan_code, OLD.sample_quantity, OLD.notes,
      OLD.idempotency_key, OLD.request_hash, OLD.created_by_user_id, OLD.correlation_id, OLD.created_at)
      OR NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at <= OLD.updated_at
      OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'quality inspection identity is immutable; lifecycle changes require optimistic version increments'
        USING ERRCODE = '55000';
    END IF;
    IF NOT (
      (OLD.status IN ('OPEN', 'ON_HOLD') AND NEW.status = 'IN_PROGRESS')
      OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('PASSED', 'FAILED', 'ON_HOLD', 'CANCELLED'))
      OR (OLD.status IN ('FAILED', 'ON_HOLD', 'PASSED') AND NEW.status IN ('DISPOSITIONED', 'ON_HOLD'))
    ) THEN
      RAISE EXCEPTION 'invalid quality inspection transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
     OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
     OR NEW.status <> 'OPEN' OR NEW.row_version <> 1 THEN
    RAISE EXCEPTION 'quality inspection must start OPEN under the authenticated actor'
      USING ERRCODE = '23514';
  END IF;

  CASE NEW.target_type
    WHEN 'INVENTORY_ITEM' THEN
      SELECT i.id INTO v_item FROM inventory_items i
      WHERE i.id = NEW.target_id AND i.tenant_id = NEW.tenant_id AND i.factory_id = NEW.factory_id
      FOR SHARE;
    WHEN 'TRACEABILITY_UNIT' THEN
      SELECT u.id, u.inventory_item_id INTO v_unit, v_item FROM traceability_units u
      WHERE u.id = NEW.target_id AND u.tenant_id = NEW.tenant_id AND u.factory_id = NEW.factory_id
      FOR SHARE;
    WHEN 'GOODS_RECEIPT_LINE' THEN
      SELECT l.inventory_item_id INTO v_item
      FROM goods_receipt_lines l JOIN goods_receipts g
        ON g.id = l.goods_receipt_id AND g.tenant_id = l.tenant_id AND g.factory_id = l.factory_id
      WHERE l.id = NEW.target_id AND l.tenant_id = NEW.tenant_id AND l.factory_id = NEW.factory_id
        AND g.status = 'POSTED'
      FOR SHARE OF l, g;
    WHEN 'PRODUCTION_REPORT' THEN
      SELECT COALESCE(wo.finished_item_id, ol.inventory_item_id) INTO v_item
      FROM order_production_reports r
      JOIN order_lines ol ON ol.id = r.order_line_id AND ol.order_id = r.order_id
        AND ol.tenant_id = r.tenant_id AND ol.factory_id = r.factory_id
      LEFT JOIN work_orders wo ON wo.id = r.work_order_id AND wo.tenant_id = r.tenant_id AND wo.factory_id = r.factory_id
      WHERE r.id = NEW.target_id AND r.tenant_id = NEW.tenant_id AND r.factory_id = NEW.factory_id
      FOR SHARE OF r, ol;
    WHEN 'WORK_ORDER' THEN
      PERFORM 1 FROM work_orders wo
      WHERE wo.id = NEW.target_id AND wo.tenant_id = NEW.tenant_id AND wo.factory_id = NEW.factory_id
      FOR SHARE;
    ELSE
      RAISE EXCEPTION 'unsupported quality inspection target type' USING ERRCODE = '23514';
  END CASE;

  IF NEW.target_type = 'TRACEABILITY_UNIT' THEN
    IF v_unit IS NULL THEN RAISE EXCEPTION 'traceability unit is not in this factory' USING ERRCODE = '23503'; END IF;
    IF NEW.traceability_unit_id IS NOT NULL AND NEW.traceability_unit_id IS DISTINCT FROM NEW.target_id THEN
      RAISE EXCEPTION 'quality traceability target binding is invalid' USING ERRCODE = '23514';
    END IF;
    IF NEW.inventory_item_id IS NOT NULL AND NEW.inventory_item_id IS DISTINCT FROM v_item THEN
      RAISE EXCEPTION 'quality traceability inventory mapping is invalid' USING ERRCODE = '23514';
    END IF;
    NEW.traceability_unit_id := NEW.target_id;
    NEW.inventory_item_id := v_item;
  ELSE
    IF NOT FOUND THEN RAISE EXCEPTION 'quality inspection target was not found in this factory' USING ERRCODE = '23503'; END IF;
    IF NEW.traceability_unit_id IS NOT NULL THEN
      RAISE EXCEPTION 'only traceability-unit inspections may link a traceability unit' USING ERRCODE = '23514';
    END IF;
    IF NEW.inventory_item_id IS NOT NULL AND NEW.inventory_item_id IS DISTINCT FROM v_item THEN
      RAISE EXCEPTION 'quality inspection inventory mapping must be resolved by the database' USING ERRCODE = '23514';
    END IF;
    NEW.inventory_item_id := v_item;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_quality_inspection_target_guard
BEFORE INSERT OR UPDATE ON quality_inspections
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_inspection_target();

CREATE OR REPLACE FUNCTION factoryos_guard_quality_inspection_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'quality inspection events are append-only' USING ERRCODE = '55000';
  END IF;
  IF NEW.actor_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'quality inspection event actor must match authenticated user' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM quality_inspections qi WHERE qi.id = NEW.inspection_id
      AND qi.tenant_id = NEW.tenant_id AND qi.factory_id = NEW.factory_id
      AND qi.status = NEW.to_status AND qi.row_version = NEW.version
  ) THEN
    RAISE EXCEPTION 'quality inspection event must match the applied status/version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_inspection_event_guard
BEFORE INSERT OR UPDATE OR DELETE ON quality_inspection_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_inspection_event();

CREATE OR REPLACE FUNCTION factoryos_require_quality_inspection_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM quality_inspection_events e WHERE e.inspection_id = NEW.id
    AND e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    AND e.version = NEW.row_version AND e.to_status = NEW.status)
    OR NOT EXISTS (SELECT 1 FROM quality_audit_events a WHERE a.inspection_id = NEW.id
      AND a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id)
    OR NOT EXISTS (SELECT 1 FROM outbox_events o WHERE o.tenant_id = NEW.tenant_id
      AND o.factory_id = NEW.factory_id AND o.aggregate_type = 'QUALITY_INSPECTION'
      AND o.aggregate_id = NEW.id AND o.event_type = 'QUALITY.INSPECTION_CHANGED') THEN
    RAISE EXCEPTION 'quality inspection changes require immutable history, audit and transactional outbox evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ctr_quality_inspection_evidence
AFTER INSERT OR UPDATE OF status ON quality_inspections
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_require_quality_inspection_evidence();

CREATE OR REPLACE FUNCTION factoryos_guard_quality_defect()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'quality defects are permanent evidence' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.reported_by_user_id IS DISTINCT FROM factoryos_current_user_id() OR NEW.status <> 'OPEN' OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'quality defect must start OPEN under the authenticated actor' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.inspection_id, NEW.defect_code, NEW.severity,
      NEW.affected_quantity, NEW.description, NEW.evidence, NEW.idempotency_key, NEW.request_hash,
      NEW.reported_by_user_id, NEW.correlation_id, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.inspection_id, OLD.defect_code, OLD.severity,
      OLD.affected_quantity, OLD.description, OLD.evidence, OLD.idempotency_key, OLD.request_hash,
      OLD.reported_by_user_id, OLD.correlation_id, OLD.created_at)
    OR OLD.status NOT IN ('OPEN', 'REWORK') OR NEW.status NOT IN ('ACCEPTED', 'REWORK', 'RESOLVED', 'SCRAPPED', 'RETURNED')
    OR (OLD.status = 'REWORK' AND NEW.status <> 'RESOLVED')
    OR NEW.row_version <> OLD.row_version + 1 OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
    OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'quality defect evidence is immutable except for a single evidenced disposition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_defect_guard
BEFORE INSERT OR UPDATE OR DELETE ON quality_defects
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_defect();

CREATE TABLE quality_defect_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  defect_id UUID NOT NULL,
  from_status VARCHAR(20),
  to_status VARCHAR(20) NOT NULL,
  action VARCHAR(20) NOT NULL,
  reason TEXT,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  actor_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_quality_defect_event_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_quality_defect_event_defect FOREIGN KEY (defect_id, tenant_id, factory_id)
    REFERENCES quality_defects(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_defect_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_defect_event_action CHECK (action IN ('REPORTED', 'DISPOSITIONED', 'RESOLVED')),
  CONSTRAINT chk_quality_defect_event_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_quality_defect_event_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE OR REPLACE FUNCTION factoryos_guard_quality_hold()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'quality holds are immutable evidence and cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() OR NEW.status <> 'ACTIVE'
      OR length(btrim(NEW.reason)) = 0 THEN
      RAISE EXCEPTION 'quality hold must begin ACTIVE with an actor and reason' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.inspection_id, NEW.inventory_item_id,
      NEW.traceability_unit_id, NEW.work_order_id, NEW.quarantined_by_quality, NEW.reason, NEW.created_by_user_id,
      NEW.correlation_id, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.inspection_id, OLD.inventory_item_id,
      OLD.traceability_unit_id, OLD.work_order_id, OLD.quarantined_by_quality, OLD.reason, OLD.created_by_user_id,
      OLD.correlation_id, OLD.created_at)
    OR OLD.status <> 'ACTIVE' OR NEW.status NOT IN ('RELEASED', 'DISPOSED')
    OR NEW.released_by_user_id IS DISTINCT FROM factoryos_current_user_id()
    OR NEW.released_at IS NULL OR length(btrim(COALESCE(NEW.release_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'quality holds only permit an evidenced ACTIVE to RELEASED/DISPOSED transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_hold_guard
BEFORE INSERT OR UPDATE OR DELETE ON quality_holds
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_hold();

CREATE OR REPLACE FUNCTION factoryos_quality_capture_traceability_hold()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status VARCHAR(16);
BEGIN
  IF NEW.traceability_unit_id IS NULL THEN
    NEW.quarantined_by_quality := FALSE;
    RETURN NEW;
  END IF;
  SELECT status INTO v_status FROM traceability_units
  WHERE id = NEW.traceability_unit_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'quality hold traceability unit is outside this factory' USING ERRCODE = '23503'; END IF;
  IF v_status NOT IN ('ACTIVE', 'QUARANTINED') THEN
    RAISE EXCEPTION 'disposed, recalled or shipped traceability units cannot be put on a new quality hold' USING ERRCODE = '23514';
  END IF;
  NEW.quarantined_by_quality := (v_status = 'ACTIVE');
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_hold_capture_unit
BEFORE INSERT ON quality_holds
FOR EACH ROW EXECUTE FUNCTION factoryos_quality_capture_traceability_hold();

CREATE OR REPLACE FUNCTION factoryos_quality_sync_traceability_hold()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit traceability_units%ROWTYPE;
  v_next_status VARCHAR(16);
  v_new_version BIGINT;
  v_actor UUID;
  v_reason TEXT;
  v_hold_id UUID;
  v_correlation UUID;
  v_hash TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.traceability_unit_id IS NULL OR NOT NEW.quarantined_by_quality THEN RETURN NULL; END IF;
    v_unit := NULL;
    SELECT * INTO v_unit FROM traceability_units
      WHERE id = NEW.traceability_unit_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
      FOR UPDATE;
    IF NOT FOUND OR v_unit.status <> 'ACTIVE' THEN RETURN NULL; END IF;
    v_next_status := 'QUARANTINED';
    v_actor := NEW.created_by_user_id; v_reason := NEW.reason; v_hold_id := NEW.id; v_correlation := NEW.correlation_id;
  ELSE
    IF NEW.traceability_unit_id IS NULL OR OLD.status <> 'ACTIVE' OR NEW.status NOT IN ('RELEASED', 'DISPOSED') THEN RETURN NULL; END IF;
    IF EXISTS (SELECT 1 FROM quality_holds h WHERE h.traceability_unit_id = NEW.traceability_unit_id
      AND h.tenant_id = NEW.tenant_id AND h.factory_id = NEW.factory_id AND h.status = 'ACTIVE') THEN RETURN NULL; END IF;
    IF NOT EXISTS (SELECT 1 FROM quality_holds h WHERE h.traceability_unit_id = NEW.traceability_unit_id
      AND h.tenant_id = NEW.tenant_id AND h.factory_id = NEW.factory_id AND h.quarantined_by_quality) THEN RETURN NULL; END IF;
    SELECT * INTO v_unit FROM traceability_units
      WHERE id = NEW.traceability_unit_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
      FOR UPDATE;
    IF NOT FOUND OR v_unit.status <> 'QUARANTINED' THEN RETURN NULL; END IF;
    IF NEW.status = 'DISPOSED' OR EXISTS (SELECT 1 FROM quality_holds h WHERE h.traceability_unit_id = NEW.traceability_unit_id
      AND h.status = 'DISPOSED' AND h.tenant_id = NEW.tenant_id AND h.factory_id = NEW.factory_id) THEN
      v_next_status := 'DISPOSED';
    ELSE
      v_next_status := 'ACTIVE';
    END IF;
    v_actor := NEW.released_by_user_id; v_reason := NEW.release_reason; v_hold_id := NEW.id; v_correlation := NEW.correlation_id;
  END IF;

  UPDATE traceability_units SET status = v_next_status, version = version + 1, updated_at = clock_timestamp()
  WHERE id = v_unit.id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
  RETURNING version INTO v_new_version;

  v_hash := repeat(md5(v_hold_id::text || ':' || v_next_status || ':' || v_new_version::text), 2);
  INSERT INTO traceability_unit_status_events (
    tenant_id, factory_id, unit_id, version, from_status, to_status, reason,
    idempotency_key, request_hash, changed_by_user_id, correlation_id
  ) VALUES (
    NEW.tenant_id, NEW.factory_id, v_unit.id, v_new_version, v_unit.status, v_next_status,
    v_reason, 'quality-hold:' || v_hold_id::text || ':' || v_next_status || ':' || v_new_version::text,
    v_hash, v_actor, v_correlation
  );
  INSERT INTO audit_events (
    tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
    correlation_id, data_class, payload
  ) VALUES (
    NEW.tenant_id, NEW.factory_id, v_actor, 'TRACEABILITY.UNIT_STATUS_CHANGED', 'STATUS_CHANGED',
    'TRACEABILITY_UNIT', v_unit.id, v_correlation, 'INTERNAL',
    jsonb_build_object('from_status', v_unit.status, 'to_status', v_next_status,
      'quality_hold_id', v_hold_id, 'reason', v_reason, 'version', v_new_version)
  );
  INSERT INTO outbox_events (
    tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
  ) VALUES (
    NEW.tenant_id, NEW.factory_id, 'TRACEABILITY_UNIT', v_unit.id,
    'TRACEABILITY.UNIT_STATUS_CHANGED',
    jsonb_build_object('unit_id', v_unit.id, 'from_status', v_unit.status,
      'to_status', v_next_status, 'quality_hold_id', v_hold_id, 'reason', v_reason, 'version', v_new_version)
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER trg_quality_sync_traceability_hold
AFTER INSERT OR UPDATE OF status ON quality_holds
FOR EACH ROW EXECUTE FUNCTION factoryos_quality_sync_traceability_hold();

CREATE OR REPLACE FUNCTION factoryos_guard_quality_disposition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'quality dispositions are append-only' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'quality disposition actor must match authenticated user' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.inspection_id, NEW.hold_id, NEW.inventory_item_id,
      NEW.action, NEW.quantity, NEW.reason, NEW.idempotency_key, NEW.request_hash, NEW.created_by_user_id,
      NEW.correlation_id, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.inspection_id, OLD.hold_id, OLD.inventory_item_id,
      OLD.action, OLD.quantity, OLD.reason, OLD.idempotency_key, OLD.request_hash, OLD.created_by_user_id,
      OLD.correlation_id, OLD.created_at)
    OR OLD.status <> 'PENDING_INVENTORY' OR NEW.status <> 'COMPLETED'
    OR NEW.inventory_movement_id IS NULL OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'quality disposition is immutable except for its guarded inventory completion' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_disposition_guard
BEFORE INSERT OR UPDATE OR DELETE ON quality_dispositions
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_disposition();

CREATE OR REPLACE FUNCTION factoryos_quality_guard_inventory_issue()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_disposition quality_dispositions%ROWTYPE;
  v_balance NUMERIC(18,4);
  v_reserved NUMERIC(18,4);
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.movement_type <> 'ISSUE' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM quality_holds h WHERE h.inventory_item_id = NEW.item_id
    AND h.tenant_id = NEW.tenant_id AND h.factory_id = NEW.factory_id AND h.status = 'ACTIVE') THEN
    RETURN NEW;
  END IF;

  IF NEW.reference_type <> 'QUALITY_DISPOSITION' OR NEW.reference_id IS NULL THEN
    RAISE EXCEPTION 'inventory item is on quality hold; issue is only allowed through an approved SCRAP or RETURN_TO_SUPPLIER disposition'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_disposition FROM quality_dispositions d
  WHERE d.id = NEW.reference_id AND d.tenant_id = NEW.tenant_id AND d.factory_id = NEW.factory_id
    AND d.inventory_item_id = NEW.item_id
  FOR UPDATE;
  IF NOT FOUND OR v_disposition.status <> 'PENDING_INVENTORY'
    OR v_disposition.action NOT IN ('SCRAP', 'RETURN_TO_SUPPLIER')
    OR NEW.quantity <> v_disposition.quantity THEN
    RAISE EXCEPTION 'quality disposition stock issue does not match a pending item-scoped disposal/return'
      USING ERRCODE = '23514';
  END IF;

  SELECT quantity_on_hand, quantity_reserved INTO v_balance, v_reserved
  FROM inventory_stock_balances
  WHERE item_id = NEW.item_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
  FOR UPDATE;
  IF NOT FOUND OR v_reserved <> 0 OR v_balance <> NEW.quantity THEN
    RAISE EXCEPTION 'quality scrap/return must remove all on-hand stock with no active reservations before release'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_guard_inventory_issue
BEFORE INSERT ON inventory_movements
FOR EACH ROW EXECUTE FUNCTION factoryos_quality_guard_inventory_issue();

CREATE OR REPLACE FUNCTION factoryos_quality_guard_inventory_reservation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM quality_holds h
    WHERE h.inventory_item_id = NEW.item_id AND h.tenant_id = NEW.tenant_id
      AND h.factory_id = NEW.factory_id AND h.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'inventory item is on quality hold and cannot be newly reserved'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_guard_inventory_reservation
BEFORE INSERT ON inventory_reservations
FOR EACH ROW EXECUTE FUNCTION factoryos_quality_guard_inventory_reservation();

CREATE OR REPLACE FUNCTION factoryos_quality_complete_inventory_disposition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_disposition quality_dispositions%ROWTYPE;
BEGIN
  IF NEW.movement_type <> 'ISSUE' OR NEW.reference_type <> 'QUALITY_DISPOSITION' OR NEW.reference_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_disposition FROM quality_dispositions d
  WHERE d.id = NEW.reference_id AND d.tenant_id = NEW.tenant_id AND d.factory_id = NEW.factory_id
  FOR UPDATE;
  IF NOT FOUND OR v_disposition.status <> 'PENDING_INVENTORY'
    OR v_disposition.inventory_item_id <> NEW.item_id OR v_disposition.quantity <> NEW.quantity THEN
    RAISE EXCEPTION 'quality disposition inventory evidence is missing or mismatched' USING ERRCODE = '23514';
  END IF;

  UPDATE quality_dispositions SET status = 'COMPLETED', inventory_movement_id = NEW.id,
    completed_at = clock_timestamp()
  WHERE id = v_disposition.id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;

  UPDATE quality_holds SET status = 'DISPOSED', released_by_user_id = NEW.created_by_user_id,
    released_at = clock_timestamp(), release_reason = v_disposition.reason, updated_at = clock_timestamp()
  WHERE inspection_id = v_disposition.inspection_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    AND status = 'ACTIVE';
  RETURN NULL;
END;
$$;
CREATE TRIGGER trg_quality_complete_inventory_disposition
AFTER INSERT ON inventory_movements
FOR EACH ROW EXECUTE FUNCTION factoryos_quality_complete_inventory_disposition();

CREATE OR REPLACE FUNCTION factoryos_quality_guard_work_order_hold()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
    AND NEW.status IN ('IN_PROGRESS', 'COMPLETED')
    AND EXISTS (
      SELECT 1 FROM quality_inspections qi JOIN quality_holds h
        ON h.inspection_id = qi.id AND h.tenant_id = qi.tenant_id AND h.factory_id = qi.factory_id
      WHERE qi.target_type = 'WORK_ORDER' AND qi.target_id = NEW.id
        AND qi.tenant_id = NEW.tenant_id AND qi.factory_id = NEW.factory_id AND h.status = 'ACTIVE'
    ) THEN
    RAISE EXCEPTION 'production work order is on quality hold and cannot start or complete'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_guard_work_order_hold
BEFORE UPDATE OF status ON work_orders
FOR EACH ROW EXECUTE FUNCTION factoryos_quality_guard_work_order_hold();

CREATE OR REPLACE FUNCTION factoryos_quality_guard_work_order_report()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.work_order_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM quality_inspections qi JOIN quality_holds h
      ON h.inspection_id = qi.id AND h.tenant_id = qi.tenant_id AND h.factory_id = qi.factory_id
    WHERE qi.target_type = 'WORK_ORDER' AND qi.target_id = NEW.work_order_id
      AND qi.tenant_id = NEW.tenant_id AND qi.factory_id = NEW.factory_id AND h.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'production output is blocked while its work order has an active quality hold'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_guard_work_order_report
BEFORE INSERT ON order_production_reports
FOR EACH ROW EXECUTE FUNCTION factoryos_quality_guard_work_order_report();

CREATE OR REPLACE FUNCTION factoryos_prevent_quality_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'quality audit evidence is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER trg_quality_audit_immutable
BEFORE UPDATE OR DELETE ON quality_audit_events
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_quality_audit_mutation();
CREATE TRIGGER trg_quality_inspection_events_immutable
BEFORE UPDATE OR DELETE ON quality_inspection_events
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_quality_audit_mutation();
CREATE TRIGGER trg_quality_defect_events_immutable
BEFORE UPDATE OR DELETE ON quality_defect_events
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_quality_audit_mutation();
CREATE TRIGGER trg_quality_ncr_actions_immutable
BEFORE UPDATE OR DELETE ON quality_ncr_actions
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_quality_audit_mutation();

CREATE OR REPLACE FUNCTION factoryos_guard_quality_ncr_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'quality NCR records cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() OR NEW.status <> 'OPEN' THEN
      RAISE EXCEPTION 'quality NCR must start OPEN under the authenticated actor' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.inspection_id, NEW.ncr_number, NEW.severity, NEW.title,
      NEW.summary, NEW.created_by_user_id, NEW.correlation_id, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.inspection_id, OLD.ncr_number, OLD.severity, OLD.title,
      OLD.summary, OLD.created_by_user_id, OLD.correlation_id, OLD.created_at)
    OR OLD.status = 'CLOSED' OR NEW.row_version <> OLD.row_version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'quality NCR identity is immutable and closure is terminal' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.status = 'OPEN' AND NEW.status = 'IN_PROGRESS')
    OR (OLD.status IN ('OPEN', 'IN_PROGRESS') AND NEW.status = 'CLOSED'
      AND NEW.closed_by_user_id IS NOT NULL AND NEW.closed_at IS NOT NULL
      AND length(btrim(COALESCE(NEW.closure_reason, ''))) > 0)
  ) THEN
    RAISE EXCEPTION 'invalid quality NCR lifecycle transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_ncr_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON quality_ncrs
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_ncr_lifecycle();

CREATE OR REPLACE FUNCTION factoryos_quality_guard_ncr_close()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'CLOSED' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NOT EXISTS (SELECT 1 FROM quality_ncr_actions a WHERE a.ncr_id = NEW.id AND a.action_type = 'CONTAINMENT'
      AND a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id)
      OR NOT EXISTS (SELECT 1 FROM quality_ncr_actions a WHERE a.ncr_id = NEW.id AND a.action_type = 'CORRECTIVE'
        AND a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id)
      OR NOT EXISTS (SELECT 1 FROM quality_ncr_actions a WHERE a.ncr_id = NEW.id AND a.action_type = 'PREVENTIVE'
        AND a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id)
      OR EXISTS (SELECT 1 FROM quality_defects d WHERE d.inspection_id = NEW.inspection_id
        AND d.tenant_id = NEW.tenant_id AND d.factory_id = NEW.factory_id AND d.status IN ('OPEN', 'REWORK')) THEN
      RAISE EXCEPTION 'NCR requires containment, corrective and preventive actions and no open/rework defects before closure'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_ncr_close_guard
BEFORE UPDATE OF status ON quality_ncrs
FOR EACH ROW EXECUTE FUNCTION factoryos_quality_guard_ncr_close();

ALTER TABLE quality_inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_inspections FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_inspections_tenant_isolation ON quality_inspections
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());
ALTER TABLE quality_inspection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_inspection_events FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_inspection_events_tenant_isolation ON quality_inspection_events
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());
ALTER TABLE quality_defects ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_defects FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_defects_tenant_isolation ON quality_defects
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());
ALTER TABLE quality_defect_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_defect_events FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_defect_events_tenant_isolation ON quality_defect_events
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());
ALTER TABLE quality_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_holds_tenant_isolation ON quality_holds
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());
ALTER TABLE quality_dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_dispositions FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_dispositions_tenant_isolation ON quality_dispositions
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());
ALTER TABLE quality_ncrs ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_ncrs FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_ncrs_tenant_isolation ON quality_ncrs
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());
ALTER TABLE quality_ncr_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_ncr_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_ncr_actions_tenant_isolation ON quality_ncr_actions
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());
ALTER TABLE quality_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_audit_events_tenant_isolation ON quality_audit_events
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMENT ON TABLE quality_inspections IS
  'Factory-scoped incoming, in-process, final, inventory and supplier inspections linked to item, traceability unit, GRN line, production report or work order.';
COMMENT ON TABLE quality_defects IS
  'Versioned defect records with immutable reporting evidence and explicit accept, rework, resolve, scrap or supplier-return disposition.';
COMMENT ON TABLE quality_holds IS
  'Active quality holds/quarantine evidence. Item holds block new reservations and stock issues; serial/lot status is synchronized through traceability status history.';
COMMENT ON TABLE quality_dispositions IS
  'Append-only quality decisions. Scrap/supplier-return dispositions require a matching full-stock inventory ISSUE before the hold can clear.';
COMMENT ON TABLE quality_ncrs IS
  'Non-conformance reports created on failed/held inspections. Closure requires recorded containment, corrective and preventive actions.';
COMMENT ON TABLE quality_ncr_actions IS
  'Append-only CAPA plan/evidence for a non-conformance report. Each NCR requires one containment, corrective and preventive action before closure.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('093_quality_inspection_ncr_holds_disposition', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
