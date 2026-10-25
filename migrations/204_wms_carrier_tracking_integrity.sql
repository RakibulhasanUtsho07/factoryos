BEGIN;

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
