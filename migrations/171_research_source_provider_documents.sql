BEGIN;

-- External provider verification is evidence, not a claim that a cited passage entails a claim.
CREATE TABLE IF NOT EXISTS research_source_authenticity_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  source_id UUID NOT NULL,
  source_revision INTEGER NOT NULL,
  rights_version INTEGER NOT NULL,
  provider VARCHAR(24) NOT NULL,
  verification_status VARCHAR(24) NOT NULL,
  provider_record_id VARCHAR(300),
  canonical_doi VARCHAR(255),
  canonical_url TEXT,
  provider_title VARCHAR(1000),
  title_similarity NUMERIC(5,4),
  response_sha256 CHAR(64),
  reason_code VARCHAR(100) NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  checked_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_research_source_auth_check_scope UNIQUE (id,tenant_id,source_id),
  CONSTRAINT fk_research_source_auth_check_source
    FOREIGN KEY (source_id,tenant_id) REFERENCES research_sources(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_source_auth_check_versions CHECK (source_revision >= 1 AND rights_version >= 1),
  CONSTRAINT chk_research_source_auth_provider CHECK (provider IN ('CROSSREF','EUROPE_PMC','NONE')),
  CONSTRAINT chk_research_source_auth_status CHECK (
    verification_status IN ('VERIFIED','REVIEW_REQUIRED','MISMATCH','NOT_FOUND','UNSUPPORTED','ERROR')
  ),
  CONSTRAINT chk_research_source_auth_similarity CHECK (
    title_similarity IS NULL OR title_similarity BETWEEN 0 AND 1
  ),
  CONSTRAINT chk_research_source_auth_hash CHECK (
    response_sha256 IS NULL OR response_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT chk_research_source_auth_evidence CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT chk_research_source_auth_verified_has_provider_evidence CHECK (
    verification_status <> 'VERIFIED'
    OR (provider IN ('CROSSREF','EUROPE_PMC') AND response_sha256 IS NOT NULL
        AND title_similarity IS NOT NULL AND provider_record_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_research_source_auth_check_history
  ON research_source_authenticity_checks (tenant_id,source_id,checked_at DESC);

CREATE TABLE IF NOT EXISTS research_source_authenticity_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  source_id UUID NOT NULL,
  authenticity_check_id UUID NOT NULL,
  source_revision INTEGER NOT NULL,
  rights_version INTEGER NOT NULL,
  decision VARCHAR(12) NOT NULL,
  reason VARCHAR(2000) NOT NULL,
  reviewed_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_research_source_auth_review_once UNIQUE (authenticity_check_id),
  CONSTRAINT fk_research_source_auth_review_source
    FOREIGN KEY (source_id,tenant_id) REFERENCES research_sources(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_source_auth_review_check
    FOREIGN KEY (authenticity_check_id,tenant_id,source_id)
    REFERENCES research_source_authenticity_checks(id,tenant_id,source_id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_source_auth_review_versions CHECK (source_revision >= 1 AND rights_version >= 1),
  CONSTRAINT chk_research_source_auth_review_decision CHECK (decision IN ('ACCEPT','REJECT')),
  CONSTRAINT chk_research_source_auth_review_reason CHECK (length(btrim(reason)) BETWEEN 10 AND 2000)
);
CREATE INDEX IF NOT EXISTS idx_research_source_auth_review_history
  ON research_source_authenticity_reviews (tenant_id,source_id,reviewed_at DESC);

-- File bytes and parsed text live separately from immutable provenance metadata so rights
-- revocation can physically erase content while retaining digest-only audit evidence.
CREATE TABLE IF NOT EXISTS research_source_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  source_id UUID NOT NULL,
  source_revision INTEGER NOT NULL,
  rights_version INTEGER NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  media_type VARCHAR(100) NOT NULL,
  byte_size INTEGER NOT NULL,
  content_sha256 CHAR(64) NOT NULL,
  extracted_text_sha256 CHAR(64) NOT NULL,
  normalized_text_sha256 CHAR(64) NOT NULL,
  text_signature JSONB NOT NULL DEFAULT '[]'::jsonb,
  parser_version VARCHAR(100) NOT NULL,
  duplicate_of_document_id UUID,
  similarity_score NUMERIC(5,4) NOT NULL DEFAULT 0,
  storage_status VARCHAR(12) NOT NULL DEFAULT 'STORED',
  purge_reason VARCHAR(40),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  purged_at TIMESTAMPTZ,
  CONSTRAINT uq_research_source_document_scope UNIQUE (id,tenant_id),
  CONSTRAINT uq_research_source_document_idempotency UNIQUE (tenant_id,source_id,idempotency_key),
  CONSTRAINT fk_research_source_document_source
    FOREIGN KEY (source_id,tenant_id) REFERENCES research_sources(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_source_document_duplicate
    FOREIGN KEY (duplicate_of_document_id,tenant_id) REFERENCES research_source_documents(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_source_document_versions CHECK (source_revision >= 1 AND rights_version >= 1),
  CONSTRAINT chk_research_source_document_idempotency CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  CONSTRAINT chk_research_source_document_hashes CHECK (
    request_hash ~ '^[a-f0-9]{64}$'
    AND content_sha256 ~ '^[a-f0-9]{64}$'
    AND extracted_text_sha256 ~ '^[a-f0-9]{64}$'
    AND normalized_text_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT chk_research_source_document_size CHECK (byte_size BETWEEN 1 AND 5242880),
  CONSTRAINT chk_research_source_document_media_type CHECK (
    media_type IN ('text/plain','text/csv','text/markdown','text/html','application/json')
  ),
  CONSTRAINT chk_research_source_document_signature CHECK (
    jsonb_typeof(text_signature) = 'array' AND jsonb_array_length(text_signature) <= 32
  ),
  CONSTRAINT chk_research_source_document_similarity CHECK (similarity_score BETWEEN 0 AND 1),
  CONSTRAINT chk_research_source_document_storage_lifecycle CHECK (
    (storage_status='STORED' AND purged_at IS NULL AND purge_reason IS NULL)
    OR (storage_status='PURGED' AND purged_at IS NOT NULL
        AND purge_reason IN ('FULL_TEXT_STORAGE_REVOKED','SOURCE_ACCESS_REVOKED','LICENSE_RESTRICTED'))
  )
);
CREATE INDEX IF NOT EXISTS idx_research_source_document_dedup
  ON research_source_documents (tenant_id,content_sha256,normalized_text_sha256)
  WHERE storage_status='STORED';
CREATE INDEX IF NOT EXISTS idx_research_source_document_history
  ON research_source_documents (tenant_id,source_id,created_at DESC);

CREATE TABLE IF NOT EXISTS research_source_document_content (
  document_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  raw_content BYTEA NOT NULL,
  extracted_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_research_source_document_content_document
    FOREIGN KEY (document_id,tenant_id)
    REFERENCES research_source_documents(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_source_document_content_not_empty CHECK (octet_length(raw_content) BETWEEN 1 AND 5242880),
  CONSTRAINT chk_research_source_document_text_not_empty CHECK (length(btrim(extracted_text)) > 0)
);
CREATE INDEX IF NOT EXISTS idx_research_source_document_content_scope
  ON research_source_document_content (tenant_id,document_id);

CREATE TABLE IF NOT EXISTS research_source_document_purges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  source_id UUID NOT NULL,
  document_id UUID NOT NULL,
  source_revision INTEGER NOT NULL,
  rights_version INTEGER NOT NULL,
  content_sha256 CHAR(64) NOT NULL,
  extracted_text_sha256 CHAR(64) NOT NULL,
  purge_reason VARCHAR(40) NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  purged_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_research_source_document_purge_source
    FOREIGN KEY (source_id,tenant_id) REFERENCES research_sources(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_source_document_purge_document
    FOREIGN KEY (document_id,tenant_id) REFERENCES research_source_documents(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_source_document_purge_versions CHECK (source_revision >= 1 AND rights_version >= 1),
  CONSTRAINT chk_research_source_document_purge_hashes CHECK (
    content_sha256 ~ '^[a-f0-9]{64}$' AND extracted_text_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT chk_research_source_document_purge_reason CHECK (
    purge_reason IN ('FULL_TEXT_STORAGE_REVOKED','SOURCE_ACCESS_REVOKED','LICENSE_RESTRICTED')
  )
);
CREATE INDEX IF NOT EXISTS idx_research_source_document_purge_history
  ON research_source_document_purges (tenant_id,source_id,purged_at DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_research_source_document()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Research source document provenance cannot be deleted' USING ERRCODE='55000';
  END IF;
  IF ROW(
      NEW.id,NEW.tenant_id,NEW.source_id,NEW.source_revision,NEW.rights_version,
      NEW.idempotency_key,NEW.request_hash,NEW.original_filename,NEW.media_type,NEW.byte_size,
      NEW.content_sha256,NEW.extracted_text_sha256,NEW.normalized_text_sha256,NEW.text_signature,
      NEW.parser_version,NEW.duplicate_of_document_id,NEW.similarity_score,NEW.created_by,NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.id,OLD.tenant_id,OLD.source_id,OLD.source_revision,OLD.rights_version,
      OLD.idempotency_key,OLD.request_hash,OLD.original_filename,OLD.media_type,OLD.byte_size,
      OLD.content_sha256,OLD.extracted_text_sha256,OLD.normalized_text_sha256,OLD.text_signature,
      OLD.parser_version,OLD.duplicate_of_document_id,OLD.similarity_score,OLD.created_by,OLD.created_at
    ) THEN
    RAISE EXCEPTION 'Research source document identity and provenance are immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.storage_status <> 'STORED' OR NEW.storage_status <> 'PURGED'
     OR NEW.purged_at IS NULL OR NEW.purge_reason NOT IN (
       'FULL_TEXT_STORAGE_REVOKED','SOURCE_ACCESS_REVOKED','LICENSE_RESTRICTED'
     ) THEN
    RAISE EXCEPTION 'Research source document may only transition from STORED to PURGED' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS research_source_documents_guard ON research_source_documents;
CREATE TRIGGER research_source_documents_guard
BEFORE UPDATE OR DELETE ON research_source_documents
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_research_source_document();

CREATE OR REPLACE FUNCTION factoryos_guard_research_source_authenticity_review()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  check_row RECORD;
  source_row RECORD;
BEGIN
  SELECT * INTO check_row
  FROM research_source_authenticity_checks
  WHERE id=NEW.authenticity_check_id AND tenant_id=NEW.tenant_id AND source_id=NEW.source_id;
  SELECT * INTO source_row
  FROM research_sources
  WHERE id=NEW.source_id AND tenant_id=NEW.tenant_id
  FOR UPDATE;
  IF check_row.id IS NULL OR source_row.id IS NULL THEN
    RAISE EXCEPTION 'RESEARCH_SOURCE_AUTHENTICITY_CHECK_NOT_FOUND' USING ERRCODE='23503';
  END IF;
  IF NEW.reviewed_by=check_row.checked_by THEN
    RAISE EXCEPTION 'RESEARCH_SOURCE_AUTHENTICITY_REQUIRES_INDEPENDENT_REVIEW' USING ERRCODE='42501';
  END IF;
  IF NEW.source_revision<>check_row.source_revision OR NEW.rights_version<>check_row.rights_version
     OR NEW.source_revision<>source_row.source_revision OR NEW.rights_version<>source_row.rights_version THEN
    RAISE EXCEPTION 'RESEARCH_SOURCE_AUTHENTICITY_REVIEW_STALE' USING ERRCODE='40001';
  END IF;
  IF NEW.decision='ACCEPT' AND check_row.verification_status<>'VERIFIED' THEN
    RAISE EXCEPTION 'RESEARCH_SOURCE_AUTHENTICITY_ACCEPT_REQUIRES_VERIFIED_PROVIDER_MATCH' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS research_source_authenticity_reviews_guard ON research_source_authenticity_reviews;
CREATE TRIGGER research_source_authenticity_reviews_guard
BEFORE INSERT ON research_source_authenticity_reviews
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_research_source_authenticity_review();

CREATE OR REPLACE FUNCTION factoryos_research_purge_uploaded_source_documents()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  reason_value VARCHAR(40);
  document_row RECORD;
BEGIN
  IF NEW.namespace <> 'TENANT' OR NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.access_status IN ('REVOKED','REJECTED') AND OLD.access_status IS DISTINCT FROM NEW.access_status THEN
    reason_value := 'SOURCE_ACCESS_REVOKED';
  ELSIF NEW.license_status IN ('RESTRICTED','UNKNOWN') AND OLD.license_status IS DISTINCT FROM NEW.license_status THEN
    reason_value := 'LICENSE_RESTRICTED';
  ELSIF OLD.full_text_storage_allowed IS TRUE AND NEW.full_text_storage_allowed IS FALSE THEN
    reason_value := 'FULL_TEXT_STORAGE_REVOKED';
  ELSE
    RETURN NEW;
  END IF;

  FOR document_row IN
    SELECT id,content_sha256,extracted_text_sha256
    FROM research_source_documents
    WHERE source_id=NEW.id AND tenant_id=NEW.tenant_id AND storage_status='STORED'
    FOR UPDATE
  LOOP
    DELETE FROM research_source_document_content
    WHERE document_id=document_row.id AND tenant_id=NEW.tenant_id;

    UPDATE research_source_documents
       SET storage_status='PURGED',purged_at=clock_timestamp(),purge_reason=reason_value
     WHERE id=document_row.id AND tenant_id=NEW.tenant_id AND storage_status='STORED';

    INSERT INTO research_source_document_purges (
      tenant_id,source_id,document_id,source_revision,rights_version,
      content_sha256,extracted_text_sha256,purge_reason,actor_user_id
    ) VALUES (
      NEW.tenant_id,NEW.id,document_row.id,NEW.source_revision,NEW.rights_version,
      document_row.content_sha256,document_row.extracted_text_sha256,reason_value,
      COALESCE(NEW.reviewed_by,NEW.created_by)
    );
  END LOOP;
  RETURN NEW;
END;
$$;

-- Trigger ordering is intentional: rights normalization/versioning and existing excerpt
-- purge run first; document bytes are erased after NEW contains the final right versions.
DROP TRIGGER IF EXISTS research_source_zzz_document_purge_guard ON research_sources;
CREATE TRIGGER research_source_zzz_document_purge_guard
BEFORE UPDATE OF full_text_storage_allowed,access_status,license_status ON research_sources
FOR EACH ROW EXECUTE FUNCTION factoryos_research_purge_uploaded_source_documents();

DROP TRIGGER IF EXISTS research_source_authenticity_checks_immutable ON research_source_authenticity_checks;
CREATE TRIGGER research_source_authenticity_checks_immutable
BEFORE UPDATE OR DELETE ON research_source_authenticity_checks
FOR EACH ROW EXECUTE FUNCTION factoryos_research_reject_provenance_mutation();
DROP TRIGGER IF EXISTS research_source_authenticity_reviews_immutable ON research_source_authenticity_reviews;
CREATE TRIGGER research_source_authenticity_reviews_immutable
BEFORE UPDATE OR DELETE ON research_source_authenticity_reviews
FOR EACH ROW EXECUTE FUNCTION factoryos_research_reject_provenance_mutation();
DROP TRIGGER IF EXISTS research_source_document_purges_immutable ON research_source_document_purges;
CREATE TRIGGER research_source_document_purges_immutable
BEFORE UPDATE OR DELETE ON research_source_document_purges
FOR EACH ROW EXECUTE FUNCTION factoryos_research_reject_provenance_mutation();
DROP TRIGGER IF EXISTS research_source_document_content_update_guard ON research_source_document_content;
CREATE TRIGGER research_source_document_content_update_guard
BEFORE UPDATE ON research_source_document_content
FOR EACH ROW EXECUTE FUNCTION factoryos_research_reject_provenance_mutation();

ALTER TABLE research_source_authenticity_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_source_authenticity_checks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS research_source_authenticity_checks_tenant_isolation ON research_source_authenticity_checks;
CREATE POLICY research_source_authenticity_checks_tenant_isolation
  ON research_source_authenticity_checks USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE research_source_authenticity_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_source_authenticity_reviews FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS research_source_authenticity_reviews_tenant_isolation ON research_source_authenticity_reviews;
CREATE POLICY research_source_authenticity_reviews_tenant_isolation
  ON research_source_authenticity_reviews USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE research_source_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_source_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS research_source_documents_tenant_isolation ON research_source_documents;
CREATE POLICY research_source_documents_tenant_isolation
  ON research_source_documents USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE research_source_document_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_source_document_content FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS research_source_document_content_tenant_isolation ON research_source_document_content;
CREATE POLICY research_source_document_content_tenant_isolation
  ON research_source_document_content USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

ALTER TABLE research_source_document_purges ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_source_document_purges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS research_source_document_purges_tenant_isolation ON research_source_document_purges;
CREATE POLICY research_source_document_purges_tenant_isolation
  ON research_source_document_purges USING (tenant_id=factoryos_current_tenant_id())
  WITH CHECK (tenant_id=factoryos_current_tenant_id());

INSERT INTO schema_migrations (version,checksum)
VALUES ('171_research_source_provider_documents',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
