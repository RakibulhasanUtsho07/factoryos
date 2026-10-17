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
  v_balance_guard_trigger BOOLEAN;
  v_balance_guard_function BOOLEAN;
  v_multi_bin_unique_index BOOLEAN;
  v_order_allocation_trigger BOOLEAN;
  v_reservation_allocation_trigger BOOLEAN;
  v_order_allocation_function BOOLEAN;
  v_final_state_balance_guard BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '065_inventory_bin_reservations'
  ) THEN
    RAISE EXCEPTION 'WP02 bin reservation migration marker is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '078_multi_bin_order_reservation_allocation'
  ) THEN
    RAISE EXCEPTION 'WP02 multi-bin order allocation migration marker is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '079_inventory_bin_balance_deferred_final_state_guard'
  ) THEN
    RAISE EXCEPTION 'WP02 final-state bin balance guard migration marker is missing';
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

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'inventory_location_balances'::regclass
      AND tgname = 'ctr_inventory_location_balance_reserved_consistency'
      AND NOT tgisinternal
      AND tgdeferrable
      AND tginitdeferred
      AND tgenabled <> 'D'
  ) INTO v_balance_guard_trigger;

  SELECT position(
    'inventory_reservations' IN
    pg_get_functiondef('factoryos_assert_inventory_location_reserved_balance()'::regprocedure)
  ) > 0 INTO v_balance_guard_function;

  SELECT position(
    'SELECT lb.quantity_reserved' IN
    pg_get_functiondef('factoryos_assert_inventory_location_reserved_balance()'::regprocedure)
  ) > 0 INTO v_final_state_balance_guard;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'inventory_reservations'
      AND indexname = 'uq_inventory_order_line_bin_active'
  ) INTO v_multi_bin_unique_index;

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'orders'::regclass
      AND tgname = 'ctr_order_inventory_reservation_allocation_guard'
      AND NOT tgisinternal AND tgdeferrable AND tginitdeferred AND tgenabled <> 'D'
  ) INTO v_order_allocation_trigger;

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'inventory_reservations'::regclass
      AND tgname = 'ctr_inventory_order_reservation_allocation_guard'
      AND NOT tgisinternal AND tgdeferrable AND tginitdeferred AND tgenabled <> 'D'
  ) INTO v_reservation_allocation_trigger;

  SELECT position('IN_PROGRESS' IN
    pg_get_functiondef('factoryos_assert_order_line_inventory_allocation()'::regprocedure)) > 0
    INTO v_order_allocation_function;

  IF NOT v_reserved_column OR NOT v_location_column OR NOT v_location_fk
     OR NOT v_location_balance_check OR NOT v_location_balance_trigger
     OR NOT v_reserved_stock_guard OR NOT v_balance_guard_trigger
     OR NOT v_balance_guard_function OR NOT v_multi_bin_unique_index
     OR NOT v_order_allocation_trigger OR NOT v_reservation_allocation_trigger
     OR NOT v_order_allocation_function OR NOT v_final_state_balance_guard THEN
    RAISE EXCEPTION
      'WP02 bin reservation schema is incomplete: reserved_column %, location_column %, location_fk %, balance_check %, reservation_consistency %, reserved_stock_guard %, balance_guard_trigger %, balance_guard_function %, multi_bin_unique %, order_guard %, reservation_guard %, order_guard_function %, final_state_balance_guard %',
      v_reserved_column, v_location_column, v_location_fk, v_location_balance_check,
      v_location_balance_trigger, v_reserved_stock_guard, v_balance_guard_trigger,
      v_balance_guard_function, v_multi_bin_unique_index, v_order_allocation_trigger,
      v_reservation_allocation_trigger, v_order_allocation_function, v_final_state_balance_guard;
  END IF;

  RAISE NOTICE 'WP02 bin-bound reservation schema checks passed';
END;
$$;

ROLLBACK;
