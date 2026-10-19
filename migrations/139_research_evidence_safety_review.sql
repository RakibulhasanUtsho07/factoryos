BEGIN;

-- A flagged item cannot be approved until a separate reviewer records a reasoned safety decision.
ALTER TABLE research_evidence_assessments
  ADD CONSTRAINT uq_research_evidence_assessment_scope UNIQUE (id, tenant_id);

CREATE TABLE research_evidence_safety_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  assessment_id UUID NOT NULL,
  claim_id UUID NOT NULL,
  source_id UUID NOT NULL,
  source_revision INTEGER NOT NULL,
  rights_version INTEGER NOT NULL,
  decision VARCHAR(12) NOT NULL,
  reason TEXT NOT NULL,
  reviewed_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_research_evidence_safety_review_assessment UNIQUE (assessment_id),
  CONSTRAINT fk_research_evidence_safety_review_assessment
    FOREIGN KEY (assessment_id, tenant_id)
    REFERENCES research_evidence_assessments(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_evidence_safety_review_claim
    FOREIGN KEY (claim_id, tenant_id) REFERENCES research_claims(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_evidence_safety_review_source
    FOREIGN KEY (source_id, tenant_id) REFERENCES research_sources(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_research_evidence_safety_review_actor
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_research_evidence_safety_review_versions
    CHECK (source_revision >= 1 AND rights_version >= 1),
  CONSTRAINT chk_research_evidence_safety_review_decision
    CHECK (decision IN ('CLEAR','REJECT')),
  CONSTRAINT chk_research_evidence_safety_review_reason
    CHECK (length(btrim(reason)) BETWEEN 10 AND 2000)
);

CREATE INDEX idx_research_evidence_safety_review_claim
  ON research_evidence_safety_reviews (tenant_id, claim_id, created_at DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_research_evidence_safety_review()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_assessment RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_SAFETY_REVIEWS_ARE_APPEND_ONLY'
      USING ERRCODE = '55000';
  END IF;

  SELECT a.claim_id, a.source_id, a.source_revision, a.rights_version,
         a.safety_status, a.citation_status,
         s.source_revision AS current_source_revision,
         s.rights_version AS current_rights_version,
         s.access_status AS current_access_status,
         s.license_status AS current_license_status,
         s.rights_basis AS current_rights_basis
    INTO v_assessment
    FROM research_evidence_assessments a
    JOIN research_sources s ON s.id = a.source_id AND s.tenant_id = a.tenant_id
    JOIN research_claims c ON c.id = a.claim_id AND c.tenant_id = a.tenant_id
   WHERE a.id = NEW.assessment_id AND a.tenant_id = NEW.tenant_id
     AND c.id = NEW.claim_id AND s.id = NEW.source_id
   FOR SHARE OF a, s, c;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_SAFETY_REVIEW_SCOPE_MISMATCH'
      USING ERRCODE = '23503';
  END IF;
  IF v_assessment.safety_status <> 'REVIEW_REQUIRED' THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_SAFETY_REVIEW_REQUIRES_FLAGGED_ASSESSMENT'
      USING ERRCODE = '23514';
  END IF;
  IF v_assessment.source_revision <> v_assessment.current_source_revision
     OR v_assessment.rights_version <> v_assessment.current_rights_version
     OR NEW.source_revision <> v_assessment.current_source_revision
     OR NEW.rights_version <> v_assessment.current_rights_version THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_SAFETY_REVIEW_SOURCE_VERSION_STALE'
      USING ERRCODE = '23514';
  END IF;
  IF v_assessment.current_access_status <> 'APPROVED'
     OR v_assessment.current_license_status NOT IN ('OPEN_ACCESS','LICENSED','USER_PROVIDED_AUTHORIZED')
     OR NULLIF(BTRIM(v_assessment.current_rights_basis), '') IS NULL THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_SAFETY_REVIEW_REQUIRES_CURRENT_SOURCE_RIGHTS'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.reviewed_by IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_SAFETY_REVIEW_ACTOR_MISMATCH'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER research_evidence_safety_review_guard
  BEFORE INSERT OR UPDATE OR DELETE ON research_evidence_safety_reviews
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_research_evidence_safety_review();

CREATE OR REPLACE FUNCTION factoryos_guard_research_evidence_score_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_factor_count INTEGER;
  v_score_sum INTEGER;
  v_max_sum INTEGER;
  v_factors_valid BOOLEAN;
  v_expected_grade VARCHAR(2);
BEGIN
  SELECT count(*)::integer,
         COALESCE(sum((entry->>'score')::integer), 0)::integer,
         COALESCE(sum((entry->>'max')::integer), 0)::integer,
         COALESCE(bool_and(
           jsonb_typeof(entry) = 'object'
           AND (entry->>'score') ~ '^[0-9]+$'
           AND (entry->>'max') ~ '^[0-9]+$'
           AND (entry->>'score')::integer BETWEEN 0 AND (entry->>'max')::integer
           AND (entry->>'max')::integer > 0
           AND length(btrim(COALESCE(entry->>'explanation',''))) > 0
         ), FALSE)
    INTO v_factor_count, v_score_sum, v_max_sum, v_factors_valid
    FROM jsonb_each(NEW.grade_factors) AS factor(name, entry);

  IF v_factor_count <> 8 OR v_score_sum <> NEW.evidence_score
     OR v_max_sum <> 100 OR NOT v_factors_valid THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_RUBRIC_FACTORS_DO_NOT_MATCH_SCORE'
      USING ERRCODE = '23514';
  END IF;

  v_expected_grade := CASE
    WHEN NEW.citation_status = 'INVALID' OR NEW.evidence_score < 50 THEN 'D'
    WHEN NEW.evidence_score >= 85 THEN 'A'
    WHEN NEW.evidence_score >= 70 THEN 'B'
    ELSE 'C'
  END;
  IF NEW.suggested_grade <> v_expected_grade THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_GRADE_DOES_NOT_MATCH_RUBRIC_THRESHOLDS'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER research_evidence_score_consistency_guard
  BEFORE INSERT ON research_evidence_assessments
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_research_evidence_score_consistency();

-- Allow claim approval only when a flagged assessment has a current explicit CLEAR decision.
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
      SELECT 1
        FROM research_evidence_assessments a
       WHERE a.claim_id = NEW.id AND a.tenant_id = NEW.tenant_id
         AND a.source_id = NEW.source_id
         AND a.source_revision = v_source_revision AND a.rights_version = v_rights_version
         AND a.citation_status = 'CONSISTENT'
         AND (
           a.safety_status = 'CLEAR'
           OR EXISTS (
             SELECT 1 FROM research_evidence_safety_reviews sr
              WHERE sr.assessment_id = a.id AND sr.tenant_id = a.tenant_id
                AND sr.claim_id = a.claim_id AND sr.source_id = a.source_id
                AND sr.source_revision = a.source_revision AND sr.rights_version = a.rights_version
                AND sr.decision = 'CLEAR'
           )
         )
    ) THEN
      RAISE EXCEPTION 'RESEARCH_CLAIM_APPROVAL_REQUIRES_CURRENT_EVIDENCE_ASSESSMENT'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE research_evidence_safety_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_evidence_safety_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY research_evidence_safety_reviews_tenant_isolation
  ON research_evidence_safety_reviews
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations (version, checksum)
VALUES ('139_research_evidence_safety_review', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
