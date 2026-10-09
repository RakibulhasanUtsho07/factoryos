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


-- Legacy integration suites use this isolated fixed tenant/factory fixture.
-- These identifiers exist only inside the disposable CI database.
INSERT INTO tenants (
  id, slug, name, status, timezone, default_locale
) VALUES (
  'faaab63d-c447-46ce-950d-deebdd7f5f30',
  'factoryos-ci-legacy',
  'FactoryOS CI Legacy Tenant',
  'ACTIVE',
  'Asia/Dhaka',
  'en-BD'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO factories (
  id, tenant_id, code, name, status, timezone
) VALUES (
  '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
  'faaab63d-c447-46ce-950d-deebdd7f5f30',
  'FAC-A',
  'FactoryOS CI Factory A',
  'ACTIVE',
  'Asia/Dhaka'
)
ON CONFLICT (id) DO NOTHING;

DO $
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
