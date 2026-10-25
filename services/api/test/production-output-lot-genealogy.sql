\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_column_count INTEGER;
  v_fk_count INTEGER;
  v_index_count INTEGER;
  v_trigger_enabled BOOLEAN;
  v_function_source TEXT;
  v_genealogy_function_source TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '198_production_output_lot_genealogy'
  ) THEN
    RAISE EXCEPTION 'production output genealogy migration marker is missing';
  END IF;

  SELECT count(*)::INTEGER INTO v_column_count
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'production_output_postings'
    AND column_name IN ('traceability_unit_id', 'scrap_traceability_unit_id');

  IF v_column_count <> 2 THEN
    RAISE EXCEPTION 'production output posting must bind both finished-good and scrap traceability identities';
  END IF;

  SELECT count(*)::INTEGER INTO v_fk_count
  FROM pg_constraint
  WHERE conrelid = 'production_output_postings'::regclass
    AND contype = 'f'
    AND conname IN (
      'fk_production_output_posting_traceability_unit',
      'fk_production_output_posting_scrap_traceability_unit'
    );

  IF v_fk_count <> 2 THEN
    RAISE EXCEPTION 'production output traceability links must be tenant/factory and item scoped foreign keys';
  END IF;

  SELECT count(*)::INTEGER INTO v_index_count
  FROM pg_index i
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_class ix ON ix.oid = i.indexrelid
  WHERE t.oid = 'production_output_postings'::regclass
    AND i.indisunique
    AND ix.relname IN (
      'uq_production_output_posting_traceability_unit',
      'uq_production_output_posting_scrap_traceability_unit'
    );

  IF v_index_count <> 2 THEN
    RAISE EXCEPTION 'a finished-good or scrap traceability identity cannot be bound to multiple output postings';
  END IF;

  SELECT t.tgenabled <> 'D'
  INTO v_trigger_enabled
  FROM pg_trigger t
  WHERE t.tgrelid = 'production_output_postings'::regclass
    AND t.tgname = 'trg_production_output_posting_traceability_link'
    AND NOT t.tgisinternal;

  IF v_trigger_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'production output traceability-link guard is missing or disabled';
  END IF;

  SELECT pg_get_functiondef('factoryos_guard_production_output_traceability_link()'::regprocedure)
  INTO v_function_source;

  IF position('positive accepted good output requires a finished-good traceability lot' IN v_function_source) = 0
    OR position('non-sellable scrap traceability identity' IN v_function_source) = 0
    OR position('finished-good traceability lot must match the report' IN v_function_source) = 0
  THEN
    RAISE EXCEPTION 'production output guard does not bind identities to report quantities and sellable/scrap roles';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.oid = 'public.traceability_units'::regclass
      AND c.relrowsecurity AND c.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.oid = 'public.product_genealogy_events'::regclass
      AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'output genealogy must preserve forced tenant RLS on traceability identities and genealogy edges';
  END IF;

  SELECT pg_get_functiondef('factoryos_guard_product_genealogy_event()'::regprocedure)
  INTO v_genealogy_function_source;

  IF position('inventory_material_allocation_policies' IN v_genealogy_function_source) = 0
    OR position('policy_scope = ''SECTOR''' IN v_genealogy_function_source) = 0
    OR position('tlb.quantity_on_hand > tlb.quantity_reserved' IN v_genealogy_function_source) = 0
    OR position('COALESCE(gr.posted_at, gr.received_at, u.created_at)' IN v_genealogy_function_source) = 0
    OR position('v_source_type' IN v_genealogy_function_source) = 0
  THEN
    RAISE EXCEPTION 'genealogy guard must align item/sector/factory FIFO/FEFO policy with eligible unreserved bin stock';
  END IF;
END $$;

ROLLBACK;
