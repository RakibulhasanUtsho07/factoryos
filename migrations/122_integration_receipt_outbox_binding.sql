BEGIN;

-- Bind each immutable intake receipt to the exact connector event placed in
-- the outbox; tenant/factory scope alone is not sufficient for provenance.
CREATE OR REPLACE FUNCTION public.factoryos_guard_integration_webhook_receipt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_source_system varchar(120);
  v_aggregate_type text;
  v_aggregate_id text;
  v_outbox_event_type text;
  v_outbox_event_version integer;
  v_outbox_payload jsonb;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT c.source_system
      INTO v_source_system
    FROM public.integration_connectors c
    WHERE c.id=NEW.connector_id
      AND c.tenant_id=NEW.tenant_id
      AND c.factory_id=NEW.factory_id
      AND c.status='ACTIVE'
      AND NEW.event_type = ANY(c.allowed_event_types);

    IF NOT FOUND THEN
      RAISE EXCEPTION 'webhook receipt requires an active scoped connector and registered event type'
        USING ERRCODE='55000';
    END IF;

    SELECT e.aggregate_type,e.aggregate_id::text,e.event_type,e.event_version,e.payload
      INTO v_aggregate_type,v_aggregate_id,v_outbox_event_type,v_outbox_event_version,v_outbox_payload
    FROM public.outbox_events e
    WHERE e.id=NEW.outbox_event_id
      AND e.tenant_id=NEW.tenant_id
      AND e.factory_id=NEW.factory_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'webhook receipt must bind to its exact outbox event'
        USING ERRCODE='23503';
    END IF;

    IF v_aggregate_type IS DISTINCT FROM 'INTEGRATION_CONNECTOR'
       OR v_aggregate_id IS DISTINCT FROM NEW.connector_id::text
       OR v_outbox_event_type IS DISTINCT FROM 'INTEGRATION.WEBHOOK_RECEIVED'
       OR v_outbox_event_version IS DISTINCT FROM 1
       OR v_outbox_payload->>'connector_id' IS DISTINCT FROM NEW.connector_id::text
       OR v_outbox_payload->>'source_system' IS DISTINCT FROM v_source_system
       OR v_outbox_payload->>'external_event_id' IS DISTINCT FROM NEW.external_event_id
       OR v_outbox_payload->>'source_event_type' IS DISTINCT FROM NEW.event_type
       OR v_outbox_payload->>'source_schema_version' IS DISTINCT FROM NEW.schema_version::text
       OR v_outbox_payload->>'request_fingerprint_sha256' IS DISTINCT FROM NEW.payload_sha256
    THEN
      RAISE EXCEPTION 'webhook receipt must bind to its exact outbox event'
        USING ERRCODE='23503';
    END IF;

    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'webhook receipts are immutable and cannot be changed or deleted'
    USING ERRCODE='55000';
END $$;

INSERT INTO schema_migrations(version)
VALUES('122_integration_receipt_outbox_binding')
ON CONFLICT(version) DO NOTHING;

COMMIT;
