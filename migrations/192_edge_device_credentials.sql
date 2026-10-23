BEGIN;
-- WP11-B: opaque per-device credentials, explicit rotation/revocation, and identity-bound ingestion.
INSERT INTO permissions(code,description) VALUES
 ('edge.devices.credentials.manage','Issue, rotate, and revoke device-bound edge credentials')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r CROSS JOIN permissions p
WHERE r.code='ORG_ADMIN' AND r.is_system=true
 AND p.code='edge.devices.credentials.manage'
ON CONFLICT(role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS edge_device_credentials(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL,
 factory_id UUID NOT NULL,
 device_id UUID NOT NULL,
 token_hash VARCHAR(64) NOT NULL,
 token_hint VARCHAR(16) NOT NULL,
 status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
 expires_at TIMESTAMPTZ NOT NULL,
 issued_by UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 revoked_at TIMESTAMPTZ,
 last_used_at TIMESTAMPTZ,
 CONSTRAINT fk_edge_credential_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CONSTRAINT fk_edge_credential_factory_scope FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_edge_credential_device_scope FOREIGN KEY(device_id,tenant_id,factory_id) REFERENCES edge_devices(id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_edge_credential_issuer FOREIGN KEY(issued_by) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_edge_credential_hash CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT chk_edge_credential_hint CHECK(token_hint ~ '^[A-Za-z0-9_-]{4,16}$'),
 CONSTRAINT chk_edge_credential_status CHECK(status IN('ACTIVE','REVOKED')),
 CONSTRAINT chk_edge_credential_lifetime CHECK(expires_at > created_at AND expires_at <= created_at + INTERVAL '366 days'),
 CONSTRAINT chk_edge_credential_revoked_at CHECK((status='ACTIVE' AND revoked_at IS NULL) OR (status='REVOKED' AND revoked_at IS NOT NULL)),
 CONSTRAINT uq_edge_credential_scope_identity UNIQUE(id,tenant_id,factory_id,device_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_edge_credential_token_hash ON edge_device_credentials(token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_edge_credential_active_device ON edge_device_credentials(tenant_id,factory_id,device_id) WHERE status='ACTIVE';
CREATE INDEX IF NOT EXISTS idx_edge_credential_device_history ON edge_device_credentials(tenant_id,factory_id,device_id,created_at DESC);
ALTER TABLE edge_device_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge_device_credentials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS edge_device_credentials_tenant_isolation ON edge_device_credentials;
CREATE POLICY edge_device_credentials_tenant_isolation ON edge_device_credentials
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());

CREATE TABLE IF NOT EXISTS edge_device_credential_events(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL,
 factory_id UUID NOT NULL,
 device_id UUID NOT NULL,
 credential_id UUID NOT NULL,
 event_type VARCHAR(12) NOT NULL,
 actor_user_id UUID NOT NULL,
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
 CONSTRAINT fk_edge_credential_event_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CONSTRAINT fk_edge_credential_event_factory_scope FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_edge_credential_event_device_scope FOREIGN KEY(device_id,tenant_id,factory_id) REFERENCES edge_devices(id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_edge_credential_event_credential_scope FOREIGN KEY(credential_id,tenant_id,factory_id,device_id) REFERENCES edge_device_credentials(id,tenant_id,factory_id,device_id) ON DELETE RESTRICT,
 CONSTRAINT fk_edge_credential_event_actor FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_edge_credential_event_type CHECK(event_type IN('ISSUED','ROTATED','REVOKED')),
 CONSTRAINT chk_edge_credential_event_metadata CHECK(jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=4096)
);
CREATE INDEX IF NOT EXISTS idx_edge_credential_event_history ON edge_device_credential_events(tenant_id,factory_id,device_id,occurred_at DESC,id DESC);
ALTER TABLE edge_device_credential_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge_device_credential_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS edge_device_credential_events_tenant_isolation ON edge_device_credential_events;
CREATE POLICY edge_device_credential_events_tenant_isolation ON edge_device_credential_events
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());

ALTER TABLE edge_observations ALTER COLUMN recorded_by DROP NOT NULL;
ALTER TABLE edge_observations ADD COLUMN IF NOT EXISTS recorded_by_credential_id UUID;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fk_edge_observation_credential_scope') THEN
  ALTER TABLE edge_observations ADD CONSTRAINT fk_edge_observation_credential_scope
   FOREIGN KEY(recorded_by_credential_id,tenant_id,factory_id,device_id)
   REFERENCES edge_device_credentials(id,tenant_id,factory_id,device_id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='chk_edge_observation_recorder_identity') THEN
  ALTER TABLE edge_observations ADD CONSTRAINT chk_edge_observation_recorder_identity
   CHECK((recorded_by IS NULL) <> (recorded_by_credential_id IS NULL));
 END IF;
END $$;

ALTER TABLE edge_sync_batches ALTER COLUMN recorded_by DROP NOT NULL;
ALTER TABLE edge_sync_batches ADD COLUMN IF NOT EXISTS recorded_by_credential_id UUID;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fk_edge_sync_credential_scope') THEN
  ALTER TABLE edge_sync_batches ADD CONSTRAINT fk_edge_sync_credential_scope
   FOREIGN KEY(recorded_by_credential_id,tenant_id,factory_id,device_id)
   REFERENCES edge_device_credentials(id,tenant_id,factory_id,device_id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='chk_edge_sync_recorder_identity') THEN
  ALTER TABLE edge_sync_batches ADD CONSTRAINT chk_edge_sync_recorder_identity
   CHECK((recorded_by IS NULL) <> (recorded_by_credential_id IS NULL));
 END IF;
END $$;

DROP TRIGGER IF EXISTS edge_device_credential_events_immutable ON edge_device_credential_events;
CREATE TRIGGER edge_device_credential_events_immutable
 BEFORE UPDATE OR DELETE ON edge_device_credential_events
 FOR EACH ROW EXECUTE FUNCTION edge_reject_ledger_mutation();


INSERT INTO factoryos_governance.tenant_relation_inventory (
  schema_name, relation_name, scope_model, data_category, export_disposition,
  erasure_disposition, audit_requirement, rationale
) VALUES
  ('public', 'edge_device_credentials', 'DIRECT_TENANT_ID', 'BUSINESS_DATA', 'EXCLUDED',
   'BLOCKED_UNREVIEWED', 'DOMAIN_LEDGER_OR_AUDIT_REVIEW',
   'Device credential tokens are represented only by SHA-256 hashes and bound to a single tenant/factory/device.'),
  ('public', 'edge_device_credential_events', 'DIRECT_TENANT_ID', 'BUSINESS_DATA', 'EXCLUDED',
   'BLOCKED_UNREVIEWED', 'DOMAIN_LEDGER_OR_AUDIT_REVIEW',
   'Credential issue, rotation and revocation events are append-only tenant/factory/device-scoped evidence.')
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
  ('public', 'edge_device_credentials', 'DIRECT_TENANT', 'DIRECT_TENANT_COLUMN_AND_RLS',
   'Opaque device credentials persist only token hashes, expire, bind to a single device and use a one-active-credential index with forced row-level security.',
   'tenant_id = public.factoryos_current_tenant_id()', 'EXCLUDED', 'BLOCKED_UNREVIEWED', 'VERIFIED'),
  ('public', 'edge_device_credential_events', 'DIRECT_TENANT', 'DIRECT_TENANT_COLUMN_AND_RLS',
   'Credential lifecycle events are append-only and scoped through composite tenant/factory/device foreign keys under forced row-level security.',
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
VALUES('192_edge_device_credentials',NULL)
ON CONFLICT(version) DO NOTHING;
COMMIT;
