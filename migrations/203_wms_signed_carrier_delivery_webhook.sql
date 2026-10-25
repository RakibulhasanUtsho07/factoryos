BEGIN;

-- Signed integrations are first-class shipment evidence sources. A carrier event
-- must not impersonate the human who created the connector or dispatched shipment.
ALTER TABLE wms_shipment_delivery_events
  ALTER COLUMN recorded_by_user_id DROP NOT NULL;

-- Keep carrier tracking resolution tenant/factory-scoped and indexed without
-- permitting cross-tenant fallback matching.
CREATE INDEX IF NOT EXISTS idx_wms_shipments_carrier_tracking
  ON wms_shipments (tenant_id, factory_id, lower(btrim(carrier_name)), tracking_reference)
  WHERE carrier_name IS NOT NULL AND tracking_reference IS NOT NULL;

CREATE OR REPLACE FUNCTION factoryos_guard_wms_shipment_delivery_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_previous_event VARCHAR(24);
  v_shipment_status VARCHAR(16);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'shipment delivery evidence is append-only' USING ERRCODE = '55000';
  END IF;

  IF NEW.source_system = 'MANUAL' THEN
    IF NEW.recorded_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'manual delivery event actor must match the authenticated user' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source_system = 'CARRIER_WEBHOOK' OR NEW.source_system = 'SYSTEM' THEN
    IF NEW.recorded_by_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'system and carrier delivery events must not assert a human actor' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported shipment delivery event source system' USING ERRCODE = '23514';
  END IF;

  SELECT status INTO v_shipment_status
  FROM wms_shipments
  WHERE shipment_unit_id=NEW.shipment_unit_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
  FOR UPDATE;
  IF NOT FOUND OR v_shipment_status <> 'DISPATCHED' THEN
    RAISE EXCEPTION 'delivery event requires a dispatched shipment in the same tenant/factory' USING ERRCODE = '23514';
  END IF;

  SELECT event_type INTO v_previous_event
  FROM wms_shipment_delivery_events
  WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND shipment_unit_id=NEW.shipment_unit_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1
  FOR UPDATE;

  IF v_previous_event IS NULL THEN
    IF NEW.event_type NOT IN ('IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'DELIVERED') THEN
      RAISE EXCEPTION 'first delivery event cannot be RETURNED' USING ERRCODE = '23514';
    END IF;
  ELSIF v_previous_event = 'IN_TRANSIT' THEN
    IF NEW.event_type NOT IN ('OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'DELIVERED', 'RETURNED') THEN
      RAISE EXCEPTION 'invalid delivery transition from IN_TRANSIT' USING ERRCODE = '23514';
    END IF;
  ELSIF v_previous_event = 'OUT_FOR_DELIVERY' THEN
    IF NEW.event_type NOT IN ('DELIVERY_FAILED', 'DELIVERED', 'RETURNED') THEN
      RAISE EXCEPTION 'invalid delivery transition from OUT_FOR_DELIVERY' USING ERRCODE = '23514';
    END IF;
  ELSIF v_previous_event = 'DELIVERY_FAILED' THEN
    IF NEW.event_type NOT IN ('IN_TRANSIT', 'OUT_FOR_DELIVERY') THEN
      RAISE EXCEPTION 'failed delivery must be retried before another final delivery event' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'delivered or returned shipments are terminal for delivery events' USING ERRCODE = '23514';
  END IF;

  IF NEW.event_type='DELIVERED' THEN
    IF length(btrim(COALESCE(NEW.recipient_name, ''))) = 0
       OR NEW.proof_type IS NULL OR length(btrim(COALESCE(NEW.proof_reference, ''))) = 0
       OR NEW.proof_sha256 IS NULL OR NEW.proof_sha256 !~ '^[a-f0-9]{64}$'
       OR NEW.signed_at IS NULL OR NEW.signed_at > NEW.event_at THEN
      RAISE EXCEPTION 'DELIVERED requires recipient, proof type, proof reference, SHA-256 digest and signed timestamp' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.recipient_name IS NOT NULL OR NEW.proof_type IS NOT NULL
     OR NEW.proof_reference IS NOT NULL OR NEW.proof_sha256 IS NOT NULL OR NEW.signed_at IS NOT NULL THEN
    RAISE EXCEPTION 'proof-of-delivery fields may only be attached to DELIVERED events' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

INSERT INTO schema_migrations(version, checksum)
VALUES ('203_wms_signed_carrier_delivery_webhook', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
