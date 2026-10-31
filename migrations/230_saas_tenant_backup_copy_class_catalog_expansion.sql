BEGIN;

-- Expand the canonical class gate to include secondary/external copy planes
-- documented by the external-copy inventory. Unknown copies have a fail-closed
-- catch-all entry; they are not backed by an erasure adapter.
ALTER TABLE public.saas_tenant_backup_copy_class_coverage_decisions
  DROP CONSTRAINT IF EXISTS chk_saas_backup_copy_class_code;

ALTER TABLE public.saas_tenant_backup_copy_class_coverage_decisions
  ADD CONSTRAINT chk_saas_backup_copy_class_code CHECK (copy_class_code IN (
    'S3_OBJECT_VERSIONS',
    'POSTGRESQL_BASE_BACKUP',
    'POSTGRESQL_WAL_PITR',
    'REDIS_AOF_BACKUP',
    'REDIS_RDB_BACKUP',
    'FILESYSTEM_SNAPSHOT',
    'BLOCK_VOLUME_SNAPSHOT',
    'MANAGED_BACKUP_VAULT',
    'REPLICA_FAILOVER_COPY',
    'EXTERNAL_DR_COPY',
    'SEARCH_INDEX_COPY',
    'VECTOR_STORE_COPY',
    'LEARNING_ARTIFACT_COPY',
    'EXTERNAL_PROVIDER_COPY',
    'EXTERNAL_CACHE_COPY',
    'UNCLASSIFIED_EXTERNAL_COPY'
  ));

INSERT INTO schema_migrations(version,checksum)
VALUES ('230_saas_tenant_backup_copy_class_catalog_expansion',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
