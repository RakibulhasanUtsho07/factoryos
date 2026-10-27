BEGIN;

-- The new constraints intentionally fail closed if existing rows need a
-- reviewed data repair; never guess a carrier or tracking reference in migration.
DO $wms_carrier_tracking_preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.wms_shipments
    WHERE (carrier_name IS NULL) <> (tracking_reference IS NULL)
       OR (carrier_name IS NOT NULL AND length(btrim(carrier_name)) = 0)
       OR (tracking_reference IS NOT NULL AND length(btrim(tracking_reference)) = 0)
  ) THEN
    RAISE EXCEPTION 'Carrier tracking migration blocked: repair shipments with incomplete carrier/tracking pairs before applying migration 204';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.wms_shipments
    WHERE carrier_name IS NOT NULL AND tracking_reference IS NOT NULL
    GROUP BY tenant_id, factory_id, lower(btrim(carrier_name)), upper(btrim(tracking_reference))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Carrier tracking migration blocked: resolve duplicate normalized carrier/tracking bindings before applying migration 204';
  END IF;
END;
$wms_carrier_tracking_preflight$;

-- A carrier callback is routable only when the shipment has both halves of its
-- carrier identity. Fail closed for legacy rows that would otherwise be ambiguous.
DO $wms_carrier_tracking_pair$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.wms_shipments'::regclass
      AND conname='chk_wms_shipment_carrier_tracking_pair'
  ) THEN
    ALTER TABLE public.wms_shipments
      ADD CONSTRAINT chk_wms_shipment_carrier_tracking_pair
      CHECK (
        (carrier_name IS NULL AND tracking_reference IS NULL)
        OR (
          length(btrim(COALESCE(carrier_name, ''))) > 0
          AND length(btrim(COALESCE(tracking_reference, ''))) > 0
        )
      ) NOT VALID;
  END IF;
END;
$wms_carrier_tracking_pair$;

ALTER TABLE public.wms_shipments
  VALIDATE CONSTRAINT chk_wms_shipment_carrier_tracking_pair;

-- Carrier identifiers are case-insensitive for routing. The unique index
-- prevents concurrent dispatches from binding two shipments to the same
-- carrier/tracking pair in a tenant/factory.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_shipments_carrier_tracking_binding
  ON public.wms_shipments (
    tenant_id,
    factory_id,
    lower(btrim(carrier_name)),
    upper(btrim(tracking_reference))
  )
  WHERE carrier_name IS NOT NULL AND tracking_reference IS NOT NULL;

INSERT INTO schema_migrations(version, checksum)
VALUES ('204_wms_carrier_tracking_integrity', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
