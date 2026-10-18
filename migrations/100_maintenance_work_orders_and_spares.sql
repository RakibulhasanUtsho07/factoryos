BEGIN;

-- Maintenance work orders, checklists and spare-part issues. Spare-part issues
-- update the existing inventory stock ledger in the same transaction.
CREATE TABLE maintenance_work_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  work_order_number VARCHAR(100) NOT NULL,
  work_order_type VARCHAR(16) NOT NULL,
  asset_id UUID NOT NULL,
  pm_plan_id UUID,
  plan_due_on DATE,
  priority VARCHAR(12) NOT NULL DEFAULT 'MEDIUM',
  status VARCHAR(16) NOT NULL DEFAULT 'PLANNED',
  title VARCHAR(255) NOT NULL,
  description TEXT,
  failure_code VARCHAR(100),
  scheduled_start_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  assigned_to_user_id UUID,
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  started_by_user_id UUID,
  started_at TIMESTAMPTZ,
  completed_by_user_id UUID,
  completed_at TIMESTAMPTZ,
  cancelled_by_user_id UUID,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_maintenance_work_order_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_maintenance_work_order_number UNIQUE (tenant_id, factory_id, work_order_number),
  CONSTRAINT uq_maintenance_work_order_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT uq_maintenance_pm_occurrence UNIQUE (tenant_id, factory_id, pm_plan_id, plan_due_on),
  CONSTRAINT fk_maintenance_wo_asset FOREIGN KEY (asset_id, tenant_id, factory_id)
    REFERENCES maintenance_assets(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_wo_plan FOREIGN KEY (pm_plan_id, tenant_id, factory_id)
    REFERENCES maintenance_pm_plans(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_wo_assignee FOREIGN KEY (assigned_to_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_wo_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_wo_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_wo_starter FOREIGN KEY (started_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_wo_completer FOREIGN KEY (completed_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_wo_canceller FOREIGN KEY (cancelled_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_maintenance_wo_type CHECK (work_order_type IN ('PM','BREAKDOWN')),
  CONSTRAINT chk_maintenance_wo_priority CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  CONSTRAINT chk_maintenance_wo_status CHECK (status IN ('PLANNED','APPROVED','IN_PROGRESS','ON_HOLD','COMPLETED','CANCELLED')),
  CONSTRAINT chk_maintenance_wo_pm_binding CHECK (
    (work_order_type = 'PM' AND pm_plan_id IS NOT NULL AND plan_due_on IS NOT NULL)
    OR (work_order_type = 'BREAKDOWN' AND pm_plan_id IS NULL AND plan_due_on IS NULL)
  ),
  CONSTRAINT chk_maintenance_wo_due_order CHECK (
    scheduled_start_at IS NULL OR due_at IS NULL OR due_at >= scheduled_start_at
  ),
  CONSTRAINT chk_maintenance_wo_title CHECK (length(btrim(title)) > 0),
  CONSTRAINT chk_maintenance_wo_version CHECK (row_version > 0),
  CONSTRAINT chk_maintenance_wo_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_maintenance_wo_cancel_reason CHECK (
    status <> 'CANCELLED' OR cancellation_reason IS NOT NULL AND length(btrim(cancellation_reason)) > 0
  )
);

CREATE INDEX idx_maintenance_wo_queue
  ON maintenance_work_orders (tenant_id, factory_id, status, priority, due_at);
CREATE INDEX idx_maintenance_wo_asset
  ON maintenance_work_orders (tenant_id, factory_id, asset_id, created_at DESC);
CREATE INDEX idx_maintenance_wo_pm_plan
  ON maintenance_work_orders (tenant_id, factory_id, pm_plan_id, plan_due_on);

CREATE TABLE maintenance_work_order_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  work_order_id UUID NOT NULL,
  task_code VARCHAR(100) NOT NULL,
  description VARCHAR(1000) NOT NULL,
  sequence_no INTEGER NOT NULL,
  is_required BOOLEAN NOT NULL DEFAULT TRUE,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  completion_reason TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  completed_by_user_id UUID,
  completed_at TIMESTAMPTZ,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_maintenance_wo_task_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_maintenance_wo_task_code UNIQUE (tenant_id, factory_id, work_order_id, task_code),
  CONSTRAINT uq_maintenance_wo_task_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_maintenance_wo_task_order FOREIGN KEY (work_order_id, tenant_id, factory_id)
    REFERENCES maintenance_work_orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_wo_task_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_wo_task_completer FOREIGN KEY (completed_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_maintenance_wo_task_sequence CHECK (sequence_no > 0),
  CONSTRAINT chk_maintenance_wo_task_status CHECK (status IN ('PENDING','COMPLETED')),
  CONSTRAINT chk_maintenance_wo_task_description CHECK (length(btrim(description)) > 0),
  CONSTRAINT chk_maintenance_wo_task_version CHECK (row_version > 0),
  CONSTRAINT chk_maintenance_wo_task_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_maintenance_wo_task_completion CHECK (
    (status = 'PENDING' AND completed_by_user_id IS NULL AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND completed_by_user_id IS NOT NULL AND completed_at IS NOT NULL
        AND completion_reason IS NOT NULL AND length(btrim(completion_reason)) > 0)
  ),
  CONSTRAINT chk_maintenance_wo_task_evidence CHECK (jsonb_typeof(evidence) = 'object')
);
CREATE INDEX idx_maintenance_wo_task_checklist
  ON maintenance_work_order_tasks (tenant_id, factory_id, work_order_id, sequence_no, status);

CREATE TABLE maintenance_work_order_parts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  work_order_id UUID NOT NULL,
  inventory_item_id UUID NOT NULL,
  required_quantity NUMERIC(18,4) NOT NULL,
  issued_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  notes TEXT,
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_maintenance_wo_part_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_maintenance_wo_part_item UNIQUE (tenant_id, factory_id, work_order_id, inventory_item_id),
  CONSTRAINT uq_maintenance_wo_part_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_maintenance_wo_part_order FOREIGN KEY (work_order_id, tenant_id, factory_id)
    REFERENCES maintenance_work_orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_wo_part_item FOREIGN KEY (inventory_item_id, tenant_id, factory_id)
    REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_wo_part_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_wo_part_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_maintenance_wo_part_quantities CHECK (
    required_quantity > 0 AND issued_quantity >= 0 AND issued_quantity <= required_quantity
    AND required_quantity * 10000 = round(required_quantity * 10000)
    AND issued_quantity * 10000 = round(issued_quantity * 10000)
  ),
  CONSTRAINT chk_maintenance_wo_part_version CHECK (row_version > 0),
  CONSTRAINT chk_maintenance_wo_part_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_maintenance_wo_parts_work_order
  ON maintenance_work_order_parts (tenant_id, factory_id, work_order_id);

CREATE TABLE maintenance_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  entity_type VARCHAR(24) NOT NULL,
  entity_id UUID NOT NULL,
  parent_work_order_id UUID,
  entity_version BIGINT NOT NULL,
  action VARCHAR(40) NOT NULL,
  from_status VARCHAR(16),
  to_status VARCHAR(16),
  reason TEXT,
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  actor_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_maintenance_event_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT uq_maintenance_event_version UNIQUE (tenant_id, factory_id, entity_type, entity_id, entity_version),
  CONSTRAINT fk_maintenance_event_parent_wo FOREIGN KEY (parent_work_order_id, tenant_id, factory_id)
    REFERENCES maintenance_work_orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_maintenance_event_type CHECK (entity_type IN ('ASSET','PM_PLAN','WORK_ORDER','WORK_ORDER_TASK','WORK_ORDER_PART')),
  CONSTRAINT chk_maintenance_event_version CHECK (entity_version > 0),
  CONSTRAINT chk_maintenance_event_action CHECK (length(btrim(action)) > 0),
  CONSTRAINT chk_maintenance_event_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_maintenance_event_data CHECK (jsonb_typeof(event_data) = 'object')
);
CREATE INDEX idx_maintenance_events_entity
  ON maintenance_events (tenant_id, factory_id, entity_type, entity_id, created_at DESC);
CREATE INDEX idx_maintenance_events_parent_wo
  ON maintenance_events (tenant_id, factory_id, parent_work_order_id, created_at DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_maintenance_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_version BIGINT;
BEGIN
  CASE NEW.entity_type
    WHEN 'ASSET' THEN
      SELECT row_version INTO v_version FROM maintenance_assets
      WHERE id=NEW.entity_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
    WHEN 'PM_PLAN' THEN
      SELECT row_version INTO v_version FROM maintenance_pm_plans
      WHERE id=NEW.entity_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
    WHEN 'WORK_ORDER' THEN
      SELECT row_version INTO v_version FROM maintenance_work_orders
      WHERE id=NEW.entity_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
    WHEN 'WORK_ORDER_TASK' THEN
      SELECT row_version INTO v_version FROM maintenance_work_order_tasks
      WHERE id=NEW.entity_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
    WHEN 'WORK_ORDER_PART' THEN
      SELECT row_version INTO v_version FROM maintenance_work_order_parts
      WHERE id=NEW.entity_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
  END CASE;
  IF v_version IS NULL OR v_version <> NEW.entity_version THEN
    RAISE EXCEPTION 'Maintenance event must match the current scoped entity version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_maintenance_event_guard
BEFORE INSERT ON maintenance_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_maintenance_event();

CREATE OR REPLACE FUNCTION factoryos_prevent_maintenance_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Maintenance events are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER trg_maintenance_events_immutable
BEFORE UPDATE OR DELETE ON maintenance_events
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_maintenance_event_mutation();

CREATE OR REPLACE FUNCTION factoryos_guard_maintenance_work_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_plan_asset UUID;
  v_plan_status VARCHAR(16);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.work_order_type = 'PM' THEN
      SELECT asset_id, status INTO v_plan_asset, v_plan_status
      FROM maintenance_pm_plans
      WHERE id=NEW.pm_plan_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
      IF v_plan_asset IS NULL OR v_plan_asset <> NEW.asset_id OR v_plan_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'A PM work order must match an active plan and its asset'
          USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM maintenance_pm_plans p
        WHERE p.id=NEW.pm_plan_id AND p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id
          AND p.next_due_on=NEW.plan_due_on) THEN
        RAISE EXCEPTION 'PM work order due date must match the plan occurrence being generated'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.row_version <> OLD.row_version + 1 THEN
      RAISE EXCEPTION 'Maintenance work-order status changes must increment row_version'
        USING ERRCODE = '23514';
    END IF;
    IF NOT (
      (OLD.status = 'PLANNED' AND NEW.status IN ('APPROVED','CANCELLED')) OR
      (OLD.status = 'APPROVED' AND NEW.status IN ('IN_PROGRESS','CANCELLED')) OR
      (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('ON_HOLD','COMPLETED')) OR
      (OLD.status = 'ON_HOLD' AND NEW.status IN ('IN_PROGRESS','CANCELLED'))
    ) THEN
      RAISE EXCEPTION 'Invalid maintenance work-order status transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = 'COMPLETED' AND OLD.status <> 'COMPLETED' THEN
    IF EXISTS (
      SELECT 1 FROM maintenance_work_order_tasks t
      WHERE t.work_order_id=NEW.id AND t.tenant_id=NEW.tenant_id AND t.factory_id=NEW.factory_id
        AND t.is_required AND t.status <> 'COMPLETED'
    ) THEN
      RAISE EXCEPTION 'Required maintenance checklist tasks must be completed before work-order closure'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = 'CANCELLED' AND OLD.status <> 'CANCELLED' AND EXISTS (
    SELECT 1 FROM maintenance_work_order_parts p
    WHERE p.work_order_id=NEW.id AND p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id
      AND p.issued_quantity > 0
  ) THEN
    RAISE EXCEPTION 'A maintenance work order with issued spare parts cannot be cancelled'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_maintenance_work_order_guard
BEFORE INSERT OR UPDATE OF status, row_version ON maintenance_work_orders
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_maintenance_work_order();

CREATE OR REPLACE FUNCTION factoryos_guard_maintenance_asset_retirement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'RETIRED' AND OLD.status <> 'RETIRED' THEN
    IF EXISTS (SELECT 1 FROM maintenance_assets child
      WHERE child.parent_asset_id=NEW.id AND child.tenant_id=NEW.tenant_id AND child.factory_id=NEW.factory_id
        AND child.status='ACTIVE') THEN
      RAISE EXCEPTION 'An asset with active child assets cannot be retired' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM maintenance_work_orders wo
      WHERE wo.asset_id=NEW.id AND wo.tenant_id=NEW.tenant_id AND wo.factory_id=NEW.factory_id
        AND wo.status NOT IN ('COMPLETED','CANCELLED')) THEN
      RAISE EXCEPTION 'An asset with open maintenance work orders cannot be retired' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_maintenance_asset_retirement_guard
BEFORE UPDATE OF status ON maintenance_assets
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_maintenance_asset_retirement();

ALTER TABLE maintenance_work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_work_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_work_orders_tenant_isolation ON maintenance_work_orders
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE maintenance_work_order_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_work_order_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_work_order_tasks_tenant_isolation ON maintenance_work_order_tasks
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE maintenance_work_order_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_work_order_parts FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_work_order_parts_tenant_isolation ON maintenance_work_order_parts
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE maintenance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_events FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_events_tenant_isolation ON maintenance_events
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations(version, checksum)
VALUES ('100_maintenance_work_orders_and_spares', NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
