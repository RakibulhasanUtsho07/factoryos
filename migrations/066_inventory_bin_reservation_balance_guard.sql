BEGIN;

-- WP02 guard: reservation aggregates must agree even when a stock balance is
-- changed outside the reservation service. The check is deferred so a single
-- transaction can update the balance and reservation row in either order.
CREATE OR REPLACE FUNCTION factoryos_assert_inventory_location_reserved_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_id UUID;
  v_factory_id UUID;
  v_item_id UUID;
  v_location_id UUID;
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

  IF NEW.quantity_reserved IS DISTINCT FROM v_active_reservations THEN
    RAISE EXCEPTION
      'location reserved quantity (%) must equal active bin reservations (%)',
      NEW.quantity_reserved, v_active_reservations
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ctr_inventory_location_balance_reserved_consistency
  ON inventory_location_balances;

CREATE CONSTRAINT TRIGGER ctr_inventory_location_balance_reserved_consistency
AFTER INSERT OR UPDATE OR DELETE ON inventory_location_balances
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION factoryos_assert_inventory_location_reserved_balance();

COMMENT ON FUNCTION factoryos_assert_inventory_location_reserved_balance() IS
  'Enforces deferred equality between each bin balance reserved quantity and active reservations pinned to that bin, including direct balance writes.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('066_inventory_bin_reservation_balance_guard', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
