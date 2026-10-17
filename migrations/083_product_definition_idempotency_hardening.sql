BEGIN;
-- Layered idempotency ledger and unique approval/retirement keys for material commands.
CREATE TABLE product_definition_idempotency (
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  product_id UUID NOT NULL,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pk_product_definition_idempotency PRIMARY KEY (tenant_id,factory_id,idempotency_key),
  CONSTRAINT fk_product_definition_idempotency_product FOREIGN KEY (product_id,tenant_id,factory_id)
    REFERENCES product_definitions(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_definition_idempotency_creator FOREIGN KEY (created_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_product_definition_idempotency_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_product_definition_idempotency_key CHECK (length(btrim(idempotency_key))>0)
);
ALTER TABLE product_definition_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_definition_idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY product_definition_idempotency_tenant_isolation ON product_definition_idempotency
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

CREATE UNIQUE INDEX uq_product_version_approval_idempotency
  ON product_versions(tenant_id,factory_id,approval_idempotency_key) WHERE approval_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_product_version_retirement_idempotency
  ON product_versions(tenant_id,factory_id,retirement_idempotency_key) WHERE retirement_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_product_alternate_approval_idempotency
  ON product_bom_alternates(tenant_id,factory_id,approval_idempotency_key) WHERE approval_idempotency_key IS NOT NULL;

INSERT INTO schema_migrations(version,checksum)
VALUES('083_product_definition_idempotency_hardening',NULL)
ON CONFLICT(version) DO NOTHING;
COMMIT;
