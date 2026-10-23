BEGIN;
-- WP11-A: tenant/factory-scoped edge device registry and immutable reconnect ingestion ledger.
INSERT INTO permissions(code,description) VALUES
 ('edge.devices.read','Read registered edge devices and their synchronization state'),
 ('edge.devices.write','Register edge devices for an authorized factory'),
 ('edge.devices.control','Pause, resume, or revoke registered edge devices'),
 ('edge.telemetry.read','Read edge observations for an authorized factory'),
 ('edge.telemetry.ingest','Synchronize edge observations after local buffering or reconnect')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r CROSS JOIN permissions p
WHERE r.code='ORG_ADMIN' AND r.is_system=true
 AND p.code IN('edge.devices.read','edge.devices.write','edge.devices.control','edge.telemetry.read','edge.telemetry.ingest')
ON CONFLICT(role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS edge_devices(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL,
 factory_id UUID NOT NULL,
 device_key VARCHAR(100) NOT NULL,
 display_name VARCHAR(180) NOT NULL,
 protocol VARCHAR(16) NOT NULL,
 device_group VARCHAR(120),
 capability_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
 status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
 registration_hash VARCHAR(64) NOT NULL,
 created_by UUID NOT NULL,
 status_changed_by UUID,
 status_changed_at TIMESTAMPTZ,
 last_seen_at TIMESTAMPTZ,
 last_sync_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_edge_device_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CONSTRAINT fk_edge_device_factory_scope FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_edge_device_created_by FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT fk_edge_device_status_actor FOREIGN KEY(status_changed_by) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_edge_device_key CHECK(device_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
 CONSTRAINT chk_edge_device_name CHECK(length(btrim(display_name)) BETWEEN 1 AND 180),
 CONSTRAINT chk_edge_device_protocol CHECK(protocol IN('OPC_UA','MQTT','MODBUS','GENERIC')),
 CONSTRAINT chk_edge_device_group CHECK(device_group IS NULL OR length(btrim(device_group)) BETWEEN 1 AND 120),
 CONSTRAINT chk_edge_device_profile CHECK(jsonb_typeof(capability_profile)='object' AND octet_length(capability_profile::text)<=8192),
 CONSTRAINT chk_edge_device_status CHECK(status IN('ACTIVE','PAUSED','REVOKED')),
 CONSTRAINT chk_edge_device_registration_hash CHECK(registration_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT uq_edge_device_scope_id UNIQUE(id,tenant_id,factory_id),
 CONSTRAINT uq_edge_device_scope_key UNIQUE(tenant_id,factory_id,device_key)
);
CREATE INDEX IF NOT EXISTS idx_edge_devices_fleet ON edge_devices(tenant_id,factory_id,status,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_edge_devices_last_sync ON edge_devices(tenant_id,factory_id,last_sync_at ASC NULLS FIRST);
ALTER TABLE edge_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge_devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS edge_devices_tenant_isolation ON edge_devices;
CREATE POLICY edge_devices_tenant_isolation ON edge_devices
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());

CREATE TABLE IF NOT EXISTS edge_observations(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL,
 factory_id UUID NOT NULL,
 device_id UUID NOT NULL,
 event_id UUID NOT NULL,
 signal_key VARCHAR(120) NOT NULL,
 observed_at TIMESTAMPTZ NOT NULL,
 source_mode VARCHAR(20) NOT NULL,
 quality VARCHAR(12) NOT NULL,
 unit VARCHAR(32),
 sampling_interval_ms INTEGER,
 payload JSONB NOT NULL,
 payload_hash VARCHAR(64) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 recorded_by UUID NOT NULL,
 ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_edge_observation_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CONSTRAINT fk_edge_observation_factory_scope FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_edge_observation_device_scope FOREIGN KEY(device_id,tenant_id,factory_id) REFERENCES edge_devices(id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_edge_observation_actor FOREIGN KEY(recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_edge_observation_signal CHECK(signal_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'),
 CONSTRAINT chk_edge_observation_source CHECK(source_mode IN('EDGE_OFFLINE','CLOUD_CONNECTED')),
 CONSTRAINT chk_edge_observation_quality CHECK(quality IN('GOOD','UNCERTAIN','BAD')),
 CONSTRAINT chk_edge_observation_stream_metadata CHECK((unit IS NULL) = (sampling_interval_ms IS NULL) AND (unit IS NULL OR (length(btrim(unit)) BETWEEN 1 AND 32 AND sampling_interval_ms BETWEEN 0 AND 86400000)),
 CONSTRAINT chk_edge_observation_payload CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=8192),
 CONSTRAINT chk_edge_observation_payload_hash CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT chk_edge_observation_request_hash CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT uq_edge_observation_event UNIQUE(tenant_id,device_id,event_id)
);
CREATE INDEX IF NOT EXISTS idx_edge_observations_timeline ON edge_observations(tenant_id,factory_id,device_id,observed_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_edge_observations_ingested ON edge_observations(tenant_id,factory_id,ingested_at DESC);
ALTER TABLE edge_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge_observations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS edge_observations_tenant_isolation ON edge_observations;
CREATE POLICY edge_observations_tenant_isolation ON edge_observations
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());

CREATE TABLE IF NOT EXISTS edge_sync_batches(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL,
 factory_id UUID NOT NULL,
 device_id UUID NOT NULL,
 batch_key VARCHAR(128) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 observations_received INTEGER NOT NULL,
 observations_inserted INTEGER NOT NULL,
 observations_deduplicated INTEGER NOT NULL,
 recorded_by UUID NOT NULL,
 received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_edge_sync_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CONSTRAINT fk_edge_sync_factory_scope FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_edge_sync_device_scope FOREIGN KEY(device_id,tenant_id,factory_id) REFERENCES edge_devices(id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_edge_sync_actor FOREIGN KEY(recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_edge_sync_key CHECK(batch_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 CONSTRAINT chk_edge_sync_hash CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT chk_edge_sync_counts CHECK(observations_received BETWEEN 1 AND 100
   AND observations_inserted BETWEEN 0 AND observations_received
   AND observations_deduplicated BETWEEN 0 AND observations_received
   AND observations_inserted + observations_deduplicated = observations_received),
 CONSTRAINT uq_edge_sync_batch UNIQUE(tenant_id,device_id,batch_key)
);
CREATE INDEX IF NOT EXISTS idx_edge_sync_device_history ON edge_sync_batches(tenant_id,factory_id,device_id,received_at DESC);
ALTER TABLE edge_sync_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge_sync_batches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS edge_sync_batches_tenant_isolation ON edge_sync_batches;
CREATE POLICY edge_sync_batches_tenant_isolation ON edge_sync_batches
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION edge_reject_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Edge observations and sync batches are append-only';
END;
$$;
DROP TRIGGER IF EXISTS edge_observations_immutable ON edge_observations;
CREATE TRIGGER edge_observations_immutable
 BEFORE UPDATE OR DELETE ON edge_observations
 FOR EACH ROW EXECUTE FUNCTION edge_reject_ledger_mutation();
DROP TRIGGER IF EXISTS edge_sync_batches_immutable ON edge_sync_batches;
CREATE TRIGGER edge_sync_batches_immutable
 BEFORE UPDATE OR DELETE ON edge_sync_batches
 FOR EACH ROW EXECUTE FUNCTION edge_reject_ledger_mutation();


INSERT INTO factoryos_governance.tenant_relation_inventory (
  schema_name, relation_name, scope_model, data_category, export_disposition,
  erasure_disposition, audit_requirement, rationale
) VALUES
  ('public', 'edge_devices', 'DIRECT_TENANT_ID', 'BUSINESS_DATA', 'EXCLUDED',
   'BLOCKED_UNREVIEWED', 'DOMAIN_LEDGER_OR_AUDIT_REVIEW',
   'Edge devices are explicitly bound to a tenant and factory with forced row-level security and immutable registry identity.'),
  ('public', 'edge_observations', 'DIRECT_TENANT_ID', 'BUSINESS_DATA', 'EXCLUDED',
   'BLOCKED_UNREVIEWED', 'DOMAIN_LEDGER_OR_AUDIT_REVIEW',
   'Edge telemetry is an append-only tenant/factory/device-scoped observation ledger with event deduplication.'),
  ('public', 'edge_sync_batches', 'DIRECT_TENANT_ID', 'BUSINESS_DATA', 'EXCLUDED',
   'BLOCKED_UNREVIEWED', 'DOMAIN_LEDGER_OR_AUDIT_REVIEW',
   'Edge reconnect batches retain idempotent synchronization evidence under tenant/factory RLS.')
ON CONFLICT (schema_name, relation_name) DO UPDATE SET
  scope_model = EXCLUDED.scope_model,
  data_category = EXCLUDED.data_category,
  export_disposition = EXCLUDED.export_disposition,
  erasure_disposition = EXCLUDED.erasure_disposition,
  audit_requirement = EXCLUDED.audit_requirement,
  rationale = EXCLUDED.rationale,
  classified_at = clock_timestamp();

INSERT INTO factoryos_governance.tenant_relation_ownership_reviews (
  schema_name, relation_name, ownership_class, evidence_type, evidence_detail,
  scope_predicate, export_disposition, erasure_disposition, review_status
) VALUES
  ('public', 'edge_devices', 'DIRECT_TENANT', 'DIRECT_TENANT_COLUMN_AND_RLS',
   'Tenant/factory scoped edge registry, immutable device key binding and forced row-level security.',
   'tenant_id = public.factoryos_current_tenant_id()', 'EXCLUDED', 'BLOCKED_UNREVIEWED', 'VERIFIED'),
  ('public', 'edge_observations', 'DIRECT_TENANT', 'DIRECT_TENANT_COLUMN_AND_RLS',
   'Append-only edge observation evidence with a scoped device foreign key, unique device event identity and forced row-level security.',
   'tenant_id = public.factoryos_current_tenant_id()', 'EXCLUDED', 'BLOCKED_UNREVIEWED', 'VERIFIED'),
  ('public', 'edge_sync_batches', 'DIRECT_TENANT', 'DIRECT_TENANT_COLUMN_AND_RLS',
   'Append-only reconnect batch receipts with tenant/factory/device scoped identity and forced row-level security.',
   'tenant_id = public.factoryos_current_tenant_id()', 'EXCLUDED', 'BLOCKED_UNREVIEWED', 'VERIFIED')
ON CONFLICT (schema_name, relation_name) DO UPDATE SET
  ownership_class = EXCLUDED.ownership_class,
  evidence_type = EXCLUDED.evidence_type,
  evidence_detail = EXCLUDED.evidence_detail,
  scope_predicate = EXCLUDED.scope_predicate,
  export_disposition = EXCLUDED.export_disposition,
  erasure_disposition = EXCLUDED.erasure_disposition,
  review_status = EXCLUDED.review_status,
  reviewed_at = clock_timestamp();

INSERT INTO schema_migrations(version,checksum)
VALUES('191_edge_ot_device_gateway',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
