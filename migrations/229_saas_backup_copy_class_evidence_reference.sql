BEGIN;

-- Evidence references are opaque, single-component artifact IDs. The API reads
-- the bytes from a deployment-owned read-only evidence root; a URL or path must
-- never be interpreted as a network destination or filesystem path.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.saas_tenant_backup_copy_class_coverage_decisions
    WHERE evidence_reference !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
  ) THEN
    RAISE EXCEPTION 'Existing backup copy-class evidence references must be migrated to opaque single-component artifact IDs before enabling source read-back';
  END IF;
END $$;

ALTER TABLE public.saas_tenant_backup_copy_class_coverage_decisions
  DROP CONSTRAINT IF EXISTS chk_saas_backup_copy_class_references;
ALTER TABLE public.saas_tenant_backup_copy_class_coverage_decisions
  ADD CONSTRAINT chk_saas_backup_copy_class_references CHECK (
    evidence_reference ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
    AND data_owner_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND infrastructure_owner_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND policy_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND attestation_owner_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND data_owner_reference !~ '://'
    AND infrastructure_owner_reference !~ '://'
    AND policy_reference !~ '://'
    AND attestation_owner_reference !~ '://'
    AND (evidence_reference || data_owner_reference || infrastructure_owner_reference || policy_reference || attestation_owner_reference)
      !~* '(secret|password|credential|access[-_]?key|token)'
  );

COMMENT ON COLUMN public.saas_tenant_backup_copy_class_coverage_decisions.evidence_reference IS
  'Opaque single-component artifact ID under FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR; never a URL or caller-controlled path. The API reads bytes and verifies evidence_sha256 before submission, review, and propagation.';

INSERT INTO schema_migrations(version,checksum)
VALUES ('229_saas_backup_copy_class_evidence_reference',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
