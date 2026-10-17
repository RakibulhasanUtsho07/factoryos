-- WP02 supplier / purchase-order lifecycle schema and behavior regression.
BEGIN;
DO $$
DECLARE
  v_tenant UUID := gen_random_uuid();
  v_factory UUID := gen_random_uuid();
  v_creator UUID := gen_random_uuid();
  v_approver UUID := gen_random_uuid();
  v_supplier UUID := gen_random_uuid();
  v_order UUID := gen_random_uuid();
  v_cancel_order UUID := gen_random_uuid();
  v_line UUID := gen_random_uuid();
  v_request UUID := gen_random_uuid();
  v_trace UUID := gen_random_uuid();
  v_rls_tables INTEGER;
  v_permissions INTEGER;
  v_functions INTEGER;
  v_triggers INTEGER;
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

  INSERT INTO tenants (id, slug, name) VALUES (v_tenant, 'procurement-test-' || v_tenant::text, 'Procurement Test');
  INSERT INTO users (id, display_name) VALUES (v_creator, 'Procurement Creator'), (v_approver, 'Procurement Approver');
  INSERT INTO factories (id, tenant_id, code, name) VALUES (v_factory, v_tenant, 'PROC-TEST', 'Procurement Test Factory');

  -- Match the transaction-local identity used by the production DatabaseService.
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  PERFORM set_config('app.user_id', v_creator::text, true);
  PERFORM set_config('app.request_id', v_request::text, true);
  PERFORM set_config('app.trace_id', v_trace::text, true);

  INSERT INTO suppliers (id, tenant_id, code, name, created_by_user_id)
    VALUES (v_supplier, v_tenant, 'SUP-TEST', 'Procurement Test Supplier', v_creator);
  INSERT INTO purchase_orders (id, tenant_id, factory_id, supplier_id, po_number, created_by_user_id)
    VALUES (v_order, v_tenant, v_factory, v_supplier, 'PO-TEST-001', v_creator);
  INSERT INTO purchase_order_lines (
    id, tenant_id, factory_id, purchase_order_id, line_number, description, quantity, unit, unit_price
  ) VALUES (v_line, v_tenant, v_factory, v_order, 1, 'Test raw material', 2.5, 'KG', 4);
  INSERT INTO purchase_order_status_history (
    tenant_id, factory_id, purchase_order_id, from_status, to_status, version, actor_user_id, reason
  ) VALUES (v_tenant, v_factory, v_order, NULL, 'DRAFT', 1, v_creator, 'Purchase order created');

  -- A draft can be revised; computed line amounts remain database-owned.
  UPDATE purchase_order_lines SET quantity = 3 WHERE id = v_line;
  IF (SELECT line_amount FROM purchase_order_lines WHERE id = v_line) <> 12 THEN
    RAISE EXCEPTION 'Expected generated line amount 12 after draft quantity edit';
  END IF;
  UPDATE purchase_orders SET notes = 'Draft terms edited', version = version + 1 WHERE id = v_order;
  INSERT INTO purchase_order_status_history (
    tenant_id, factory_id, purchase_order_id, from_status, to_status, version, actor_user_id, reason
  ) VALUES (v_tenant, v_factory, v_order, 'DRAFT', 'DRAFT', 2, v_creator, 'Draft terms edited');

  UPDATE purchase_orders SET status = 'SUBMITTED', submitted_by_user_id = v_creator,
    submitted_at = clock_timestamp(), version = version + 1 WHERE id = v_order;
  INSERT INTO purchase_order_status_history (
    tenant_id, factory_id, purchase_order_id, from_status, to_status, version, actor_user_id, reason
  ) VALUES (v_tenant, v_factory, v_order, 'DRAFT', 'SUBMITTED', 3, v_creator, 'Submitted in schema regression test');

  BEGIN
    UPDATE purchase_order_lines SET quantity = 4 WHERE id = v_line;
    RAISE EXCEPTION 'Expected submitted purchase-order lines to be immutable';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE purchase_order_lines SET purchase_order_id = gen_random_uuid() WHERE id = v_line;
    RAISE EXCEPTION 'Expected purchase-order line parent identity changes to be rejected';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    UPDATE purchase_orders SET status = 'APPROVED', approved_by_user_id = v_creator,
      approved_at = clock_timestamp(), version = version + 1 WHERE id = v_order;
    RAISE EXCEPTION 'Expected purchase-order creator self-approval to be rejected';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE purchase_orders SET status = 'APPROVED', approved_by_user_id = v_approver,
      approved_at = clock_timestamp(), version = version + 1 WHERE id = v_order;
    RAISE EXCEPTION 'Expected approval actor spoofing from a different database identity to be rejected';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE purchase_orders SET status = 'DRAFT', version = version + 1 WHERE id = v_order;
    RAISE EXCEPTION 'Expected invalid status regression to be rejected';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  PERFORM set_config('app.user_id', v_approver::text, true);
  UPDATE purchase_orders SET status = 'APPROVED', approved_by_user_id = v_approver,
    approved_at = clock_timestamp(), version = version + 1 WHERE id = v_order;
  INSERT INTO purchase_order_status_history (
    tenant_id, factory_id, purchase_order_id, from_status, to_status, version, actor_user_id, reason
  ) VALUES (v_tenant, v_factory, v_order, 'SUBMITTED', 'APPROVED', 4, v_approver, 'Approved in schema regression test');

  BEGIN
    UPDATE purchase_order_status_history SET reason = 'tampered' WHERE purchase_order_id = v_order AND version = 4;
    RAISE EXCEPTION 'Expected status history mutation to be rejected';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    UPDATE purchase_orders SET approved_by_user_id = v_creator, version = version + 1 WHERE id = v_order;
    RAISE EXCEPTION 'Expected approval actor provenance to be immutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    INSERT INTO purchase_order_status_history (
      tenant_id, factory_id, purchase_order_id, from_status, to_status, version, actor_user_id, reason
    ) VALUES (v_tenant, v_factory, v_order, 'APPROVED', 'DRAFT', 5, v_creator, 'Injected invalid history');
    RAISE EXCEPTION 'Expected history that does not match aggregate state to be rejected';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A draft cancellation cannot fabricate a submission actor/timestamp.
  PERFORM set_config('app.user_id', v_creator::text, true);
  INSERT INTO purchase_orders (id, tenant_id, factory_id, supplier_id, po_number, created_by_user_id)
    VALUES (v_cancel_order, v_tenant, v_factory, v_supplier, 'PO-TEST-002', v_creator);
  INSERT INTO purchase_order_status_history (
    tenant_id, factory_id, purchase_order_id, from_status, to_status, version, actor_user_id, reason
  ) VALUES (v_tenant, v_factory, v_cancel_order, NULL, 'DRAFT', 1, v_creator, 'Purchase order created');

  BEGIN
    UPDATE purchase_orders SET status = 'CANCELLED',
      submitted_by_user_id = v_creator, submitted_at = clock_timestamp(),
      cancelled_by_user_id = v_creator, cancelled_at = clock_timestamp(),
      cancellation_reason = 'No longer needed', version = version + 1
    WHERE id = v_cancel_order;
    RAISE EXCEPTION 'Expected draft cancellation from fabricating submission provenance to be rejected';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  UPDATE purchase_orders SET status = 'CANCELLED',
    cancelled_by_user_id = v_creator, cancelled_at = clock_timestamp(),
    cancellation_reason = 'No longer needed', version = version + 1
  WHERE id = v_cancel_order;
  INSERT INTO purchase_order_status_history (
    tenant_id, factory_id, purchase_order_id, from_status, to_status, version, actor_user_id, reason
  ) VALUES (v_tenant, v_factory, v_cancel_order, 'DRAFT', 'CANCELLED', 2, v_creator, 'No longer needed');

  IF NOT EXISTS (
    SELECT 1 FROM audit_events
    WHERE tenant_id = v_tenant AND resource_type = 'SUPPLIER'
      AND resource_id = v_supplier AND action = 'CREATE'
      AND actor_user_id = v_creator AND request_id = v_request
      AND correlation_id = v_trace AND payload->>'version' = '1'
  ) THEN
    RAISE EXCEPTION 'Expected supplier creation audit with actor/request/trace correlation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM audit_events
    WHERE tenant_id = v_tenant AND resource_type = 'PURCHASE_ORDER'
      AND resource_id = v_order AND action = 'CREATE'
      AND payload->>'version' = '1'
  ) THEN
    RAISE EXCEPTION 'Expected purchase-order creation audit to be written transactionally';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM audit_events
    WHERE tenant_id = v_tenant AND resource_type = 'PURCHASE_ORDER'
      AND resource_id = v_order AND action = 'DRAFT_UPDATED'
      AND payload->>'version' = '2'
  ) THEN
    RAISE EXCEPTION 'Expected draft edit audit to be written transactionally';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM audit_events
    WHERE tenant_id = v_tenant AND resource_type = 'PURCHASE_ORDER'
      AND resource_id = v_order AND action = 'STATUS_CHANGED'
      AND payload->>'version' = '3'
  ) THEN
    RAISE EXCEPTION 'Expected submission audit to be written transactionally';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM audit_events
    WHERE tenant_id = v_tenant AND resource_type = 'PURCHASE_ORDER'
      AND resource_id = v_order AND action = 'STATUS_CHANGED'
      AND payload->>'version' = '4'
  ) THEN
    RAISE EXCEPTION 'Expected approval audit to be written transactionally';
  END IF;

  -- Every version written during the test must have its own current-state history row.
  SET CONSTRAINTS ALL IMMEDIATE;

  RAISE NOTICE 'WP02 supplier and purchase-order lifecycle, versioning, and audit checks passed';
END;
$$;
ROLLBACK;
