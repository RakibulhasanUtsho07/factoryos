BEGIN;

-- Full-text storage permission is never considered active while source access
-- is unapproved or the license no longer permits reuse. The trigger name
-- sorts before research_source_revision_guard so version counters see the
-- normalized NEW row; the excerpt-purge trigger runs afterward.
CREATE OR REPLACE FUNCTION factoryos_research_normalize_source_storage_rights()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.namespace = 'TENANT' AND NEW.tenant_id IS NOT NULL
     AND (
       NEW.access_status <> 'APPROVED'
       OR NEW.license_status NOT IN ('OPEN_ACCESS','LICENSED','USER_PROVIDED_AUTHORIZED')
       OR NEW.rights_basis IS NULL
       OR length(btrim(NEW.rights_basis)) = 0
     ) THEN
    NEW.full_text_storage_allowed := FALSE;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER research_source_a_access_normalize_guard
BEFORE UPDATE OF access_status,license_status,rights_basis,full_text_storage_allowed ON research_sources
FOR EACH ROW EXECUTE FUNCTION factoryos_research_normalize_source_storage_rights();

-- Normalize legacy/inconsistent rows through the same revision, rights,
-- purge, history and job invalidation triggers as ordinary rights changes.
UPDATE research_sources
   SET full_text_storage_allowed=FALSE
 WHERE namespace='TENANT' AND tenant_id IS NOT NULL
   AND full_text_storage_allowed=TRUE
   AND (
     access_status <> 'APPROVED'
     OR license_status NOT IN ('OPEN_ACCESS','LICENSED','USER_PROVIDED_AUTHORIZED')
     OR rights_basis IS NULL
     OR length(btrim(rights_basis)) = 0
   );

ALTER TABLE research_sources
  ADD CONSTRAINT chk_research_source_full_text_requires_current_access CHECK (
    NOT full_text_storage_allowed
    OR (
      access_status = 'APPROVED'
      AND license_status IN ('OPEN_ACCESS','LICENSED','USER_PROVIDED_AUTHORIZED')
      AND rights_basis IS NOT NULL
      AND length(btrim(rights_basis)) > 0
    )
  );

INSERT INTO schema_migrations (version,checksum)
VALUES ('137_research_full_text_access_normalization',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
