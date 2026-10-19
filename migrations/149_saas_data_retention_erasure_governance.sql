BEGIN;

-- Govern tenant data retention/erasure as audited, versioned control-plane records.
-- This migration does not execute destructive purges: a category-to-storage deletion
-- adapter and approved regulatory schedule must be supplied and verified separately.

INSERT INTO permissions(code, description) VALUES
  ('saas.data_retention.read', 'Read tenant retention policies, legal holds and erasure requests'),
  ('saas.data_retention.write', 'Version tenant retention policies and request legal holds or erasure'),
  ('saas.data_retention.approve', 'Release legal holds and review tenant erasure requests')
ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM roles r CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN' AND r.is_system = true
  AND p.code IN ('saas.data_retention.read', 'saas.data_retention.write', 'saas.data_retention.approve')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE saas_tenant_data_retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  category_code varchar(40) NOT NULL,
  version bigint NOT NULL,
  retention_days integer NOT NULL,
  disposition varchar(16) NOT NULL,
  legal_basis varchar(200) NOT NULL,
  reason varchar(1000) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_saas_retention_policy_version UNIQUE (tenant_id, category_code, version),
  CONSTRAINT uq_saas_retention_policy_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT chk_saas_retention_category CHECK (category_code IN (
    'BUSINESS_DATA', 'AUDIT_LOG', 'EVIDENCE', 'APPROVALS',
    'EFFECTIVE_DATED_MASTER_DATA', 'AI_CONTEXT', 'LEARNING_EVALUATION',
    'INTEGRATION_METADATA', 'FILE_REFERENCES', 'IAM_ACCESS'
  )),
  CONSTRAINT chk_saas_retention_version CHECK (version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_saas_retention_days CHECK (retention_days BETWEEN 1 AND 36500),
  CONSTRAINT chk_saas_retention_disposition CHECK (disposition IN ('DELETE', 'ANONYMIZE', 'REVIEW')),
  CONSTRAINT chk_saas_retention_legal_basis CHECK (length(btrim(legal_basis)) BETWEEN 3 AND 200),
  CONSTRAINT chk_saas_retention_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_retention_idempotency CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_retention_hash CHECK (request_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX idx_saas_retention_policy_latest
  ON saas_tenant_data_retention_policies (tenant_id, category_code, version DESC);

CREATE FUNCTION factoryos_guard_saas_retention_policy_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE prior_version bigint;
BEGIN
  SELECT max(version) INTO prior_version
  FROM public.saas_tenant_data_retention_policies
  WHERE tenant_id = NEW.tenant_id AND category_code = NEW.category_code;
  IF prior_version IS NULL AND NEW.version <> 1 THEN
    RAISE EXCEPTION 'first retention policy version must be 1';
  END IF;
  IF prior_version IS NOT NULL AND NEW.version <> prior_version + 1 THEN
    RAISE EXCEPTION 'retention policy versions must be contiguous';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER saas_retention_policy_version_guard
  BEFORE INSERT ON saas_tenant_data_retention_policies
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_retention_policy_version();
CREATE TRIGGER saas_retention_policy_immutable
  BEFORE UPDATE OR DELETE ON saas_tenant_data_retention_policies
  FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

CREATE TABLE saas_tenant_data_legal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  categories jsonb NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'ACTIVE',
  case_reference varchar(200) NOT NULL,
  reason varchar(1000) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  released_at timestamptz,
  release_reason varchar(1000),
  row_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_saas_tenant_data_legal_hold_id_scope UNIQUE (id, tenant_id),
  CONSTRAINT uq_saas_tenant_data_legal_hold_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT chk_saas_legal_hold_categories CHECK (
    jsonb_typeof(categories) = 'array' AND jsonb_array_length(categories) BETWEEN 1 AND 10
      AND octet_length(categories::text) <= 4096
  ),
  CONSTRAINT chk_saas_legal_hold_status CHECK (status IN ('ACTIVE', 'RELEASED')),
  CONSTRAINT chk_saas_legal_hold_case_reference CHECK (case_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  CONSTRAINT chk_saas_legal_hold_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_legal_hold_idempotency CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_legal_hold_hash CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_legal_hold_version CHECK (row_version >= 1),
  CONSTRAINT chk_saas_legal_hold_lifecycle CHECK (
    (status = 'ACTIVE' AND released_by_user_id IS NULL AND released_at IS NULL AND release_reason IS NULL)
    OR
    (status = 'RELEASED' AND released_by_user_id IS NOT NULL AND released_at IS NOT NULL
      AND released_by_user_id <> created_by_user_id AND length(btrim(release_reason)) BETWEEN 3 AND 1000)
  )
);
CREATE INDEX idx_saas_data_legal_holds_active
  ON saas_tenant_data_legal_holds (tenant_id, status, created_at DESC);

CREATE FUNCTION factoryos_guard_saas_tenant_data_legal_hold()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'legal hold evidence is retained; release a hold instead of deleting it'
      USING ERRCODE = '55000';
  END IF;
  IF (NEW.tenant_id, NEW.categories, NEW.case_reference, NEW.reason, NEW.idempotency_key,
      NEW.request_hash, NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.categories, OLD.case_reference, OLD.reason, OLD.idempotency_key,
      OLD.request_hash, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'legal hold scope and creation evidence are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'RELEASED' OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'only an ACTIVE legal hold can be released with the next row version'
      USING ERRCODE = '40001';
  END IF;
  IF NEW.released_by_user_id IS NULL OR NEW.released_by_user_id = OLD.created_by_user_id
     OR NEW.released_at IS NULL OR length(btrim(NEW.release_reason)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'legal hold release requires a distinct reviewer and a recorded reason'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER saas_tenant_data_legal_hold_guard
  BEFORE UPDATE OR DELETE ON saas_tenant_data_legal_holds
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_tenant_data_legal_hold();

CREATE TABLE saas_tenant_data_erasure_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  status varchar(12) NOT NULL DEFAULT 'REQUESTED',
  categories jsonb NOT NULL,
  export_transfer_id uuid NOT NULL,
  export_transfer_version bigint NOT NULL,
  export_bundle_digest varchar(64) NOT NULL,
  reason varchar(1000) NOT NULL,
  requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_reason varchar(1000),
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_saas_tenant_data_erasure_version UNIQUE (tenant_id, request_id, version),
  CONSTRAINT uq_saas_tenant_data_erasure_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_saas_tenant_erasure_export
    FOREIGN KEY (tenant_id, export_transfer_id, export_transfer_version)
    REFERENCES saas_tenant_data_transfers (tenant_id, transfer_id, version) ON DELETE RESTRICT,
  CONSTRAINT chk_saas_tenant_erasure_version CHECK (version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_saas_tenant_erasure_status CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED')),
  CONSTRAINT chk_saas_tenant_erasure_categories CHECK (
    jsonb_typeof(categories) = 'array' AND jsonb_array_length(categories) BETWEEN 1 AND 10
      AND octet_length(categories::text) <= 4096
  ),
  CONSTRAINT chk_saas_tenant_erasure_export_digest CHECK (export_bundle_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_tenant_erasure_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_saas_tenant_erasure_idempotency CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_tenant_erasure_hash CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_saas_tenant_erasure_row_version CHECK (row_version >= 1),
  CONSTRAINT chk_saas_tenant_erasure_review CHECK (
    (status = 'REQUESTED' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND review_reason IS NULL)
    OR
    (status IN ('APPROVED', 'REJECTED') AND reviewed_by_user_id IS NOT NULL
      AND reviewed_by_user_id <> requested_by_user_id AND reviewed_at IS NOT NULL
      AND length(btrim(review_reason)) BETWEEN 3 AND 1000)
  )
);
CREATE INDEX idx_saas_tenant_erasure_queue
  ON saas_tenant_data_erasure_requests (tenant_id, status, created_at DESC);

CREATE FUNCTION factoryos_guard_saas_tenant_data_erasure_request()
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
      AND t.preservation_verified = true
      AND t.source_bundle_digest = NEW.export_bundle_digest;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'erasure request requires a completed and preservation-verified export for the same tenant'
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
CREATE TRIGGER saas_tenant_data_erasure_request_guard
  BEFORE INSERT OR UPDATE OR DELETE ON saas_tenant_data_erasure_requests
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_tenant_data_erasure_request();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'saas_tenant_data_retention_policies',
    'saas_tenant_data_legal_holds',
    'saas_tenant_data_erasure_requests'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I USING (tenant_id = factoryos_current_tenant_id()) WITH CHECK (tenant_id = factoryos_current_tenant_id())',
      table_name || '_tenant_isolation', table_name);
  END LOOP;
END;
$$;

INSERT INTO schema_migrations(version, checksum)
VALUES ('149_saas_data_retention_erasure_governance', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
