-- Verify the migrated lot reservation schema is tenant isolated and has
-- reservation quantity conservation plus immutable issue receipts.
DO $$
DECLARE
  v_expected TEXT[];
  v_missing TEXT[];
  v_rel TEXT;
BEGIN
  v_expected := ARRAY[
    'inventory_lot_stock_balances',
    'inventory_reservation_lot_allocations',
    'inventory_reservation_consumptions',
    'inventory_reservation_consumption_lots'
  ];
  SELECT array_agg(t.rel ORDER BY t.rel) INTO v_missing
  FROM unnest(v_expected) AS t(rel)
  WHERE to_regclass('public.' || t.rel) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'lot reservation migration omitted required tables: %', v_missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='inventory_reservations' AND column_name='quantity_remaining'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='inventory_reservations' AND column_name='quantity_consumed'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='inventory_reservations' AND column_name='quantity_released'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='inventory_reservations' AND column_name='lot_policy_enforced'
  ) THEN
    RAISE EXCEPTION 'reservation quantity conservation columns are missing';
  END IF;

  FOREACH v_rel IN ARRAY v_expected LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=v_rel AND c.relkind IN ('r','p')
        AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'lot reservation table % must have ENABLE and FORCE ROW LEVEL SECURITY', v_rel;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname='public' AND p.tablename=v_rel
        AND p.qual LIKE '%factoryos_current_tenant_id%'
        AND p.with_check LIKE '%factoryos_current_tenant_id%'
    ) THEN
      RAISE EXCEPTION 'lot reservation table % is missing its tenant-scoped RLS policy', v_rel;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE NOT t.tgisinternal AND t.tgname='trg_inventory_reservation_lot_policy' AND t.tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE NOT t.tgisinternal AND t.tgname='trg_inventory_reservation_lot_allocation_guard' AND t.tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE NOT t.tgisinternal AND t.tgname='trg_inventory_reservation_consumption_immutable' AND t.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'reservation lot/consumption guard triggers are missing or disabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='inventory_location_transfers'
      AND column_name='traceability_unit_id'
  ) THEN
    RAISE EXCEPTION 'directed put-away/picking transfer is missing traceability_unit_id';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.inventory_reservations'::regclass
      AND c.conname='chk_inventory_reservation_quantity_conservation'
  ) THEN
    RAISE EXCEPTION 'reservation conservation constraint is missing';
  END IF;
END;
$$;
