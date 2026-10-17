-- WP02 supplier / purchase-order lifecycle schema and security regression.
BEGIN;
DO $$
DECLARE v_rls_tables INTEGER; v_permissions INTEGER; v_functions INTEGER; v_triggers INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '067_supplier_purchase_order_lifecycle') THEN
    RAISE EXCEPTION 'WP02 supplier/purchase-order migration marker is missing';
  END IF;
  IF to_regclass('suppliers') IS NULL OR to_regclass('purchase_orders') IS NULL
     OR to_regclass('purchase_order_lines') IS NULL OR to_regclass('purchase_order_status_history') IS NULL THEN
    RAISE EXCEPTION 'WP02 procurement tables are incomplete';
  END IF;
  SELECT count(*) INTO v_rls_tables FROM pg_class c
  WHERE c.oid IN ('suppliers'::regclass, 'purchase_orders'::regclass,
    'purchase_order_lines'::regclass, 'purchase_order_status_history'::regclass)
    AND c.relrowsecurity AND c.relforcerowsecurity;
  IF v_rls_tables <> 4 THEN RAISE EXCEPTION 'Expected RLS + FORCE RLS on 4 procurement tables, found %', v_rls_tables; END IF;
  SELECT count(*) INTO v_permissions FROM permissions
  WHERE code IN ('suppliers.read', 'suppliers.write', 'purchase_orders.read', 'purchase_orders.write', 'purchase_orders.approve');
  IF v_permissions <> 5 THEN RAISE EXCEPTION 'Expected 5 procurement permissions, found %', v_permissions; END IF;
  SELECT count(*) INTO v_functions FROM pg_proc WHERE proname IN (
    'factoryos_guard_supplier_lifecycle', 'factoryos_guard_purchase_order_lifecycle',
    'factoryos_guard_purchase_order_line_lifecycle', 'factoryos_guard_purchase_order_history_immutable');
  IF v_functions <> 4 THEN RAISE EXCEPTION 'Expected 4 procurement integrity functions, found %', v_functions; END IF;
  SELECT count(*) INTO v_triggers FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
    'trg_suppliers_lifecycle_guard', 'trg_purchase_orders_lifecycle_guard',
    'trg_purchase_order_lines_lifecycle_guard', 'trg_purchase_order_history_immutable') AND tgenabled <> 'D';
  IF v_triggers <> 4 THEN RAISE EXCEPTION 'Expected 4 enabled procurement integrity triggers, found %', v_triggers; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'purchase_orders'::regclass AND conname = 'uq_purchase_orders_idempotency')
  THEN RAISE EXCEPTION 'Purchase-order idempotency uniqueness is missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'purchase_order_lines'::regclass
    AND conname = 'fk_purchase_order_lines_inventory_scope' AND contype = 'f')
  THEN RAISE EXCEPTION 'Purchase-order line inventory scope FK is missing'; END IF;
  RAISE NOTICE 'WP02 supplier and purchase-order lifecycle schema checks passed';
END;
$$;
ROLLBACK;
