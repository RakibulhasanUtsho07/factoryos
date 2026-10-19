-- PostgreSQL contract for rights-gated, resumable research ingestion/extraction.
DO $$
DECLARE
  required_table TEXT;
  required_index TEXT;
  required_trigger TEXT;
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'research_ingestion_jobs',
    'research_ingestion_events',
    'research_extraction_runs',
    'research_extraction_items',
    'research_source_rights_history',
    'research_extraction_item_reviews',
    'research_source_content_purges',
    'research_evidence_assessments',
    'research_evidence_safety_reviews'
  ] LOOP
    IF to_regclass('public.' || required_table) IS NULL THEN
      RAISE EXCEPTION 'RESEARCH_INGESTION_REQUIRED_TABLE_MISSING: %', required_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      WHERE c.oid=to_regclass('public.' || required_table)
        AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'RESEARCH_INGESTION_RLS_NOT_FORCED: %', required_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename=required_table
        AND policyname=required_table || '_tenant_isolation'
    ) THEN
      RAISE EXCEPTION 'RESEARCH_INGESTION_TENANT_POLICY_MISSING: %', required_table;
    END IF;
  END LOOP;

  FOREACH required_index IN ARRAY ARRAY[
    'uq_research_source_id_tenant',
    'uq_research_ingestion_job_scope',
    'uq_research_ingestion_idempotency',
    'idx_research_ingestion_queue',
    'idx_research_ingestion_source',
    'idx_research_ingestion_lease',
    'idx_research_ingestion_events_timeline',
    'uq_research_extraction_job',
    'idx_research_extraction_source',
    'uq_research_extraction_item_key',
    'idx_research_extraction_items_review',
    'uq_research_claim_extraction_item',
    'idx_research_source_rights_history',
    'idx_research_extraction_item_review_history',
    'uq_research_extraction_item_review',
    'uq_research_claim_id_tenant',
    'idx_research_source_content_purges_timeline',
    'idx_research_evidence_assessment_history',
    'idx_research_evidence_assessment_source_version',
    'uq_research_evidence_assessment_scope',
    'idx_research_evidence_safety_review_claim'
  ] LOOP
    IF to_regclass('public.' || required_index) IS NULL THEN
      RAISE EXCEPTION 'RESEARCH_INGESTION_REQUIRED_INDEX_MISSING: %', required_index;
    END IF;
  END LOOP;

  FOREACH required_trigger IN ARRAY ARRAY[
    'research_source_revision_guard',
    'research_source_rights_history_record',
    'research_ingestion_job_transition_guard',
    'research_ingestion_events_immutable',
    'research_extraction_runs_immutable',
    'research_extraction_items_immutable',
    'research_source_rights_history_immutable',
    'research_extraction_item_review_guard',
    'research_extraction_item_reviews_immutable',
    'research_extracted_claim_review_guard',
    'research_source_z_excerpt_purge_guard',
    'research_source_content_purges_immutable',
    'research_source_a_access_normalize_guard',
    'research_evidence_assessments_guard',
    'research_claim_evidence_assessment_guard',
    'research_evidence_safety_review_guard',
    'research_evidence_score_consistency_guard'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgname=required_trigger AND NOT t.tgisinternal AND t.tgenabled <> 'D'
    ) THEN
      RAISE EXCEPTION 'RESEARCH_INGESTION_REQUIRED_TRIGGER_MISSING: %', required_trigger;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='research_sources' AND column_name='source_revision'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='research_sources' AND column_name='rights_version'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='research_claims' AND column_name='extraction_item_id'
  ) THEN
    RAISE EXCEPTION 'RESEARCH_INGESTION_PROVENANCE_COLUMNS_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='research_sources' AND column_name='full_text_storage_allowed'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='chk_research_source_full_text_requires_current_access'
  ) THEN
    RAISE EXCEPTION 'RESEARCH_FULL_TEXT_ACCESS_CONSTRAINT_MISSING';
  END IF;

  IF position('BASELINE_IMPORTED'
      IN pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname='chk_research_source_rights_history_action'))) = 0 THEN
    RAISE EXCEPTION 'RESEARCH_SOURCE_BASELINE_HISTORY_ACTION_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version='134_research_ingestion_provenance'
  ) OR NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version='135_research_extraction_review_gate'
  ) OR NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version='136_research_content_rights_purge'
  ) OR NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version='137_research_full_text_access_normalization'
  ) OR NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version='138_research_evidence_assessment'
  ) OR NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version='139_research_evidence_safety_review'
  ) OR NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version='140_research_claim_assessment_insert_guard'
  ) THEN
    RAISE EXCEPTION 'RESEARCH_INGESTION_MIGRATION_REGISTRATION_MISSING';
  END IF;

  IF position('SOURCE_ACCESS_REVOKED'
      IN pg_get_functiondef('public.factoryos_research_purge_unlicensed_excerpts()'::regprocedure)) = 0
     OR position('storedExcerptSha256'
      IN pg_get_functiondef('public.factoryos_research_purge_unlicensed_excerpts()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'RESEARCH_RIGHTS_EXCERPT_PURGE_GUARD_MISSING';
  END IF;

  IF position('Extracted claims require explicit extraction-item review'
      IN pg_get_functiondef('public.factoryos_guard_research_extracted_claim_review()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'RESEARCH_EXTRACTION_REVIEW_APPROVAL_GUARD_MISSING';
  END IF;

  IF position('RESEARCH_CLAIM_APPROVAL_REQUIRES_CURRENT_EVIDENCE_ASSESSMENT'
      IN pg_get_functiondef('public.factoryos_guard_research_claim_evidence_assessment()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'RESEARCH_CLAIM_EVIDENCE_ASSESSMENT_APPROVAL_GATE_MISSING';
  END IF;

  IF position('RESEARCH_EVIDENCE_ASSESSMENT_SNAPSHOT_CONTENT_MISMATCH'
      IN pg_get_functiondef('public.factoryos_guard_research_evidence_assessment()'::regprocedure)) = 0
     OR position('RESEARCH_EVIDENCE_ASSESSMENTS_ARE_APPEND_ONLY'
      IN pg_get_functiondef('public.factoryos_guard_research_evidence_assessment()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_ASSESSMENT_IMMUTABILITY_GUARD_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.oid=to_regclass('public.research_evidence_assessments')
      AND c.relrowsecurity AND c.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='research_evidence_assessments'
      AND policyname='research_evidence_assessments_tenant_isolation'
  ) THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_ASSESSMENT_TENANT_ISOLATION_MISSING';
  END IF;

  IF position('RESEARCH_EVIDENCE_RUBRIC_FACTORS_DO_NOT_MATCH_SCORE'
      IN pg_get_functiondef('public.factoryos_guard_research_evidence_score_consistency()'::regprocedure)) = 0
     OR position('RESEARCH_EVIDENCE_GRADE_DOES_NOT_MATCH_RUBRIC_THRESHOLDS'
      IN pg_get_functiondef('public.factoryos_guard_research_evidence_score_consistency()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_RUBRIC_DATABASE_CONSISTENCY_GUARD_MISSING';
  END IF;

  IF position('RESEARCH_EVIDENCE_SAFETY_REVIEW_SOURCE_VERSION_STALE'
      IN pg_get_functiondef('public.factoryos_guard_research_evidence_safety_review()'::regprocedure)) = 0
     OR position('RESEARCH_EVIDENCE_SAFETY_REVIEWS_ARE_APPEND_ONLY'
      IN pg_get_functiondef('public.factoryos_guard_research_evidence_safety_review()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_SAFETY_REVIEW_INTEGRITY_GUARD_MISSING';
  END IF;

  IF position('INSERT' IN upper(pg_get_triggerdef((
      SELECT oid FROM pg_trigger
      WHERE tgname='research_claim_evidence_assessment_guard' AND NOT tgisinternal
    )))) = 0 THEN
    RAISE EXCEPTION 'RESEARCH_CLAIM_ASSESSMENT_INSERT_GUARD_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.oid=to_regclass('public.research_evidence_safety_reviews')
      AND c.relrowsecurity AND c.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='research_evidence_safety_reviews'
      AND policyname='research_evidence_safety_reviews_tenant_isolation'
  ) THEN
    RAISE EXCEPTION 'RESEARCH_EVIDENCE_SAFETY_REVIEW_TENANT_ISOLATION_MISSING';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM permissions WHERE code='research.ingest') THEN
    RAISE EXCEPTION 'RESEARCH_INGESTION_PERMISSION_MISSING';
  END IF;

  IF position('RESEARCH_INGESTION_JOB_TERMINAL'
      IN pg_get_functiondef('public.factoryos_research_ingestion_job_transition_guard()'::regprocedure)) = 0
     OR position('RESEARCH_INGESTION_PROGRESS_CANNOT_MOVE_BACKWARD'
      IN pg_get_functiondef('public.factoryos_research_ingestion_job_transition_guard()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'RESEARCH_INGESTION_LIFECYCLE_GUARD_MISSING';
  END IF;

  IF position('ingestedAt'
      IN pg_get_functiondef('public.factoryos_research_record_source_history()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'RESEARCH_SOURCE_INGESTION_TIMESTAMP_PROVENANCE_MISSING';
  END IF;

  IF position('SOURCE_RIGHTS_CHANGED'
      IN pg_get_functiondef('public.factoryos_research_record_source_history()'::regprocedure)) = 0
     OR position('BLOCKED_RIGHTS'
      IN pg_get_functiondef('public.factoryos_research_record_source_history()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'RESEARCH_INGESTION_RIGHTS_INVALIDATION_GUARD_MISSING';
  END IF;

  RAISE NOTICE 'Research rights, resumable ingestion, extraction provenance and tenant-isolation contract passed';
END $$;
