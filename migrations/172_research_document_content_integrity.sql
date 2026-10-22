BEGIN;

-- Content storage is an implementation detail behind immutable digest metadata.
-- Only an INSERT that matches the current rights-approved document snapshot is allowed.
CREATE OR REPLACE FUNCTION factoryos_guard_research_source_document_content()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  document_row RECORD;
  source_row RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Research source document content is immutable' USING ERRCODE='55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- Deletion is permitted only as a nested part of the source-rights purge trigger.
    -- Direct API or SQL deletes must not bypass the digest-only purge receipt.
    IF pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'Research source document content may only be removed by the governed rights-purge transition'
        USING ERRCODE='42501';
    END IF;
    RETURN OLD;
  END IF;

  SELECT d.id,d.tenant_id,d.source_id,d.source_revision,d.rights_version,d.byte_size,
         d.content_sha256,d.extracted_text_sha256,d.storage_status
    INTO document_row
    FROM research_source_documents d
   WHERE d.id=NEW.document_id AND d.tenant_id=NEW.tenant_id
   FOR UPDATE;

  IF document_row.id IS NULL OR document_row.storage_status <> 'STORED' THEN
    RAISE EXCEPTION 'RESEARCH_SOURCE_DOCUMENT_CONTENT_PARENT_NOT_STORED' USING ERRCODE='23503';
  END IF;

  SELECT s.id,s.source_revision,s.rights_version,s.access_status,s.license_status,
         s.rights_basis,s.full_text_storage_allowed
    INTO source_row
    FROM research_sources s
   WHERE s.id=document_row.source_id AND s.tenant_id=NEW.tenant_id
     AND s.namespace='TENANT'
   FOR UPDATE;

  IF source_row.id IS NULL
     OR source_row.access_status <> 'APPROVED'
     OR source_row.license_status NOT IN ('OPEN_ACCESS','LICENSED','USER_PROVIDED_AUTHORIZED')
     OR source_row.rights_basis IS NULL OR length(btrim(source_row.rights_basis))=0
     OR source_row.full_text_storage_allowed IS NOT TRUE THEN
    RAISE EXCEPTION 'RESEARCH_SOURCE_DOCUMENT_CONTENT_RIGHTS_NOT_CURRENT' USING ERRCODE='42501';
  END IF;

  IF document_row.source_revision <> source_row.source_revision
     OR document_row.rights_version <> source_row.rights_version THEN
    RAISE EXCEPTION 'RESEARCH_SOURCE_DOCUMENT_CONTENT_SOURCE_SNAPSHOT_STALE' USING ERRCODE='40001';
  END IF;

  IF octet_length(NEW.raw_content) <> document_row.byte_size
     OR encode(sha256(NEW.raw_content),'hex') <> document_row.content_sha256
     OR encode(sha256(convert_to(NEW.extracted_text,'UTF8')),'hex') <> document_row.extracted_text_sha256 THEN
    RAISE EXCEPTION 'RESEARCH_SOURCE_DOCUMENT_CONTENT_DIGEST_MISMATCH' USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS research_source_document_content_update_guard ON research_source_document_content;
DROP TRIGGER IF EXISTS research_source_document_content_integrity_guard ON research_source_document_content;
CREATE TRIGGER research_source_document_content_integrity_guard
BEFORE INSERT OR UPDATE OR DELETE ON research_source_document_content
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_research_source_document_content();

INSERT INTO schema_migrations (version,checksum)
VALUES ('172_research_document_content_integrity',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
