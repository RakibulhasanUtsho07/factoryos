BEGIN;

-- Once a sales-order line is managed by production work orders, do not allow
-- new output rows to bypass the final routing operation via the legacy
-- order-level reporting endpoint or direct SQL.
CREATE OR REPLACE FUNCTION factoryos_guard_unlinked_production_report_route()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.work_order_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Serialize the route check with work-order creation, which locks this order
  -- and line before allocating a production target.
  PERFORM 1
  FROM orders o
  WHERE o.id = NEW.order_id
    AND o.tenant_id = NEW.tenant_id
    AND o.factory_id = NEW.factory_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'production report order is missing from its factory scope'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM work_orders wo
    WHERE wo.source_order_id = NEW.order_id
      AND wo.source_order_line_id = NEW.order_line_id
      AND wo.tenant_id = NEW.tenant_id
      AND wo.factory_id = NEW.factory_id
  ) THEN
    RAISE EXCEPTION
      'production output for an order line with a work order must be recorded against the active final operation'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_order_production_report_work_order_path_guard
BEFORE INSERT ON order_production_reports
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_unlinked_production_report_route();

INSERT INTO schema_migrations (version, checksum)
VALUES ('092_order_production_report_work_order_routing_guard', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
