BEGIN;

-- ============================================================
-- WP08 / Canonical text and bounded document extraction
-- ============================================================
-- The API accepts explicitly supplied plain text or extracted PDF/DOCX text.
-- It never fetches canonical_uri, runs macros, executes source content, or
-- performs OCR. Stored content is immutable and is readable only after latest
-- manual RIGHTS and SECURITY assessments both approve this exact text hash.

INSERT INTO permissions (code, description)
VALUES
  ('research.sources.ingest', 'Ingest canonical text or bounded PDF/DOCX extraction for research sources'),
  ('research.sources.content.read', 'Read research source text after required review approvals')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
  AND p.code IN ('research.sources.ingest', 'research.sources.content.read')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS research_source_text_content (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL,
    factory_id            UUID NOT NULL,
    source_id             UUID NOT NULL,
    content_sha256        VARCHAR(64) NOT NULL,
    canonical_text        TEXT NOT NULL,
    character_count       INTEGER NOT NULL,
    line_count            INTEGER NOT NULL,
    parser_version        VARCHAR(40) NOT NULL DEFAULT 'factoryos-plain-text-v1',
    source_format         VARCHAR(20) NOT NULL DEFAULT 'PLAIN_TEXT',
    original_file_sha256  VARCHAR(64),
    created_by            UUID NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_research_text_content_factory_scope
      FOREIGN KEY (factory_id, tenant_id)
      REFERENCES factories (id, tenant_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_research_text_content_source_scope
      FOREIGN KEY (source_id, tenant_id, factory_id)
      REFERENCES research_source_registry (id, tenant_id, factory_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_research_text_content_actor
      FOREIGN KEY (created_by)
      REFERENCES users (id)
      ON DELETE RESTRICT,

    CONSTRAINT chk_research_text_content_hash
      CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),

    CONSTRAINT chk_research_text_content_metrics
      CHECK (
        character_count > 0
        AND character_count <= 32768
        AND line_count > 0
        AND octet_length(canonical_text) <= 49152
      ),

    CONSTRAINT chk_research_text_content_parser
      CHECK (parser_version IN ('factoryos-plain-text-v1', 'factoryos-document-extractor-v1')), 

    CONSTRAINT chk_research_text_content_source_format
      CHECK (source_format IN ('PLAIN_TEXT', 'PDF', 'DOCX')),

    CONSTRAINT chk_research_text_content_original_file_hash
      CHECK (original_file_sha256 IS NULL OR original_file_sha256 ~ '^[a-f0-9]{64}$'),

    CONSTRAINT chk_research_text_content_provenance
      CHECK (
        (source_format = 'PLAIN_TEXT'
          AND parser_version = 'factoryos-plain-text-v1'
          AND original_file_sha256 IS NULL)
        OR
        (source_format IN ('PDF', 'DOCX')
          AND parser_version = 'factoryos-document-extractor-v1'
          AND original_file_sha256 IS NOT NULL)
      ),

    CONSTRAINT chk_research_text_content_nonempty
      CHECK (LENGTH(BTRIM(canonical_text)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_source_text_content_source
  ON research_source_text_content (
    tenant_id, factory_id, source_id
  );

CREATE INDEX IF NOT EXISTS idx_research_source_text_content_scope
  ON research_source_text_content (
    tenant_id, factory_id, source_id, created_at DESC
  );

ALTER TABLE research_source_text_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_source_text_content FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS research_source_text_content_tenant_isolation
  ON research_source_text_content;
CREATE POLICY research_source_text_content_tenant_isolation
  ON research_source_text_content
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION reject_research_source_text_content_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Research source text content is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_research_source_text_content_immutable
  ON research_source_text_content;
CREATE TRIGGER trg_research_source_text_content_immutable
  BEFORE UPDATE OR DELETE ON research_source_text_content
  FOR EACH ROW
  EXECUTE FUNCTION reject_research_source_text_content_mutation();

INSERT INTO schema_migrations (version, checksum)
VALUES ('032_research_source_text_content', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
