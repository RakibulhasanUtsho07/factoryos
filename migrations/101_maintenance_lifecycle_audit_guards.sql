BEGIN;

-- Parent assignment and deletion guards preserve the asset tree and records.
CREATE OR REPLACE FUNCTION factoryos_guard_maintenance_asset_hierarchy()
RETURNS trigger LANGUAGE plpgsql AS $
DECLARE
  v_parent UUID;
  v_parent_status VARCHAR(16);
  v_seen UUID[] := ARRAY[]::UUID[];
BEGIN
  IF NEW.parent_asset_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_asset_id = NEW.id THEN
    RAISE EXCEPTION 'An asset cannot be its own parent' USING ERRCODE='23514';
  END IF;
  SELECT a.parent_asset_id,a.status INTO v_parent,v_parent_status
  FROM maintenance_assets a
  WHERE a.id=NEW.parent_asset_id AND a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Parent asset must belong to the same tenant and factory' USING ERRCODE='23503';
  END IF;
  IF v_parent_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'An asset must be linked under an active parent' USING ERRCODE='23514';
  END IF;
  v_seen:=array_append(v_seen,NEW.parent_asset_id);
  WHILE v_parent IS NOT NULL LOOP
    IF v_parent=NEW.id OR v_parent=ANY(v_seen) THEN
      RAISE EXCEPTION 'Asset hierarchy cannot contain a cycle' USING ERRCODE='23514';
    END IF;
    v_seen:=array_append(v_seen,v_parent);
    SELECT a.parent_asset_id INTO v_parent
    FROM maintenance_assets a
    WHERE a.id=v_parent AND a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Asset ancestry must remain inside the same factory' USING ERRCODE='23503';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$;

CREATE OR REPLACE FUNCTION factoryos_prevent_maintenance_entity_delete()
RETURNS trigger LANGUAGE plpgsql AS $
BEGIN
  RAISE EXCEPTION 'Maintenance registry, plan and work-order records are retained for audit; use lifecycle transitions'
    USING ERRCODE='55000';
END;
$;
CREATE TRIGGER trg_maintenance_asset_delete_guard
BEFORE DELETE ON maintenance_assets
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_maintenance_entity_delete();
CREATE TRIGGER trg_maintenance_pm_plan_delete_guard
BEFORE DELETE ON maintenance_pm_plans
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_maintenance_entity_delete();
CREATE TRIGGER trg_maintenance_work_order_delete_guard
BEFORE DELETE ON maintenance_work_orders
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_maintenance_entity_delete();

-- A changed maintenance record must advance exactly one version. The service
-- records the matching immutable event in the same transaction.
CREATE OR REPLACE FUNCTION factoryos_guard_maintenance_asset_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'Asset updates must increment row_version exactly once' USING ERRCODE='23514';
  END IF;
  IF NEW.asset_code IS DISTINCT FROM OLD.asset_code THEN
    RAISE EXCEPTION 'Asset codes are immutable; register a replacement asset instead' USING ERRCODE='23514';
  END IF;
  IF NEW.status <> 'ACTIVE' AND OLD.status='ACTIVE' THEN
    IF EXISTS (SELECT 1 FROM maintenance_assets child
      WHERE child.parent_asset_id=OLD.id AND child.tenant_id=OLD.tenant_id AND child.factory_id=OLD.factory_id
        AND child.status='ACTIVE') THEN
      RAISE EXCEPTION 'An asset with active child assets cannot be inactivated or retired' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM maintenance_work_orders wo
      WHERE wo.asset_id=OLD.id AND wo.tenant_id=OLD.tenant_id AND wo.factory_id=OLD.factory_id
        AND wo.status NOT IN ('COMPLETED','CANCELLED')) THEN
      RAISE EXCEPTION 'An asset with open maintenance work orders cannot be inactivated or retired' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_maintenance_asset_update_guard
BEFORE UPDATE ON maintenance_assets
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_maintenance_asset_update();

CREATE OR REPLACE FUNCTION factoryos_guard_maintenance_pm_plan_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'Preventive-maintenance plan updates must increment row_version exactly once' USING ERRCODE='23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status='DRAFT' AND NEW.status IN ('ACTIVE','RETIRED')) OR
    (OLD.status='ACTIVE' AND NEW.status IN ('PAUSED','RETIRED')) OR
    (OLD.status='PAUSED' AND NEW.status IN ('ACTIVE','RETIRED'))
  ) THEN
    RAISE EXCEPTION 'Invalid preventive-maintenance plan transition: % -> %',OLD.status,NEW.status USING ERRCODE='23514';
  END IF;
  IF NEW.status='ACTIVE' AND OLD.status <> 'ACTIVE' THEN
    IF NEW.approved_by_user_id IS NULL OR NEW.approved_by_user_id=NEW.created_by_user_id THEN
      RAISE EXCEPTION 'Activating a preventive-maintenance plan requires an independent approver' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM maintenance_assets a
      WHERE a.id=NEW.asset_id AND a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id AND a.status='ACTIVE') THEN
      RAISE EXCEPTION 'Preventive-maintenance plan requires an active asset' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_maintenance_pm_plan_update_guard
BEFORE UPDATE ON maintenance_pm_plans
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_maintenance_pm_plan_update();

CREATE OR REPLACE FUNCTION factoryos_guard_maintenance_task_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Maintenance checklist tasks cannot be deleted' USING ERRCODE='55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1
    OR OLD.status <> 'PENDING' OR NEW.status <> 'COMPLETED'
    OR NEW.work_order_id <> OLD.work_order_id
    OR NEW.task_code <> OLD.task_code
    OR NEW.description <> OLD.description
    OR NEW.sequence_no <> OLD.sequence_no
    OR NEW.is_required <> OLD.is_required
    OR NEW.created_by_user_id <> OLD.created_by_user_id
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.request_hash <> OLD.request_hash THEN
    RAISE EXCEPTION 'Checklist task only supports an audited PENDING to COMPLETED transition' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM maintenance_work_orders wo
    WHERE wo.id=NEW.work_order_id AND wo.tenant_id=NEW.tenant_id AND wo.factory_id=NEW.factory_id
      AND wo.status='IN_PROGRESS') THEN
    RAISE EXCEPTION 'Checklist tasks may only be completed while the work order is in progress' USING ERRCODE='23514';
  END IF;
  IF NEW.completed_by_user_id IS NULL OR NEW.completed_at IS NULL
    OR NEW.completion_reason IS NULL OR length(btrim(NEW.completion_reason))=0 THEN
    RAISE EXCEPTION 'Checklist completion requires an actor, timestamp and reason' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_maintenance_task_update_guard
BEFORE UPDATE OR DELETE ON maintenance_work_order_tasks
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_maintenance_task_update();

CREATE OR REPLACE FUNCTION factoryos_guard_maintenance_part_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_delta NUMERIC(18,4);
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Maintenance spare-part evidence cannot be deleted' USING ERRCODE='55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1
    OR NEW.work_order_id <> OLD.work_order_id
    OR NEW.inventory_item_id <> OLD.inventory_item_id
    OR NEW.required_quantity <> OLD.required_quantity
    OR NEW.created_by_user_id <> OLD.created_by_user_id
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.request_hash <> OLD.request_hash THEN
    RAISE EXCEPTION 'Spare-part requirement identity is immutable and updates must be versioned' USING ERRCODE='23514';
  END IF;
  v_delta := NEW.issued_quantity - OLD.issued_quantity;
  IF v_delta <= 0 OR NOT EXISTS (
    SELECT 1 FROM inventory_movements m
    WHERE m.tenant_id=NEW.tenant_id AND m.factory_id=NEW.factory_id
      AND m.item_id=NEW.inventory_item_id AND m.movement_type='ISSUE'
      AND m.reference_type='MAINTENANCE_WORK_ORDER_PART' AND m.reference_id=NEW.id
      AND m.quantity=v_delta AND m.quantity_delta=-v_delta
  ) THEN
    RAISE EXCEPTION 'Issued spare-part quantity must match a committed inventory ISSUE movement' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM maintenance_work_orders wo
    WHERE wo.id=NEW.work_order_id AND wo.tenant_id=NEW.tenant_id AND wo.factory_id=NEW.factory_id
      AND wo.status='IN_PROGRESS') THEN
    RAISE EXCEPTION 'Spare parts can only be issued to an in-progress work order' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_maintenance_part_update_guard
BEFORE UPDATE OR DELETE ON maintenance_work_order_parts
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_maintenance_part_update();

CREATE OR REPLACE FUNCTION factoryos_require_maintenance_entity_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_entity_type TEXT;
  v_entity_id UUID;
  v_tenant_id UUID;
  v_factory_id UUID;
  v_version BIGINT;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'maintenance_assets' THEN v_entity_type:='ASSET';
    WHEN 'maintenance_pm_plans' THEN v_entity_type:='PM_PLAN';
    WHEN 'maintenance_work_orders' THEN v_entity_type:='WORK_ORDER';
    WHEN 'maintenance_work_order_tasks' THEN v_entity_type:='WORK_ORDER_TASK';
    WHEN 'maintenance_work_order_parts' THEN v_entity_type:='WORK_ORDER_PART';
    ELSE RAISE EXCEPTION 'Unknown maintenance entity table %',TG_TABLE_NAME;
  END CASE;
  v_entity_id:=NEW.id;
  v_tenant_id:=NEW.tenant_id;
  v_factory_id:=NEW.factory_id;
  v_version:=NEW.row_version;
  IF NOT EXISTS (SELECT 1 FROM maintenance_events e
    WHERE e.tenant_id=v_tenant_id AND e.factory_id=v_factory_id
      AND e.entity_type=v_entity_type AND e.entity_id=v_entity_id AND e.entity_version=v_version) THEN
    RAISE EXCEPTION 'Missing immutable maintenance event for % % version %',v_entity_type,v_entity_id,v_version
      USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_maintenance_assets_event_required
AFTER INSERT OR UPDATE ON maintenance_assets DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_require_maintenance_entity_event();
CREATE CONSTRAINT TRIGGER trg_maintenance_pm_plans_event_required
AFTER INSERT OR UPDATE ON maintenance_pm_plans DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_require_maintenance_entity_event();
CREATE CONSTRAINT TRIGGER trg_maintenance_work_orders_event_required
AFTER INSERT OR UPDATE ON maintenance_work_orders DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_require_maintenance_entity_event();
CREATE CONSTRAINT TRIGGER trg_maintenance_work_order_tasks_event_required
AFTER INSERT OR UPDATE ON maintenance_work_order_tasks DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_require_maintenance_entity_event();
CREATE CONSTRAINT TRIGGER trg_maintenance_work_order_parts_event_required
AFTER INSERT OR UPDATE ON maintenance_work_order_parts DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_require_maintenance_entity_event();

INSERT INTO schema_migrations(version, checksum)
VALUES ('101_maintenance_lifecycle_audit_guards', NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
