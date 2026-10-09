-- CI-only fixture. This runs only against an ephemeral GitHub Actions PostgreSQL service.
-- It provides an active factory alongside the demo tenant/user created by seed-dev-iam.sql.
BEGIN;

INSERT INTO factories (
  tenant_id,
  code,
  name,
  status
)
SELECT
  t.id,
  'CI-FACTORY',
  'FactoryOS CI Factory',
  'ACTIVE'
FROM tenants t
WHERE t.slug = 'factoryos-demo'
ON CONFLICT (tenant_id, code)
DO UPDATE SET
  name = EXCLUDED.name,
  status = 'ACTIVE';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM tenants t
    INNER JOIN factories f ON f.tenant_id = t.id
    INNER JOIN tenant_memberships tm ON tm.tenant_id = t.id
    INNER JOIN users u ON u.id = tm.user_id
    WHERE t.slug = 'factoryos-demo'
      AND t.status = 'ACTIVE'
      AND f.code = 'CI-FACTORY'
      AND f.status = 'ACTIVE'
      AND tm.status = 'ACTIVE'
      AND u.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'CI PostgreSQL fixture requires an active demo tenant, user membership and factory';
  END IF;
END;
$$;

COMMIT;
