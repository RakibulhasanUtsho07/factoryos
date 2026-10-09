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





-- Legacy order/outbox HTTP tests require an active actor membership and
-- permissions; all rows below exist only in the disposable CI database.
INSERT INTO permissions (code, description)
VALUES
  ('orders.read', 'CI test: read orders'),
  ('orders.write', 'CI test: write orders')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('orders.read', 'orders.write')
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO tenant_memberships (tenant_id, user_id, status)
SELECT t.id, u.id, 'ACTIVE'
FROM tenants t
CROSS JOIN users u
WHERE t.slug IN ('factoryos-demo', 'factoryos-ci-legacy')
  AND u.id = '921382b8-e83f-43ab-a576-e3db6a06b70c'
ON CONFLICT (tenant_id, user_id)
DO UPDATE SET status = 'ACTIVE';

INSERT INTO user_roles (membership_id, role_id, factory_id)
SELECT tm.id, r.id, NULL::uuid
FROM tenant_memberships tm
JOIN tenants t ON t.id = tm.tenant_id
JOIN roles r ON r.tenant_id = t.id AND r.code = 'ORG_ADMIN'
JOIN users u ON u.id = tm.user_id
WHERE t.slug = 'factoryos-demo'
  AND u.id = '921382b8-e83f-43ab-a576-e3db6a06b70c'
ON CONFLICT DO NOTHING;

INSERT INTO user_roles (membership_id, role_id, factory_id)
SELECT tm.id, r.id, f.id
FROM tenant_memberships tm
JOIN tenants t ON t.id = tm.tenant_id
JOIN roles r ON r.tenant_id = t.id AND r.code = 'FACTORY_MANAGER'
JOIN factories f ON f.id = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7'
JOIN users u ON u.id = tm.user_id
WHERE t.slug = 'factoryos-ci-legacy'
  AND u.id = '921382b8-e83f-43ab-a576-e3db6a06b70c'
ON CONFLICT DO NOTHING;

-- A canonical base order and published event support the legacy outbox/DLQ
-- suites, which query for existing records rather than creating their own.
INSERT INTO orders (
  id, tenant_id, factory_id, order_number, customer_name, status,
  order_date, currency, created_by_user_id
)
VALUES (
  'a45f0c18-72a7-4b6c-9ed4-ea7a8f2a54d1',
  'faaab63d-c447-46ce-950d-deebdd7f5f30',
  '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
  'CI-OUTBOX-SEED-ORDER',
  'FactoryOS CI Outbox Fixture',
  'IN_PROGRESS',
  CURRENT_DATE,
  'BDT',
  '921382b8-e83f-43ab-a576-e3db6a06b70c'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO outbox_events (
  id, tenant_id, factory_id, aggregate_type, aggregate_id,
  event_type, event_version, payload, status, attempts,
  next_attempt_at, occurred_at, published_at
)
VALUES (
  'b61280d3-6156-4a57-aab2-2b7db269f462',
  'faaab63d-c447-46ce-950d-deebdd7f5f30',
  '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
  'ORDER',
  'a45f0c18-72a7-4b6c-9ed4-ea7a8f2a54d1',
  'ORDER.CREATED',
  1,
  jsonb_build_object(
    'order',
    jsonb_build_object(
      'id', 'a45f0c18-72a7-4b6c-9ed4-ea7a8f2a54d1',
      'tenant_id', 'faaab63d-c447-46ce-950d-deebdd7f5f30',
      'factory_id', '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
      'order_number', 'CI-OUTBOX-SEED-ORDER',
      'status', 'IN_PROGRESS'
    )
  ),
  'PUBLISHED',
  1,
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
