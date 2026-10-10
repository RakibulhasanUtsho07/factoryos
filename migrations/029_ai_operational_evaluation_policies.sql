BEGIN;

-- ============================================================
-- WP07 / Versioned operational evaluation policy registry
-- ============================================================
-- Policy versions are append-only. The most recently created version for a
-- policy_key is effective; older versions remain auditable and reproducible.

INSERT INTO permissions (code, description)
VALUES (
  'ai.evaluation.policies.write',
  'Create versioned operational AI evaluation policies'
)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
  AND p.code = 'ai.evaluation.policies.write'
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_operational_evaluation_policies (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                       UUID NOT NULL,
    factory_id                      UUID NOT NULL,
    policy_key                      VARCHAR(150) NOT NULL,
    policy_version                  VARCHAR(50) NOT NULL,
    domain                          VARCHAR(20) NOT NULL,
    metric_key                      VARCHAR(100) NOT NULL,
    minimum_samples                 INTEGER NOT NULL,
    max_mean_absolute_error         NUMERIC(22, 6),
    max_mean_absolute_percentage_error NUMERIC(21, 6),
    min_within_tolerance_rate        NUMERIC(7, 6),
    max_expected_calibration_error   NUMERIC(7, 6),
    request_hash                    VARCHAR(64) NOT NULL,
    created_by                      UUID NOT NULL,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_ai_eval_policy_factory_scope
      FOREIGN KEY (factory_id, tenant_id)
      REFERENCES factories (id, tenant_id)
      ON DELETE RESTRICT,

    CONSTRAINT fk_ai_eval_policy_actor
      FOREIGN KEY (created_by)
      REFERENCES users (id)
      ON DELETE RESTRICT,

    CONSTRAINT chk_ai_eval_policy_domain
      CHECK (domain IN ('PLANNING', 'QUALITY', 'MAINTENANCE', 'FINANCE', 'ENERGY')),

    CONSTRAINT chk_ai_eval_policy_strings
      CHECK (
        LENGTH(BTRIM(policy_key)) > 0
        AND LENGTH(BTRIM(policy_version)) > 0
        AND LENGTH(BTRIM(metric_key)) > 0
      ),

    CONSTRAINT chk_ai_eval_policy_samples
      CHECK (minimum_samples BETWEEN 1 AND 1000000),

    CONSTRAINT chk_ai_eval_policy_mae
      CHECK (max_mean_absolute_error IS NULL OR max_mean_absolute_error BETWEEN 0 AND 1000000000000000),

    CONSTRAINT chk_ai_eval_policy_mape
      CHECK (max_mean_absolute_percentage_error IS NULL OR max_mean_absolute_percentage_error BETWEEN 0 AND 1000000000),

    CONSTRAINT chk_ai_eval_policy_tolerance_rate
      CHECK (min_within_tolerance_rate IS NULL OR min_within_tolerance_rate BETWEEN 0 AND 1),

    CONSTRAINT chk_ai_eval_policy_calibration_error
      CHECK (max_expected_calibration_error IS NULL OR max_expected_calibration_error BETWEEN 0 AND 1),

    CONSTRAINT chk_ai_eval_policy_threshold_present
      CHECK (
        max_mean_absolute_error IS NOT NULL
        OR max_mean_absolute_percentage_error IS NOT NULL
        OR min_within_tolerance_rate IS NOT NULL
        OR max_expected_calibration_error IS NOT NULL
      ),

    CONSTRAINT chk_ai_eval_policy_request_hash
      CHECK (request_hash ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_eval_policy_version_scope
  ON ai_operational_evaluation_policies (
    tenant_id, factory_id, policy_key, policy_version
  );

CREATE INDEX IF NOT EXISTS idx_ai_eval_policy_latest_scope
  ON ai_operational_evaluation_policies (
    tenant_id, factory_id, policy_key, created_at DESC
  );

ALTER TABLE ai_operational_evaluation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_operational_evaluation_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_operational_evaluation_policy_tenant_isolation
  ON ai_operational_evaluation_policies;
CREATE POLICY ai_operational_evaluation_policy_tenant_isolation
  ON ai_operational_evaluation_policies
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION reject_ai_operational_evaluation_policy_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AI operational evaluation policy versions are append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_operational_evaluation_policy_immutable
  ON ai_operational_evaluation_policies;
CREATE TRIGGER trg_ai_operational_evaluation_policy_immutable
  BEFORE UPDATE OR DELETE ON ai_operational_evaluation_policies
  FOR EACH ROW
  EXECUTE FUNCTION reject_ai_operational_evaluation_policy_mutation();

INSERT INTO schema_migrations (version, checksum)
VALUES ('029_ai_operational_evaluation_policies', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
