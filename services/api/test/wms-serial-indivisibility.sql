-- WP02 / SRS v2.1 FR-WMS-04: serial identities are indivisible; unbacked LOT/SERIAL transformations fail closed.
BEGIN;

DO $$
DECLARE
  v_tenant UUID := gen_random_uuid();
  v_factory UUID := gen_random_uuid();
  v_actor UUID := gen_random_uuid();
  v_item UUID := gen_random_uuid();
  v_lot_two UUID := gen_random_uuid();
  v_serial_one UUID := gen_random_uuid();
  v_serial_two UUID := gen_random_uuid();
  v_lot UUID := gen_random_uuid();
  v_location UUID;
  v_reservation UUID := gen_random_uuid();
  v_fake_id UUID := gen_random_uuid();
  v_request UUID := gen_random_uuid();
  v_trace UUID := gen_random_uuid();
  v_created_at TIMESTAMPTZ := clock_timestamp();
  v_mixed_source UUID := gen_random_uuid();
  v_mixed_reservation UUID := gen_random_uuid();
  v_mixed_outputs JSONB;
  v_mixed_result JSONB;
  v_mixed_replay JSONB;
  v_mixed_lot_target UUID;
  v_mixed_serial_target UUID;
  v_merged_lot UUID;
  v_merge_result JSONB;
  v_merge_replay JSONB;
  v_split_result JSONB;
  v_split_replay JSONB;
  v_serial_outputs JSONB;
  v_bad_serial_outputs JSONB;
  v_existing_serial_code TEXT;
  v_failed_command_rolled_back BOOLEAN := FALSE;
  v_lot_split_rejected BOOLEAN := FALSE;
  v_lot_merge_rejected BOOLEAN := FALSE;
  v_serial_fractional_edge_rejected BOOLEAN := FALSE;
  v_serial_split_rejected BOOLEAN := FALSE;
  v_serial_merge_source_rejected BOOLEAN := FALSE;
  v_serial_merge_target_rejected BOOLEAN := FALSE;
  v_fractional_location_rejected BOOLEAN := FALSE;
  v_duplicate_serial_location_rejected BOOLEAN := FALSE;
  v_fractional_reserved_location_rejected BOOLEAN := FALSE;
  v_fractional_allocation_rejected BOOLEAN := FALSE;
  v_second_active_allocation_rejected BOOLEAN := FALSE;
  v_partial_serial_issue_rejected BOOLEAN := FALSE;
  v_partial_serial_release_rejected BOOLEAN := FALSE;
  v_fractional_consumption_evidence_rejected BOOLEAN := FALSE;
  v_fractional_transfer_rejected BOOLEAN := FALSE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '236_wms_serial_indivisibility'
  ) THEN
    RAISE EXCEPTION 'serial indivisibility migration marker is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '238_wms_genealogy_transformations_require_commands'
  ) THEN
    RAISE EXCEPTION 'stock-conserving genealogy transformation guard migration marker is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '239_wms_stock_conserving_lot_serial_transformations'
  ) THEN
    RAISE EXCEPTION 'stock-conserving LOT/SERIAL transformation command migration marker is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '240_wms_reservation_traceability_allocation_remapping'
  ) THEN
    RAISE EXCEPTION 'active reservation allocation remapping migration marker is missing';
  END IF;

  INSERT INTO tenants (id, slug, name)
  VALUES (v_tenant, 'wms-serial-unit-' || v_tenant::text, 'WMS Serial Indivisibility Test');
  INSERT INTO users (id, display_name)
  VALUES (v_actor, 'WMS Serial Indivisibility Actor');
  INSERT INTO factories (id, tenant_id, code, name, status)
  VALUES (
    v_factory, v_tenant, 'WSI-' || upper(substr(v_factory::text, 1, 8)),
    'WMS Serial Indivisibility Factory', 'ACTIVE'
  );

  PERFORM set_config('app.tenant_id', v_tenant::text, TRUE);
  PERFORM set_config('app.user_id', v_actor::text, TRUE);
  PERFORM set_config('app.request_id', v_request::text, TRUE);
  PERFORM set_config('app.trace_id', v_trace::text, TRUE);

  INSERT INTO inventory_items (
    id, tenant_id, factory_id, sku, name, unit, created_by_user_id
  ) VALUES (
    v_item, v_tenant, v_factory, 'WSI-' || upper(substr(v_item::text, 1, 8)),
    'Serial indivisibility fixture item', 'PCS', v_actor
  );
  INSERT INTO inventory_stock_balances (
    tenant_id, factory_id, item_id, quantity_on_hand, quantity_reserved
  ) VALUES (v_tenant, v_factory, v_item, 12, 0);

  SELECT id INTO v_location
  FROM inventory_locations
  WHERE tenant_id = v_tenant AND factory_id = v_factory AND is_default = TRUE;
  IF v_location IS NULL THEN
    RAISE EXCEPTION 'factory default UNASSIGNED location was not seeded';
  END IF;

  INSERT INTO inventory_location_balances (
    tenant_id, factory_id, item_id, location_id, quantity_on_hand, quantity_reserved
  ) VALUES (v_tenant, v_factory, v_item, v_location, 12, 0)
  ON CONFLICT (tenant_id, factory_id, item_id, location_id)
  DO UPDATE SET quantity_on_hand = EXCLUDED.quantity_on_hand,
                quantity_reserved = EXCLUDED.quantity_reserved;

  INSERT INTO traceability_units (
    id, tenant_id, factory_id, unit_type, product_role, unit_code, barcode_value,
    inventory_item_id, quantity, unit, external_reference,
    idempotency_key, request_hash, created_by_user_id, correlation_id, created_at
  ) VALUES
    (v_serial_one, v_tenant, v_factory, 'SERIAL', 'MATERIAL',
     'WSI-SERIAL-001-' || substr(v_serial_one::text, 1, 8),
     'WSI-SERIAL-001-' || substr(v_serial_one::text, 1, 8),
     v_item, 1, 'PCS', 'WSI-EXT-SERIAL-001',
     'wsi-serial-one-' || v_serial_one::text, repeat('1', 64), v_actor, v_trace, v_created_at),
    (v_serial_two, v_tenant, v_factory, 'SERIAL', 'MATERIAL',
     'WSI-SERIAL-002-' || substr(v_serial_two::text, 1, 8),
     'WSI-SERIAL-002-' || substr(v_serial_two::text, 1, 8),
     v_item, 1, 'PCS', 'WSI-EXT-SERIAL-002',
     'wsi-serial-two-' || v_serial_two::text, repeat('2', 64), v_actor, v_trace, v_created_at),
    (v_lot, v_tenant, v_factory, 'LOT', 'MATERIAL',
     'WSI-LOT-001-' || substr(v_lot::text, 1, 8),
     'WSI-LOT-001-' || substr(v_lot::text, 1, 8),
     v_item, 8, 'PCS', 'WSI-EXT-LOT-001',
     'wsi-lot-' || v_lot::text, repeat('3', 64), v_actor, v_trace, v_created_at),
    (v_lot_two, v_tenant, v_factory, 'LOT', 'MATERIAL',
     'WSI-LOT-002-' || substr(v_lot_two::text, 1, 8),
     'WSI-LOT-002-' || substr(v_lot_two::text, 1, 8),
     v_item, 2, 'PCS', 'WSI-EXT-LOT-002',
     'wsi-lot-two-' || v_lot_two::text, repeat('c', 64), v_actor, v_trace, v_created_at);

  INSERT INTO audit_events (
    tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
    correlation_id, request_id, data_class, payload
  )
  SELECT u.tenant_id, u.factory_id, u.created_by_user_id, 'TRACEABILITY', 'REGISTERED',
    'TRACEABILITY_UNIT', u.id, u.correlation_id, v_request, 'INTERNAL',
    jsonb_build_object('unit_code', u.unit_code, 'unit_type', u.unit_type, 'quantity', u.quantity)
  FROM traceability_units u
  WHERE u.tenant_id = v_tenant AND u.factory_id = v_factory
    AND u.id IN (v_serial_one, v_serial_two, v_lot, v_lot_two);

  INSERT INTO outbox_events (tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload)
  SELECT u.tenant_id, u.factory_id, 'TRACEABILITY_UNIT', u.id, 'TRACEABILITY.UNIT_REGISTERED',
    jsonb_build_object('unit_id', u.id, 'unit_code', u.unit_code, 'unit_type', u.unit_type)
  FROM traceability_units u
  WHERE u.tenant_id = v_tenant AND u.factory_id = v_factory
    AND u.id IN (v_serial_one, v_serial_two, v_lot, v_lot_two);

  -- A genealogy-only LOT -> SERIAL edge is not a stock split. The generic path
  -- must fail until an authorized command conserves aggregate, bin and identity stock.
  BEGIN
    INSERT INTO product_genealogy_events (
      tenant_id, factory_id, source_unit_id, target_unit_id, relationship_type,
      quantity, unit, evidence, idempotency_key, request_hash, created_by_user_id, correlation_id
    ) VALUES (
      v_tenant, v_factory, v_lot, v_serial_one, 'SPLIT_INTO',
      1, 'PCS', '{"fixture":"unbacked split must be blocked"}'::jsonb,
      'wsi-generic-lot-serial-split-rejected', repeat('4', 64), v_actor, v_trace
    );
  EXCEPTION WHEN check_violation THEN
    v_lot_split_rejected := TRUE;
  END;
  IF NOT v_lot_split_rejected THEN
    RAISE EXCEPTION 'generic LOT-to-SERIAL genealogy write bypassed stock-conserving split command';
  END IF;

  -- A LOT -> LOT merge is equally forbidden through the generic edge API/SQL path.
  BEGIN
    INSERT INTO product_genealogy_events (
      tenant_id, factory_id, source_unit_id, target_unit_id, relationship_type,
      quantity, unit, evidence, idempotency_key, request_hash, created_by_user_id, correlation_id
    ) VALUES (
      v_tenant, v_factory, v_lot, v_lot_two, 'MERGED_INTO',
      2, 'PCS', '{"fixture":"unbacked merge must be blocked"}'::jsonb,
      'wsi-generic-lot-merge-rejected', repeat('d', 64), v_actor, v_trace
    );
  EXCEPTION WHEN check_violation THEN
    v_lot_merge_rejected := TRUE;
  END;
  IF NOT v_lot_merge_rejected THEN
    RAISE EXCEPTION 'generic LOT-to-LOT genealogy write bypassed stock-conserving merge command';
  END IF;

  -- A serial source cannot represent fractional consumption.
  BEGIN
    INSERT INTO product_genealogy_events (
      tenant_id, factory_id, source_unit_id, target_unit_id, relationship_type,
      quantity, unit, evidence, idempotency_key, request_hash, created_by_user_id, correlation_id
    ) VALUES (
      v_tenant, v_factory, v_serial_two, v_lot, 'CONSUMED_INTO',
      0.5, 'PCS', '{}'::jsonb, 'wsi-fractional-serial-edge', repeat('5', 64), v_actor, v_trace
    );
  EXCEPTION WHEN check_violation THEN
    v_serial_fractional_edge_rejected := TRUE;
  END;
  IF NOT v_serial_fractional_edge_rejected THEN
    RAISE EXCEPTION 'fractional genealogy edge from a serial was accepted';
  END IF;

  BEGIN
    INSERT INTO product_genealogy_events (
      tenant_id, factory_id, source_unit_id, target_unit_id, relationship_type,
      quantity, unit, evidence, idempotency_key, request_hash, created_by_user_id, correlation_id
    ) VALUES (
      v_tenant, v_factory, v_serial_two, v_lot, 'SPLIT_INTO',
      1, 'PCS', '{}'::jsonb, 'wsi-serial-split-rejected', repeat('6', 64), v_actor, v_trace
    );
  EXCEPTION WHEN check_violation THEN
    v_serial_split_rejected := TRUE;
  END;
  IF NOT v_serial_split_rejected THEN
    RAISE EXCEPTION 'a serial was allowed to become the source of a split';
  END IF;

  BEGIN
    INSERT INTO product_genealogy_events (
      tenant_id, factory_id, source_unit_id, target_unit_id, relationship_type,
      quantity, unit, evidence, idempotency_key, request_hash, created_by_user_id, correlation_id
    ) VALUES (
      v_tenant, v_factory, v_serial_two, v_lot, 'MERGED_INTO',
      1, 'PCS', '{}'::jsonb, 'wsi-serial-merge-source-rejected', repeat('7', 64), v_actor, v_trace
    );
  EXCEPTION WHEN check_violation THEN
    v_serial_merge_source_rejected := TRUE;
  END;
  IF NOT v_serial_merge_source_rejected THEN
    RAISE EXCEPTION 'a serial source was allowed in a merge';
  END IF;

  BEGIN
    INSERT INTO product_genealogy_events (
      tenant_id, factory_id, source_unit_id, target_unit_id, relationship_type,
      quantity, unit, evidence, idempotency_key, request_hash, created_by_user_id, correlation_id
    ) VALUES (
      v_tenant, v_factory, v_lot, v_serial_two, 'MERGED_INTO',
      1, 'PCS', '{}'::jsonb, 'wsi-serial-merge-target-rejected', repeat('8', 64), v_actor, v_trace
    );
  EXCEPTION WHEN check_violation THEN
    v_serial_merge_target_rejected := TRUE;
  END;
  IF NOT v_serial_merge_target_rejected THEN
    RAISE EXCEPTION 'a serial target was allowed in a merge';
  END IF;

  -- Per-location serial quantities and reservation quantities must be integral.
  BEGIN
    INSERT INTO inventory_traceability_location_balances (
      tenant_id, factory_id, item_id, traceability_unit_id, location_id,
      quantity_on_hand, quantity_reserved
    ) VALUES (v_tenant, v_factory, v_item, v_serial_one, gen_random_uuid(), 0.5, 0);
  EXCEPTION WHEN check_violation THEN
    v_fractional_location_rejected := TRUE;
  END;
  IF NOT v_fractional_location_rejected THEN
    RAISE EXCEPTION 'fractional serial location on-hand quantity was accepted';
  END IF;

  BEGIN
    INSERT INTO inventory_traceability_location_balances (
      tenant_id, factory_id, item_id, traceability_unit_id, location_id,
      quantity_on_hand, quantity_reserved
    ) VALUES (v_tenant, v_factory, v_item, v_serial_one, gen_random_uuid(), 1, 0);
  EXCEPTION WHEN check_violation THEN
    v_duplicate_serial_location_rejected := TRUE;
  END;
  IF NOT v_duplicate_serial_location_rejected THEN
    RAISE EXCEPTION 'one serial was allowed to hold one unit in two different locations';
  END IF;

  BEGIN
    INSERT INTO inventory_traceability_location_balances (
      tenant_id, factory_id, item_id, traceability_unit_id, location_id,
      quantity_on_hand, quantity_reserved
    ) VALUES (v_tenant, v_factory, v_item, v_serial_one, gen_random_uuid(), 1, 0.5);
  EXCEPTION WHEN check_violation THEN
    v_fractional_reserved_location_rejected := TRUE;
  END;
  IF NOT v_fractional_reserved_location_rejected THEN
    RAISE EXCEPTION 'fractional serial location reserved quantity was accepted';
  END IF;

  -- The before-trigger rejects a partial reservation before any invalid fixture FK is evaluated.
  BEGIN
    INSERT INTO inventory_reservation_traceability_allocations (
      tenant_id, factory_id, reservation_id, item_id, traceability_unit_id,
      location_id, allocation_sequence, allocated_quantity, consumed_quantity, released_quantity
    ) VALUES (
      v_tenant, v_factory, v_fake_id, v_item, v_serial_one,
      v_location, 1, 0.5, 0, 0
    );
  EXCEPTION WHEN check_violation THEN
    v_fractional_allocation_rejected := TRUE;
  END;
  IF NOT v_fractional_allocation_rejected THEN
    RAISE EXCEPTION 'fractional serial reservation allocation was accepted';
  END IF;

  -- Establish one valid active whole-unit reservation/allocation.
  INSERT INTO inventory_reservations (
    id, tenant_id, factory_id, item_id, location_id, quantity, status,
    idempotency_key, request_hash, created_by_user_id, correlation_id
  ) VALUES (
    v_reservation, v_tenant, v_factory, v_item, v_location, 1, 'RESERVED',
    'wsi-reservation-' || v_reservation::text, repeat('9', 64), v_actor, v_trace
  );

  UPDATE inventory_stock_balances
  SET quantity_reserved = 1
  WHERE tenant_id = v_tenant AND factory_id = v_factory AND item_id = v_item;
  UPDATE inventory_location_balances
  SET quantity_reserved = 1
  WHERE tenant_id = v_tenant AND factory_id = v_factory
    AND item_id = v_item AND location_id = v_location;
  UPDATE inventory_traceability_location_balances
  SET quantity_reserved = 1, version = version + 1, updated_at = clock_timestamp()
  WHERE tenant_id = v_tenant AND factory_id = v_factory
    AND item_id = v_item AND traceability_unit_id = v_serial_one AND location_id = v_location;

  INSERT INTO inventory_reservation_traceability_allocations (
    tenant_id, factory_id, reservation_id, item_id, traceability_unit_id,
    location_id, allocation_sequence, allocated_quantity, consumed_quantity, released_quantity
  ) VALUES (
    v_tenant, v_factory, v_reservation, v_item, v_serial_one,
    v_location, 1, 1, 0, 0
  );

  -- Locking the serial identity prevents a concurrent second reservation from claiming it.
  BEGIN
    INSERT INTO inventory_reservation_traceability_allocations (
      tenant_id, factory_id, reservation_id, item_id, traceability_unit_id,
      location_id, allocation_sequence, allocated_quantity, consumed_quantity, released_quantity
    ) VALUES (
      v_tenant, v_factory, gen_random_uuid(), v_item, v_serial_one,
      v_location, 1, 1, 0, 0
    );
  EXCEPTION WHEN check_violation THEN
    v_second_active_allocation_rejected := TRUE;
  END;
  IF NOT v_second_active_allocation_rejected THEN
    RAISE EXCEPTION 'one serial was assigned to two simultaneous active reservations';
  END IF;

  BEGIN
    UPDATE inventory_reservation_traceability_allocations
    SET consumed_quantity = 0.5, updated_at = clock_timestamp()
    WHERE tenant_id = v_tenant AND factory_id = v_factory
      AND reservation_id = v_reservation AND traceability_unit_id = v_serial_one;
  EXCEPTION WHEN check_violation THEN
    v_partial_serial_issue_rejected := TRUE;
  END;
  IF NOT v_partial_serial_issue_rejected THEN
    RAISE EXCEPTION 'partial serial issue was accepted';
  END IF;

  BEGIN
    UPDATE inventory_reservation_traceability_allocations
    SET released_quantity = 0.5, updated_at = clock_timestamp()
    WHERE tenant_id = v_tenant AND factory_id = v_factory
      AND reservation_id = v_reservation AND traceability_unit_id = v_serial_one;
  EXCEPTION WHEN check_violation THEN
    v_partial_serial_release_rejected := TRUE;
  END;
  IF NOT v_partial_serial_release_rejected THEN
    RAISE EXCEPTION 'partial serial reservation release was accepted';
  END IF;

  BEGIN
    INSERT INTO inventory_reservation_consumption_traceability_allocations (
      tenant_id, factory_id, consumption_id, traceability_unit_id, location_id, quantity
    ) VALUES (v_tenant, v_factory, gen_random_uuid(), v_serial_one, v_location, 0.5);
  EXCEPTION WHEN check_violation THEN
    v_fractional_consumption_evidence_rejected := TRUE;
  END;
  IF NOT v_fractional_consumption_evidence_rejected THEN
    RAISE EXCEPTION 'fractional serial consumption evidence was accepted';
  END IF;

  BEGIN
    INSERT INTO inventory_location_transfers (
      tenant_id, factory_id, item_id, source_location_id, destination_location_id,
      quantity, source_quantity_before, source_quantity_after,
      destination_quantity_before, destination_quantity_after,
      idempotency_key, request_hash, created_by_user_id, correlation_id,
      movement_purpose, traceability_unit_id
    ) VALUES (
      v_tenant, v_factory, v_item, gen_random_uuid(), gen_random_uuid(),
      0.5, 1, 0.5, 0, 0.5,
      'wsi-fractional-transfer', repeat('a', 64), v_actor, v_trace, 'TRANSFER', v_serial_two
    );
  EXCEPTION WHEN check_violation THEN
    v_fractional_transfer_rejected := TRUE;
  END;
  IF NOT v_fractional_transfer_rejected THEN
    RAISE EXCEPTION 'fractional serial location transfer was accepted';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM inventory_traceability_location_balances
    WHERE tenant_id = v_tenant AND factory_id = v_factory
      AND item_id = v_item AND traceability_unit_id = v_serial_one
      AND location_id = v_location AND quantity_on_hand = 1
  ) THEN
    RAISE EXCEPTION 'serial registration did not preserve one whole physical unit';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM inventory_traceability_location_balances
    WHERE tenant_id = v_tenant AND factory_id = v_factory
      AND item_id = v_item AND traceability_unit_id = v_lot
      AND location_id = v_location AND quantity_on_hand = 8
  ) OR NOT EXISTS (
    SELECT 1 FROM inventory_traceability_location_balances
    WHERE tenant_id = v_tenant AND factory_id = v_factory
      AND item_id = v_item AND traceability_unit_id = v_lot_two
      AND location_id = v_location AND quantity_on_hand = 2
  ) THEN
    RAISE EXCEPTION 'failed transformation attempt changed LOT identity stock';
  END IF;

  IF EXISTS (
    SELECT 1 FROM product_genealogy_events
    WHERE tenant_id = v_tenant AND factory_id = v_factory
      AND relationship_type IN ('SPLIT_INTO', 'MERGED_INTO')
  ) THEN
    RAISE EXCEPTION 'blocked transformations left genealogy rows without stock-ledger commands';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM inventory_stock_balances
    WHERE tenant_id = v_tenant AND factory_id = v_factory
      AND item_id = v_item AND quantity_on_hand = 12 AND quantity_reserved = 1
  ) OR NOT EXISTS (
    SELECT 1 FROM inventory_location_balances
    WHERE tenant_id = v_tenant AND factory_id = v_factory
      AND item_id = v_item AND location_id = v_location
      AND quantity_on_hand = 12 AND quantity_reserved = 1
  ) THEN
    RAISE EXCEPTION 'failed transformation attempt changed aggregate or BIN stock';
  END IF;


  -- A real merge conserves the source LOT quantity at the same physical location
  -- and records two MERGED_INTO genealogy edges plus command/audit/outbox evidence.
  v_merge_result := factoryos_execute_lot_serial_transformation(
    'MERGE', v_tenant, v_factory, v_actor, ARRAY[v_lot, v_lot_two],
    'WSI-MERGED-LOT', '[]'::jsonb, 'Consolidate compatible material LOTs',
    'wsi-real-lot-merge-001', repeat('a', 64)
  );
  v_merged_lot := (v_merge_result->'target_unit_ids'->>0)::uuid;
  v_merge_replay := factoryos_execute_lot_serial_transformation(
    'MERGE', v_tenant, v_factory, v_actor, ARRAY[v_lot, v_lot_two],
    'WSI-MERGED-LOT', '[]'::jsonb, 'Consolidate compatible material LOTs',
    'wsi-real-lot-merge-001', repeat('a', 64)
  );
  IF (v_merge_result->>'replayed')::boolean OR NOT (v_merge_replay->>'replayed')::boolean
     OR v_merge_result->'target_unit_ids' IS DISTINCT FROM v_merge_replay->'target_unit_ids' THEN
    RAISE EXCEPTION 'LOT merge idempotency did not replay the original result';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM traceability_units
    WHERE id = v_merged_lot AND tenant_id = v_tenant AND factory_id = v_factory
      AND unit_type = 'LOT' AND quantity = 10 AND status = 'ACTIVE'
      AND allocation_received_at_override = v_created_at
  ) THEN
    RAISE EXCEPTION 'LOT merge did not create the expected compatible target identity or preserve effective receipt precedence';
  END IF;
  IF EXISTS (
    SELECT 1 FROM traceability_units
    WHERE id IN (v_lot, v_lot_two) AND status <> 'DISPOSED'
  ) OR EXISTS (
    SELECT 1 FROM inventory_traceability_location_balances
    WHERE traceability_unit_id IN (v_lot, v_lot_two) AND quantity_on_hand <> 0
  ) THEN
    RAISE EXCEPTION 'LOT merge did not retire all source physical identity balances';
  END IF;

  -- Prepare ten one-unit SERIAL outputs. First deliberately collide with an
  -- existing unit code so PostgreSQL raises after the command/header/source-map
  -- writes have begun; the enclosing savepoint must roll every write back.
  SELECT jsonb_agg(jsonb_build_object(
    'unit_type', 'SERIAL',
    'unit_code', 'WSI-TRANSFORM-SERIAL-' || lpad(n::text, 2, '0'),
    'quantity', 1,
    'locations', jsonb_build_array(jsonb_build_object(
      'location_id', v_location, 'quantity', 1
    ))
  ) ORDER BY n)
  INTO v_serial_outputs
  FROM generate_series(1, 10) AS g(n);

  SELECT unit_code INTO v_existing_serial_code
  FROM traceability_units WHERE id = v_serial_one;
  v_bad_serial_outputs := jsonb_set(
    v_serial_outputs, '{0,unit_code}', to_jsonb(v_existing_serial_code)
  );
  BEGIN
    PERFORM factoryos_execute_lot_serial_transformation(
      'SPLIT', v_tenant, v_factory, v_actor, ARRAY[v_merged_lot],
      NULL, v_bad_serial_outputs, 'This attempt must roll back on duplicate identity',
      'wsi-failing-lot-split-001', repeat('b', 64)
    );
  EXCEPTION WHEN unique_violation THEN
    v_failed_command_rolled_back := TRUE;
  END;
  IF NOT v_failed_command_rolled_back
     OR EXISTS (
       SELECT 1 FROM inventory_traceability_transformations
       WHERE tenant_id = v_tenant AND factory_id = v_factory
         AND idempotency_key = 'wsi-failing-lot-split-001'
     )
     OR NOT EXISTS (
       SELECT 1 FROM traceability_units WHERE id = v_merged_lot AND status = 'ACTIVE'
     )
     OR NOT EXISTS (
       SELECT 1 FROM inventory_traceability_location_balances
       WHERE tenant_id = v_tenant AND factory_id = v_factory
         AND traceability_unit_id = v_merged_lot AND location_id = v_location
         AND quantity_on_hand = 10 AND quantity_reserved = 0
     ) THEN
    RAISE EXCEPTION 'failed mid-command split did not roll back header, source status and LOT/BIN balances';
  END IF;

  -- The valid LOT -> SERIAL split consumes the entire remaining LOT map and
  -- creates ten independently addressable whole-unit serial identities.
  v_split_result := factoryos_execute_lot_serial_transformation(
    'SPLIT', v_tenant, v_factory, v_actor, ARRAY[v_merged_lot],
    NULL, v_serial_outputs, 'Serialize all ten finished material units',
    'wsi-real-lot-serial-split-001', repeat('c', 64)
  );
  v_split_replay := factoryos_execute_lot_serial_transformation(
    'SPLIT', v_tenant, v_factory, v_actor, ARRAY[v_merged_lot],
    NULL, v_serial_outputs, 'Serialize all ten finished material units',
    'wsi-real-lot-serial-split-001', repeat('c', 64)
  );
  IF (v_split_result->>'replayed')::boolean OR NOT (v_split_replay->>'replayed')::boolean
     OR v_split_result->'target_unit_ids' IS DISTINCT FROM v_split_replay->'target_unit_ids'
     OR jsonb_array_length(v_split_result->'target_unit_ids') <> 10 THEN
    RAISE EXCEPTION 'LOT-to-SERIAL split did not create ten serial outputs or replay idempotently';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(v_split_result->'target_unit_ids') ids(target_id)
    LEFT JOIN traceability_units u ON u.id = ids.target_id::uuid
      AND u.tenant_id = v_tenant AND u.factory_id = v_factory
    LEFT JOIN inventory_traceability_location_balances b ON b.traceability_unit_id = u.id
      AND b.tenant_id = v_tenant AND b.factory_id = v_factory
      AND b.item_id = v_item AND b.location_id = v_location
    WHERE u.id IS NULL OR u.unit_type <> 'SERIAL' OR u.quantity <> 1 OR u.status <> 'ACTIVE'
       OR b.quantity_on_hand <> 1 OR b.quantity_reserved <> 0
  ) THEN
    RAISE EXCEPTION 'LOT-to-SERIAL split created a fractional, unlocated or unavailable SERIAL output';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM traceability_units
    WHERE id = v_merged_lot AND status = 'DISPOSED'
  ) OR EXISTS (
    SELECT 1 FROM inventory_traceability_location_balances
    WHERE traceability_unit_id = v_merged_lot AND quantity_on_hand <> 0
  ) THEN
    RAISE EXCEPTION 'LOT-to-SERIAL split did not retire the complete source LOT quantity';
  END IF;

  IF (SELECT count(*) FROM product_genealogy_events
      WHERE transformation_id = (v_merge_result->>'transformation_id')::uuid
        AND relationship_type = 'MERGED_INTO') <> 2
     OR (SELECT count(*) FROM product_genealogy_events
      WHERE transformation_id = (v_split_result->>'transformation_id')::uuid
        AND relationship_type = 'SPLIT_INTO') <> 10 THEN
    RAISE EXCEPTION 'split/merge genealogy edges do not match the immutable transformation command lines';
  END IF;
  IF (SELECT count(*) FROM inventory_traceability_transformations
      WHERE tenant_id = v_tenant AND factory_id = v_factory) <> 2
     OR (SELECT count(*) FROM outbox_events
      WHERE tenant_id = v_tenant AND factory_id = v_factory
        AND aggregate_type = 'WMS_LOT_SERIAL_TRANSFORMATION'
        AND event_type = 'WMS.LOT_SERIAL_TRANSFORMATION_COMPLETED') <> 2
     OR (SELECT count(*) FROM audit_events
      WHERE tenant_id = v_tenant AND factory_id = v_factory
        AND resource_type = 'WMS_LOT_SERIAL_TRANSFORMATION' AND action = 'COMPLETED') <> 2 THEN
    RAISE EXCEPTION 'transformation idempotency duplicated command, audit or outbox evidence';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM inventory_stock_balances
    WHERE tenant_id = v_tenant AND factory_id = v_factory
      AND item_id = v_item AND quantity_on_hand = 12 AND quantity_reserved = 1
  ) OR NOT EXISTS (
    SELECT 1 FROM inventory_location_balances
    WHERE tenant_id = v_tenant AND factory_id = v_factory
      AND item_id = v_item AND location_id = v_location
      AND quantity_on_hand = 12 AND quantity_reserved = 1
  ) OR (
    SELECT COALESCE(SUM(quantity_on_hand),0) FROM inventory_traceability_location_balances
    WHERE tenant_id = v_tenant AND factory_id = v_factory AND item_id = v_item
  ) <> 12 OR (
    SELECT COALESCE(SUM(quantity_reserved),0) FROM inventory_traceability_location_balances
    WHERE tenant_id = v_tenant AND factory_id = v_factory AND item_id = v_item
  ) <> 1 THEN
    RAISE EXCEPTION 'LOT merge/split changed aggregate, BIN, traceable on-hand or reserved quantity';
  END IF;

  -- Exercise a mixed split with an active reservation. The first output is a
  -- whole-unit SERIAL so the existing reservation must be remapped onto that
  -- exact target; the remaining two units stay bulk LOT stock.
  -- Registration automatically binds available aggregate/BIN stock to the
  -- new identity. Increase the physical source balances first so its trigger
  -- creates the three-unit row; then reserve exactly one of those units.
  UPDATE inventory_stock_balances
  SET quantity_on_hand = 15, quantity_reserved = 2
  WHERE tenant_id = v_tenant AND factory_id = v_factory AND item_id = v_item;
  UPDATE inventory_location_balances
  SET quantity_on_hand = 15, quantity_reserved = 2
  WHERE tenant_id = v_tenant AND factory_id = v_factory
    AND item_id = v_item AND location_id = v_location;

  INSERT INTO traceability_units (
    id, tenant_id, factory_id, unit_type, product_role, unit_code, barcode_value,
    inventory_item_id, quantity, unit, external_reference,
    idempotency_key, request_hash, created_by_user_id, correlation_id
  ) VALUES (
    v_mixed_source, v_tenant, v_factory, 'LOT', 'MATERIAL',
    'WSI-MIXED-SOURCE-' || substr(v_mixed_source::text, 1, 8),
    'WSI-MIXED-SOURCE-' || substr(v_mixed_source::text, 1, 8),
    v_item, 3, 'PCS', 'WSI-EXT-MIXED-SOURCE',
    'wsi-mixed-source-' || v_mixed_source::text, repeat('d', 64), v_actor, v_trace
  );

  INSERT INTO inventory_reservations (
    id, tenant_id, factory_id, item_id, location_id, quantity, status,
    idempotency_key, request_hash, created_by_user_id, correlation_id
  ) VALUES (
    v_mixed_reservation, v_tenant, v_factory, v_item, v_location, 1, 'RESERVED',
    'wsi-mixed-reservation-' || v_mixed_reservation::text, repeat('e', 64), v_actor, v_trace
  );

  UPDATE inventory_traceability_location_balances
  SET quantity_reserved = 1, version = version + 1, updated_at = clock_timestamp()
  WHERE tenant_id = v_tenant AND factory_id = v_factory AND item_id = v_item
    AND traceability_unit_id = v_mixed_source AND location_id = v_location;

  INSERT INTO inventory_reservation_traceability_allocations (
    tenant_id, factory_id, reservation_id, item_id, traceability_unit_id,
    location_id, allocation_sequence, allocated_quantity, consumed_quantity, released_quantity
  ) VALUES (
    v_tenant, v_factory, v_mixed_reservation, v_item, v_mixed_source,
    v_location, 1, 1, 0, 0
  );

  v_mixed_outputs := jsonb_build_array(
    jsonb_build_object(
      'unit_type', 'SERIAL',
      'unit_code', 'WSI-MIXED-SERIAL-' || substr(v_mixed_source::text, 1, 8),
      'quantity', 1,
      'locations', jsonb_build_array(jsonb_build_object('location_id', v_location, 'quantity', 1))
    ),
    jsonb_build_object(
      'unit_type', 'LOT',
      'unit_code', 'WSI-MIXED-LOT-' || substr(v_mixed_source::text, 1, 8),
      'quantity', 2,
      'locations', jsonb_build_array(jsonb_build_object('location_id', v_location, 'quantity', 2))
    )
  );

  v_mixed_result := factoryos_execute_lot_serial_transformation(
    'SPLIT', v_tenant, v_factory, v_actor, ARRAY[v_mixed_source],
    NULL, v_mixed_outputs, 'Split one material LOT into one SERIAL plus a bulk LOT remainder',
    'wsi-mixed-lot-serial-split-001', repeat('f', 64)
  );
  v_mixed_replay := factoryos_execute_lot_serial_transformation(
    'SPLIT', v_tenant, v_factory, v_actor, ARRAY[v_mixed_source],
    NULL, v_mixed_outputs, 'Split one material LOT into one SERIAL plus a bulk LOT remainder',
    'wsi-mixed-lot-serial-split-001', repeat('f', 64)
  );
  v_mixed_serial_target := (v_mixed_result->'target_unit_ids'->>0)::uuid;
  v_mixed_lot_target := (v_mixed_result->'target_unit_ids'->>1)::uuid;

  IF (v_mixed_result->>'replayed')::boolean
     OR NOT (v_mixed_replay->>'replayed')::boolean
     OR v_mixed_result->'target_unit_ids' IS DISTINCT FROM v_mixed_replay->'target_unit_ids'
     OR jsonb_array_length(v_mixed_result->'target_unit_ids') <> 2 THEN
    RAISE EXCEPTION 'mixed LOT/SERIAL split did not create two ordered targets or replay idempotently';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM traceability_units
    WHERE id = v_mixed_serial_target AND tenant_id = v_tenant AND factory_id = v_factory
      AND unit_type = 'SERIAL' AND quantity = 1 AND status = 'ACTIVE'
  ) OR NOT EXISTS (
    SELECT 1 FROM traceability_units
    WHERE id = v_mixed_lot_target AND tenant_id = v_tenant AND factory_id = v_factory
      AND unit_type = 'LOT' AND quantity = 2 AND status = 'ACTIVE'
  ) OR NOT EXISTS (
    SELECT 1 FROM inventory_traceability_location_balances
    WHERE tenant_id = v_tenant AND factory_id = v_factory
      AND item_id = v_item AND traceability_unit_id = v_mixed_serial_target
      AND location_id = v_location AND quantity_on_hand = 1 AND quantity_reserved = 1
  ) OR NOT EXISTS (
    SELECT 1 FROM inventory_traceability_location_balances
    WHERE tenant_id = v_tenant AND factory_id = v_factory
      AND item_id = v_item AND traceability_unit_id = v_mixed_lot_target
      AND location_id = v_location AND quantity_on_hand = 2 AND quantity_reserved = 0
  ) THEN
    RAISE EXCEPTION 'mixed split did not preserve exact LOT/SERIAL target identities and location quantities';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM inventory_reservation_traceability_allocation_remaps remap
    JOIN inventory_reservation_traceability_allocations target_allocation
      ON target_allocation.id = remap.target_allocation_id
    WHERE remap.transformation_id = (v_mixed_result->>'transformation_id')::uuid
      AND remap.reservation_id = v_mixed_reservation
      AND remap.source_unit_id = v_mixed_source
      AND remap.target_unit_id = v_mixed_serial_target
      AND remap.quantity = 1
      AND target_allocation.traceability_unit_id = v_mixed_serial_target
      AND target_allocation.allocated_quantity = 1
  ) OR NOT EXISTS (
    SELECT 1 FROM inventory_reservation_traceability_allocations source_allocation
    WHERE source_allocation.reservation_id = v_mixed_reservation
      AND source_allocation.traceability_unit_id = v_mixed_source
      AND source_allocation.remapped_quantity = 1
  ) THEN
    RAISE EXCEPTION 'active reservation allocation was not remapped to the exact whole-unit SERIAL target';
  END IF;

  IF (SELECT count(*) FROM product_genealogy_events
      WHERE transformation_id = (v_mixed_result->>'transformation_id')::uuid
        AND relationship_type = 'SPLIT_INTO') <> 2
     OR (SELECT count(*) FROM inventory_traceability_transformations
         WHERE tenant_id = v_tenant AND factory_id = v_factory) <> 3
     OR (SELECT count(*) FROM outbox_events
         WHERE tenant_id = v_tenant AND factory_id = v_factory
           AND aggregate_type = 'WMS_LOT_SERIAL_TRANSFORMATION'
           AND event_type = 'WMS.LOT_SERIAL_TRANSFORMATION_COMPLETED') <> 3
     OR (SELECT count(*) FROM audit_events
         WHERE tenant_id = v_tenant AND factory_id = v_factory
           AND resource_type = 'WMS_LOT_SERIAL_TRANSFORMATION' AND action = 'COMPLETED') <> 3 THEN
    RAISE EXCEPTION 'mixed split genealogy, command, audit or outbox evidence is incomplete or duplicated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM inventory_stock_balances
    WHERE tenant_id = v_tenant AND factory_id = v_factory
      AND item_id = v_item AND quantity_on_hand = 15 AND quantity_reserved = 2
  ) OR NOT EXISTS (
    SELECT 1 FROM inventory_location_balances
    WHERE tenant_id = v_tenant AND factory_id = v_factory
      AND item_id = v_item AND location_id = v_location
      AND quantity_on_hand = 15 AND quantity_reserved = 2
  ) OR (
    SELECT COALESCE(SUM(quantity_on_hand),0) FROM inventory_traceability_location_balances
    WHERE tenant_id = v_tenant AND factory_id = v_factory AND item_id = v_item
  ) <> 15 OR (
    SELECT COALESCE(SUM(quantity_reserved),0) FROM inventory_traceability_location_balances
    WHERE tenant_id = v_tenant AND factory_id = v_factory AND item_id = v_item
  ) <> 2 THEN
    RAISE EXCEPTION 'mixed LOT/SERIAL split changed aggregate, BIN or traceability on-hand/reserved quantity';
  END IF;

  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE NOTICE 'serial indivisibility, mixed LOT/SERIAL split, reservation remap, idempotency and stock conservation passed';
END;
$$;

ROLLBACK;
