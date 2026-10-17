BEGIN;

-- Constraint triggers run at commit. A row may be updated several times in one
-- transaction (multiple order lines can share one bin), so compare the final
-- stored balance with the final set of active reservations, not each queued NEW
-- row snapshot captured midway through the transaction.
CREATE OR REPLACE FUNCTION factoryos_assert_inventory_location_reserved_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_id UUID;
  v_factory_id UUID;
  v_item_id UUID;
  v_location_id UUID;
  v_current_reserved NUMERIC(18, 4);
  v_active_reservations NUMERIC(18, 4);
  v_old_active_reservations NUMERIC(18, 4);
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_tenant_id := OLD.tenant_id;
    v_factory_id := OLD.factory_id;
    v_item_id := OLD.item_id;
    v_location_id := OLD.location_id;
  ELSE
    v_tenant_id := NEW.tenant_id;
    v_factory_id := NEW.factory_id;
    v_item_id := NEW.item_id;
    v_location_id := NEW.location_id;
  END IF;

  SELECT COALESCE(SUM(r.quantity), 0)
    INTO v_active_reservations
  FROM inventory_reservations r
  WHERE r.tenant_id = v_tenant_id
    AND r.factory_id = v_factory_id
    AND r.item_id = v_item_id
    AND r.location_id = v_location_id
    AND r.status = 'RESERVED';

  IF TG_OP = 'DELETE' THEN
    IF v_active_reservations > 0 THEN
      RAISE EXCEPTION 'cannot delete a location balance with active bin reservations'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND ROW(NEW.tenant_id, NEW.factory_id, NEW.item_id, NEW.location_id)
         IS DISTINCT FROM
         ROW(OLD.tenant_id, OLD.factory_id, OLD.item_id, OLD.location_id) THEN
    SELECT COALESCE(SUM(r.quantity), 0)
      INTO v_old_active_reservations
    FROM inventory_reservations r
    WHERE r.tenant_id = OLD.tenant_id
      AND r.factory_id = OLD.factory_id
      AND r.item_id = OLD.item_id
      AND r.location_id = OLD.location_id
      AND r.status = 'RESERVED';

    IF v_old_active_reservations > 0 THEN
      RAISE EXCEPTION 'cannot rebind a location balance with active bin reservations'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT lb.quantity_reserved
    INTO v_current_reserved
  FROM inventory_location_balances lb
  WHERE lb.tenant_id = v_tenant_id
    AND lb.factory_id = v_factory_id
    AND lb.item_id = v_item_id
    AND lb.location_id = v_location_id;

  IF NOT FOUND THEN
    IF v_active_reservations > 0 THEN
      RAISE EXCEPTION 'active bin reservations require a persisted location balance'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF v_current_reserved IS DISTINCT FROM v_active_reservations THEN
    RAISE EXCEPTION
      'location reserved quantity (%) must equal active bin reservations (%)',
      v_current_reserved, v_active_reservations
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- Restrict the order-level final-state guard to lifecycle transitions only.
DROP TRIGGER IF EXISTS ctr_order_inventory_reservation_allocation_guard ON orders;
CREATE CONSTRAINT TRIGGER ctr_order_inventory_reservation_allocation_guard
AFTER UPDATE OF status ON orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION factoryos_assert_order_line_inventory_allocation();

COMMENT ON FUNCTION factoryos_assert_inventory_location_reserved_balance() IS
  'Deferred bin consistency guard compares final transaction state so repeated updates to one location in a transaction remain valid.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('079_inventory_bin_balance_deferred_final_state_guard', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
