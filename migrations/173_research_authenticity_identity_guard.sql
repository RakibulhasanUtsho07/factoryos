BEGIN;

CREATE OR REPLACE FUNCTION factoryos_guard_research_source_authenticity_check()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  source_row RECORD;
  source_doi_normalized TEXT;
  source_pmid TEXT;
  source_title_normalized TEXT;
BEGIN
  SELECT id,doi,source_url,source_metadata,title,source_revision,rights_version
    INTO source_row
    FROM research_sources
   WHERE id=NEW.source_id AND tenant_id=NEW.tenant_id AND namespace='TENANT'
   FOR UPDATE;

  IF source_row.id IS NULL THEN
    RAISE EXCEPTION 'RESEARCH_SOURCE_AUTHENTICITY_SOURCE_NOT_FOUND' USING ERRCODE='23503';
  END IF;

  IF NEW.source_revision <> source_row.source_revision OR NEW.rights_version <> source_row.rights_version THEN
    RAISE EXCEPTION 'RESEARCH_SOURCE_AUTHENTICITY_CHECK_STALE' USING ERRCODE='40001';
  END IF;

  IF NEW.verification_status <> 'VERIFIED' THEN
    RETURN NEW;
  END IF;

  source_doi_normalized := lower(regexp_replace(
    btrim(COALESCE(source_row.doi,'')),
    '^(https?://(dx[.])?doi[.]org/|doi:[[:space:]]*)','', 'i'
  ));
  source_pmid := substring(COALESCE(source_row.source_url,'')
    from 'https?://(www[.])?pubmed[.]ncbi[.]nlm[.]nih[.]gov/([0-9]+)');
  IF source_pmid IS NULL THEN
    source_pmid := substring(COALESCE(source_row.source_url,'')
      from 'https?://(www[.])?ncbi[.]nlm[.]nih[.]gov/pubmed/([0-9]+)');
  END IF;
  IF source_pmid IS NULL THEN
    source_pmid := COALESCE(source_row.source_metadata->>'pubmedId','');
  END IF;

  IF NEW.provider='CROSSREF' THEN
    IF source_doi_normalized !~ '^10[.][0-9]{4,9}/[^[:space:]?#]+$'
       OR lower(COALESCE(NEW.canonical_doi,'')) <> source_doi_normalized
       OR lower(COALESCE(NEW.provider_record_id,'')) <> source_doi_normalized
       OR NEW.title_similarity < 0.85
       OR NEW.response_sha256 IS NULL THEN
      RAISE EXCEPTION 'RESEARCH_SOURCE_AUTHENTICITY_CROSSREF_IDENTITY_MISMATCH' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.provider='EUROPE_PMC' THEN
    IF source_pmid !~ '^[0-9]{1,12}$'
       OR COALESCE(NEW.provider_record_id,'') <> 'PMID:' || source_pmid
       OR NEW.canonical_url !~ ('^https://pubmed[.]ncbi[.]nlm[.]nih[.]gov/' || source_pmid || '/?$')
       OR NEW.title_similarity < 0.85
       OR NEW.response_sha256 IS NULL THEN
      RAISE EXCEPTION 'RESEARCH_SOURCE_AUTHENTICITY_EUROPE_PMC_IDENTITY_MISMATCH' USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'RESEARCH_SOURCE_AUTHENTICITY_VERIFIED_REQUIRES_APPROVED_PROVIDER' USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS research_source_authenticity_check_guard ON research_source_authenticity_checks;
CREATE TRIGGER research_source_authenticity_check_guard
BEFORE INSERT ON research_source_authenticity_checks
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_research_source_authenticity_check();

INSERT INTO schema_migrations (version,checksum)
VALUES ('173_research_authenticity_identity_guard',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
