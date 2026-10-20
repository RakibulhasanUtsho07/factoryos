BEGIN;

-- Independent, append-only, tenant-scoped evidence is required before an export
-- can be used as the preservation prerequisite of a tenant erasure request.
CREATE TABLE saas_tenant_data_export_preservation_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  transfer_id uuid NOT NULL,
  transfer_version bigint NOT NULL,
  bundle_digest varchar(64) NOT NULL,
  verification_method varchar(32) NOT NULL,
  verification_reference varchar(200) NOT NULL,
  reason varchar(1000) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  verified_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_saas_export_preservation_per_version UNIQUE (tenant_id, transfer_id, transfer_version),
  CONSTRAINT uq_saas_export_preservation_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_saas_export_preservation_transfer
    FOREIGN KEY (tenant_id, transfer_id, transfer_version)
    REFERENCES saas_tenant_data_transfers (tenant_id, transfer_id, version) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_export_preservation_version CHECK (transfer_version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_saas_export_preservation_digest CHECK (bundle_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_export_preservation_method CHECK (
    verification_method IN ('READ_BACK_HASH', 'SIGNATURE_VALIDATION', 'DUAL_CONTROL_REVIEW')
  ),
  CONSTRAINT chk_saas_export_preservation_reference CHECK (
    verification_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
  ),
  CONSTRAINT chk_saas_export_preservation_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_export_preservation_idempotency CHECK (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT chk_saas_export_preservation_hash CHECK (request_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX idx_saas_export_preservation_lookup
  ON saas_tenant_data_export_preservation_attestations
     (tenant_id, transfer_id, transfer_version, verified_at DESC);

CREATE FUNCTION factoryos_guard_saas_export_preservation_attestation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_transfer public.saas_tenant_data_transfers%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'export preservation evidence is append-only'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO source_transfer
  FROM public.saas_tenant_data_transfers t
  WHERE t.tenant_id = NEW.tenant_id
    AND t.transfer_id = NEW.transfer_id
    AND t.version = NEW.transfer_version
    AND t.operation_type = 'EXPORT'
    AND t.status = 'COMPLETED'
    AND t.source_bundle_digest = NEW.bundle_digest;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'preservation attestation must bind to the completed export version and digest'
      USING ERRCODE = '55000';
  END IF;
  IF source_transfer.actor_user_id = NEW.verified_by_user_id THEN
    RAISE EXCEPTION 'export creator/attester cannot verify preservation of the same export'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER saas_export_preservation_attestation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_data_export_preservation_attestations
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_export_preservation_attestation();

ALTER TABLE saas_tenant_data_export_preservation_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_tenant_data_export_preservation_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY saas_tenant_data_export_preservation_attestations_tenant_isolation
  ON saas_tenant_data_export_preservation_attestations
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_saas_tenant_data_erasure_request()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_transfer public.saas_tenant_data_transfers%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tenant erasure request evidence is retained'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'REQUESTED' OR NEW.version <> 1 OR NEW.row_version <> 1
       OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.review_reason IS NOT NULL THEN
      RAISE EXCEPTION 'erasure requests must start in REQUESTED with version 1'
        USING ERRCODE = '55000';
    END IF;
    SELECT * INTO source_transfer
    FROM public.saas_tenant_data_transfers t
    WHERE t.tenant_id = NEW.tenant_id
      AND t.transfer_id = NEW.export_transfer_id
      AND t.version = NEW.export_transfer_version
      AND t.operation_type = 'EXPORT'
      AND t.status = 'COMPLETED'
      AND t.source_bundle_digest = NEW.export_bundle_digest;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'erasure request requires a completed export for the same tenant with the matching digest'
        USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.saas_tenant_data_export_preservation_attestations a
      WHERE a.tenant_id = NEW.tenant_id
        AND a.transfer_id = NEW.export_transfer_id
        AND a.transfer_version = NEW.export_transfer_version
        AND a.bundle_digest = NEW.export_bundle_digest
        AND a.verified_by_user_id <> source_transfer.actor_user_id
    ) THEN
      RAISE EXCEPTION 'erasure request requires an independent preservation attestation'
        USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(source_transfer.required_categories) exported(category)
        WHERE exported.category = requested.category
      )
    ) THEN
      RAISE EXCEPTION 'requested erasure categories must be included in the preserved export'
        USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.saas_tenant_data_legal_holds h
      CROSS JOIN LATERAL jsonb_array_elements_text(h.categories) held(category)
      CROSS JOIN LATERAL jsonb_array_elements_text(NEW.categories) requested(category)
      WHERE h.tenant_id = NEW.tenant_id AND h.status = 'ACTIVE'
        AND held.category = requested.category
    ) THEN
      RAISE EXCEPTION 'active legal hold blocks erasure for one or more requested categories'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.tenant_id, NEW.request_id, NEW.version, NEW.categories, NEW.export_transfer_id,
      NEW.export_transfer_version, NEW.export_bundle_digest, NEW.reason,
      NEW.requested_by_user_id, NEW.idempotency_key, NEW.request_hash, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.request_id, OLD.version, OLD.categories, OLD.export_transfer_id,
      OLD.export_transfer_version, OLD.export_bundle_digest, OLD.reason,
      OLD.requested_by_user_id, OLD.idempotency_key, OLD.request_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'erasure request definition is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'REQUESTED' OR NEW.status NOT IN ('APPROVED', 'REJECTED')
     OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'only a REQUESTED erasure may be reviewed once using the next row version'
      USING ERRCODE = '40001';
  END IF;
  IF NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id = OLD.requested_by_user_id
     OR NEW.reviewed_at IS NULL OR length(btrim(NEW.review_reason)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'erasure review requires a distinct reviewer and a reason'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'APPROVED' AND EXISTS (
    SELECT 1
    FROM public.saas_tenant_data_legal_holds h
    CROSS JOIN LATERAL jsonb_array_elements_text(h.categories) held(category)
    CROSS JOIN LATERAL jsonb_array_elements_text(OLD.categories) requested(category)
    WHERE h.tenant_id = OLD.tenant_id AND h.status = 'ACTIVE'
      AND held.category = requested.category
  ) THEN
    RAISE EXCEPTION 'active legal hold blocks approval for one or more erasure categories'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

INSERT INTO schema_migrations(version, checksum)
VALUES ('150_saas_export_preservation_attestation', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
