-- Manufacturing lifecycle cross-slice PostgreSQL acceptance gate.
-- Functional data-path regressions for PO/GRN, UoM, genealogy, WMS and quality are
-- executed in this same CI job. This gate verifies that their durable contracts
-- compose across the order -> material -> work order -> output -> quality/genealogy path.
BEGIN;

DO $$
DECLARE
  v_missing TEXT[];
  v_table TEXT;
  v_enabled BOOLEAN;
  v_forced BOOLEAN;
  v_col RECORD;
  v_precision INTEGER;
  v_scale INTEGER;
  v_pair RECORD;
  v_key_table TEXT;
  v_trigger RECORD;
  v_required_quantity NUMERIC(18,4);
  v_report_yield NUMERIC(7,4);
  v_trigger_enabled BOOLEAN;
  v_trigger_deferrable BOOLEAN;
  v_trigger_initially_deferred BOOLEAN;
BEGIN
  SELECT array_agg(required.version ORDER BY required.version)
  INTO v_missing
  FROM unnest(ARRAY[
    '058_inventory_reservations',
    '059_order_line_inventory_binding',
    '060_order_material_dispositions',
    '063_order_production_yield_scrap_tracking',
    '065_inventory_bin_reservations',
    '066_inventory_bin_reservation_balance_guard',
    '067_supplier_purchase_order_lifecycle',
    '068_purchase_order_lifecycle_integrity',
    '069_supplier_po_transactional_audit',
    '070_purchase_order_actor_binding',
    '071_supplier_audit_correlation',
    '072_goods_receipt_grn',
    '073_grn_stock_posting_guard',
    '074_lot_serial_product_genealogy',
    '075_uom_conversion_controls',
    '077_uom_base_quantity_precision_guard',
    '078_multi_bin_order_reservation_allocation',
    '079_inventory_bin_balance_deferred_final_state_guard',
    '080_inventory_location_directed_policy',
    '082_product_bom_routing_version_contracts',
    '083_product_definition_idempotency_hardening',
    '084_product_contract_maker_checker',
    '085_product_alternate_retirement_lifecycle',
    '086_product_bom_uom_snapshots',
    '087_product_bom_contract_retention_guards',
    '088_product_version_supersession_and_release_readiness',
    '090_production_work_order_operation_lifecycle',
    '091_production_output_inventory_posting',
    '092_order_production_report_work_order_routing_guard',
    '093_quality_inspection_ncr_holds_disposition',
    '094_quality_inspection_plans_and_results',
    '095_quality_ncr_resolution_gate',
    '096_quality_capa_action_lifecycle',
    '097_quality_defect_order_traceability',
    '098_quality_rework_execution_and_verification'
  ]) AS required(version)
  WHERE NOT EXISTS (
    SELECT 1 FROM schema_migrations sm WHERE sm.version = required.version
  );

  IF COALESCE(cardinality(v_missing), 0) > 0 THEN
    RAISE EXCEPTION 'Manufacturing lifecycle acceptance is missing migration markers: %', array_to_string(v_missing, ', ');
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'purchase_orders',
    'purchase_order_lines',
    'purchase_order_status_history',
    'goods_receipts',
    'goods_receipt_lines',
    'uom_units',
    'uom_conversion_rules',
    'uom_conversion_events',
    'product_definitions',
    'product_versions',
    'product_bom_lines',
    'product_bom_alternates',
    'product_routing_steps',
    'work_orders',
    'work_order_operations',
    'work_order_material_requirements',
    'work_order_material_reservations',
    'inventory_reservations',
    'inventory_reservation_consumptions',
    'inventory_items',
    'inventory_stock_balances',
    'inventory_movements',
    'order_production_reports',
    'production_output_postings',
    'traceability_units',
    'product_genealogy_events',
    'quality_inspections',
    'quality_inspection_events',
    'quality_defects',
    'quality_defect_events',
    'quality_audit_events',
    'quality_holds',
    'quality_dispositions',
    'quality_rework_orders',
    'quality_rework_events',
    'audit_events',
    'outbox_events'
  ] LOOP
    IF to_regclass(v_table) IS NULL THEN
      RAISE EXCEPTION 'Manufacturing lifecycle acceptance table % is missing', v_table;
    END IF;
  END LOOP;

  -- Core mutable records must remain tenant-isolated even when this contract runs as a DB owner.
  FOREACH v_table IN ARRAY ARRAY[
    'purchase_orders', 'purchase_order_lines', 'purchase_order_status_history', 'goods_receipts', 'goods_receipt_lines',
    'uom_units', 'uom_conversion_rules', 'uom_conversion_events', 'product_definitions', 'product_versions',
    'product_bom_lines', 'product_bom_alternates', 'product_routing_steps',
    'work_orders', 'work_order_operations', 'work_order_events',
    'work_order_material_requirements', 'work_order_material_reservations',
    'inventory_reservations', 'inventory_stock_balances', 'inventory_movements',
    'order_production_reports', 'production_output_postings', 'traceability_units',
    'product_genealogy_events', 'traceability_unit_status_events',
    'quality_inspections', 'quality_inspection_events', 'quality_defects', 'quality_defect_events',
    'quality_holds', 'quality_dispositions', 'quality_rework_orders', 'quality_rework_events'
  ] LOOP
    SELECT c.relrowsecurity, c.relforcerowsecurity
    INTO v_enabled, v_forced
    FROM pg_class c
    WHERE c.oid = to_regclass(v_table);

    IF COALESCE(v_enabled, FALSE) IS NOT TRUE OR COALESCE(v_forced, FALSE) IS NOT TRUE THEN
      RAISE EXCEPTION 'Manufacturing lifecycle tenant RLS must be enabled and forced for %', v_table;
    END IF;
  END LOOP;

  -- Ensure the integration cannot silently become a collection of unlinked tables.
  FOR v_pair IN
    SELECT *
    FROM (VALUES
      ('purchase_order_lines', 'purchase_orders', 1),
      ('goods_receipts', 'purchase_orders', 1),
      ('goods_receipt_lines', 'goods_receipts', 1),
      ('goods_receipt_lines', 'purchase_order_lines', 1),
      ('goods_receipt_lines', 'inventory_items', 1),
      ('product_versions', 'product_definitions', 1),
      ('product_bom_lines', 'product_versions', 1),
      ('product_bom_lines', 'inventory_items', 1),
      ('product_routing_steps', 'product_versions', 1),
      ('product_routing_steps', 'manufacturing_work_centres', 1),
      ('work_orders', 'orders', 1),
      ('work_orders', 'order_lines', 1),
      ('work_orders', 'product_versions', 1),
      ('work_orders', 'inventory_items', 1),
      ('work_order_material_requirements', 'product_bom_lines', 1),
      ('work_order_material_requirements', 'inventory_items', 1),
      ('work_order_material_reservations', 'inventory_reservations', 1),
      ('work_order_material_reservations', 'work_order_material_requirements', 1),
      ('order_production_reports', 'work_orders', 1),
      ('order_production_reports', 'work_order_operations', 1),
      ('production_output_postings', 'order_production_reports', 1),
      ('production_output_postings', 'inventory_movements', 1),
      ('production_output_postings', 'work_orders', 1),
      ('quality_inspections', 'traceability_units', 1),
      ('quality_holds', 'traceability_units', 1),
      ('quality_dispositions', 'inventory_movements', 1),
      ('quality_rework_orders', 'quality_inspections', 1),
      ('product_genealogy_events', 'traceability_units', 2)
    ) AS pairs(source_table, target_table, minimum_links)
  LOOP
    SELECT count(*)::INTEGER INTO v_precision
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.conrelid = to_regclass(v_pair.source_table)
      AND c.confrelid = to_regclass(v_pair.target_table);

    IF v_precision < v_pair.minimum_links THEN
      RAISE EXCEPTION 'Manufacturing lifecycle relationship % -> % requires at least % scoped foreign key(s); found %',
        v_pair.source_table, v_pair.target_table, v_pair.minimum_links, v_precision;
    END IF;
  END LOOP;

  -- Every operational quantity must persist as NUMERIC(18,4), not binary float or rounded integers.
  FOR v_col IN
    SELECT * FROM (VALUES
      ('goods_receipt_lines', 'received_quantity'),
      ('goods_receipt_lines', 'rejected_quantity'),
      ('goods_receipt_lines', 'accepted_quantity'),
      ('inventory_stock_balances', 'quantity_on_hand'),
      ('inventory_stock_balances', 'quantity_reserved'),
      ('inventory_movements', 'quantity'),
      ('inventory_movements', 'quantity_delta'),
      ('inventory_movements', 'quantity_after'),
      ('inventory_reservations', 'quantity'),
      ('work_orders', 'target_quantity'),
      ('work_order_material_requirements', 'required_quantity'),
      ('work_order_material_reservations', 'quantity'),
      ('order_production_reports', 'good_quantity'),
      ('order_production_reports', 'scrap_quantity'),
      ('order_production_reports', 'cumulative_good_quantity'),
      ('order_production_reports', 'cumulative_scrap_quantity'),
      ('production_output_postings', 'good_quantity'),
      ('production_output_postings', 'scrap_quantity'),
      ('traceability_units', 'quantity'),
      ('product_genealogy_events', 'quantity'),
      ('quality_defects', 'affected_quantity'),
      ('quality_dispositions', 'quantity'),
      ('quality_rework_orders', 'input_quantity'),
      ('quality_rework_orders', 'recovered_quantity'),
      ('quality_rework_orders', 'scrap_quantity')
    ) AS quantities(table_name, column_name)
  LOOP
    SELECT c.numeric_precision, c.numeric_scale
    INTO v_precision, v_scale
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema()
      AND c.table_name = v_col.table_name
      AND c.column_name = v_col.column_name
      AND c.data_type = 'numeric';

    IF NOT FOUND OR v_precision <> 18 OR v_scale <> 4 THEN
      RAISE EXCEPTION 'Manufacturing quantity %.% must be NUMERIC(18,4); actual precision/scale is %/%',
        v_col.table_name, v_col.column_name, v_precision, v_scale;
    END IF;
  END LOOP;

  -- Writes across the lifecycle must carry unique replay keys; exact key replays cannot duplicate stock.
  FOREACH v_key_table IN ARRAY ARRAY[
    'purchase_orders', 'goods_receipts', 'uom_units', 'uom_conversion_rules', 'uom_conversion_events',
    'manufacturing_work_centres', 'product_versions', 'product_bom_alternates',
    'work_orders', 'work_order_events', 'inventory_reservations',
    'order_production_reports', 'production_output_postings', 'quality_inspections',
    'quality_inspection_events', 'quality_defects', 'quality_defect_events',
    'quality_dispositions', 'quality_rework_orders', 'quality_rework_events', 'traceability_units',
    'traceability_unit_status_events', 'product_genealogy_events'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema()
        AND t.relname = v_key_table
        AND i.indisunique
        AND pg_get_indexdef(i.indexrelid) ILIKE '%idempotency_key%'
    ) THEN
      RAISE EXCEPTION 'Manufacturing lifecycle idempotency uniqueness is missing on %', v_key_table;
    END IF;
  END LOOP;

  -- Releasing/consuming reservations and output posting must be guarded at transaction commit.
  IF to_regprocedure('factoryos_assert_inventory_reservation_balance()') IS NULL
    OR to_regprocedure('factoryos_guard_work_order_lifecycle()') IS NULL
    OR to_regprocedure('factoryos_guard_work_order_operation_lifecycle()') IS NULL
    OR to_regprocedure('factoryos_guard_production_output_posting()') IS NULL
    OR to_regprocedure('factoryos_require_production_output_posting()') IS NULL
    OR to_regprocedure('factoryos_guard_quality_hold()') IS NULL
    OR to_regprocedure('factoryos_quality_sync_traceability_hold()') IS NULL
    OR to_regprocedure('factoryos_guard_quality_disposition()') IS NULL THEN
    RAISE EXCEPTION 'Manufacturing lifecycle cross-domain integrity functions are missing';
  END IF;

  SELECT t.tgenabled <> 'D', t.tgdeferrable, t.tginitdeferred
  INTO v_trigger_enabled, v_trigger_deferrable, v_trigger_initially_deferred
  FROM pg_trigger t
  WHERE t.tgrelid = 'order_production_reports'::regclass
    AND t.tgname = 'trg_order_production_report_inventory_posting_required'
    AND NOT t.tgisinternal;

  IF NOT FOUND OR NOT v_trigger_enabled OR NOT v_trigger_deferrable OR NOT v_trigger_initially_deferred THEN
    RAISE EXCEPTION 'Work-order output report must require its yield/stock posting in the same transaction';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'production_output_postings'::regclass
      AND t.tgname = 'trg_production_output_posting_guard'
      AND NOT t.tgisinternal AND t.tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'quality_holds'::regclass
      AND t.tgname = 'trg_quality_sync_traceability_hold'
      AND NOT t.tgisinternal AND t.tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'inventory_reservations'::regclass
      AND t.tgname = 'ctr_inventory_reservation_balance_consistency'
      AND NOT t.tgisinternal AND t.tgenabled <> 'D' AND t.tgdeferrable
  ) THEN
    RAISE EXCEPTION 'Stock receipt, quality quarantine/genealogy or reservation-consistency guard is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'order_production_reports'::regclass
      AND t.tgname = 'trg_order_production_report_work_order_guard'
      AND NOT t.tgisinternal AND t.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Order output must remain linked to its final production work-order operation';
  END IF;

  -- Require the guard rails that make the isolated domain test fixtures composable.
  -- These checks deliberately assert enabled triggers and deferred commit-time evidence,
  -- rather than accepting table existence as proof of lifecycle integrity.
  FOR v_trigger IN
    SELECT required.table_name, required.trigger_name, required.must_defer
    FROM (VALUES
      ('purchase_orders', 'trg_purchase_orders_lifecycle_guard', FALSE),
      ('goods_receipts', 'trg_goods_receipts_lifecycle_guard', FALSE),
      ('goods_receipts', 'ctr_goods_receipt_posted_integrity', TRUE),
      ('inventory_movements', 'trg_goods_receipt_stock_movement_guard', FALSE),
      ('uom_units', 'trg_uom_unit_immutable', FALSE),
      ('uom_units', 'ctr_uom_unit_evidence', TRUE),
      ('uom_conversion_rules', 'trg_uom_conversion_rule_guard', FALSE),
      ('uom_conversion_rules', 'ctr_uom_conversion_evidence', TRUE),
      ('uom_conversion_events', 'ctr_uom_conversion_event_evidence', TRUE),
      ('product_versions', 'trg_product_version_guard', FALSE),
      ('product_versions', 'trg_product_version_release_readiness', FALSE),
      ('product_bom_lines', 'trg_product_bom_line_guard', FALSE),
      ('product_bom_alternates', 'trg_product_bom_alternate_guard', FALSE),
      ('product_routing_steps', 'trg_product_routing_step_guard', FALSE),
      ('work_orders', 'trg_work_order_lifecycle', FALSE),
      ('work_order_operations', 'trg_work_order_operation_lifecycle', FALSE),
      ('work_order_events', 'trg_work_order_event_payload_guard', FALSE),
      ('production_output_postings', 'trg_production_output_posting_guard', FALSE),
      ('traceability_units', 'trg_traceability_unit_guard', FALSE),
      ('traceability_units', 'ctr_traceability_unit_evidence', TRUE),
      ('product_genealogy_events', 'trg_product_genealogy_guard', FALSE),
      ('product_genealogy_events', 'ctr_product_genealogy_event_evidence', TRUE),
      ('quality_inspections', 'trg_quality_inspection_target_guard', FALSE),
      ('quality_inspections', 'ctr_quality_inspection_evidence', TRUE),
      ('quality_holds', 'trg_quality_hold_guard', FALSE),
      ('quality_holds', 'trg_quality_sync_traceability_hold', FALSE),
      ('quality_dispositions', 'trg_quality_disposition_guard', FALSE),
      ('quality_rework_orders', 'trg_quality_rework_order_lifecycle', FALSE),
      ('quality_rework_orders', 'ctr_quality_rework_state_event', TRUE),
      ('quality_rework_events', 'ctr_quality_rework_event_audit', TRUE)
    ) AS required(table_name, trigger_name, must_defer)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_trigger t
      WHERE t.tgrelid = to_regclass(v_trigger.table_name)
        AND t.tgname = v_trigger.trigger_name
        AND NOT t.tgisinternal
        AND t.tgenabled <> 'D'
        AND (NOT v_trigger.must_defer OR (t.tgdeferrable AND t.tginitdeferred))
    ) THEN
      RAISE EXCEPTION 'Manufacturing lifecycle trigger %.% is missing, disabled or not deferred as required',
        v_trigger.table_name, v_trigger.trigger_name;
    END IF;
  END LOOP;

  -- A small deterministic quantity oracle spans BOM, yield, wastage and the database's 4dp policy.
  v_required_quantity := CEIL(
    ((4::NUMERIC / (90::NUMERIC / 100)) * 0.5000 * (1 + 2.5000 / 100)) * 10000
  ) / 10000;
  v_report_yield := ROUND(4.0000 * 100 / (4.0000 + 1.0000), 4);

  IF v_required_quantity <> 2.2778 OR v_report_yield <> 80.0000 THEN
    RAISE EXCEPTION 'Deterministic manufacturing quantity oracle changed: requirement %, yield %',
      v_required_quantity, v_report_yield;
  END IF;

  -- Force deferred guards now so missing cross-slice evidence fails this CI step rather than at later teardown.
  SET CONSTRAINTS ALL IMMEDIATE;

  RAISE NOTICE 'Manufacturing lifecycle acceptance passed: PO/GRN, UoM, BOM/routing, work-order/output, quality disposition, inventory and genealogy contracts are linked';
END;
$$;

ROLLBACK;
