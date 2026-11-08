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

  -- Migration 238 blocks generic SPLIT_INTO writes before the serial guard runs.
  -- Keep migration 236's single-parent invariant independently verified from the
  -- installed trigger/function definition, without fabricating a genealogy edge.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    WHERE t.tgrelid = 'product_genealogy_events'::regclass
      AND t.tgname = 'a_product_genealogy_serial_indivisibility'
      AND t.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'serial genealogy indivisibility trigger is missing or disabled';
  END IF;
  IF position(
    'a serial can have only one SPLIT_INTO parent identity'
    IN pg_get_functiondef('factoryos_guard_serial_genealogy_indivisibility()'::regprocedure)
  ) = 0 THEN
    RAISE EXCEPTION 'serial unique split-parent guard is missing from the installed trigger function';
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
    idempotency_key, request_hash, created_by_user_id, correlation_id
  ) VALUES
    (v_serial_one, v_tenant, v_factory, 'SERIAL', 'MATERIAL',
     'WSI-SERIAL-001-' || substr(v_serial_one::text, 1, 8),
     'WSI-SERIAL-001-' || substr(v_serial_one::text, 1, 8),
     v_item, 1, 'PCS', 'WSI-EXT-SERIAL-001',
     'wsi-serial-one-' || v_serial_one::text, repeat('1', 64), v_actor, v_trace),
    (v_serial_two, v_tenant, v_factory, 'SERIAL', 'MATERIAL',
     'WSI-SERIAL-002-' || substr(v_serial_two::text, 1, 8),
     'WSI-SERIAL-002-' || substr(v_serial_two::text, 1, 8),
     v_item, 1, 'PCS', 'WSI-EXT-SERIAL-002',
     'wsi-serial-two-' || v_serial_two::text, repeat('2', 64), v_actor, v_trace),
    (v_lot, v_tenant, v_factory, 'LOT', 'MATERIAL',
     'WSI-LOT-001-' || substr(v_lot::text, 1, 8),
     'WSI-LOT-001-' || substr(v_lot::text, 1, 8),
     v_item, 8, 'PCS', 'WSI-EXT-LOT-001',
     'wsi-lot-' || v_lot::text, repeat('3', 64), v_actor, v_trace),
    (v_lot_two, v_tenant, v_factory, 'LOT', 'MATERIAL',
     'WSI-LOT-002-' || substr(v_lot_two::text, 1, 8),
     'WSI-LOT-002-' || substr(v_lot_two::text, 1, 8),
     v_item, 2, 'PCS', 'WSI-EXT-LOT-002',
     'wsi-lot-two-' || v_lot_two::text, repeat('c', 64), v_actor, v_trace);

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

  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE NOTICE 'serial indivisibility and fail-closed LOT/SERIAL transformation guards passed; no unbacked split/merge edge or stock change was recorded';
END;
$$;

ROLLBACK;
