BEGIN;

-- Immutable, tenant-scoped snapshots of deterministic evidence/citation assessments.
-- Suggested grades support reviewers; they do not approve claims or represent calibrated probabilities.
CREATE TABLE research_evidence_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  claim_id UUID NOT NULL,
  source_id UUID NOT NULL,
  source_revision INTEGER NOT NULL,
  rights_version INTEGER NOT NULL,
  claim_fingerprint CHAR(64) NOT NULL,
  rubric_version VARCHAR(80) NOT NULL,
  evidence_score SMALLINT NOT NULL,
  suggested_grade VARCHAR(2) NOT NULL,
  grade_factors JSONB NOT NULL,
  citation_status VARCHAR(20) NOT NULL,
  citation_findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  citation_verification_level VARCHAR(24) NOT NULL DEFAULT 'METADATA_ONLY',
  safety_status VARCHAR(20) NOT NULL,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_snapshot JSONB NOT NULL,
  assessed_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_research_evidence_assessment_claim
    FOREIGN KEY (claim_id, tenant_id) REFERENCES research_claims(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_evidence_assessment_source
    FOREIGN KEY (source_id, tenant_id) REFERENCES research_sources(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_evidence_assessment_actor
    FOREIGN KEY (assessed_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_evidence_assessment_versions
    CHECK (source_revision >= 1 AND rights_version >= 1),
  CONSTRAINT chk_research_evidence_assessment_fingerprint
    CHECK (claim_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_research_evidence_assessment_rubric
    CHECK (rubric_version = 'research-evidence-rubric.v1'),
  CONSTRAINT chk_research_evidence_assessment_score
    CHECK (evidence_score BETWEEN 0 AND 100),
  CONSTRAINT chk_research_evidence_assessment_grade
    CHECK (suggested_grade IN ('A','B','C','D')),
  CONSTRAINT chk_research_evidence_assessment_factors
    CHECK (jsonb_typeof(grade_factors) = 'object'),
  CONSTRAINT chk_research_evidence_assessment_citation_status
    CHECK (citation_status IN ('CONSISTENT','REVIEW_REQUIRED','INVALID')),
  CONSTRAINT chk_research_evidence_assessment_citation_findings
    CHECK (jsonb_typeof(citation_findings) = 'array'),
  CONSTRAINT chk_research_evidence_assessment_citation_level
    CHECK (citation_verification_level = 'METADATA_ONLY'),
  CONSTRAINT chk_research_evidence_assessment_safety_status
    CHECK (safety_status IN ('CLEAR','REVIEW_REQUIRED')),
  CONSTRAINT chk_research_evidence_assessment_safety_flags
    CHECK (jsonb_typeof(safety_flags) = 'array'),
  CONSTRAINT chk_research_evidence_assessment_snapshot
    CHECK (jsonb_typeof(evidence_snapshot) = 'object')
);

CREATE INDEX idx_research_evidence_assessment_history
  ON research_evidence_assessments (tenant_id, claim_id, created_at DESC, id DESC);
CREATE INDEX idx_research_evidence_assessment_source_version
  ON research_evidence_assessments (tenant_id, source_id, source_revision, rights_version, created_at DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_research_evidence_assessment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_claim RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_ASSESSMENTS_ARE_APPEND_ONLY'
      USING ERRCODE = '55000';
  END IF;

  -- PostgreSQL computes the durable fingerprint from the exact JSONB snapshot it stores.
  NEW.claim_fingerprint := encode(sha256(convert_to(NEW.evidence_snapshot::text, 'UTF8')), 'hex');

  SELECT c.*, s.title AS current_source_title, s.doi AS current_source_doi,
         s.source_url AS current_source_url, s.authors AS current_source_authors,
         s.publication_date AS current_publication_date,
         s.source_revision AS current_source_revision, s.rights_version AS current_rights_version,
         s.access_status AS current_access_status, s.license_status AS current_license_status,
         s.rights_basis AS current_rights_basis
    INTO v_claim
    FROM research_claims c
    JOIN research_sources s ON s.id = c.source_id AND s.tenant_id = c.tenant_id
   WHERE c.id = NEW.claim_id AND c.tenant_id = NEW.tenant_id
     AND s.id = NEW.source_id
   FOR SHARE OF c, s;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_ASSESSMENT_CLAIM_SCOPE_MISMATCH'
      USING ERRCODE = '23503';
  END IF;
  IF v_claim.namespace <> 'TENANT' OR v_claim.status NOT IN ('PROPOSED','APPROVED') THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_ASSESSMENT_REQUIRES_A_LIVE_TENANT_CLAIM'
      USING ERRCODE = '23514';
  END IF;
  IF v_claim.current_access_status <> 'APPROVED'
     OR v_claim.current_license_status NOT IN ('OPEN_ACCESS','LICENSED','USER_PROVIDED_AUTHORIZED')
     OR NULLIF(BTRIM(v_claim.current_rights_basis), '') IS NULL THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_ASSESSMENT_REQUIRES_CURRENT_REUSE_RIGHTS'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.assessed_by IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_ASSESSMENT_ACTOR_MUST_MATCH_DATABASE_CONTEXT'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.source_revision <> v_claim.current_source_revision
     OR NEW.rights_version <> v_claim.current_rights_version
     OR NEW.evidence_snapshot->>'claimId' IS DISTINCT FROM v_claim.id::text
     OR NEW.evidence_snapshot->>'sourceId' IS DISTINCT FROM v_claim.source_id::text
     OR NEW.evidence_snapshot->>'sourceRevision' IS DISTINCT FROM v_claim.current_source_revision::text
     OR NEW.evidence_snapshot->>'rightsVersion' IS DISTINCT FROM v_claim.current_rights_version::text THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_ASSESSMENT_SOURCE_VERSION_STALE'
      USING ERRCODE = '23514';
  END IF;

  -- Verify the immutable assessment is bound to the exact fields scored by the API.
  IF NEW.evidence_snapshot->>'claimTextSha256' IS DISTINCT FROM
       encode(sha256(convert_to(v_claim.claim_text, 'UTF8')), 'hex')
     OR NEW.evidence_snapshot->>'methodologySha256' IS DISTINCT FROM
       encode(sha256(convert_to(COALESCE(v_claim.methodology, ''), 'UTF8')), 'hex')
     OR NEW.evidence_snapshot->>'datasetDescriptionSha256' IS DISTINCT FROM
       encode(sha256(convert_to(COALESCE(v_claim.dataset_description, ''), 'UTF8')), 'hex')
     OR NEW.evidence_snapshot->>'limitationsSha256' IS DISTINCT FROM
       encode(sha256(convert_to(COALESCE(v_claim.limitations, ''), 'UTF8')), 'hex')
     OR NEW.evidence_snapshot->>'practicalImplicationSha256' IS DISTINCT FROM
       encode(sha256(convert_to(COALESCE(v_claim.practical_implication, ''), 'UTF8')), 'hex')
     OR NEW.evidence_snapshot->>'storedExcerptSha256' IS DISTINCT FROM
       encode(sha256(convert_to(COALESCE(v_claim.stored_excerpt, ''), 'UTF8')), 'hex')
     OR NEW.evidence_snapshot->'provenanceRef' IS DISTINCT FROM v_claim.provenance_ref
     OR NEW.evidence_snapshot->'topicTags' IS DISTINCT FROM v_claim.topic_tags
     OR NEW.evidence_snapshot->>'evidenceGrade' IS DISTINCT FROM v_claim.evidence_grade
     OR NEW.evidence_snapshot->>'evidenceStrength' IS DISTINCT FROM v_claim.evidence_strength
     OR NEW.evidence_snapshot->>'sourceTitle' IS DISTINCT FROM v_claim.current_source_title
     OR NEW.evidence_snapshot->>'sourceDoi' IS DISTINCT FROM v_claim.current_source_doi
     OR NEW.evidence_snapshot->>'sourceUrl' IS DISTINCT FROM v_claim.current_source_url
     OR NEW.evidence_snapshot->'sourceAuthors' IS DISTINCT FROM v_claim.current_source_authors
     OR NEW.evidence_snapshot->>'publicationDate' IS DISTINCT FROM v_claim.current_publication_date::text THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_ASSESSMENT_SNAPSHOT_CONTENT_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.citation_status = 'CONSISTENT' AND jsonb_array_length(NEW.citation_findings) <> 0 THEN
    RAISE EXCEPTION 'RESEARCH_CITATION_CONSISTENT_STATUS_CANNOT_HAVE_FINDINGS'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.safety_status = 'CLEAR' AND jsonb_array_length(NEW.safety_flags) <> 0 THEN
    RAISE EXCEPTION 'RESEARCH_SAFETY_CLEAR_STATUS_CANNOT_HAVE_FLAGS'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.citation_status = 'INVALID' AND NEW.suggested_grade <> 'D' THEN
    RAISE EXCEPTION 'RESEARCH_INVALID_CITATION_MUST_RECEIVE_GRADE_D'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER research_evidence_assessments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON research_evidence_assessments
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_research_evidence_assessment();

-- Approval now requires a current, rights-bound metadata-consistent citation assessment
-- and a clear prompt-injection screen. Evidence suggestions never approve a claim by themselves.
CREATE OR REPLACE FUNCTION factoryos_guard_research_claim_evidence_assessment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_revision INTEGER;
  v_rights_version INTEGER;
BEGIN
  IF NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED' THEN
    SELECT source_revision, rights_version
      INTO v_source_revision, v_rights_version
      FROM research_sources
     WHERE id = NEW.source_id AND tenant_id = NEW.tenant_id
       AND access_status = 'APPROVED'
       AND license_status IN ('OPEN_ACCESS','LICENSED','USER_PROVIDED_AUTHORIZED')
       AND NULLIF(BTRIM(rights_basis), '') IS NOT NULL;

    IF NOT FOUND OR NOT EXISTS (
      SELECT 1 FROM research_evidence_assessments a
       WHERE a.claim_id = NEW.id AND a.tenant_id = NEW.tenant_id
         AND a.source_id = NEW.source_id
         AND a.source_revision = v_source_revision AND a.rights_version = v_rights_version
         AND a.citation_status = 'CONSISTENT' AND a.safety_status = 'CLEAR'
    ) THEN
      RAISE EXCEPTION 'RESEARCH_CLAIM_APPROVAL_REQUIRES_CURRENT_EVIDENCE_ASSESSMENT'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER research_claim_evidence_assessment_guard
  BEFORE UPDATE OF status ON research_claims
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_research_claim_evidence_assessment();

ALTER TABLE research_evidence_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_evidence_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY research_evidence_assessments_tenant_isolation
  ON research_evidence_assessments
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations (version, checksum)
VALUES ('138_research_evidence_assessment', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
