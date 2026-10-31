BEGIN;

ALTER TABLE public.saas_tenant_external_copy_coverage_decisions
  DROP CONSTRAINT IF EXISTS chk_saas_external_copy_coverage_store_kind;
ALTER TABLE public.saas_tenant_external_copy_coverage_decisions
  ADD CONSTRAINT chk_saas_external_copy_coverage_store_kind CHECK (store_kind IN (
    'OBJECT_STORAGE','CACHE','SEARCH_INDEX','VECTOR_STORE','LEARNING_ARTIFACT',
    'EXTERNAL_PROVIDER','REPLICA','BACKUP','UNCLASSIFIED_EXTERNAL_STORE'
  ));

ALTER TABLE public.saas_tenant_external_copy_coverage_decisions
  DROP CONSTRAINT IF EXISTS chk_saas_external_copy_coverage_unclassified_disposition;
ALTER TABLE public.saas_tenant_external_copy_coverage_decisions
  ADD CONSTRAINT chk_saas_external_copy_coverage_unclassified_disposition CHECK (
    store_kind <> 'UNCLASSIFIED_EXTERNAL_STORE'
    OR disposition IN ('NOT_APPLICABLE','UNRESOLVED')
  );

INSERT INTO schema_migrations(version,checksum)
VALUES ('232_saas_external_copy_coverage_unclassified_store_guard',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
