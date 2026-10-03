BEGIN;

WITH new_tenant AS (
  INSERT INTO tenants (
    slug,
    name,
    status,
    timezone,
    default_locale
  )
  VALUES (
    'factoryos-demo',
    'FactoryOS Demo Organization',
    'ACTIVE',
    'Asia/Dhaka',
    'en-BD'
  )
  RETURNING id
),
new_user AS (
  INSERT INTO users (
    external_subject,
    email,
    display_name,
    status
  )
  VALUES (
    'local-dev-user-001',
    'admin@factoryos.local',
    'FactoryOS Local Admin',
    'ACTIVE'
  )
  RETURNING id
),
new_membership AS (
  INSERT INTO tenant_memberships (
    tenant_id,
    user_id,
    status
  )
  SELECT
    new_tenant.id,
    new_user.id,
    'ACTIVE'
  FROM new_tenant
  CROSS JOIN new_user
  RETURNING id, tenant_id, user_id
),
new_role AS (
  INSERT INTO roles (
    tenant_id,
    code,
    name,
    description,
    is_system
  )
  SELECT
    new_tenant.id,
    'ORG_ADMIN',
    'Organization Administrator',
    'Local development administrator role',
    true
  FROM new_tenant
  RETURNING id, tenant_id
)
INSERT INTO user_roles (
  membership_id,
  role_id,
  factory_id
)
SELECT
  new_membership.id,
  new_role.id,
  NULL
FROM new_membership
CROSS JOIN new_role;

INSERT INTO permissions (
  code,
  description
)
VALUES
  (
    'iam.access.read',
    'Read IAM access information'
  ),
  (
    'iam.users.read',
    'Read user information'
  ),
  (
    'iam.roles.read',
    'Read role information'
  ),
  (
    'iam.permissions.read',
    'Read permission information'
  )
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (
  role_id,
  permission_id
)
SELECT
  r.id,
  p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND p.code IN (
    'iam.access.read',
    'iam.users.read',
    'iam.roles.read',
    'iam.permissions.read'
  );

COMMIT;