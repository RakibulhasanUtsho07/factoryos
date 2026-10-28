BEGIN;

-- Preserve append-only provider evidence while separating the governance outcome
-- from the legacy provider execution status.
ALTER TABLE public.saas_tenant_external_propagation_receipts
  ADD COLUMN IF NOT EXISTS outcome_code varchar(24),
  ADD COLUMN IF NOT EXISTS manifest_kind varchar(24),
  ADD COLUMN IF NOT EXISTS resource_class varchar(32),
  ADD COLUMN IF NOT EXISTS adapter_version varchar(100),
  ADD COLUMN IF NOT EXISTS max_page_size integer,
  ADD COLUMN IF NOT EXISTS max_batch_size integer,
  ADD COLUMN IF NOT EXISTS policy_versions jsonb,
  ADD COLUMN IF NOT EXISTS residual_reason varchar(1000),
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- A migration-only controlled backfill. Restore user triggers immediately after
-- the update; runtime callers still cannot mutate or delete a receipt.
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

-- Classify historical failures using their persisted per-target plan when present.
-- Older versions also wrote pseudo-markers such as "unverified-scope:..." or
-- "residual-count:..." into residual_manifest. Those are not provider resource IDs:
-- preserve the conservative counts/reason, but remove fabricated identifiers.
UPDATE public.saas_tenant_external_propagation_receipts AS receipt
SET manifest_kind = CASE
      WHEN jsonb_typeof(run.external_manifest->'plans'->receipt.target_id) = 'object'
       AND run.external_manifest #>> ARRAY['plans',receipt.target_id,'manifestDigest'] = receipt.manifest_digest
       AND run.external_manifest #>> ARRAY['plans',receipt.target_id,'plannedCopies'] = receipt.planned_copies::text
        THEN 'RESOURCE_IDENTITIES'
      ELSE 'SCOPE_INTENT'
    END,
    residual_manifest = COALESCE((
      SELECT jsonb_agg(item.reference ORDER BY item.ordinality)
      FROM jsonb_array_elements_text(receipt.residual_manifest) WITH ORDINALITY AS item(reference, ordinality)
      WHERE item.reference !~ '^(unverified-scope|residual-count|not-executed|unexecuted-count):'
    ), '[]'::jsonb),
    status = CASE
      WHEN receipt.status = 'RESIDUALS' AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(receipt.residual_manifest) AS item(reference)
        WHERE item.reference !~ '^(unverified-scope|residual-count|not-executed|unexecuted-count):'
      ) THEN 'FAILED'
      ELSE receipt.status
    END,
    failure_code = CASE
      WHEN receipt.status = 'RESIDUALS' AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(receipt.residual_manifest) AS item(reference)
        WHERE item.reference !~ '^(unverified-scope|residual-count|not-executed|unexecuted-count):'
      ) THEN COALESCE(receipt.failure_code, 'LEGACY_RESIDUAL_SCOPE_UNVERIFIED')
      ELSE receipt.failure_code
    END,
    residual_reason = CASE
      WHEN EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(receipt.residual_manifest) AS item(reference)
        WHERE item.reference ~ '^(unverified-scope|residual-count|not-executed|unexecuted-count):'
      ) THEN COALESCE(receipt.residual_reason,
        'Legacy receipt contained a synthetic scope marker rather than provider resource identifiers; independent read-back is required.')
      ELSE receipt.residual_reason
    END
FROM public.saas_tenant_external_propagation_runs AS run
WHERE run.tenant_id = receipt.tenant_id
  AND run.request_id = receipt.request_id
  AND run.run_id = receipt.run_id
  AND receipt.status <> 'VERIFIED';

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
  DROP CONSTRAINT IF EXISTS chk_saas_external_receipt_page_size,
  DROP CONSTRAINT IF EXISTS chk_saas_external_receipt_batch_size,
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
  ADD CONSTRAINT chk_saas_external_receipt_page_size
    CHECK (max_page_size IS NULL OR max_page_size BETWEEN 1 AND 5000),
  ADD CONSTRAINT chk_saas_external_receipt_batch_size
    CHECK (max_batch_size IS NULL OR max_batch_size BETWEEN 1 AND 1000),
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
