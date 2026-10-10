BEGIN;

-- ============================================================
-- WP08 / Append-only source assessment evidence
-- ============================================================
-- This records explicit human review decisions against the exact bytes
-- identified by the registry SHA-256. It does not fetch, parse, or scan
-- content and does not mutate the source registry's NOT_ASSESSED snapshot.

INSERT INTO permissions (code, description)
VALUES
  ('research.sources.assess', 'Record human assessments for registered research source versions')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
  AND p.code = 'research.sources.assess'
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_source_registry_scope_id
  ON research_source_registry (id, tenant_id, factory_id);

CREATE TABLE IF NOT EXISTS research_source_assessments (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL,
    factory_id            UUID NOT NULL,
    source_id             UUID NOT NULL,
    assessment_type       VARCHAR(20) NOT NULL,
    decision              VARCHAR(20) NOT NULL,
    assessment_method     VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
    content_sha256        VARCHAR(64) NOT NULL,
    assessment_basis      TEXT NOT NULL,
    idempotency_key       VARCHAR(128) NOT NULL,
    request_hash          VARCHAR(64) NOT NULL,
    assessed_by           UUID NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_research_assessment_factory_scope
      FOREIGN KEY (factory_id, tenant_id)
      REFERENCES factories (id, tenant_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_research_assessment_source_scope
      FOREIGN KEY (source_id, tenant_id, factory_id)
      REFERENCES research_source_registry (id, tenant_id, factory_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_research_assessment_actor
      FOREIGN KEY (assessed_by)
      REFERENCES users (id)
      ON DELETE RESTRICT,

    CONSTRAINT chk_research_assessment_type
      CHECK (assessment_type IN ('RIGHTS', 'SECURITY')),

    CONSTRAINT chk_research_assessment_decision
      CHECK (decision IN ('APPROVED', 'REJECTED', 'REVIEW_REQUIRED')),

    CONSTRAINT chk_research_assessment_method
      CHECK (assessment_method = 'MANUAL'),

    CONSTRAINT chk_research_assessment_content_hash
      CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),

    CONSTRAINT chk_research_assessment_request_hash
      CHECK (request_hash ~ '^[a-f0-9]{64}$'),

    CONSTRAINT chk_research_assessment_idempotency_key
      CHECK (idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),

    CONSTRAINT chk_research_assessment_basis
      CHECK (LENGTH(BTRIM(assessment_basis)) BETWEEN 1 AND 4000)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_source_assessment_idempotency
  ON research_source_assessments (tenant_id, factory_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_research_source_assessments_history
  ON research_source_assessments (
    tenant_id, factory_id, source_id, created_at DESC, id DESC
  );

ALTER TABLE research_source_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_source_assessments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS research_source_assessments_tenant_isolation
  ON research_source_assessments;
CREATE POLICY research_source_assessments_tenant_isolation
  ON research_source_assessments
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION reject_research_source_assessment_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Research source assessments are append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_research_source_assessments_immutable
  ON research_source_assessments;
CREATE TRIGGER trg_research_source_assessments_immutable
  BEFORE UPDATE OR DELETE ON research_source_assessments
  FOR EACH ROW
  EXECUTE FUNCTION reject_research_source_assessment_mutation();

INSERT INTO schema_migrations (version, checksum)
VALUES ('031_research_source_assessments', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
