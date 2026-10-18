BEGIN;

CREATE OR REPLACE FUNCTION public.factoryos_integration_event_types_valid(p_types varchar[])
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item varchar(150);
  seen varchar(150)[] := ARRAY[]::varchar(150)[];
BEGIN
  IF p_types IS NULL OR cardinality(p_types) < 1 OR cardinality(p_types) > 100 THEN
    RETURN false;
  END IF;
  FOREACH item IN ARRAY p_types LOOP
    IF item IS NULL OR item !~ '^[A-Z][A-Z0-9_.-]{0,149}$' OR item = ANY(seen) THEN
      RETURN false;
    END IF;
    seen := array_append(seen, item);
  END LOOP;
  RETURN true;
END $$;

ALTER TABLE integration_connectors
  ADD COLUMN allowed_event_types varchar(150)[] NOT NULL DEFAULT ARRAY['UNCONFIGURED.EVENT']::varchar(150)[];

ALTER TABLE integration_connectors
  ADD CONSTRAINT chk_integration_connector_allowed_event_types
  CHECK (public.factoryos_integration_event_types_valid(allowed_event_types));

CREATE OR REPLACE FUNCTION public.factoryos_guard_integration_connector()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.status<>'PENDING_REVIEW'
       OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL THEN
      RAISE EXCEPTION 'integration connector creation requires authenticated creator and pending review state'
        USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id,NEW.tenant_id,NEW.factory_id,NEW.display_name,NEW.source_system,NEW.connector_type,
         NEW.schema_version,NEW.allowed_event_types,NEW.payload_schema,NEW.idempotency_key,NEW.request_hash,
         NEW.created_by_user_id,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.tenant_id,OLD.factory_id,OLD.display_name,OLD.source_system,OLD.connector_type,
         OLD.schema_version,OLD.allowed_event_types,OLD.payload_schema,OLD.idempotency_key,OLD.request_hash,
         OLD.created_by_user_id,OLD.created_at) THEN
    RAISE EXCEPTION 'integration connector identity and event/schema contract are immutable; create a new connector version'
      USING ERRCODE='55000';
  END IF;

  IF NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'integration connector updater must match authenticated user'
      USING ERRCODE='42501';
  END IF;

  IF NEW.secret_reference IS DISTINCT FROM OLD.secret_reference
     AND NOT (OLD.status='PAUSED' AND NEW.status='PAUSED') THEN
    RAISE EXCEPTION 'integration connector secret may only rotate while paused'
      USING ERRCODE='55000';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status='PENDING_REVIEW' AND NEW.status IN ('ACTIVE','REJECTED'))
      OR (OLD.status='ACTIVE' AND NEW.status='PAUSED')
      OR (OLD.status='PAUSED' AND NEW.status='ACTIVE')
    ) THEN
      RAISE EXCEPTION 'invalid integration connector lifecycle transition'
        USING ERRCODE='55000';
    END IF;
    IF OLD.status='PENDING_REVIEW' AND
       (NEW.reviewed_by_user_id IS DISTINCT FROM factoryos_current_user_id()
        OR NEW.reviewed_by_user_id=OLD.created_by_user_id
        OR NEW.reviewed_at IS NULL) THEN
      RAISE EXCEPTION 'connector activation or rejection requires a different reviewer'
        USING ERRCODE='42501';
    END IF;
  END IF;
  NEW.updated_at=clock_timestamp();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.factoryos_guard_integration_webhook_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(
      SELECT 1 FROM integration_connectors c
      WHERE c.id=NEW.connector_id AND c.tenant_id=NEW.tenant_id
        AND c.factory_id=NEW.factory_id AND c.status='ACTIVE'
        AND NEW.event_type = ANY(c.allowed_event_types)
    ) THEN
      RAISE EXCEPTION 'webhook receipt requires an active scoped connector and registered event type'
        USING ERRCODE='55000';
    END IF;
    IF NOT EXISTS(
      SELECT 1 FROM outbox_events e
      WHERE e.id=NEW.outbox_event_id AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
        AND e.event_type='INTEGRATION.WEBHOOK_RECEIVED' AND e.event_version=1
        AND e.payload->>'source_event_type'=NEW.event_type
        AND e.payload->>'source_schema_version'=NEW.schema_version::text
    ) THEN
      RAISE EXCEPTION 'webhook receipt must bind to its exact outbox event'
        USING ERRCODE='23503';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'webhook receipts are immutable and cannot be changed or deleted'
    USING ERRCODE='55000';
END $$;

INSERT INTO schema_migrations(version)
VALUES('120_integration_connector_event_allowlist')
ON CONFLICT(version) DO NOTHING;

COMMIT;
