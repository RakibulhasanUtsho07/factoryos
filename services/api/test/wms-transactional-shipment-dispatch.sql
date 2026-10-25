\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_dispatch_guard TEXT;
  v_line_guard TEXT;
  v_movement_guard TEXT;
  v_lifecycle_guard TEXT;
  v_evidence_guard TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '202_wms_transactional_shipment_dispatch'
  ) THEN
    RAISE EXCEPTION 'transactional shipment dispatch migration marker is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='traceability_shipment_dispatches' AND c.relkind='r'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='traceability_shipment_dispatch_lines' AND c.relkind='r'
  ) THEN
    RAISE EXCEPTION 'dispatch header and immutable lines tables must exist';
  END IF;

  IF NOT (
    (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='traceability_shipment_dispatches'::regclass)
    AND
    (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='traceability_shipment_dispatch_lines'::regclass)
  ) THEN
    RAISE EXCEPTION 'both shipment dispatch tables must enable and force RLS';
  END IF;

  SELECT pg_get_functiondef('factoryos_guard_traceability_shipment_dispatch()'::regprocedure)
    INTO v_dispatch_guard;
  IF v_dispatch_guard NOT ILIKE '%STAGING%'
    OR v_dispatch_guard NOT ILIKE '%picking_enabled%'
    OR v_dispatch_guard NOT ILIKE '%customer_order_reference%'
    OR v_dispatch_guard NOT ILIKE '%SHIPPED_AS%' THEN
    RAISE EXCEPTION 'dispatch guard must require active outbound staging, customer order references and package genealogy';
  END IF;

  SELECT pg_get_functiondef('factoryos_guard_traceability_shipment_dispatch_line()'::regprocedure)
    INTO v_line_guard;
  IF v_line_guard NOT ILIKE '%FINISHED_GOOD%'
    OR v_line_guard NOT ILIKE '%inventory_movement_id%'
    OR v_line_guard NOT ILIKE '%SHIPMENT_DISPATCH%' THEN
    RAISE EXCEPTION 'dispatch line guard must bind a finished-good identity to its matching issue movement';
  END IF;

  SELECT pg_get_functiondef('factoryos_guard_inventory_shipment_dispatch_movement()'::regprocedure)
    INTO v_movement_guard;
  IF v_movement_guard NOT ILIKE '%SHIPMENT_DISPATCH%'
    OR v_movement_guard NOT ILIKE '%ISSUE%'
    OR v_movement_guard NOT ILIKE '%source_location_id%' THEN
    RAISE EXCEPTION 'inventory movement guard must bind shipment issues to the dispatch and source location';
  END IF;

  SELECT pg_get_functiondef('factoryos_guard_shipment_customer_lifecycle()'::regprocedure)
    INTO v_lifecycle_guard;
  IF v_lifecycle_guard NOT ILIKE '%traceability_shipment_dispatches%'
    OR v_lifecycle_guard NOT ILIKE '%shipment cannot become SHIPPED%'
    OR v_lifecycle_guard NOT ILIKE '%customer_order_reference%' THEN
    RAISE EXCEPTION 'shipment status guard must reject shipping outside the transactional dispatch workflow';
  END IF;

  SELECT pg_get_functiondef('factoryos_assert_traceability_shipment_dispatch_evidence()'::regprocedure)
    INTO v_evidence_guard;
  IF v_evidence_guard NOT ILIKE '%inventory_movement_id%'
    OR v_evidence_guard NOT ILIKE '%line_quantity%'
    OR v_evidence_guard NOT ILIKE '%audit_events%'
    OR v_evidence_guard NOT ILIKE '%outbox_events%' THEN
    RAISE EXCEPTION 'deferred dispatch evidence guard must reconcile stock issues and transactional audit/outbox';
  END IF;

  IF (SELECT count(*) FROM pg_trigger
      WHERE tgrelid='inventory_movements'::regclass
        AND tgname='inventory_shipment_dispatch_movement_guard'
        AND NOT tgisinternal AND tgenabled='O') <> 1
    OR (SELECT count(*) FROM pg_trigger
      WHERE tgrelid='traceability_shipment_dispatches'::regclass
        AND tgname='ctr_traceability_shipment_dispatch_evidence'
        AND NOT tgisinternal AND tgenabled='O') <> 1 THEN
    RAISE EXCEPTION 'shipment issue and deferred dispatch evidence triggers must be enabled exactly once';
  END IF;
END;
$$;

ROLLBACK;
