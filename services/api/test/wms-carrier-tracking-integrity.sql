DO $$
DECLARE
  v_pair_constraint BOOLEAN;
  v_constraint_definition TEXT;
  v_unique_index BOOLEAN;
  v_index_definition TEXT;
BEGIN
  IF to_regclass('public.wms_shipments') IS NULL THEN
    RAISE EXCEPTION 'WMS shipment table is missing';
  END IF;

  SELECT pg_get_constraintdef(oid)
  INTO v_constraint_definition
  FROM pg_constraint
  WHERE conrelid='public.wms_shipments'::regclass
    AND conname='chk_wms_shipment_carrier_tracking_pair'
    AND contype='c';
  v_pair_constraint := v_constraint_definition IS NOT NULL
    AND position('carrier_name IS NULL' IN v_constraint_definition) > 0
    AND position('tracking_reference IS NULL' IN v_constraint_definition) > 0;
  IF v_pair_constraint IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Shipment carrier/tracking pair constraint is missing or incomplete';
  END IF;

  SELECT indisunique AND indisvalid, pg_get_indexdef(indexrelid)
  INTO v_unique_index, v_index_definition
  FROM pg_index
  WHERE indexrelid='public.uq_wms_shipments_carrier_tracking_binding'::regclass;
  IF v_unique_index IS DISTINCT FROM TRUE
     OR position('lower' IN v_index_definition) = 0
     OR position('upper' IN v_index_definition) = 0
     OR position('btrim' IN v_index_definition) = 0
     OR length(v_index_definition) - length(replace(v_index_definition, 'btrim', '')) < 10
     OR position('carrier_name' IN v_index_definition) = 0
     OR position('tracking_reference' IN v_index_definition) = 0 THEN
    RAISE EXCEPTION 'Case-normalized tenant/factory carrier tracking uniqueness is missing or invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version='204_wms_carrier_tracking_integrity'
  ) THEN
    RAISE EXCEPTION 'Carrier tracking integrity migration version is not registered';
  END IF;
END;
$$;
