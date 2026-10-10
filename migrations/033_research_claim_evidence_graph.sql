BEGIN;

-- ============================================================
-- WP08 / Claim & evidence graph with deterministic citation checks
-- ============================================================

INSERT INTO permissions (code, description)
VALUES
  ('research.claims.read', 'Read research claims and their evidence graph'),
  ('research.claims.write', 'Register immutable research claim versions'),
  ('research.claims.evidence.write', 'Link registered claims to exact source content and quote offsets'),
  ('research.claims.validate', 'Record deterministic citation traceability validation')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
  AND p.code IN (
    'research.claims.read',
    'research.claims.write',
    'research.claims.evidence.write',
    'research.claims.validate'
  )
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS research_claim_registry (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL,
    factory_id            UUID NOT NULL,
    claim_key             VARCHAR(200) NOT NULL,
    claim_version         VARCHAR(60) NOT NULL,
    claim_type            VARCHAR(24) NOT NULL,
    statement             TEXT NOT NULL,
    statement_sha256      VARCHAR(64) NOT NULL,
    request_hash          VARCHAR(64) NOT NULL,
    idempotency_key       VARCHAR(128) NOT NULL,
    created_by            UUID NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_research_claim_factory_scope
      FOREIGN KEY (factory_id, tenant_id)
      REFERENCES factories (id, tenant_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_research_claim_actor
      FOREIGN KEY (created_by)
      REFERENCES users (id)
      ON DELETE RESTRICT,

    CONSTRAINT chk_research_claim_key
      CHECK (claim_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$'),

    CONSTRAINT chk_research_claim_version
      CHECK (claim_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,59}$'),

    CONSTRAINT chk_research_claim_type
      CHECK (claim_type IN ('FACT', 'INFERENCE', 'RECOMMENDATION', 'OPINION')),

    CONSTRAINT chk_research_claim_statement
      CHECK (LENGTH(BTRIM(statement)) BETWEEN 1 AND 4000),

    CONSTRAINT chk_research_claim_statement_hash
      CHECK (statement_sha256 ~ '^[a-f0-9]{64}$'),

    CONSTRAINT chk_research_claim_request_hash
      CHECK (request_hash ~ '^[a-f0-9]{64}$'),

    CONSTRAINT chk_research_claim_idempotency
      CHECK (idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_claim_scope_version
  ON research_claim_registry (tenant_id, factory_id, claim_key, claim_version);

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_claim_scope_idempotency
  ON research_claim_registry (tenant_id, factory_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_claim_scope_id
  ON research_claim_registry (id, tenant_id, factory_id);

CREATE INDEX IF NOT EXISTS idx_research_claim_scope_created
  ON research_claim_registry (tenant_id, factory_id, created_at DESC, id DESC);

ALTER TABLE research_claim_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_claim_registry FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS research_claim_registry_tenant_isolation
  ON research_claim_registry;
CREATE POLICY research_claim_registry_tenant_isolation
  ON research_claim_registry
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION reject_research_claim_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Research claims are immutable; register a new version instead';
END;
$$;

DROP TRIGGER IF EXISTS trg_research_claim_registry_immutable
  ON research_claim_registry;
CREATE TRIGGER trg_research_claim_registry_immutable
  BEFORE UPDATE OR DELETE ON research_claim_registry
  FOR EACH ROW
  EXECUTE FUNCTION reject_research_claim_mutation();

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_source_text_content_evidence_scope
  ON research_source_text_content (id, tenant_id, factory_id, source_id, content_sha256);

CREATE TABLE IF NOT EXISTS research_claim_evidence (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL,
    factory_id            UUID NOT NULL,
    claim_id              UUID NOT NULL,
    source_id             UUID NOT NULL,
    content_id            UUID NOT NULL,
    content_sha256        VARCHAR(64) NOT NULL,
    quote_text            TEXT NOT NULL,
    quote_sha256          VARCHAR(64) NOT NULL,
    start_offset          INTEGER NOT NULL,
    end_offset            INTEGER NOT NULL,
    locator               VARCHAR(300),
    request_hash          VARCHAR(64) NOT NULL,
    idempotency_key       VARCHAR(128) NOT NULL,
    created_by            UUID NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_research_claim_evidence_claim
      FOREIGN KEY (claim_id, tenant_id, factory_id)
      REFERENCES research_claim_registry (id, tenant_id, factory_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_research_claim_evidence_source
      FOREIGN KEY (source_id, tenant_id, factory_id)
      REFERENCES research_source_registry (id, tenant_id, factory_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_research_claim_evidence_content
      FOREIGN KEY (content_id, tenant_id, factory_id, source_id, content_sha256)
      REFERENCES research_source_text_content (id, tenant_id, factory_id, source_id, content_sha256)
      ON DELETE RESTRICT,

    CONSTRAINT fk_research_claim_evidence_actor
      FOREIGN KEY (created_by)
      REFERENCES users (id)
      ON DELETE RESTRICT,

    CONSTRAINT chk_research_claim_evidence_hashes
      CHECK (
        content_sha256 ~ '^[a-f0-9]{64}$'
        AND quote_sha256 ~ '^[a-f0-9]{64}$'
        AND request_hash ~ '^[a-f0-9]{64}$'
      ),

    CONSTRAINT chk_research_claim_evidence_offsets
      CHECK (start_offset >= 0 AND end_offset > start_offset AND end_offset - start_offset <= 4000),

    CONSTRAINT chk_research_claim_evidence_quote
      CHECK (LENGTH(BTRIM(quote_text)) BETWEEN 1 AND 4000),

    CONSTRAINT chk_research_claim_evidence_locator
      CHECK (locator IS NULL OR LENGTH(BTRIM(locator)) BETWEEN 1 AND 300),

    CONSTRAINT chk_research_claim_evidence_idempotency
      CHECK (idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_claim_evidence_scope_idempotency
  ON research_claim_evidence (tenant_id, factory_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_claim_evidence_graph_scope
  ON research_claim_evidence (id, claim_id, tenant_id, factory_id);

CREATE INDEX IF NOT EXISTS idx_research_claim_evidence_claim
  ON research_claim_evidence (tenant_id, factory_id, claim_id, created_at, id);

ALTER TABLE research_claim_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_claim_evidence FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS research_claim_evidence_tenant_isolation
  ON research_claim_evidence;
CREATE POLICY research_claim_evidence_tenant_isolation
  ON research_claim_evidence
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION reject_research_claim_evidence_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Research claim evidence links are append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_research_claim_evidence_immutable
  ON research_claim_evidence;
CREATE TRIGGER trg_research_claim_evidence_immutable
  BEFORE UPDATE OR DELETE ON research_claim_evidence
  FOR EACH ROW
  EXECUTE FUNCTION reject_research_claim_evidence_mutation();

CREATE TABLE IF NOT EXISTS research_citation_validations (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL,
    factory_id            UUID NOT NULL,
    claim_id              UUID NOT NULL,
    evidence_id           UUID NOT NULL,
    verdict               VARCHAR(24) NOT NULL,
    reason_code            VARCHAR(40) NOT NULL,
    algorithm_version      VARCHAR(40) NOT NULL DEFAULT 'factoryos-citation-check-v1',
    content_sha256         VARCHAR(64) NOT NULL,
    quote_sha256           VARCHAR(64) NOT NULL,
    request_hash           VARCHAR(64) NOT NULL,
    idempotency_key        VARCHAR(128) NOT NULL,
    validated_by           UUID NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_research_citation_validation_evidence
      FOREIGN KEY (evidence_id, claim_id, tenant_id, factory_id)
      REFERENCES research_claim_evidence (id, claim_id, tenant_id, factory_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_research_citation_validation_claim
      FOREIGN KEY (claim_id, tenant_id, factory_id)
      REFERENCES research_claim_registry (id, tenant_id, factory_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_research_citation_validation_actor
      FOREIGN KEY (validated_by)
      REFERENCES users (id)
      ON DELETE RESTRICT,

    CONSTRAINT chk_research_citation_validation_verdict
      CHECK (verdict IN ('VALID', 'INVALID', 'REVIEW_REQUIRED')),

    CONSTRAINT chk_research_citation_validation_reason
      CHECK (reason_code IN (
        'QUOTE_MATCHED',
        'QUOTE_MISMATCH',
        'QUOTE_HASH_MISMATCH',
        'RIGHTS_NOT_APPROVED',
        'SECURITY_NOT_APPROVED',
        'SOURCE_RIGHTS_RESTRICTED'
      )),

    CONSTRAINT chk_research_citation_validation_algorithm
      CHECK (algorithm_version = 'factoryos-citation-check-v1'),

    CONSTRAINT chk_research_citation_validation_hashes
      CHECK (
        content_sha256 ~ '^[a-f0-9]{64}$'
        AND quote_sha256 ~ '^[a-f0-9]{64}$'
        AND request_hash ~ '^[a-f0-9]{64}$'
      ),

    CONSTRAINT chk_research_citation_validation_idempotency
      CHECK (idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_citation_validation_idempotency
  ON research_citation_validations (tenant_id, factory_id, evidence_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_research_citation_validation_latest
  ON research_citation_validations (tenant_id, factory_id, claim_id, evidence_id, created_at DESC);

ALTER TABLE research_citation_validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_citation_validations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS research_citation_validations_tenant_isolation
  ON research_citation_validations;
CREATE POLICY research_citation_validations_tenant_isolation
  ON research_citation_validations
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION reject_research_citation_validation_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Citation validation records are append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_research_citation_validations_immutable
  ON research_citation_validations;
CREATE TRIGGER trg_research_citation_validations_immutable
  BEFORE UPDATE OR DELETE ON research_citation_validations
  FOR EACH ROW
  EXECUTE FUNCTION reject_research_citation_validation_mutation();

INSERT INTO schema_migrations (version, checksum)
VALUES ('033_research_claim_evidence_graph', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
