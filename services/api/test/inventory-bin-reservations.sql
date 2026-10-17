-- WP02 bin-bound inventory reservation schema regression.
BEGIN;

DO $$
DECLARE
  v_reserved_column BOOLEAN;
  v_location_column BOOLEAN;
  v_location_fk BOOLEAN;
  v_location_balance_check BOOLEAN;
  v_location_balance_trigger BOOLEAN;
  v_reserved_stock_guard BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '065_inventory_bin_reservations'
  ) THEN
    RAISE EXCEPTION 'WP02 bin reservation migration marker is missing';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'inventory_location_balances'
      AND column_name = 'quantity_reserved'
  ) INTO v_reserved_column;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'inventory_reservations'
      AND column_name = 'location_id'
  ) INTO v_location_column;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'inventory_reservations'::regclass
      AND conname = 'fk_inventory_reservation_location_scope'
      AND contype = 'f'
  ) INTO v_location_fk;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'inventory_location_balances'::regclass
      AND conname = 'chk_inventory_location_balance_reserved'
      AND contype = 'c'
  ) INTO v_location_balance_check;

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'inventory_reservations'::regclass
      AND tgname = 'ctr_inventory_location_reservation_balance_consistency'
      AND NOT tgisinternal
      AND tgdeferrable
      AND tginitdeferred
      AND tgenabled <> 'D'
  ) INTO v_location_balance_trigger;

  SELECT position('quantity_reserved' IN pg_get_functiondef('factoryos_sync_inventory_location_balance()'::regprocedure)) > 0
    INTO v_reserved_stock_guard;

  IF NOT v_reserved_column OR NOT v_location_column OR NOT v_location_fk
     OR NOT v_location_balance_check OR NOT v_location_balance_trigger
     OR NOT v_reserved_stock_guard THEN
    RAISE EXCEPTION
      'WP02 bin reservation schema is incomplete: reserved_column %, location_column %, location_fk %, balance_check %, deferred_consistency %, reserved_stock_guard %',
      v_reserved_column, v_location_column, v_location_fk, v_location_balance_check,
      v_location_balance_trigger, v_reserved_stock_guard;
  END IF;

  RAISE NOTICE 'WP02 bin-bound reservation schema checks passed';
END;
$$;

ROLLBACK;
