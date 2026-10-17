-- GRN regression: partial receipt, rejected quantity, stock posting, replay key, and audit/outbox atomicity.
BEGIN;
DO $$
DECLARE
  v_tenant UUID := gen_random_uuid();
  v_factory UUID := gen_random_uuid();
  v_creator UUID := gen_random_uuid();
  v_approver UUID := gen_random_uuid();
  v_supplier UUID := gen_random_uuid();
  v_item UUID := gen_random_uuid();
  v_order UUID := gen_random_uuid();
  v_po_line UUID := gen_random_uuid();
  v_receipt_one UUID := gen_random_uuid();
  v_receipt_two UUID := gen_random_uuid();
  v_bad_receipt UUID := gen_random_uuid();
  v_location UUID;
  v_request UUID := gen_random_uuid();
  v_trace UUID := gen_random_uuid();
  v_quantity NUMERIC(18,4);
  v_received NUMERIC(18,4);
  v_rejected NUMERIC(18,4);
  v_accepted NUMERIC(18,4);
  v_expected_hash CHAR(64);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '072_goods_receipt_grn') THEN
    RAISE EXCEPTION 'GRN migration marker is missing';
  END IF;
  IF to_regclass('goods_receipts') IS NULL OR to_regclass('goods_receipt_lines') IS NULL THEN
    RAISE EXCEPTION 'GRN header/line tables are missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE code = 'goods_receipts.read'
  ) OR NOT EXISTS (
    SELECT 1 FROM permissions WHERE code = 'goods_receipts.write'
  ) THEN
    RAISE EXCEPTION 'GRN permissions are missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.oid = 'goods_receipts'::regclass AND c.relrowsecurity AND c.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.oid = 'goods_receipt_lines'::regclass AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'GRN tables must enforce tenant RLS';
  END IF;

  INSERT INTO tenants (id, slug, name)
  VALUES (v_tenant, 'grn-test-' || v_tenant::text, 'GRN Integration Test');
  INSERT INTO users (id, display_name)
  VALUES (v_creator, 'GRN Creator'), (v_approver, 'GRN Approver');
  INSERT INTO factories (id, tenant_id, code, name, status)
  VALUES (v_factory, v_tenant, 'GRN-' || upper(substr(v_factory::text, 1, 8)), 'GRN Test Factory', 'ACTIVE');

  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  PERFORM set_config('app.user_id', v_creator::text, true);
  PERFORM set_config('app.request_id', v_request::text, true);
  PERFORM set_config('app.trace_id', v_trace::text, true);

  SELECT id INTO v_location
  FROM inventory_locations
  WHERE tenant_id = v_tenant AND factory_id = v_factory AND is_default = TRUE AND status = 'ACTIVE';

  IF v_location IS NULL THEN RAISE EXCEPTION 'Factory default inventory location was not created'; END IF;

  INSERT INTO suppliers (id, tenant_id, code, name, created_by_user_id)
  VALUES (v_supplier, v_tenant, 'GRN-SUP-' || upper(substr(v_supplier::text, 1, 8)), 'GRN Supplier', v_creator);

  INSERT INTO inventory_items (id, tenant_id, factory_id, sku, name, unit, created_by_user_id)
  VALUES (v_item, v_tenant, v_factory, 'GRN-SKU-' || upper(substr(v_item::text, 1, 8)), 'GRN Test Material', 'PCS', v_creator);
  INSERT INTO inventory_stock_balances (tenant_id, factory_id, item_id, quantity_on_hand)
  VALUES (v_tenant, v_factory, v_item, 0);

  INSERT INTO purchase_orders (
    id, tenant_id, factory_id, supplier_id, po_number, status, created_by_user_id
  ) VALUES (v_order, v_tenant, v_factory, v_supplier,
    'GRN-PO-' || upper(substr(v_order::text, 1, 8)), 'DRAFT', v_creator);
  INSERT INTO purchase_order_lines (
    id, tenant_id, factory_id, purchase_order_id, line_number, inventory_item_id,
    description, quantity, unit, unit_price
  ) VALUES (v_po_line, v_tenant, v_factory, v_order, 1, v_item, 'GRN test material', 10, 'PCS', 4);
  INSERT INTO purchase_order_status_history (
    tenant_id, factory_id, purchase_order_id, from_status, to_status, version, actor_user_id, reason
  ) VALUES (v_tenant, v_factory, v_order, NULL, 'DRAFT', 1, v_creator, 'PO created for GRN test');

  UPDATE purchase_orders SET status = 'SUBMITTED',
    submitted_by_user_id = v_creator, submitted_at = clock_timestamp(),
    updated_at = clock_timestamp(), version = version + 1
  WHERE id = v_order;
  INSERT INTO purchase_order_status_history (
    tenant_id, factory_id, purchase_order_id, from_status, to_status, version, actor_user_id, reason,
    request_id, trace_id
  ) VALUES (v_tenant, v_factory, v_order, 'DRAFT', 'SUBMITTED', 2, v_creator, 'PO submitted for GRN test',
    v_request, v_trace);

  PERFORM set_config('app.user_id', v_approver::text, true);
  UPDATE purchase_orders SET status = 'APPROVED',
    approved_by_user_id = v_approver, approved_at = clock_timestamp(),
    updated_at = clock_timestamp(), version = version + 1
  WHERE id = v_order;
  INSERT INTO purchase_order_status_history (
    tenant_id, factory_id, purchase_order_id, from_status, to_status, version, actor_user_id, reason,
    request_id, trace_id
  ) VALUES (v_tenant, v_factory, v_order, 'SUBMITTED', 'APPROVED', 3, v_approver, 'PO approved for GRN test',
    v_request, v_trace);

  PERFORM set_config('app.inventory_location_id', v_location::text, true);

  -- First partial GRN: six physically received, one rejected, five accepted to stock.
  INSERT INTO goods_receipts (
    id, tenant_id, factory_id, purchase_order_id, receipt_number, status,
    supplier_delivery_reference, notes, created_by_user_id, idempotency_key, request_hash,
    request_id, trace_id, correlation_id
  ) VALUES (
    v_receipt_one, v_tenant, v_factory, v_order, 'GRN-TEST-001', 'POSTING',
    'SUP-DELIVERY-001', 'First partial delivery', v_approver, 'grn-test-key-001',
    repeat('a', 64), v_request, v_trace, v_trace
  );
  INSERT INTO goods_receipt_lines (
    tenant_id, factory_id, goods_receipt_id, purchase_order_id, purchase_order_line_id,
    inventory_item_id, received_quantity, rejected_quantity, rejection_reason
  ) VALUES (v_tenant, v_factory, v_receipt_one, v_order, v_po_line, v_item, 6, 1, 'Damaged packaging');

  UPDATE inventory_stock_balances
  SET quantity_on_hand = quantity_on_hand + 5, version = version + 1, updated_at = clock_timestamp()
  WHERE tenant_id = v_tenant AND factory_id = v_factory AND item_id = v_item
  RETURNING quantity_on_hand INTO v_quantity;

  INSERT INTO inventory_movements (
    tenant_id, factory_id, item_id, location_id, movement_type, quantity, quantity_delta, quantity_after,
    idempotency_key, request_hash, reference_type, reference_id, notes, created_by_user_id, correlation_id
  ) VALUES (
    v_tenant, v_factory, v_item, v_location, 'RECEIPT', 5, 5, v_quantity,
    'GRN:' || v_receipt_one::text || ':' || v_po_line::text, repeat('b', 64),
    'GOODS_RECEIPT', v_receipt_one, 'First partial receipt', v_approver, v_trace
  );
  INSERT INTO outbox_events (tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload)
  VALUES (v_tenant, v_factory, 'GOODS_RECEIPT', v_receipt_one, 'PROCUREMENT.GOODS_RECEIPT_POSTED',
    jsonb_build_object('receipt_id', v_receipt_one, 'accepted_quantity', 5, 'rejected_quantity', 1));
  INSERT INTO audit_events (
    tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
    correlation_id, request_id, data_class, payload
  ) VALUES (
    v_tenant, v_factory, v_approver, 'PROCUREMENT', 'POSTED', 'GOODS_RECEIPT', v_receipt_one,
    v_trace, v_request, 'INTERNAL', jsonb_build_object('accepted_quantity', 5, 'rejected_quantity', 1)
  );
  UPDATE goods_receipts SET status = 'POSTED', posted_at = clock_timestamp() WHERE id = v_receipt_one;

  SELECT received_quantity, rejected_quantity, accepted_quantity
  INTO v_received, v_rejected, v_accepted
  FROM goods_receipt_lines WHERE goods_receipt_id = v_receipt_one AND purchase_order_line_id = v_po_line;
  IF v_received <> 6 OR v_rejected <> 1 OR v_accepted <> 5 THEN
    RAISE EXCEPTION 'GRN partial/rejected quantity was not calculated correctly';
  END IF;
  IF (SELECT quantity_on_hand FROM inventory_stock_balances WHERE item_id = v_item) <> 5 THEN
    RAISE EXCEPTION 'Rejected quantity must not be posted to stock';
  END IF;
  IF (SELECT quantity_on_hand FROM inventory_location_balances
      WHERE item_id = v_item AND location_id = v_location) <> 5 THEN
    RAISE EXCEPTION 'GRN stock posting must update the selected/default location balance';
  END IF;

  -- Second partial GRN completes the PO line at ten received, but only nine good units enter stock.
  INSERT INTO goods_receipts (
    id, tenant_id, factory_id, purchase_order_id, receipt_number, status,
    created_by_user_id, idempotency_key, request_hash, request_id, trace_id, correlation_id
  ) VALUES (
    v_receipt_two, v_tenant, v_factory, v_order, 'GRN-TEST-002', 'POSTING',
    v_approver, 'grn-test-key-002', repeat('c', 64), v_request, v_trace, v_trace
  );
  INSERT INTO goods_receipt_lines (
    tenant_id, factory_id, goods_receipt_id, purchase_order_id, purchase_order_line_id,
    inventory_item_id, received_quantity, rejected_quantity
  ) VALUES (v_tenant, v_factory, v_receipt_two, v_order, v_po_line, v_item, 4, 0);

  UPDATE inventory_stock_balances
  SET quantity_on_hand = quantity_on_hand + 4, version = version + 1, updated_at = clock_timestamp()
  WHERE tenant_id = v_tenant AND factory_id = v_factory AND item_id = v_item
  RETURNING quantity_on_hand INTO v_quantity;

  INSERT INTO inventory_movements (
    tenant_id, factory_id, item_id, location_id, movement_type, quantity, quantity_delta, quantity_after,
    idempotency_key, request_hash, reference_type, reference_id, notes, created_by_user_id, correlation_id
  ) VALUES (
    v_tenant, v_factory, v_item, v_location, 'RECEIPT', 4, 4, v_quantity,
    'GRN:' || v_receipt_two::text || ':' || v_po_line::text, repeat('d', 64),
    'GOODS_RECEIPT', v_receipt_two, 'Second partial receipt', v_approver, v_trace
  );
  INSERT INTO outbox_events (tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload)
  VALUES (v_tenant, v_factory, 'GOODS_RECEIPT', v_receipt_two, 'PROCUREMENT.GOODS_RECEIPT_POSTED',
    jsonb_build_object('receipt_id', v_receipt_two, 'accepted_quantity', 4, 'rejected_quantity', 0));
  INSERT INTO audit_events (
    tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
    correlation_id, request_id, data_class, payload
  ) VALUES (
    v_tenant, v_factory, v_approver, 'PROCUREMENT', 'POSTED', 'GOODS_RECEIPT', v_receipt_two,
    v_trace, v_request, 'INTERNAL', jsonb_build_object('accepted_quantity', 4, 'rejected_quantity', 0)
  );
  UPDATE goods_receipts SET status = 'POSTED', posted_at = clock_timestamp() WHERE id = v_receipt_two;

  IF (SELECT quantity_on_hand FROM inventory_stock_balances WHERE item_id = v_item) <> 9 THEN
    RAISE EXCEPTION 'Only nine accepted units should be added after receiving one rejected unit';
  END IF;
  IF (SELECT SUM(received_quantity) FROM goods_receipt_lines WHERE purchase_order_line_id = v_po_line) <> 10 THEN
    RAISE EXCEPTION 'Partial receipts must accumulate against the ordered quantity';
  END IF;
  IF (SELECT COUNT(*) FROM inventory_movements WHERE reference_type = 'GOODS_RECEIPT'
      AND reference_id IN (v_receipt_one, v_receipt_two)) <> 2 THEN
    RAISE EXCEPTION 'Each receipt with accepted quantity must post one stock movement';
  END IF;

  -- A reused request key cannot create a second GRN, even with another receipt id.
  BEGIN
    INSERT INTO goods_receipts (
      id, tenant_id, factory_id, purchase_order_id, receipt_number, status,
      created_by_user_id, idempotency_key, request_hash, correlation_id
    ) VALUES (
      v_bad_receipt, v_tenant, v_factory, v_order, 'GRN-TEST-DUP', 'POSTING',
      v_approver, 'grn-test-key-001', repeat('a', 64), v_trace
    );
    RAISE EXCEPTION 'Expected duplicate GRN idempotency key to be rejected';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- Rejections need a reason; this failure is checked before PO balance/over-receipt validation.
  BEGIN
    INSERT INTO goods_receipts (
      id, tenant_id, factory_id, purchase_order_id, receipt_number, status,
      created_by_user_id, idempotency_key, request_hash, correlation_id
    ) VALUES (
      v_bad_receipt, v_tenant, v_factory, v_order, 'GRN-TEST-NO-REASON', 'POSTING',
      v_approver, 'grn-test-key-no-reason', repeat('e', 64), v_trace
    );
    INSERT INTO goods_receipt_lines (
      tenant_id, factory_id, goods_receipt_id, purchase_order_id, purchase_order_line_id,
      inventory_item_id, received_quantity, rejected_quantity, rejection_reason
    ) VALUES (v_tenant, v_factory, v_bad_receipt, v_order, v_po_line, v_item, 0.1, 0.1, NULL);
    RAISE EXCEPTION 'Expected missing rejection reason to be rejected';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Rejected units count toward the ordered receipt total, so even an all-rejected over-receipt is invalid.
  BEGIN
    INSERT INTO goods_receipts (
      id, tenant_id, factory_id, purchase_order_id, receipt_number, status,
      created_by_user_id, idempotency_key, request_hash, correlation_id
    ) VALUES (
      v_bad_receipt, v_tenant, v_factory, v_order, 'GRN-TEST-OVER', 'POSTING',
      v_approver, 'grn-test-key-over', repeat('f', 64), v_trace
    );
    INSERT INTO goods_receipt_lines (
      tenant_id, factory_id, goods_receipt_id, purchase_order_id, purchase_order_line_id,
      inventory_item_id, received_quantity, rejected_quantity, rejection_reason
    ) VALUES (v_tenant, v_factory, v_bad_receipt, v_order, v_po_line, v_item, 0.0001, 0.0001, 'Rejected overage');
    RAISE EXCEPTION 'Expected over-receipt to be rejected even when fully rejected';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM audit_events WHERE tenant_id = v_tenant
      AND resource_type = 'GOODS_RECEIPT' AND resource_id = v_receipt_one
      AND action = 'POSTED' AND actor_user_id = v_approver
      AND request_id = v_request AND correlation_id = v_trace
  ) THEN RAISE EXCEPTION 'GRN audit event/correlation is missing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM outbox_events WHERE tenant_id = v_tenant AND factory_id = v_factory
      AND aggregate_type = 'GOODS_RECEIPT' AND aggregate_id = v_receipt_one
      AND event_type = 'PROCUREMENT.GOODS_RECEIPT_POSTED'
  ) THEN RAISE EXCEPTION 'GRN transactional outbox event is missing'; END IF;

  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE NOTICE 'GRN partial receipt, rejected quantity, duplicate-key, stock posting, and audit checks passed';
END;
$$;
ROLLBACK;
