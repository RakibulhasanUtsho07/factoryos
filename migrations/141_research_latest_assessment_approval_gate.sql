BEGIN;

-- The database approval boundary must inspect only the newest assessment for the
-- current source/right version. An older CLEAR decision must not mask a newer flag.
CREATE OR REPLACE FUNCTION factoryos_guard_research_claim_evidence_assessment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_revision INTEGER;
  v_rights_version INTEGER;
  v_check_required BOOLEAN := FALSE;
  v_assessment RECORD;
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

    IF NOT FOUND THEN
      RAISE EXCEPTION 'RESEARCH_CLAIM_APPROVAL_REQUIRES_CURRENT_EVIDENCE_ASSESSMENT'
        USING ERRCODE = '23514';
    END IF;

    SELECT a.* INTO v_assessment
      FROM research_evidence_assessments a
     WHERE a.claim_id = NEW.id AND a.tenant_id = NEW.tenant_id
       AND a.source_id = NEW.source_id
       AND a.source_revision = v_source_revision AND a.rights_version = v_rights_version
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT 1;

    IF NOT FOUND OR v_assessment.citation_status <> 'CONSISTENT'
       OR NOT (
         v_assessment.safety_status = 'CLEAR'
         OR EXISTS (
           SELECT 1 FROM research_evidence_safety_reviews sr
            WHERE sr.assessment_id = v_assessment.id AND sr.tenant_id = v_assessment.tenant_id
              AND sr.claim_id = v_assessment.claim_id AND sr.source_id = v_assessment.source_id
              AND sr.source_revision = v_assessment.source_revision
              AND sr.rights_version = v_assessment.rights_version
              AND sr.decision = 'CLEAR'
         )
       ) THEN
      RAISE EXCEPTION 'RESEARCH_CLAIM_APPROVAL_REQUIRES_CURRENT_EVIDENCE_ASSESSMENT'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('141_research_latest_assessment_approval_gate', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
