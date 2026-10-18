BEGIN;

INSERT INTO permissions(code,description) VALUES
  ('integrations.connectors.read','Read integration connector registry records in the active factory scope'),
  ('integrations.connectors.write','Register and pause integration connectors in the active factory scope'),
  ('integrations.connectors.approve','Approve, reject, resume and rotate integration connector credentials')
ON CONFLICT(code) DO UPDATE SET description=EXCLUDED.description;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='ORG_ADMIN' AND r.is_system=true
  AND p.code IN ('integrations.connectors.read','integrations.connectors.write','integrations.connectors.approve')
ON CONFLICT(role_id,permission_id) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='FACTORY_MANAGER' AND r.is_system=false
  AND p.code IN ('integrations.connectors.read','integrations.connectors.write')
ON CONFLICT(role_id,permission_id) DO NOTHING;

CREATE TABLE integration_connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  display_name varchar(160) NOT NULL,
  source_system varchar(120) NOT NULL,
  connector_type varchar(24) NOT NULL DEFAULT 'SIGNED_WEBHOOK',
  status varchar(24) NOT NULL DEFAULT 'PENDING_REVIEW',
  secret_reference varchar(120) NOT NULL,
  schema_version integer NOT NULL,
  payload_schema jsonb NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(64) NOT NULL,
  created_by_user_id uuid NOT NULL,
  updated_by_user_id uuid NOT NULL,
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  paused_at timestamptz,
  decision_reason varchar(500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_integration_connector_scope UNIQUE(id,tenant_id,factory_id),
  CONSTRAINT uq_integration_connector_idempotency UNIQUE(tenant_id,factory_id,idempotency_key),
  CONSTRAINT fk_integration_connector_factory FOREIGN KEY(factory_id,tenant_id)
    REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_integration_connector_creator FOREIGN KEY(created_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_integration_connector_updater FOREIGN KEY(updated_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_integration_connector_reviewer FOREIGN KEY(reviewed_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_integration_connector_name CHECK(length(btrim(display_name)) BETWEEN 2 AND 160),
  CONSTRAINT chk_integration_connector_source CHECK(source_system ~ '^[A-Z0-9][A-Z0-9._-]{1,119}$'),
  CONSTRAINT chk_integration_connector_type CHECK(connector_type='SIGNED_WEBHOOK'),
  CONSTRAINT chk_integration_connector_status CHECK(status IN ('PENDING_REVIEW','ACTIVE','PAUSED','REJECTED')),
  CONSTRAINT chk_integration_connector_secret_reference CHECK(secret_reference ~ '^env://WEBHOOK_SECRET_[A-Z][A-Z0-9_]{0,79}$'),
  CONSTRAINT chk_integration_connector_schema_version CHECK(schema_version BETWEEN 1 AND 10000),
  CONSTRAINT chk_integration_connector_schema_object CHECK(jsonb_typeof(payload_schema)='object'),
  CONSTRAINT chk_integration_connector_idempotency CHECK(length(btrim(idempotency_key)) BETWEEN 1 AND 200 AND idempotency_key !~ '[[:cntrl:]]'),
  CONSTRAINT chk_integration_connector_request_hash CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_integration_connector_decision CHECK(
    (status='PENDING_REVIEW' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL)
    OR (status IN ('ACTIVE','REJECTED') AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
    OR (status='PAUSED' AND reviewed_by_user_id IS NOT NULL AND paused_at IS NOT NULL)
  )
);

CREATE INDEX idx_integration_connectors_factory_status
  ON integration_connectors(tenant_id,factory_id,status,created_at DESC);

CREATE TABLE integration_connector_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  action varchar(24) NOT NULL,
  reason varchar(500),
  schema_version integer NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_integration_history_connector FOREIGN KEY(connector_id,tenant_id,factory_id)
    REFERENCES integration_connectors(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_integration_history_actor FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_integration_history_action CHECK(action IN ('CREATED','ACTIVATED','PAUSED','RESUMED','REJECTED','SECRET_ROTATED')),
  CONSTRAINT chk_integration_history_schema CHECK(schema_version BETWEEN 1 AND 10000),
  CONSTRAINT chk_integration_history_metadata CHECK(jsonb_typeof(metadata)='object')
);
CREATE INDEX idx_integration_connector_history_scope
  ON integration_connector_history(tenant_id,factory_id,connector_id,created_at DESC);

CREATE TABLE integration_webhook_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  external_event_id varchar(200) NOT NULL,
  event_type varchar(150) NOT NULL,
  schema_version integer NOT NULL,
  payload_sha256 varchar(64) NOT NULL,
  signature_timestamp bigint NOT NULL,
  outbox_event_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_integration_webhook_external_event UNIQUE(tenant_id,connector_id,external_event_id),
  CONSTRAINT uq_integration_webhook_outbox_event UNIQUE(outbox_event_id),
  CONSTRAINT fk_integration_receipt_connector FOREIGN KEY(connector_id,tenant_id,factory_id)
    REFERENCES integration_connectors(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_integration_receipt_outbox FOREIGN KEY(outbox_event_id,tenant_id,factory_id)
    REFERENCES outbox_events(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_integration_webhook_event_id CHECK(length(btrim(external_event_id)) BETWEEN 1 AND 200 AND external_event_id !~ '[[:cntrl:]]'),
  CONSTRAINT chk_integration_webhook_event_type CHECK(event_type ~ '^[A-Z][A-Z0-9_.-]{0,149}$'),
  CONSTRAINT chk_integration_webhook_schema_version CHECK(schema_version BETWEEN 1 AND 10000),
  CONSTRAINT chk_integration_webhook_payload_hash CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_integration_webhook_timestamp CHECK(signature_timestamp > 0)
);
CREATE INDEX idx_integration_webhook_receipts_recent
  ON integration_webhook_receipts(tenant_id,factory_id,connector_id,received_at DESC);

CREATE SCHEMA integration_internal;
REVOKE ALL ON SCHEMA integration_internal FROM PUBLIC;

CREATE TABLE integration_internal.webhook_routes (
  connector_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_integration_webhook_route_scope UNIQUE(connector_id,tenant_id,factory_id),
  CONSTRAINT fk_integration_webhook_route_connector FOREIGN KEY(connector_id,tenant_id,factory_id)
    REFERENCES public.integration_connectors(id,tenant_id,factory_id) ON DELETE RESTRICT
);
REVOKE ALL ON ALL TABLES IN SCHEMA integration_internal FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.factoryos_register_integration_webhook_route()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, integration_internal
AS $$
BEGIN
  INSERT INTO integration_internal.webhook_routes(connector_id,tenant_id,factory_id)
  VALUES(NEW.id,NEW.tenant_id,NEW.factory_id);
  RETURN NEW;
END $$;

CREATE TRIGGER trg_integration_connector_register_webhook_route
  AFTER INSERT ON integration_connectors
  FOR EACH ROW EXECUTE FUNCTION public.factoryos_register_integration_webhook_route();

CREATE OR REPLACE FUNCTION public.factoryos_resolve_integration_webhook(p_connector_id uuid)
RETURNS TABLE(tenant_id uuid,factory_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, integration_internal
AS $$
  SELECT r.tenant_id,r.factory_id
  FROM integration_internal.webhook_routes r
  WHERE r.connector_id=p_connector_id
$$;
REVOKE ALL ON FUNCTION public.factoryos_resolve_integration_webhook(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.factoryos_register_integration_webhook_route() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='factoryos_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.factoryos_resolve_integration_webhook(uuid) TO factoryos_app';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='factoryos_app') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA integration_internal FROM factoryos_app';
  END IF;
END $$;

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
         NEW.schema_version,NEW.payload_schema,NEW.idempotency_key,NEW.request_hash,
         NEW.created_by_user_id,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.tenant_id,OLD.factory_id,OLD.display_name,OLD.source_system,OLD.connector_type,
         OLD.schema_version,OLD.payload_schema,OLD.idempotency_key,OLD.request_hash,
         OLD.created_by_user_id,OLD.created_at) THEN
    RAISE EXCEPTION 'integration connector identity and schema are immutable; create a new connector version'
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

CREATE TRIGGER trg_integration_connector_guard
  BEFORE INSERT OR UPDATE ON integration_connectors
  FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_integration_connector();

CREATE OR REPLACE FUNCTION public.factoryos_guard_integration_connector_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.actor_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'integration connector history actor must match authenticated user'
        USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'integration connector history is append-only'
    USING ERRCODE='55000';
END $$;
CREATE TRIGGER trg_integration_connector_history_append_only
  BEFORE INSERT OR UPDATE OR DELETE ON integration_connector_history
  FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_integration_connector_history();

CREATE OR REPLACE FUNCTION public.factoryos_guard_integration_webhook_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(
      SELECT 1 FROM integration_connectors c
      WHERE c.id=NEW.connector_id AND c.tenant_id=NEW.tenant_id
        AND c.factory_id=NEW.factory_id AND c.status='ACTIVE'
    ) THEN
      RAISE EXCEPTION 'webhook receipt requires an active scoped connector'
        USING ERRCODE='55000';
    END IF;
    IF NOT EXISTS(
      SELECT 1 FROM outbox_events e
      WHERE e.id=NEW.outbox_event_id AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
        AND e.event_type=NEW.event_type AND e.event_version=NEW.schema_version
    ) THEN
      RAISE EXCEPTION 'webhook receipt must bind to its exact outbox event'
        USING ERRCODE='23503';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'webhook receipts are immutable and cannot be changed or deleted'
    USING ERRCODE='55000';
END $$;
CREATE TRIGGER trg_integration_webhook_receipt_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON integration_webhook_receipts
  FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_integration_webhook_receipt();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration_connectors','integration_connector_history','integration_webhook_receipts'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON public.%I USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id())',t||'_tenant_isolation',t);
  END LOOP;
END $$;

INSERT INTO schema_migrations(version)
VALUES('119_integration_connector_registry')
ON CONFLICT(version) DO NOTHING;

COMMIT;
