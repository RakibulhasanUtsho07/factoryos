BEGIN;

-- FR-SAAS2-08 target-side import receipt. This table contains only immutable
-- manifest/digest metadata; imported tenant business rows remain in their domain tables.
CREATE TABLE saas_tenant_import_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  transfer_id UUID NOT NULL,
  source_schema_version VARCHAR(32) NOT NULL,
  target_schema_version VARCHAR(32) NOT NULL,
  source_manifest JSONB NOT NULL,
  target_manifest JSONB NOT NULL,
  source_manifest_digest VARCHAR(64) NOT NULL,
  target_snapshot_digest VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_saas_tenant_import_receipt_transfer UNIQUE (tenant_id, transfer_id),
  CONSTRAINT uq_saas_tenant_import_receipt_scope UNIQUE (id, tenant_id),
  CONSTRAINT chk_saas_tenant_import_source_schema
    CHECK (source_schema_version ~ '^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}$'),
  CONSTRAINT chk_saas_tenant_import_target_schema
    CHECK (target_schema_version ~ '^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}$'),
  CONSTRAINT chk_saas_tenant_import_source_manifest
    CHECK (jsonb_typeof(source_manifest) = 'object' AND octet_length(source_manifest::text) <= 65536),
  CONSTRAINT chk_saas_tenant_import_target_manifest
    CHECK (jsonb_typeof(target_manifest) = 'object' AND octet_length(target_manifest::text) <= 65536),
  CONSTRAINT chk_saas_tenant_import_source_digest
    CHECK (source_manifest_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_tenant_import_target_digest
    CHECK (target_snapshot_digest ~ '^[a-f0-9]{64}$')
);

CREATE INDEX idx_saas_tenant_import_receipts_created
  ON saas_tenant_import_receipts (tenant_id, created_at DESC);

ALTER TABLE saas_tenant_import_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_import_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY saas_tenant_import_receipts_tenant_isolation
  ON saas_tenant_import_receipts
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE TRIGGER saas_tenant_import_receipts_immutable
BEFORE UPDATE OR DELETE ON saas_tenant_import_receipts
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

INSERT INTO schema_migrations (version, checksum)
VALUES ('053_saas_tenant_import_receipts', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
