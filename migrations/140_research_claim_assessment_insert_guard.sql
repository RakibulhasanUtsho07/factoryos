BEGIN;

-- Close the direct-SQL INSERT bypass as well as the API UPDATE path. An
-- APPROVED claim must already have a source/version-bound assessment; callers
-- cannot create a trusted claim and backfill evidence later.
CREATE OR REPLACE FUNCTION factoryos_guard_research_claim_evidence_assessment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_revision INTEGER;
  v_rights_version INTEGER;
  v_check_required BOOLEAN := FALSE;
BEGIN
  IF NEW.status = 'APPROVED' THEN
    IF TG_OP = 'INSERT' THEN
      v_check_required := TRUE;
    ELSE
      v_check_required := OLD.status IS DISTINCT FROM 'APPROVED';
    END IF;
  END IF;

  IF v_check_required THEN
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

DROP TRIGGER research_claim_evidence_assessment_guard ON research_claims;
CREATE TRIGGER research_claim_evidence_assessment_guard
  BEFORE INSERT OR UPDATE ON research_claims
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_research_claim_evidence_assessment();

INSERT INTO schema_migrations (version, checksum)
VALUES ('140_research_claim_assessment_insert_guard', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
