-- Repeatable PostgreSQL contract for provider authenticity, customer-file evidence,
-- idempotency metadata, dedup linkage, digest guards, tenant RLS and rights-revocation purge.
BEGIN;

DO $$
DECLARE
  required_table TEXT;
  required_trigger TEXT;
  required_policy TEXT;
  tenant_id UUID := 'faaab63d-c447-46ce-950d-deebdd7f5f30';
  actor_id UUID := '921382b8-e83f-43ab-a576-e3db6a06b70c';
  reviewer_id UUID := '21eaa0e0-e7b8-43a3-9c32-d8a5c6d11110';
  source_id UUID := gen_random_uuid();
  check_id UUID := gen_random_uuid();
  first_document_id UUID := gen_random_uuid();
  duplicate_document_id UUID := gen_random_uuid();
  content_text TEXT := 'FactoryOS customer evidence proves this text is retained only under current rights.';
  content_bytes BYTEA;
  content_hash CHAR(64);
  text_hash CHAR(64);
  signature JSONB;
  source_revision_value INTEGER;
  rights_version_value INTEGER;
  rejected_self_review BOOLEAN := FALSE;
  rejected_direct_delete BOOLEAN := FALSE;
  stored_content_count INTEGER;
  purged_document_count INTEGER;
  purge_receipt_count INTEGER;
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'research_source_authenticity_checks',
    'research_source_authenticity_reviews',
    'research_source_documents',
    'research_source_document_content',
    'research_source_document_purges'
  ] LOOP
    IF to_regclass('public.' || required_table) IS NULL THEN
      RAISE EXCEPTION 'RESEARCH_SOURCE_PRODUCTION_REQUIRED_TABLE_MISSING: %', required_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      WHERE c.oid=to_regclass('public.' || required_table)
        AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'RESEARCH_SOURCE_PRODUCTION_RLS_NOT_FORCED: %', required_table;
    END IF;
    required_policy := required_table || '_tenant_isolation';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename=required_table AND policyname=required_policy
    ) THEN
      RAISE EXCEPTION 'RESEARCH_SOURCE_PRODUCTION_TENANT_POLICY_MISSING: %', required_policy;
    END IF;
  END LOOP;

  FOREACH required_trigger IN ARRAY ARRAY[
    'research_source_authenticity_checks_immutable',
    'research_source_authenticity_reviews_guard',
    'research_source_authenticity_reviews_immutable',
    'research_source_documents_guard',
    'research_source_document_content_integrity_guard',
    'research_source_document_purges_immutable',
    'research_source_zzz_document_purge_guard'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname=required_trigger AND NOT tgisinternal AND tgenabled <> 'D'
    ) THEN
      RAISE EXCEPTION 'RESEARCH_SOURCE_PRODUCTION_REQUIRED_TRIGGER_MISSING: %', required_trigger;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='171_research_source_provider_documents')
     OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='172_research_document_content_integrity') THEN
    RAISE EXCEPTION 'RESEARCH_SOURCE_PRODUCTION_MIGRATION_REGISTRATION_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.oid=to_regclass('public.research_source_document_content')
      AND c.relkind='r'
  ) THEN
    RAISE EXCEPTION 'RESEARCH_SOURCE_DOCUMENT_CONTENT_TABLE_MISSING';
  END IF;

  INSERT INTO users (id,external_subject,email,display_name,status)
  VALUES (
    reviewer_id,'factoryos-research-prod-review-fixture',
    'research-prod-review-fixture@factoryos.local',
    'FactoryOS Research Independent Reviewer','ACTIVE'
  )
  ON CONFLICT (id) DO UPDATE SET status='ACTIVE';

  INSERT INTO research_sources (
    id,tenant_id,namespace,source_type,title,authors,source_metadata,
    license_status,access_status,rights_basis,license_reference,full_text_storage_allowed,
    untrusted_content,created_by,reviewed_by,reviewed_at,review_reason
  ) VALUES (
    source_id,tenant_id,'TENANT','CUSTOMER_PROVIDED',
    'CI customer-provided research evidence', '[]'::jsonb, '{}'::jsonb,
    'USER_PROVIDED_AUTHORIZED','APPROVED',
    'Disposable CI fixture permits this source document to be stored for contract testing',
    'https://example.test/ci-fixture-rights',TRUE,TRUE,
    actor_id,actor_id,clock_timestamp(),'Authorized CI test fixture'
  );

  SELECT source_revision,rights_version
    INTO source_revision_value,rights_version_value
    FROM research_sources WHERE id=source_id AND tenant_id=tenant_id;

  INSERT INTO research_source_authenticity_checks (
    id,tenant_id,source_id,source_revision,rights_version,provider,verification_status,
    provider_record_id,canonical_doi,canonical_url,provider_title,title_similarity,
    response_sha256,reason_code,evidence,checked_by
  ) VALUES (
    check_id,tenant_id,source_id,source_revision_value,rights_version_value,
    'CROSSREF','VERIFIED','10.1234/ci.fixture','10.1234/ci.fixture',
    'https://doi.org/10.1234/ci.fixture','CI customer-provided research evidence',1.0,
    repeat('a',64),'DOI_AND_TITLE_MATCH','{}'::jsonb,actor_id
  );

  BEGIN
    INSERT INTO research_source_authenticity_reviews (
      tenant_id,source_id,authenticity_check_id,source_revision,rights_version,
      decision,reason,reviewed_by
    ) VALUES (
      tenant_id,source_id,check_id,source_revision_value,rights_version_value,
      'ACCEPT','Same-user review must be rejected',actor_id
    );
  EXCEPTION WHEN insufficient_privilege THEN
    rejected_self_review := TRUE;
  END;
  IF NOT rejected_self_review THEN
    RAISE EXCEPTION 'RESEARCH_AUTHENTICITY_SELF_REVIEW_WAS_NOT_REJECTED';
  END IF;

  INSERT INTO research_source_authenticity_reviews (
    tenant_id,source_id,authenticity_check_id,source_revision,rights_version,
    decision,reason,reviewed_by
  ) VALUES (
    tenant_id,source_id,check_id,source_revision_value,rights_version_value,
    'ACCEPT','Independent review accepts the provider identity match',reviewer_id
  );

  content_bytes := convert_to(content_text,'UTF8');
  content_hash := encode(sha256(content_bytes),'hex');
  text_hash := encode(sha256(convert_to(content_text,'UTF8')),'hex');
  signature := to_jsonb(ARRAY[
    repeat('a',16),repeat('b',16),repeat('c',16),repeat('d',16),
    repeat('e',16),repeat('f',16),repeat('1',16),repeat('2',16),
    repeat('3',16),repeat('4',16),repeat('5',16),repeat('6',16),
    repeat('7',16),repeat('8',16),repeat('9',16),repeat('0',16)
  ]);

  INSERT INTO research_source_documents (
    id,tenant_id,source_id,source_revision,rights_version,idempotency_key,request_hash,
    original_filename,media_type,byte_size,content_sha256,extracted_text_sha256,
    normalized_text_sha256,text_signature,parser_version,similarity_score,created_by
  ) VALUES (
    first_document_id,tenant_id,source_id,source_revision_value,rights_version_value,
    'research-production-fixture-1',repeat('b',64),'evidence.txt','text/plain',
    octet_length(content_bytes),content_hash,text_hash,text_hash,signature,
    'factoryos-text-parser.v1',0,actor_id
  );

  INSERT INTO research_source_document_content (document_id,tenant_id,raw_content,extracted_text)
  VALUES (first_document_id,tenant_id,content_bytes,content_text);

  -- Same bytes should remain separately traceable and be linked as a duplicate, not merged.
  INSERT INTO research_source_documents (
    id,tenant_id,source_id,source_revision,rights_version,idempotency_key,request_hash,
    original_filename,media_type,byte_size,content_sha256,extracted_text_sha256,
    normalized_text_sha256,text_signature,parser_version,duplicate_of_document_id,
    similarity_score,created_by
  ) VALUES (
    duplicate_document_id,tenant_id,source_id,source_revision_value,rights_version_value,
    'research-production-fixture-2',repeat('c',64),'duplicate-evidence.txt','text/plain',
    octet_length(content_bytes),content_hash,text_hash,text_hash,signature,
    'factoryos-text-parser.v1',first_document_id,1,actor_id
  );
  INSERT INTO research_source_document_content (document_id,tenant_id,raw_content,extracted_text)
  VALUES (duplicate_document_id,tenant_id,content_bytes,content_text);

  BEGIN
    DELETE FROM research_source_document_content
    WHERE document_id=first_document_id AND tenant_id=tenant_id;
  EXCEPTION WHEN insufficient_privilege THEN
    rejected_direct_delete := TRUE;
  END;
  IF NOT rejected_direct_delete THEN
    RAISE EXCEPTION 'RESEARCH_DOCUMENT_CONTENT_DIRECT_DELETE_WAS_NOT_REJECTED';
  END IF;

  UPDATE research_sources
     SET access_status='REVOKED',
         full_text_storage_allowed=FALSE,
         reviewed_by=reviewer_id,
         reviewed_at=clock_timestamp(),
         review_reason='CI rights revocation exercises the content purge contract'
   WHERE id=source_id AND tenant_id=tenant_id;

  SELECT count(*) INTO stored_content_count
    FROM research_source_document_content WHERE tenant_id=tenant_id
      AND document_id IN (first_document_id,duplicate_document_id);
  SELECT count(*) INTO purged_document_count
    FROM research_source_documents WHERE tenant_id=tenant_id AND source_id=source_id
      AND id IN (first_document_id,duplicate_document_id) AND storage_status='PURGED';
  SELECT count(*) INTO purge_receipt_count
    FROM research_source_document_purges WHERE tenant_id=tenant_id AND source_id=source_id
      AND document_id IN (first_document_id,duplicate_document_id)
      AND content_sha256=content_hash AND extracted_text_sha256=text_hash
      AND purge_reason='SOURCE_ACCESS_REVOKED';

  IF stored_content_count <> 0 OR purged_document_count <> 2 OR purge_receipt_count <> 2 THEN
    RAISE EXCEPTION 'RESEARCH_DOCUMENT_RIGHTS_PURGE_FAILED: content=%, documents=%, receipts=%',
      stored_content_count,purged_document_count,purge_receipt_count;
  END IF;

  RAISE NOTICE 'Research provider verification review, duplicate lineage, content digest and rights purge contract passed';
END $$;

ROLLBACK;
