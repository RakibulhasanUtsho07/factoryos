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



-- Two early factories under one tenant keep order-read integration fixtures
-- within a single tenant while still exercising cross-factory isolation.
INSERT INTO factories (
  tenant_id,
  code,
  name,
  status
)
SELECT
  t.id,
  'CI-FACTORY-B',
  'FactoryOS CI Factory B',
  'ACTIVE'
FROM tenants t
WHERE t.slug = 'factoryos-demo'
ON CONFLICT (tenant_id, code)
DO UPDATE SET
  name = EXCLUDED.name,
  status = 'ACTIVE';

-- Legacy order/outbox tests use this fixed actor identity. Keep it isolated
-- to the disposable PostgreSQL test database.
INSERT INTO users (
  id,
  external_subject,
  email,
  display_name,
  status
) VALUES (
  '921382b8-e83f-43ab-a576-e3db6a06b70c',
  'factoryos-ci-legacy-test-user',
  'ci-legacy-test-user@factoryos.local',
  'FactoryOS CI Legacy Test User',
  'ACTIVE'
)
ON CONFLICT (id) DO UPDATE
SET
  external_subject = EXCLUDED.external_subject,
  email = EXCLUDED.email,
  display_name = EXCLUDED.display_name,
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

-- Fixture is deterministic and covered by PostgreSQL integration tests.



COMMIT;
