BEGIN;

-- Round 39/40: bounded, normalized OT registry + telemetry spool-ingestion contract.
-- The API stores references to credentials/configuration; it never stores credentials
-- or opens a network connection to an industrial controller itself.

INSERT INTO permissions(code, description) VALUES
  ('ot.devices.read', 'Read OT device metadata in the active factory scope'),
  ('ot.devices.write', 'Register and pause OT devices in the active factory scope'),
  ('ot.devices.approve', 'Activate or revoke OT devices in the active factory scope'),
  ('ot.telemetry.ingest', 'Ingest normalized device telemetry into the scoped event ledger'),
  ('ot.telemetry.read', 'Read normalized telemetry events in the active factory scope')
ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN' AND r.is_system = true
  AND p.code IN (
    'ot.devices.read', 'ot.devices.write', 'ot.devices.approve',
    'ot.telemetry.ingest', 'ot.telemetry.read'
  )
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'FACTORY_MANAGER' AND r.is_system = false
  AND p.code IN ('ot.devices.read', 'ot.devices.write', 'ot.telemetry.ingest', 'ot.telemetry.read')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE ot_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  display_name varchar(160) NOT NULL,
  device_key varchar(160) NOT NULL,
  protocol varchar(16) NOT NULL,
  connection_reference varchar(140) NOT NULL,
  secret_reference varchar(100) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(20) NOT NULL DEFAULT 'PENDING_REVIEW',
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(64) NOT NULL,
  row_version integer NOT NULL DEFAULT 1,
  created_by_user_id uuid NOT NULL,
  updated_by_user_id uuid NOT NULL,
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  paused_at timestamptz,
  revoked_by_user_id uuid,
  revoked_at timestamptz,
  revocation_reason varchar(500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_ot_device_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_ot_device_key UNIQUE (tenant_id, factory_id, device_key),
  CONSTRAINT uq_ot_device_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_ot_device_factory FOREIGN KEY (factory_id, tenant_id)
    REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ot_device_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ot_device_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ot_device_reviewer FOREIGN KEY (reviewed_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ot_device_revoker FOREIGN KEY (revoked_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_ot_device_name CHECK (length(btrim(display_name)) BETWEEN 2 AND 160),
  CONSTRAINT chk_ot_device_key CHECK (device_key ~ '^[A-Z0-9][A-Z0-9._:-]{1,159}$'),
  CONSTRAINT chk_ot_device_protocol CHECK (protocol IN ('OPC_UA', 'MQTT', 'MODBUS_TCP')),
  CONSTRAINT chk_ot_device_connection_reference CHECK (connection_reference ~ '^config://[A-Z0-9][A-Z0-9_./-]{0,119}$'),
  CONSTRAINT chk_ot_device_secret_reference CHECK (secret_reference ~ '^env://OT_SECRET_[A-Z][A-Z0-9_]{0,79}$'),
  CONSTRAINT chk_ot_device_metadata CHECK (jsonb_typeof(metadata) = 'object' AND jsonb_object_length(metadata) <= 100),
  CONSTRAINT chk_ot_device_status CHECK (status IN ('PENDING_REVIEW', 'ACTIVE', 'PAUSED', 'REVOKED')),
  CONSTRAINT chk_ot_device_idempotency CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200 AND idempotency_key !~ '[[:cntrl:]]'),
  CONSTRAINT chk_ot_device_request_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_ot_device_row_version CHECK (row_version >= 1),
  CONSTRAINT chk_ot_device_lifecycle_metadata CHECK (
    (status = 'PENDING_REVIEW' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL
      AND paused_at IS NULL AND revoked_by_user_id IS NULL AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR
    (status = 'ACTIVE' AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL
      AND paused_at IS NULL AND revoked_by_user_id IS NULL AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR
    (status = 'PAUSED' AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL
      AND paused_at IS NOT NULL AND revoked_by_user_id IS NULL AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR
    (status = 'REVOKED' AND revoked_by_user_id IS NOT NULL AND revoked_at IS NOT NULL
      AND length(btrim(revocation_reason)) BETWEEN 3 AND 500)
  )
);
CREATE INDEX idx_ot_devices_scope_status
  ON ot_devices (tenant_id, factory_id, status, created_at DESC);

CREATE TABLE ot_device_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  device_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  action varchar(32) NOT NULL,
  reason varchar(500),
  row_version integer NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_ot_device_history_device FOREIGN KEY (device_id, tenant_id, factory_id)
    REFERENCES ot_devices (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ot_device_history_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_ot_device_history_action CHECK (action IN (
    'REGISTERED', 'ACTIVATED', 'PAUSED', 'RESUMED', 'REVOKED', 'TELEMETRY_BATCH_INGESTED'
  )),
  CONSTRAINT chk_ot_device_history_reason CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 500),
  CONSTRAINT chk_ot_device_history_version CHECK (row_version >= 1),
  CONSTRAINT chk_ot_device_history_metadata CHECK (jsonb_typeof(metadata) = 'object' AND jsonb_object_length(metadata) <= 100)
);
CREATE INDEX idx_ot_device_history_timeline
  ON ot_device_history (tenant_id, factory_id, device_id, occurred_at DESC, id);

CREATE TABLE ot_device_stream_cursors (
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  device_id uuid NOT NULL,
  stream_key varchar(160) NOT NULL,
  last_source_sequence bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, factory_id, device_id, stream_key),
  CONSTRAINT fk_ot_stream_cursor_device FOREIGN KEY (device_id, tenant_id, factory_id)
    REFERENCES ot_devices (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_ot_stream_cursor_key CHECK (length(btrim(stream_key)) BETWEEN 1 AND 160 AND stream_key !~ '[[:cntrl:]]'),
  CONSTRAINT chk_ot_stream_cursor_sequence CHECK (last_source_sequence BETWEEN 1 AND 9007199254740991)
);

CREATE TABLE ot_telemetry_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  device_id uuid NOT NULL,
  source_event_id varchar(200) NOT NULL,
  event_type varchar(100) NOT NULL,
  stream_key varchar(160) NOT NULL,
  source_sequence bigint,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivery_status varchar(16) NOT NULL,
  payload jsonb NOT NULL,
  payload_sha256 varchar(64) NOT NULL,
  CONSTRAINT uq_ot_telemetry_event_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_ot_telemetry_source_event UNIQUE (tenant_id, factory_id, device_id, source_event_id),
  CONSTRAINT fk_ot_telemetry_device FOREIGN KEY (device_id, tenant_id, factory_id)
    REFERENCES ot_devices (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_ot_telemetry_source_event CHECK (length(btrim(source_event_id)) BETWEEN 1 AND 200 AND source_event_id !~ '[[:cntrl:]]'),
  CONSTRAINT chk_ot_telemetry_event_type CHECK (event_type ~ '^[A-Z][A-Z0-9_.-]{0,99}$'),
  CONSTRAINT chk_ot_telemetry_stream_key CHECK (length(btrim(stream_key)) BETWEEN 1 AND 160 AND stream_key !~ '[[:cntrl:]]'),
  CONSTRAINT chk_ot_telemetry_sequence CHECK (source_sequence IS NULL OR source_sequence BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_ot_telemetry_delivery_status CHECK (delivery_status IN ('ON_TIME', 'LATE', 'SEQUENCE_GAP')),
  CONSTRAINT chk_ot_telemetry_payload CHECK (
    jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 4096
  ),
  CONSTRAINT chk_ot_telemetry_payload_hash CHECK (payload_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX uq_ot_telemetry_sequence
  ON ot_telemetry_events (tenant_id, factory_id, device_id, stream_key, source_sequence)
  WHERE source_sequence IS NOT NULL;
CREATE INDEX idx_ot_telemetry_timeline
  ON ot_telemetry_events (tenant_id, factory_id, device_id, observed_at DESC, id);
CREATE INDEX idx_ot_telemetry_delivery
  ON ot_telemetry_events (tenant_id, factory_id, device_id, delivery_status, received_at DESC);

CREATE OR REPLACE FUNCTION public.factoryos_guard_ot_device_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'OT device records are retained; revoke a device instead of deleting it'
      USING ERRCODE = '55000';
  END IF;

  IF (NEW.tenant_id, NEW.factory_id, NEW.display_name, NEW.device_key, NEW.protocol,
      NEW.connection_reference, NEW.secret_reference, NEW.metadata, NEW.idempotency_key,
      NEW.request_hash, NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.factory_id, OLD.display_name, OLD.device_key, OLD.protocol,
      OLD.connection_reference, OLD.secret_reference, OLD.metadata, OLD.idempotency_key,
      OLD.request_hash, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'OT device registration contract is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'OT device lifecycle updates require the next row version'
      USING ERRCODE = '40001';
  END IF;

  IF NOT (
    (OLD.status = 'PENDING_REVIEW' AND NEW.status IN ('ACTIVE', 'REVOKED'))
    OR (OLD.status = 'ACTIVE' AND NEW.status IN ('PAUSED', 'REVOKED'))
    OR (OLD.status = 'PAUSED' AND NEW.status IN ('ACTIVE', 'REVOKED'))
  ) THEN
    RAISE EXCEPTION 'invalid OT device lifecycle transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ot_device_update_guard
  BEFORE UPDATE OR DELETE ON ot_devices
  FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_ot_device_update();

CREATE OR REPLACE FUNCTION public.factoryos_guard_ot_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; write a compensating event instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_ot_device_history_append_only
  BEFORE UPDATE OR DELETE ON ot_device_history
  FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_ot_append_only();

CREATE TRIGGER trg_ot_telemetry_events_append_only
  BEFORE UPDATE OR DELETE ON ot_telemetry_events
  FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_ot_append_only();

-- RLS is forced at the table boundary in addition to explicit tenant/factory
-- predicates in every service query. The composite foreign keys bind child rows
-- to the same tenant and factory as their device.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ot_devices', 'ot_device_history', 'ot_device_stream_cursors', 'ot_telemetry_events'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I USING (tenant_id = factoryos_current_tenant_id()) WITH CHECK (tenant_id = factoryos_current_tenant_id())',
      table_name || '_tenant_scope', table_name);
  END LOOP;
END;
$$;

INSERT INTO schema_migrations(version, checksum)
VALUES ('148_ot_device_registry_spool', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
