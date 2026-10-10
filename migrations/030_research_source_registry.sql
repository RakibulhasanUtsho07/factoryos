BEGIN;

-- ============================================================
-- WP08 / Versioned research source registry
-- ============================================================
-- Source metadata only. This does not fetch external URLs or assert that
-- rights/security were independently verified. New records remain REGISTERED
-- and prompt-injection status stays NOT_ASSESSED until later review tooling.

INSERT INTO permissions (code, description)
VALUES
  ('research.sources.read', 'Read tenant-scoped research source registry metadata'),
  ('research.sources.write', 'Register immutable versions of research sources')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
  AND p.code IN ('research.sources.read', 'research.sources.write')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS research_source_registry (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL,
    factory_id            UUID NOT NULL,
    source_key            VARCHAR(200) NOT NULL,
    source_version        VARCHAR(60) NOT NULL,
    source_type           VARCHAR(20) NOT NULL,
    title                 VARCHAR(300) NOT NULL,
    canonical_uri         TEXT,
    content_sha256        VARCHAR(64),
    rights_status         VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN',
    rights_basis          TEXT,
    license_label         VARCHAR(150),
    allow_research        BOOLEAN NOT NULL DEFAULT FALSE,
    allow_model_training  BOOLEAN NOT NULL DEFAULT FALSE,
    allow_redistribution  BOOLEAN NOT NULL DEFAULT FALSE,
    prompt_injection_status VARCHAR(20) NOT NULL DEFAULT 'NOT_ASSESSED',
    registry_status       VARCHAR(20) NOT NULL DEFAULT 'REGISTERED',
    request_hash          VARCHAR(64) NOT NULL,
    created_by            UUID NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_research_source_factory_scope
      FOREIGN KEY (factory_id, tenant_id)
      REFERENCES factories (id, tenant_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_research_source_actor
      FOREIGN KEY (created_by)
      REFERENCES users (id)
      ON DELETE RESTRICT,

    CONSTRAINT chk_research_source_type
      CHECK (source_type IN ('WEB', 'DOCUMENT', 'CONNECTOR', 'INTERNAL')),

    CONSTRAINT chk_research_source_rights_status
      CHECK (rights_status IN ('VERIFIED', 'UNKNOWN', 'RESTRICTED', 'REVOKED')),

    CONSTRAINT chk_research_source_review_state
      CHECK (
        prompt_injection_status = 'NOT_ASSESSED'
        AND registry_status = 'REGISTERED'
      ),

    CONSTRAINT chk_research_source_url
      CHECK (
        (source_type <> 'WEB' OR canonical_uri IS NOT NULL)
        AND (
          canonical_uri IS NULL
          OR canonical_uri ~* '^https?://'
        )
      ),

    CONSTRAINT chk_research_source_strings
      CHECK (
        LENGTH(BTRIM(source_key)) > 0
        AND LENGTH(BTRIM(source_version)) > 0
        AND LENGTH(BTRIM(title)) > 0
        AND (license_label IS NULL OR LENGTH(BTRIM(license_label)) > 0)
      ),

    CONSTRAINT chk_research_source_content_hash
      CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[a-f0-9]{64}$'),

    CONSTRAINT chk_research_source_request_hash
      CHECK (request_hash ~ '^[a-f0-9]{64}$'),

    CONSTRAINT chk_research_source_rights_basis
      CHECK (
        (rights_status = 'VERIFIED' AND rights_basis IS NOT NULL AND LENGTH(BTRIM(rights_basis)) > 0)
        OR
        (rights_status <> 'VERIFIED'
          AND rights_basis IS NULL
          AND license_label IS NULL
          AND NOT allow_research
          AND NOT allow_model_training
          AND NOT allow_redistribution)
      )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_source_version_scope
  ON research_source_registry (
    tenant_id, factory_id, source_key, source_version
  );

CREATE INDEX IF NOT EXISTS idx_research_source_registry_latest
  ON research_source_registry (
    tenant_id, factory_id, source_key, created_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_research_source_registry_rights
  ON research_source_registry (
    tenant_id, factory_id, rights_status, created_at DESC
  );

ALTER TABLE research_source_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_source_registry FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS research_source_registry_tenant_isolation
  ON research_source_registry;
CREATE POLICY research_source_registry_tenant_isolation
  ON research_source_registry
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION reject_research_source_registry_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Research source registry versions are append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_research_source_registry_immutable
  ON research_source_registry;
CREATE TRIGGER trg_research_source_registry_immutable
  BEFORE UPDATE OR DELETE ON research_source_registry
  FOR EACH ROW
  EXECUTE FUNCTION reject_research_source_registry_mutation();

INSERT INTO schema_migrations (version, checksum)
VALUES ('030_research_source_registry', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
