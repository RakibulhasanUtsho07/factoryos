-- Min/max reorder policy integrity, tenant scope, and versioning regression.
BEGIN;
DO $$
DECLARE
  v_tenant UUID := gen_random_uuid();
  v_factory UUID := gen_random_uuid();
  v_actor UUID := gen_random_uuid();
  v_supplier UUID := gen_random_uuid();
  v_item UUID := gen_random_uuid();
  v_policy UUID := gen_random_uuid();
  v_rls_enabled BOOLEAN;
  v_permission_count INTEGER;
  v_version BIGINT;
  v_rejected BOOLEAN := FALSE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '081_inventory_reorder_replenishment'
  ) THEN
    RAISE EXCEPTION 'inventory reorder/replenishment migration marker is missing';
  END IF;

  IF to_regclass('inventory_reorder_policies') IS NULL THEN
    RAISE EXCEPTION 'inventory_reorder_policies table is missing';
  END IF;

  SELECT c.relrowsecurity AND c.relforcerowsecurity INTO v_rls_enabled
  FROM pg_class c WHERE c.oid = 'inventory_reorder_policies'::regclass;
  IF NOT COALESCE(v_rls_enabled, FALSE) THEN
    RAISE EXCEPTION 'inventory_reorder_policies must force tenant row-level security';
  END IF;

  SELECT count(*) INTO v_permission_count
  FROM permissions
  WHERE code IN ('inventory.reorder.read', 'inventory.reorder.write');
  IF v_permission_count <> 2 THEN
    RAISE EXCEPTION 'expected both reorder permissions, found %', v_permission_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'inventory_reorder_policies'::regclass
      AND tgname = 'trg_inventory_reorder_policy_guard'
      AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'inventory reorder policy integrity trigger is missing or disabled';
  END IF;

  INSERT INTO tenants (id, slug, name)
  VALUES (v_tenant, 'reorder-test-' || v_tenant::text, 'Reorder Test');
  INSERT INTO users (id, display_name)
  VALUES (v_actor, 'Reorder Test Actor');
  INSERT INTO factories (id, tenant_id, code, name, status)
  VALUES (v_factory, v_tenant, 'REORDER-' || upper(substr(v_factory::text, 1, 8)), 'Reorder Test Factory', 'ACTIVE');

  PERFORM set_config('app.tenant_id', v_tenant::text, TRUE);
  PERFORM set_config('app.user_id', v_actor::text, TRUE);
  PERFORM set_config('app.request_id', gen_random_uuid()::text, TRUE);
  PERFORM set_config('app.trace_id', gen_random_uuid()::text, TRUE);

  INSERT INTO suppliers (id, tenant_id, code, name, created_by_user_id)
  VALUES (v_supplier, v_tenant, 'REORDER-SUP-' || upper(substr(v_supplier::text, 1, 8)), 'Reorder Supplier', v_actor);

  INSERT INTO inventory_items (id, tenant_id, factory_id, sku, name, unit, created_by_user_id)
  VALUES (v_item, v_tenant, v_factory,
    'REORDER-SKU-' || upper(substr(v_item::text, 1, 8)), 'Reorder Test Item', 'PCS', v_actor);
  INSERT INTO inventory_stock_balances (tenant_id, factory_id, item_id, quantity_on_hand)
  VALUES (v_tenant, v_factory, v_item, 3);

  INSERT INTO inventory_reorder_policies (
    id, tenant_id, factory_id, item_id, minimum_quantity, maximum_quantity,
    lead_time_days, preferred_supplier_id, enabled, created_by_user_id, updated_by_user_id
  ) VALUES (
    v_policy, v_tenant, v_factory, v_item, 5, 20, 7, v_supplier, TRUE, v_actor, v_actor
  );

  -- Changes without a version increment are rejected by the database.
  BEGIN
    UPDATE inventory_reorder_policies
    SET minimum_quantity = 6
    WHERE id = v_policy;
  EXCEPTION WHEN check_violation THEN
    v_rejected := TRUE;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'reorder policy accepted a change without incrementing version';
  END IF;

  -- Invalid threshold ordering fails even when the version is advanced correctly.
  v_rejected := FALSE;
  BEGIN
    UPDATE inventory_reorder_policies
    SET minimum_quantity = 20, maximum_quantity = 20, version = version + 1
    WHERE id = v_policy;
  EXCEPTION WHEN check_violation THEN
    v_rejected := TRUE;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'reorder policy accepted maximum_quantity <= minimum_quantity';
  END IF;

  UPDATE inventory_reorder_policies
  SET minimum_quantity = 6, version = version + 1,
      updated_by_user_id = v_actor, updated_at = clock_timestamp()
  WHERE id = v_policy;

  SELECT version INTO v_version
  FROM inventory_reorder_policies
  WHERE id = v_policy;
  IF v_version <> 2 THEN
    RAISE EXCEPTION 'expected reorder policy version 2 after a valid update, found %', v_version;
  END IF;

  v_rejected := FALSE;
  BEGIN
    DELETE FROM inventory_reorder_policies WHERE id = v_policy;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_rejected := TRUE;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'reorder policy deletion was not blocked';
  END IF;
END;
$$;
ROLLBACK;
