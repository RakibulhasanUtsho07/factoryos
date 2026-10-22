-- Permit only a versioned, one-time OPEN inspection sampling-profile bind after advanced-quality schema exists.
BEGIN;

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
      OR (OLD.status = 'OPEN' AND NEW.status = 'OPEN'
        AND OLD.aql_profile_id IS NULL AND OLD.fabric_scoring_profile_id IS NULL
        AND (NEW.aql_profile_id IS NOT NULL OR NEW.fabric_scoring_profile_id IS NOT NULL))
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

INSERT INTO schema_migrations (version, checksum)
VALUES ('165_quality_sampling_binding_state_guard', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
