BEGIN;

-- An extraction result is a proposal, never a trusted claim until a reviewer
-- explicitly accepts the extracted item. Decisions are immutable provenance.
CREATE TABLE research_extraction_item_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  extraction_item_id UUID NOT NULL,
  source_revision INTEGER NOT NULL,
  rights_version INTEGER NOT NULL,
  output_sha256 CHAR(64) NOT NULL,
  decision VARCHAR(16) NOT NULL,
  reason TEXT NOT NULL,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewed_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_research_extraction_item_review UNIQUE (extraction_item_id),
  CONSTRAINT fk_research_extraction_item_review_item
    FOREIGN KEY (extraction_item_id, tenant_id)
    REFERENCES research_extraction_items(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_extraction_item_review_reviewer
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_extraction_item_review_decision CHECK (decision IN ('APPROVE','REJECT')),
  CONSTRAINT chk_research_extraction_item_review_reason CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
  CONSTRAINT chk_research_extraction_item_review_versions CHECK (source_revision >= 1 AND rights_version >= 1),
  CONSTRAINT chk_research_extraction_item_review_hash CHECK (output_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_research_extraction_item_review_flags CHECK (jsonb_typeof(safety_flags) = 'array')
);
CREATE INDEX idx_research_extraction_item_review_history
  ON research_extraction_item_reviews (tenant_id, reviewed_by, created_at DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_research_extraction_item_review()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  item_flags JSONB;
  run_source_revision INTEGER;
  run_rights_version INTEGER;
  run_output_sha256 CHAR(64);
  current_source_revision INTEGER;
  current_rights_version INTEGER;
  current_access_status TEXT;
  current_license_status TEXT;
  current_rights_basis TEXT;
BEGIN
  SELECT i.safety_flags, r.source_revision, r.rights_version, r.output_sha256,
         s.source_revision, s.rights_version, s.access_status, s.license_status, s.rights_basis
    INTO item_flags, run_source_revision, run_rights_version, run_output_sha256,
         current_source_revision, current_rights_version, current_access_status, current_license_status, current_rights_basis
    FROM research_extraction_items i
    JOIN research_extraction_runs r
      ON r.id = i.extraction_run_id AND r.tenant_id = i.tenant_id
    JOIN research_sources s
      ON s.id = r.source_id AND s.tenant_id = r.tenant_id
    WHERE i.id = NEW.extraction_item_id AND i.tenant_id = NEW.tenant_id
    FOR UPDATE OF i, s;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESEARCH_EXTRACTION_ITEM_NOT_FOUND_FOR_REVIEW'
      USING ERRCODE = '23503';
  END IF;
  IF current_access_status <> 'APPROVED'
     OR current_license_status NOT IN ('OPEN_ACCESS','LICENSED','USER_PROVIDED_AUTHORIZED')
     OR current_rights_basis IS NULL OR length(btrim(current_rights_basis)) = 0 THEN
    RAISE EXCEPTION 'RESEARCH_EXTRACTION_REVIEW_REQUIRES_CURRENT_SOURCE_RIGHTS'
      USING ERRCODE = '23514';
  END IF;
  IF run_source_revision <> current_source_revision OR run_rights_version <> current_rights_version THEN
    RAISE EXCEPTION 'RESEARCH_EXTRACTION_SOURCE_OR_RIGHTS_VERSION_CHANGED'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.source_revision <> run_source_revision
     OR NEW.rights_version <> run_rights_version
     OR NEW.output_sha256 <> run_output_sha256
     OR NEW.safety_flags <> item_flags THEN
    RAISE EXCEPTION 'RESEARCH_EXTRACTION_REVIEW_PROVENANCE_MISMATCH'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER research_extraction_item_review_guard
BEFORE INSERT ON research_extraction_item_reviews
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_research_extraction_item_review();

CREATE TRIGGER research_extraction_item_reviews_immutable
BEFORE UPDATE OR DELETE ON research_extraction_item_reviews
FOR EACH ROW EXECUTE FUNCTION factoryos_research_reject_provenance_mutation();

CREATE OR REPLACE FUNCTION factoryos_guard_research_extracted_claim_review()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  item_review_decision TEXT;
BEGIN
  IF NEW.status = 'APPROVED' AND NEW.extraction_item_id IS NOT NULL THEN
    SELECT decision INTO item_review_decision
      FROM research_extraction_item_reviews
     WHERE extraction_item_id = NEW.extraction_item_id
       AND tenant_id = NEW.tenant_id;
    IF NOT FOUND OR item_review_decision <> 'APPROVE' THEN
      RAISE EXCEPTION 'Extracted claims require explicit extraction-item review before approval'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER research_extracted_claim_review_guard
BEFORE INSERT OR UPDATE OF status, extraction_item_id ON research_claims
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_research_extracted_claim_review();

ALTER TABLE research_extraction_item_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_extraction_item_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY research_extraction_item_reviews_tenant_isolation
  ON research_extraction_item_reviews
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations (version, checksum)
VALUES ('135_research_extraction_review_gate', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
