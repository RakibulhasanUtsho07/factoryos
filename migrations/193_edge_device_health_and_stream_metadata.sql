BEGIN;
-- WP11-D: edge runtime health, model/drift reporting, and explicit stream metadata.

INSERT INTO permissions(code,description) VALUES
 ('edge.devices.health.read','Read scoped edge-agent health, model versions, and reported drift signals')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r CROSS JOIN permissions p
WHERE r.code='ORG_ADMIN' AND r.is_system=true
 AND p.code='edge.devices.health.read'
ON CONFLICT(role_id,permission_id) DO NOTHING;

ALTER TABLE edge_observations
 ADD COLUMN IF NOT EXISTS unit VARCHAR(32),
 ADD COLUMN IF NOT EXISTS sampling_interval_ms INTEGER;

DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='chk_edge_observation_unit') THEN
  ALTER TABLE edge_observations ADD CONSTRAINT chk_edge_observation_unit
   CHECK(unit IS NULL OR unit ~ '^[A-Za-z0-9%._/-]{1,32}$');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='chk_edge_observation_sampling_interval') THEN
  ALTER TABLE edge_observations ADD CONSTRAINT chk_edge_observation_sampling_interval
   CHECK(sampling_interval_ms IS NULL OR sampling_interval_ms BETWEEN 0 AND 86400000);
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS edge_device_health_reports(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL,
 factory_id UUID NOT NULL,
 device_id UUID NOT NULL,
 credential_id UUID NOT NULL,
 health_event_id UUID NOT NULL,
 reported_at TIMESTAMPTZ NOT NULL,
 agent_version VARCHAR(64) NOT NULL,
 runtime_status VARCHAR(20) NOT NULL,
 pending_batches INTEGER NOT NULL,
 pending_bytes BIGINT NOT NULL,
 last_successful_sync_at TIMESTAMPTZ,
 model_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
 drift_signals JSONB NOT NULL DEFAULT '[]'::jsonb,
 capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
 request_hash VARCHAR(64) NOT NULL,
 received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_edge_health_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CONSTRAINT fk_edge_health_factory_scope FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_edge_health_device_scope FOREIGN KEY(device_id,tenant_id,factory_id) REFERENCES edge_devices(id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_edge_health_credential_scope FOREIGN KEY(credential_id,tenant_id,factory_id,device_id)
  REFERENCES edge_device_credentials(id,tenant_id,factory_id,device_id) ON DELETE RESTRICT,
 CONSTRAINT uq_edge_health_event UNIQUE(tenant_id,device_id,health_event_id),
 CONSTRAINT chk_edge_health_agent_version CHECK(agent_version ~ '^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$'),
 CONSTRAINT chk_edge_health_status CHECK(runtime_status IN('HEALTHY','DEGRADED','NEEDS_ATTENTION')),
 CONSTRAINT chk_edge_health_pending_batches CHECK(pending_batches BETWEEN 0 AND 10000),
 CONSTRAINT chk_edge_health_pending_bytes CHECK(pending_bytes BETWEEN 0 AND 4294967296),
 CONSTRAINT chk_edge_health_models CHECK(jsonb_typeof(model_versions)='object' AND octet_length(model_versions::text)<=8192),
 CONSTRAINT chk_edge_health_drift CHECK(jsonb_typeof(drift_signals)='array' AND jsonb_array_length(drift_signals)<=32 AND octet_length(drift_signals::text)<=16384),
 CONSTRAINT chk_edge_health_capabilities CHECK(jsonb_typeof(capabilities)='object' AND octet_length(capabilities::text)<=8192),
 CONSTRAINT chk_edge_health_hash CHECK(request_hash ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_edge_health_latest
 ON edge_device_health_reports(tenant_id,factory_id,device_id,received_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_edge_health_status
 ON edge_device_health_reports(tenant_id,factory_id,runtime_status,received_at DESC);

ALTER TABLE edge_device_health_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge_device_health_reports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS edge_device_health_tenant_isolation ON edge_device_health_reports;
CREATE POLICY edge_device_health_tenant_isolation ON edge_device_health_reports
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());

DROP TRIGGER IF EXISTS edge_device_health_reports_immutable ON edge_device_health_reports;
CREATE TRIGGER edge_device_health_reports_immutable
 BEFORE UPDATE OR DELETE ON edge_device_health_reports
 FOR EACH ROW EXECUTE FUNCTION edge_reject_ledger_mutation();


INSERT INTO factoryos_governance.tenant_relation_inventory (
  schema_name, relation_name, scope_model, data_category, export_disposition,
  erasure_disposition, audit_requirement, rationale
) VALUES
  ('public', 'edge_device_health_reports', 'DIRECT_TENANT_ID', 'BUSINESS_DATA', 'EXCLUDED', 'BLOCKED_UNREVIEWED', 'DOMAIN_LEDGER_OR_AUDIT_REVIEW', 'Append-only device-reported health/drift telemetry, explicitly not an evaluation or rollout authorization.')
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
  ('public', 'edge_device_health_reports', 'DIRECT_TENANT', 'DIRECT_TENANT_COLUMN_AND_RLS', 'Append-only device-reported health/drift telemetry, explicitly not an evaluation or rollout authorization.', 'tenant_id = public.factoryos_current_tenant_id()', 'EXCLUDED', 'BLOCKED_UNREVIEWED', 'VERIFIED')
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
VALUES('193_edge_device_health_and_stream_metadata',NULL)
ON CONFLICT(version) DO NOTHING;
COMMIT;
