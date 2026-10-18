BEGIN;

INSERT INTO permissions(code,description) VALUES
  ('integrations.reconciliation.read','Read external attendance, production and quality reconciliation reports and cases'),
  ('integrations.reconciliation.review','Resolve or waive operational integration reconciliation cases')
ON CONFLICT(code) DO UPDATE SET description=EXCLUDED.description;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='ORG_ADMIN' AND r.is_system=true
  AND p.code IN ('integrations.reconciliation.read','integrations.reconciliation.review')
ON CONFLICT(role_id,permission_id) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='FACTORY_MANAGER' AND r.is_system=false
  AND p.code='integrations.reconciliation.read'
ON CONFLICT(role_id,permission_id) DO NOTHING;

CREATE TABLE integration_reconciliation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  domain varchar(16) NOT NULL,
  source_system varchar(120) NOT NULL,
  external_event_id varchar(200) NOT NULL,
  event_type varchar(150) NOT NULL,
  schema_version integer NOT NULL,
  occurred_at timestamptz,
  source_sequence bigint,
  watermark_through_sequence bigint,
  stream_key varchar(200),
  entity_reference varchar(200),
  reconciliation_key varchar(200),
  payload_sha256 varchar(64) NOT NULL,
  comparison_sha256 varchar(64) NOT NULL,
  correlation_id uuid,
  delivery_class varchar(16) NOT NULL DEFAULT 'ON_TIME',
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_integration_reconciliation_event_scope UNIQUE(id,tenant_id,factory_id),
  CONSTRAINT uq_integration_reconciliation_event_external UNIQUE(tenant_id,factory_id,connector_id,domain,external_event_id),
  CONSTRAINT fk_integration_reconciliation_event_connector FOREIGN KEY(connector_id,tenant_id,factory_id)
    REFERENCES integration_connectors(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_integration_reconciliation_domain CHECK(domain IN ('ATTENDANCE','PRODUCTION','QUALITY')),
  CONSTRAINT chk_integration_reconciliation_source_event CHECK(length(btrim(external_event_id)) BETWEEN 1 AND 200 AND external_event_id !~ '[[:cntrl:]]'),
  CONSTRAINT chk_integration_reconciliation_source_system CHECK(source_system ~ '^[A-Z0-9][A-Z0-9._-]{1,119}$'),
  CONSTRAINT chk_integration_reconciliation_event_type CHECK(event_type ~ '^[A-Z][A-Z0-9_.-]{0,149}$'),
  CONSTRAINT chk_integration_reconciliation_schema CHECK(schema_version BETWEEN 1 AND 10000),
  CONSTRAINT chk_integration_reconciliation_source_sequence CHECK(source_sequence IS NULL OR source_sequence BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_integration_reconciliation_watermark CHECK(watermark_through_sequence IS NULL OR watermark_through_sequence BETWEEN 0 AND 9007199254740991),
  CONSTRAINT chk_integration_reconciliation_stream_key CHECK(stream_key IS NULL OR (length(btrim(stream_key)) BETWEEN 1 AND 200 AND stream_key !~ '[[:cntrl:]]')),
  CONSTRAINT chk_integration_reconciliation_entity_reference CHECK(entity_reference IS NULL OR (length(btrim(entity_reference)) BETWEEN 1 AND 200 AND entity_reference !~ '[[:cntrl:]]')),
  CONSTRAINT chk_integration_reconciliation_key CHECK(reconciliation_key IS NULL OR (length(btrim(reconciliation_key)) BETWEEN 1 AND 200 AND reconciliation_key !~ '[[:cntrl:]]')),
  CONSTRAINT chk_integration_reconciliation_hash CHECK(payload_sha256 ~ '^[0-9a-f]{64}$' AND comparison_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_integration_reconciliation_delivery_class CHECK(delivery_class IN ('ON_TIME','LATE'))
);
CREATE INDEX idx_integration_reconciliation_stream_sequence
  ON integration_reconciliation_events(tenant_id,factory_id,connector_id,domain,stream_key,source_sequence)
  WHERE source_sequence IS NOT NULL;
CREATE INDEX idx_integration_reconciliation_received
  ON integration_reconciliation_events(tenant_id,factory_id,domain,received_at DESC);
CREATE INDEX idx_integration_reconciliation_cross_source
  ON integration_reconciliation_events(tenant_id,factory_id,domain,reconciliation_key,event_type)
  WHERE reconciliation_key IS NOT NULL;

CREATE TABLE integration_reconciliation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  event_id uuid,
  domain varchar(16) NOT NULL,
  case_type varchar(32) NOT NULL,
  case_key varchar(180) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'OPEN',
  severity varchar(16) NOT NULL DEFAULT 'WARNING',
  stream_key varchar(200),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_version integer NOT NULL DEFAULT 1,
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_by_user_id uuid,
  resolved_at timestamptz,
  resolution_reason varchar(500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_integration_reconciliation_case_scope UNIQUE(id,tenant_id,factory_id),
  CONSTRAINT fk_integration_reconciliation_case_connector FOREIGN KEY(connector_id,tenant_id,factory_id)
    REFERENCES integration_connectors(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_integration_reconciliation_case_event FOREIGN KEY(event_id,tenant_id,factory_id)
    REFERENCES integration_reconciliation_events(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_integration_reconciliation_case_resolver FOREIGN KEY(resolved_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_integration_reconciliation_case_domain CHECK(domain IN ('ATTENDANCE','PRODUCTION','QUALITY')),
  CONSTRAINT chk_integration_reconciliation_case_type CHECK(case_type IN (
    'MISSING_EVENT_TIME','INVALID_EVENT_TIME','INVALID_SEQUENCE','MISSING_SEQUENCE_RANGE',
    'SEQUENCE_COLLISION','CROSS_SOURCE_CONFLICT','CONFLICTING_DUPLICATE',
    'DUPLICATE_BUSINESS_EVENT','BUSINESS_EVENT_CONFLICT'
  )),
  CONSTRAINT chk_integration_reconciliation_case_status CHECK(status IN ('OPEN','RESOLVED','WAIVED')),
  CONSTRAINT chk_integration_reconciliation_case_severity CHECK(severity IN ('INFO','WARNING','ERROR')),
  CONSTRAINT chk_integration_reconciliation_case_key CHECK(length(btrim(case_key)) BETWEEN 1 AND 180),
  CONSTRAINT chk_integration_reconciliation_case_details CHECK(jsonb_typeof(details)='object'),
  CONSTRAINT chk_integration_reconciliation_case_version CHECK(row_version>=1),
  CONSTRAINT chk_integration_reconciliation_case_resolution CHECK(
    (status='OPEN' AND resolved_by_user_id IS NULL AND resolved_at IS NULL AND resolution_reason IS NULL)
    OR (status IN ('RESOLVED','WAIVED') AND resolved_at IS NOT NULL AND resolution_reason IS NOT NULL)
  )
);
CREATE UNIQUE INDEX uq_integration_reconciliation_open_case_key
  ON integration_reconciliation_cases(tenant_id,factory_id,case_key)
  WHERE status='OPEN';
CREATE INDEX idx_integration_reconciliation_case_queue
  ON integration_reconciliation_cases(tenant_id,factory_id,status,domain,opened_at DESC);

CREATE TABLE integration_reconciliation_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  event_id uuid,
  domain varchar(16) NOT NULL,
  external_event_id varchar(200) NOT NULL,
  incoming_payload_sha256 varchar(64) NOT NULL,
  outcome varchar(24) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_integration_reconciliation_attempt_connector FOREIGN KEY(connector_id,tenant_id,factory_id)
    REFERENCES integration_connectors(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_integration_reconciliation_attempt_event FOREIGN KEY(event_id,tenant_id,factory_id)
    REFERENCES integration_reconciliation_events(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_integration_reconciliation_attempt_domain CHECK(domain IN ('ATTENDANCE','PRODUCTION','QUALITY')),
  CONSTRAINT chk_integration_reconciliation_attempt_event_id CHECK(length(btrim(external_event_id)) BETWEEN 1 AND 200 AND external_event_id !~ '[[:cntrl:]]'),
  CONSTRAINT chk_integration_reconciliation_attempt_hash CHECK(incoming_payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_integration_reconciliation_attempt_outcome CHECK(outcome IN ('ACCEPTED','DUPLICATE_REPLAY','CONFLICTING_DUPLICATE'))
);
CREATE INDEX idx_integration_reconciliation_attempts_recent
  ON integration_reconciliation_attempts(tenant_id,factory_id,domain,received_at DESC);

CREATE TABLE integration_reconciliation_case_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  case_id uuid NOT NULL,
  actor_user_id uuid,
  action varchar(24) NOT NULL,
  status varchar(16) NOT NULL,
  reason varchar(500),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  happened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_integration_reconciliation_case_history_case FOREIGN KEY(case_id,tenant_id,factory_id)
    REFERENCES integration_reconciliation_cases(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_integration_reconciliation_case_history_actor FOREIGN KEY(actor_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_integration_reconciliation_history_action CHECK(action IN ('OPENED','RESOLVED','WAIVED','AUTO_RECONCILED')),
  CONSTRAINT chk_integration_reconciliation_history_status CHECK(status IN ('OPEN','RESOLVED','WAIVED')),
  CONSTRAINT chk_integration_reconciliation_history_details CHECK(jsonb_typeof(details)='object')
);
CREATE INDEX idx_integration_reconciliation_case_history
  ON integration_reconciliation_case_history(tenant_id,factory_id,case_id,happened_at DESC);

CREATE OR REPLACE FUNCTION public.factoryos_guard_integration_reconciliation_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'operational reconciliation event evidence is append-only'
      USING ERRCODE='55000';
  END IF;

  IF NOT EXISTS(
    SELECT 1
    FROM public.integration_webhook_receipts r
    JOIN public.integration_connectors c
      ON c.id=r.connector_id AND c.tenant_id=r.tenant_id AND c.factory_id=r.factory_id
    JOIN public.outbox_events o
      ON o.id=r.outbox_event_id AND o.tenant_id=r.tenant_id AND o.factory_id=r.factory_id
    WHERE r.tenant_id=NEW.tenant_id AND r.factory_id=NEW.factory_id
      AND r.connector_id=NEW.connector_id AND r.external_event_id=NEW.external_event_id
      AND r.event_type=NEW.event_type AND r.schema_version=NEW.schema_version
      AND r.payload_sha256=NEW.payload_sha256
      AND c.source_system=NEW.source_system
      AND o.event_type='INTEGRATION.WEBHOOK_RECEIVED'
      AND o.payload->>'external_event_id'=NEW.external_event_id
      AND o.payload->>'request_fingerprint_sha256'=NEW.payload_sha256
  ) THEN
    RAISE EXCEPTION 'reconciliation event must be bound to its exact signed webhook receipt and outbox event'
      USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_integration_reconciliation_event_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON integration_reconciliation_events
  FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_integration_reconciliation_event();

CREATE OR REPLACE FUNCTION public.factoryos_guard_integration_reconciliation_case()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    RETURN NEW;
  END IF;
  IF TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'reconciliation cases cannot be deleted'
      USING ERRCODE='55000';
  END IF;

  IF ROW(NEW.id,NEW.tenant_id,NEW.factory_id,NEW.connector_id,NEW.event_id,NEW.domain,NEW.case_type,
         NEW.case_key,NEW.severity,NEW.stream_key,NEW.details,NEW.opened_at,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.tenant_id,OLD.factory_id,OLD.connector_id,OLD.event_id,OLD.domain,OLD.case_type,
         OLD.case_key,OLD.severity,OLD.stream_key,OLD.details,OLD.opened_at,OLD.created_at) THEN
    RAISE EXCEPTION 'reconciliation case identity and evidence are immutable'
      USING ERRCODE='55000';
  END IF;

  IF OLD.status<>'OPEN' OR NEW.status NOT IN ('RESOLVED','WAIVED')
     OR NEW.row_version<>OLD.row_version+1
     OR NEW.resolved_at IS NULL OR NEW.resolution_reason IS NULL
     OR length(btrim(NEW.resolution_reason)) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'reconciliation case decision must be a reasoned OPEN to RESOLVED/WAIVED transition'
      USING ERRCODE='55000';
  END IF;

  IF NEW.resolved_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    IF NOT (NEW.resolved_by_user_id IS NULL AND factoryos_current_user_id() IS NULL AND NEW.status='RESOLVED') THEN
      RAISE EXCEPTION 'reconciliation case resolver must match authenticated user'
        USING ERRCODE='42501';
    END IF;
  END IF;
  NEW.updated_at=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_integration_reconciliation_case_guard
  BEFORE INSERT OR UPDATE OR DELETE ON integration_reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_integration_reconciliation_case();

CREATE OR REPLACE FUNCTION public.factoryos_record_integration_reconciliation_case_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_action varchar(24);
  v_actor uuid;
  v_reason varchar(500);
BEGIN
  IF TG_OP='INSERT' THEN
    v_action:='OPENED';
    v_actor:=factoryos_current_user_id();
    v_reason:=NULL;
  ELSE
    v_action:=CASE WHEN NEW.resolved_by_user_id IS NULL THEN 'AUTO_RECONCILED'
                   WHEN NEW.status='WAIVED' THEN 'WAIVED'
                   ELSE 'RESOLVED' END;
    v_actor:=NEW.resolved_by_user_id;
    v_reason:=NEW.resolution_reason;
  END IF;
  INSERT INTO public.integration_reconciliation_case_history(
    tenant_id,factory_id,case_id,actor_user_id,action,status,reason,details
  ) VALUES(
    NEW.tenant_id,NEW.factory_id,NEW.id,v_actor,v_action,NEW.status,v_reason,
    jsonb_build_object('case_type',NEW.case_type,'case_key',NEW.case_key,'row_version',NEW.row_version)
  );
  RETURN NEW;
END $$;
CREATE TRIGGER trg_integration_reconciliation_case_history
  AFTER INSERT OR UPDATE ON integration_reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION public.factoryos_record_integration_reconciliation_case_history();

CREATE OR REPLACE FUNCTION public.factoryos_guard_integration_reconciliation_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.event_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM integration_reconciliation_events e
      WHERE e.id=NEW.event_id AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
        AND e.connector_id=NEW.connector_id AND e.domain=NEW.domain
        AND e.external_event_id=NEW.external_event_id
    ) THEN
      RAISE EXCEPTION 'delivery attempt must reference matching accepted event evidence'
        USING ERRCODE='23503';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'reconciliation delivery attempts are append-only'
    USING ERRCODE='55000';
END $$;
CREATE TRIGGER trg_integration_reconciliation_attempt_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON integration_reconciliation_attempts
  FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_integration_reconciliation_attempt();

CREATE OR REPLACE FUNCTION public.factoryos_guard_integration_reconciliation_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'reconciliation case history is append-only'
    USING ERRCODE='55000';
END $$;
CREATE TRIGGER trg_integration_reconciliation_history_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON integration_reconciliation_case_history
  FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_integration_reconciliation_history();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'integration_reconciliation_events',
    'integration_reconciliation_cases',
    'integration_reconciliation_attempts',
    'integration_reconciliation_case_history'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id())',
      t||'_tenant_isolation',t
    );
  END LOOP;
END $$;

INSERT INTO schema_migrations(version)
VALUES('130_integration_operational_reconciliation')
ON CONFLICT(version) DO NOTHING;

COMMIT;
