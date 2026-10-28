BEGIN;

-- The legacy receipt status describes provider execution mechanics, not the
-- governance disposition. Add explicit outcomes without changing historical
-- receipt identity or weakening append-only controls.
ALTER TABLE public.saas_tenant_external_propagation_receipts
  ADD COLUMN IF NOT EXISTS outcome_code varchar(24),
  ADD COLUMN IF NOT EXISTS manifest_kind varchar(24),
  ADD COLUMN IF NOT EXISTS resource_class varchar(32),
  ADD COLUMN IF NOT EXISTS adapter_version varchar(100),
  ADD COLUMN IF NOT EXISTS policy_versions jsonb,
  ADD COLUMN IF NOT EXISTS residual_reason varchar(1000),
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- This is a controlled schema migration backfill. Runtime mutations remain
-- rejected by the append-only receipt trigger after it is re-enabled.
ALTER TABLE public.saas_tenant_external_propagation_receipts DISABLE TRIGGER USER;
UPDATE public.saas_tenant_external_propagation_receipts
SET outcome_code = CASE WHEN status = 'VERIFIED' THEN 'COMPLETED' ELSE 'FAILED_RETRYABLE' END,
    manifest_kind = CASE WHEN status = 'VERIFIED' THEN 'RESOURCE_IDENTITIES' ELSE 'SCOPE_INTENT' END,
    resource_class = store_kind,
    policy_versions = '{}'::jsonb,
    completed_at = COALESCE(completed_at, created_at, clock_timestamp())
WHERE outcome_code IS NULL
   OR manifest_kind IS NULL
   OR resource_class IS NULL
   OR policy_versions IS NULL
   OR completed_at IS NULL;
ALTER TABLE public.saas_tenant_external_propagation_receipts ENABLE TRIGGER USER;

ALTER TABLE public.saas_tenant_external_propagation_receipts
  ALTER COLUMN outcome_code SET DEFAULT 'FAILED_RETRYABLE',
  ALTER COLUMN outcome_code SET NOT NULL,
  ALTER COLUMN manifest_kind SET DEFAULT 'SCOPE_INTENT',
  ALTER COLUMN manifest_kind SET NOT NULL,
  ALTER COLUMN resource_class SET NOT NULL,
  ALTER COLUMN policy_versions SET DEFAULT '{}'::jsonb,
  ALTER COLUMN policy_versions SET NOT NULL,
  ALTER COLUMN completed_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN completed_at SET NOT NULL;

ALTER TABLE public.saas_tenant_external_propagation_receipts
  DROP CONSTRAINT IF EXISTS chk_saas_external_receipt_outcome_code,
  DROP CONSTRAINT IF EXISTS chk_saas_external_receipt_manifest_kind,
  DROP CONSTRAINT IF EXISTS chk_saas_external_receipt_adapter_version,
  DROP CONSTRAINT IF EXISTS chk_saas_external_receipt_policy_versions,
  DROP CONSTRAINT IF EXISTS chk_saas_external_receipt_residual_reason,
  DROP CONSTRAINT IF EXISTS chk_saas_external_receipt_outcome_consistency;

ALTER TABLE public.saas_tenant_external_propagation_receipts
  ADD CONSTRAINT chk_saas_external_receipt_outcome_code
    CHECK (outcome_code IN ('COMPLETED','BLOCKED','RETAINED','FAILED_RETRYABLE')),
  ADD CONSTRAINT chk_saas_external_receipt_manifest_kind
    CHECK (manifest_kind IN ('RESOURCE_IDENTITIES','SCOPE_INTENT')),
  ADD CONSTRAINT chk_saas_external_receipt_adapter_version
    CHECK (adapter_version IS NULL OR adapter_version ~ '^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$'),
  ADD CONSTRAINT chk_saas_external_receipt_policy_versions
    CHECK (jsonb_typeof(policy_versions) = 'object' AND octet_length(policy_versions::text) <= 16384),
  ADD CONSTRAINT chk_saas_external_receipt_residual_reason
    CHECK (residual_reason IS NULL OR length(btrim(residual_reason)) BETWEEN 3 AND 1000),
  ADD CONSTRAINT chk_saas_external_receipt_outcome_consistency
    CHECK (
      (outcome_code = 'COMPLETED'
        AND status = 'VERIFIED'
        AND manifest_kind = 'RESOURCE_IDENTITIES'
        AND verified_manifest_digest = manifest_digest
        AND residual_copies = 0
        AND deleted_copies = planned_copies
        AND residual_reason IS NULL)
      OR
      (outcome_code = 'BLOCKED'
        AND status = 'FAILED'
        AND manifest_kind = 'SCOPE_INTENT'
        AND residual_reason IS NOT NULL)
      OR
      (outcome_code = 'RETAINED'
        AND status = 'FAILED'
        AND residual_reason IS NOT NULL)
      OR
      (outcome_code = 'FAILED_RETRYABLE'
        AND status IN ('FAILED','RESIDUALS'))
    );

CREATE INDEX IF NOT EXISTS idx_saas_external_receipt_outcome
  ON public.saas_tenant_external_propagation_receipts(tenant_id, request_id, outcome_code, created_at DESC);

INSERT INTO schema_migrations(version, checksum)
VALUES ('218_saas_external_erasure_outcome_receipts', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
