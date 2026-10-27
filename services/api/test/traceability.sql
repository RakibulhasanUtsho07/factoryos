-- Lot/serial genealogy regression: identity, forward/reverse trace, duplicate, cycle, quantity and recall.
BEGIN;
DO $$
DECLARE
  v_tenant UUID := gen_random_uuid();
  v_factory UUID := gen_random_uuid();
  v_actor UUID := gen_random_uuid();
  v_material_item UUID := gen_random_uuid();
  v_finished_item UUID := gen_random_uuid();
  v_template UUID := gen_random_uuid();
  v_material UUID := gen_random_uuid();
  v_finished UUID := gen_random_uuid();
  v_carton UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_other_unit UUID := gen_random_uuid();
  v_serial UUID := gen_random_uuid();
  v_event_one UUID := gen_random_uuid();
  v_event_two UUID := gen_random_uuid();
  v_event_three UUID := gen_random_uuid();
  v_node_count INTEGER;
  v_cycle_rejected BOOLEAN := FALSE;
  v_overconsumption_rejected BOOLEAN := FALSE;
  v_immutable_rejected BOOLEAN := FALSE;
  v_duplicate_rejected BOOLEAN := FALSE;
  v_request UUID := gen_random_uuid();
  v_trace UUID := gen_random_uuid();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '074_lot_serial_product_genealogy') THEN
    RAISE EXCEPTION 'traceability migration marker is missing';
  END IF;
  IF to_regclass('traceability_units') IS NULL
     OR to_regclass('product_genealogy_events') IS NULL
     OR to_regclass('traceability_label_templates') IS NULL
     OR to_regclass('traceability_settings') IS NULL
     OR to_regclass('traceability_unit_status_events') IS NULL THEN
    RAISE EXCEPTION 'traceability tables are missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c WHERE c.oid = 'traceability_units'::regclass AND c.relrowsecurity AND c.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class c WHERE c.oid = 'product_genealogy_events'::regclass AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'traceability units and genealogy events must force tenant RLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE code = 'traceability.read')
     OR NOT EXISTS (SELECT 1 FROM permissions WHERE code = 'traceability.write') THEN
    RAISE EXCEPTION 'traceability permissions are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'traceability_label_templates'::regclass
      AND conname = 'chk_traceability_label_template_symbology'
      AND pg_get_constraintdef(oid) LIKE '%GS1_DATAMATRIX%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'traceability_label_issues'::regclass
      AND conname = 'chk_traceability_label_issue_symbology'
      AND pg_get_constraintdef(oid) LIKE '%GS1_DATAMATRIX%'
  ) THEN
    RAISE EXCEPTION 'GS1 Data Matrix must be accepted by both template and immutable issue symbology constraints';
  END IF;

  INSERT INTO tenants (id, slug, name)
  VALUES (v_tenant, 'traceability-test-' || v_tenant::text, 'Traceability Integration Test');
  INSERT INTO users (id, display_name) VALUES (v_actor, 'Traceability Test Actor');
  INSERT INTO factories (id, tenant_id, code, name, status)
  VALUES (v_factory, v_tenant, 'TRC-' || upper(substr(v_factory::text, 1, 8)), 'Traceability Test Factory', 'ACTIVE');

  PERFORM set_config('app.tenant_id', v_tenant::text, TRUE);
  PERFORM set_config('app.user_id', v_actor::text, TRUE);
  PERFORM set_config('app.request_id', v_request::text, TRUE);
  PERFORM set_config('app.trace_id', v_trace::text, TRUE);

  IF NOT EXISTS (
    SELECT 1 FROM traceability_settings WHERE tenant_id = v_tenant AND factory_id = v_factory
      AND allocation_policy = 'FIFO' AND retention_years = 7
  ) THEN RAISE EXCEPTION 'new factories must receive default traceability settings'; END IF;

  INSERT INTO inventory_items (id, tenant_id, factory_id, sku, name, unit, created_by_user_id)
  VALUES
    (v_material_item, v_tenant, v_factory, 'TRC-MAT-' || upper(substr(v_material_item::text, 1, 8)), 'Traceable raw material', 'PCS', v_actor),
    (v_finished_item, v_tenant, v_factory, 'TRC-FG-' || upper(substr(v_finished_item::text, 1, 8)), 'Traceable finished good', 'PCS', v_actor);
  INSERT INTO inventory_stock_balances (tenant_id, factory_id, item_id, quantity_on_hand)
  VALUES (v_tenant, v_factory, v_material_item, 10), (v_tenant, v_factory, v_finished_item, 5);

  INSERT INTO traceability_label_templates (
    id, tenant_id, factory_id, template_code, name, symbology, supported_unit_types,
    label_layout, created_by_user_id
  ) VALUES (
    v_template, v_tenant, v_factory, 'TRACE-QR-V1', 'Traceability QR v1', 'QR',
    ARRAY['LOT','SERIAL','FINISHED_GOOD','CARTON','SHIPMENT']::text[],
    '{"fields":["unit_code","barcode_value","product_role","unit","quantity"]}'::jsonb, v_actor
  );
  INSERT INTO audit_events (
    tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
    correlation_id, request_id, data_class, payload
  ) VALUES (
    v_tenant, v_factory, v_actor, 'TRACEABILITY', 'CREATED', 'TRACEABILITY_LABEL_TEMPLATE', v_template,
    v_trace, v_request, 'INTERNAL', jsonb_build_object('template_code','TRACE-QR-V1','symbology','QR')
  );
  INSERT INTO outbox_events (tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload)
  VALUES (
    v_tenant, v_factory, 'TRACEABILITY_LABEL_TEMPLATE', v_template, 'TRACEABILITY.LABEL_TEMPLATE_CREATED',
    jsonb_build_object('template_id',v_template,'template_code','TRACE-QR-V1','symbology','QR')
  );

  INSERT INTO traceability_units (
    id, tenant_id, factory_id, unit_type, product_role, unit_code, barcode_value,
    inventory_item_id, quantity, unit, external_reference, label_template_id,
    idempotency_key, request_hash, created_by_user_id, correlation_id
  ) VALUES
    (v_material, v_tenant, v_factory, 'LOT', 'MATERIAL', 'MAT-LOT-001', 'QR-MAT-LOT-001',
     v_material_item, 10, 'PCS', 'SUPPLIER-LOT-EXT-001', v_template, 'trace-unit-material', repeat('a',64), v_actor, v_trace),
    (v_finished, v_tenant, v_factory, 'FINISHED_GOOD', 'FINISHED_GOOD', 'FG-LOT-001', 'QR-FG-LOT-001',
     v_finished_item, 5, 'PCS', 'PRODUCTION-BATCH-001', v_template, 'trace-unit-finished', repeat('b',64), v_actor, v_trace),
    (v_carton, v_tenant, v_factory, 'CARTON', 'PACKAGING', 'CARTON-001', 'QR-CARTON-001',
     NULL, 1, 'EA', 'CARTON-EXT-001', v_template, 'trace-unit-carton', repeat('c',64), v_actor, v_trace),
    (v_shipment, v_tenant, v_factory, 'SHIPMENT', 'SHIPMENT', 'SHIPMENT-001', 'QR-SHIPMENT-001',
     NULL, 1, 'EA', 'CUSTOMER-SHIPMENT-EXT-001', v_template, 'trace-unit-shipment', repeat('d',64), v_actor, v_trace),
    (v_other_unit, v_tenant, v_factory, 'FINISHED_GOOD', 'FINISHED_GOOD', 'FG-LOT-002', 'QR-FG-LOT-002',
     v_finished_item, 1, 'PCS', 'PRODUCTION-BATCH-002', v_template, 'trace-unit-finished-2', repeat('e',64), v_actor, v_trace),
    (v_serial, v_tenant, v_factory, 'SERIAL', 'MATERIAL', 'MAT-SERIAL-001', 'QR-MAT-SERIAL-001',
     v_material_item, 1, 'PCS', 'SERIAL-EXT-001', v_template, 'trace-unit-material-serial', repeat('8',64), v_actor, v_trace);

  INSERT INTO audit_events (
    tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
    correlation_id, request_id, data_class, payload
  )
  SELECT u.tenant_id, u.factory_id, u.created_by_user_id, 'TRACEABILITY', 'REGISTERED',
    'TRACEABILITY_UNIT', u.id, u.correlation_id, v_request, 'INTERNAL',
    jsonb_build_object('unit_code',u.unit_code,'unit_type',u.unit_type,'product_role',u.product_role)
  FROM traceability_units u WHERE u.tenant_id = v_tenant AND u.factory_id = v_factory;
  INSERT INTO outbox_events (tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload)
  SELECT u.tenant_id, u.factory_id, 'TRACEABILITY_UNIT', u.id, 'TRACEABILITY.UNIT_REGISTERED',
    jsonb_build_object('unit_id',u.id,'unit_code',u.unit_code,'unit_type',u.unit_type)
  FROM traceability_units u WHERE u.tenant_id = v_tenant AND u.factory_id = v_factory;

  BEGIN
    INSERT INTO traceability_units (
      tenant_id, factory_id, unit_type, product_role, unit_code, barcode_value,
      inventory_item_id, quantity, unit, external_reference, idempotency_key, request_hash,
      created_by_user_id, correlation_id
    ) VALUES (
      v_tenant, v_factory, 'LOT', 'MATERIAL', 'MAT-LOT-DUP', 'QR-MAT-LOT-DUP',
      v_material_item, 1, 'PCS', 'DUP-EXT', 'trace-unit-material', repeat('9',64), v_actor, v_trace
    );
  EXCEPTION WHEN unique_violation THEN
    v_duplicate_rejected := TRUE;
  END;
  IF NOT v_duplicate_rejected THEN RAISE EXCEPTION 'duplicate traceability idempotency key was not rejected'; END IF;

  INSERT INTO product_genealogy_events (
    id, tenant_id, factory_id, source_unit_id, target_unit_id, relationship_type, quantity,
    unit, evidence, notes, idempotency_key, request_hash, created_by_user_id, correlation_id
  ) VALUES
    (v_event_one, v_tenant, v_factory, v_material, v_finished, 'CONSUMED_INTO', 5, 'PCS',
     '{"source":"GRN/lot evidence","batch":"PRODUCTION-BATCH-001"}'::jsonb, 'Material consumed in production',
     'trace-edge-material-fg', repeat('f',64), v_actor, v_trace),
    (v_event_two, v_tenant, v_factory, v_finished, v_carton, 'PACKED_INTO', 1, 'PCS',
     '{"pack_level":"carton"}'::jsonb, 'Finished goods packed into carton',
     'trace-edge-fg-carton', repeat('1',64), v_actor, v_trace),
    (v_event_three, v_tenant, v_factory, v_carton, v_shipment, 'SHIPPED_AS', 1, 'EA',
     '{"customer_reference":"CUSTOMER-001","shipment_reference":"SHIPMENT-001"}'::jsonb, 'Carton included in shipment',
     'trace-edge-carton-shipment', repeat('2',64), v_actor, v_trace);

  INSERT INTO audit_events (
    tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
    correlation_id, request_id, data_class, payload
  )
  SELECT e.tenant_id, e.factory_id, e.created_by_user_id, 'TRACEABILITY', 'RECORDED',
    'PRODUCT_GENEALOGY_EVENT', e.id, e.correlation_id, v_request, 'INTERNAL',
    jsonb_build_object('source_unit_id',e.source_unit_id,'target_unit_id',e.target_unit_id,
      'relationship_type',e.relationship_type,'quantity',e.quantity)
  FROM product_genealogy_events e WHERE e.tenant_id = v_tenant AND e.factory_id = v_factory;
  INSERT INTO outbox_events (tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload)
  SELECT e.tenant_id, e.factory_id, 'PRODUCT_GENEALOGY_EVENT', e.id, 'TRACEABILITY.GENEALOGY_RECORDED',
    jsonb_build_object('source_unit_id',e.source_unit_id,'target_unit_id',e.target_unit_id,
      'relationship_type',e.relationship_type,'quantity',e.quantity)
  FROM product_genealogy_events e WHERE e.tenant_id = v_tenant AND e.factory_id = v_factory;

  WITH RECURSIVE forward_walk(unit_id, depth, visited) AS (
    SELECT v_material, 0, ARRAY[v_material]::uuid[]
    UNION ALL
    SELECT e.target_unit_id, w.depth + 1, w.visited || e.target_unit_id
    FROM forward_walk w
    JOIN product_genealogy_events e
      ON e.source_unit_id = w.unit_id AND e.tenant_id = v_tenant AND e.factory_id = v_factory
    WHERE NOT e.target_unit_id = ANY(w.visited)
  )
  SELECT count(DISTINCT unit_id) INTO v_node_count FROM forward_walk;
  IF v_node_count <> 4 THEN RAISE EXCEPTION 'forward trace expected 4 nodes; got %', v_node_count; END IF;

  WITH RECURSIVE reverse_walk(unit_id, depth, visited) AS (
    SELECT v_shipment, 0, ARRAY[v_shipment]::uuid[]
    UNION ALL
    SELECT e.source_unit_id, w.depth + 1, w.visited || e.source_unit_id
    FROM reverse_walk w
    JOIN product_genealogy_events e
      ON e.target_unit_id = w.unit_id AND e.tenant_id = v_tenant AND e.factory_id = v_factory
    WHERE NOT e.source_unit_id = ANY(w.visited)
  )
  SELECT count(DISTINCT unit_id) INTO v_node_count FROM reverse_walk;
  IF v_node_count <> 4 THEN RAISE EXCEPTION 'reverse trace expected 4 nodes; got %', v_node_count; END IF;

  BEGIN
    INSERT INTO product_genealogy_events (
      tenant_id, factory_id, source_unit_id, target_unit_id, relationship_type, quantity, unit,
      evidence, idempotency_key, request_hash, created_by_user_id, correlation_id
    ) VALUES (
      v_tenant, v_factory, v_shipment, v_material, 'REWORKED_INTO', 1, 'EA', '{}'::jsonb,
      'trace-cycle-edge', repeat('3',64), v_actor, v_trace
    );
  EXCEPTION WHEN check_violation THEN
    v_cycle_rejected := TRUE;
  END;
  IF NOT v_cycle_rejected THEN RAISE EXCEPTION 'genealogy cycle was not rejected'; END IF;

  BEGIN
    INSERT INTO product_genealogy_events (
      tenant_id, factory_id, source_unit_id, target_unit_id, relationship_type, quantity, unit,
      evidence, idempotency_key, request_hash, created_by_user_id, correlation_id
    ) VALUES (
      v_tenant, v_factory, v_material, v_other_unit, 'CONSUMED_INTO', 6, 'PCS', '{}'::jsonb,
      'trace-overconsume-edge', repeat('4',64), v_actor, v_trace
    );
  EXCEPTION WHEN check_violation THEN
    v_overconsumption_rejected := TRUE;
  END;
  IF NOT v_overconsumption_rejected THEN RAISE EXCEPTION 'cumulative genealogy consumption above source quantity was allowed'; END IF;

  BEGIN
    UPDATE traceability_units SET unit_code = 'MUTATED-IDENTITY'
    WHERE id = v_material AND tenant_id = v_tenant AND factory_id = v_factory;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_immutable_rejected := TRUE;
  END;
  IF NOT v_immutable_rejected THEN RAISE EXCEPTION 'traceability unit identity mutation was not rejected'; END IF;

  UPDATE traceability_units
  SET status = 'RECALLED', version = version + 1, updated_at = clock_timestamp()
  WHERE id = v_material AND tenant_id = v_tenant AND factory_id = v_factory;
  INSERT INTO traceability_unit_status_events (
    tenant_id, factory_id, unit_id, version, from_status, to_status, reason,
    idempotency_key, request_hash, changed_by_user_id, correlation_id
  ) VALUES (
    v_tenant, v_factory, v_material, 2, 'ACTIVE', 'RECALLED', 'Recall regression test',
    'trace-status-material-recall', repeat('5',64), v_actor, v_trace
  );
  INSERT INTO audit_events (
    tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
    correlation_id, request_id, data_class, payload
  ) VALUES (
    v_tenant, v_factory, v_actor, 'TRACEABILITY', 'STATUS_CHANGED', 'TRACEABILITY_UNIT', v_material,
    v_trace, v_request, 'INTERNAL',
    jsonb_build_object('from_status','ACTIVE','to_status','RECALLED','reason','Recall regression test','version',2)
  );
  INSERT INTO outbox_events (tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload)
  VALUES (
    v_tenant, v_factory, 'TRACEABILITY_UNIT', v_material, 'TRACEABILITY.UNIT_STATUS_CHANGED',
    jsonb_build_object('unit_id',v_material,'from_status','ACTIVE','to_status','RECALLED','version',2)
  );

  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE NOTICE 'traceability identity, forward/reverse genealogy, duplicate key, cycle/quantity guards, immutable identity and recall audit checks passed';
END;
$$;
ROLLBACK;
