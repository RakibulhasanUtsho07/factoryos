BEGIN;

-- 1. Create development user
INSERT INTO users (
  external_subject,
  email,
  display_name,
  status
)
SELECT
  'local-dev-user-002',
  'manager@factoryos.local',
  'Factory A Manager',
  'ACTIVE'
WHERE NOT EXISTS (
  SELECT 1
  FROM users
  WHERE email = 'manager@factoryos.local'
);

-- 2. Create active tenant membership
INSERT INTO tenant_memberships (
  tenant_id,
  user_id,
  status
)
SELECT
  'faaab63d-c447-46ce-950d-deebdd7f5f30',
  u.id,
  'ACTIVE'
FROM users u
WHERE u.email = 'manager@factoryos.local'
  AND NOT EXISTS (
    SELECT 1
    FROM tenant_memberships tm
    WHERE tm.tenant_id = 'faaab63d-c447-46ce-950d-deebdd7f5f30'
      AND tm.user_id = u.id
  );

-- 3. Create tenant-level role definition
INSERT INTO roles (
  tenant_id,
  code,
  name,
  description,
  is_system
)
SELECT
  'faaab63d-c447-46ce-950d-deebdd7f5f30',
  'FACTORY_MANAGER',
  'Factory Manager',
  'Factory-scoped manager role for local development',
  false
WHERE NOT EXISTS (
  SELECT 1
  FROM roles
  WHERE tenant_id = 'faaab63d-c447-46ce-950d-deebdd7f5f30'
    AND code = 'FACTORY_MANAGER'
);

-- 4. Attach permission to the role
INSERT INTO role_permissions (
  role_id,
  permission_id
)
SELECT
  r.id,
  p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.tenant_id = 'faaab63d-c447-46ce-950d-deebdd7f5f30'
  AND r.code = 'FACTORY_MANAGER'
  AND p.code = 'iam.access.read'
  AND NOT EXISTS (
    SELECT 1
    FROM role_permissions rp
    WHERE rp.role_id = r.id
      AND rp.permission_id = p.id
  );

-- 5. Assign the role ONLY to Factory A
INSERT INTO user_roles (
  membership_id,
  role_id,
  factory_id
)
SELECT
  tm.id,
  r.id,
  '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7'
FROM tenant_memberships tm
INNER JOIN users u
  ON u.id = tm.user_id
INNER JOIN roles r
  ON r.tenant_id = tm.tenant_id
WHERE u.email = 'manager@factoryos.local'
  AND tm.tenant_id = 'faaab63d-c447-46ce-950d-deebdd7f5f30'
  AND tm.status = 'ACTIVE'
  AND r.code = 'FACTORY_MANAGER'
  AND NOT EXISTS (
    SELECT 1
    FROM user_roles ur
    WHERE ur.membership_id = tm.id
      AND ur.role_id = r.id
      AND ur.factory_id =
        '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7'
  );

COMMIT;
BEGIN;

INSERT INTO users (
  external_subject,
  email,
  display_name,
  status
)
SELECT
  'local-dev-user-002',
  'manager@factoryos.local',
  'Factory A Manager',
  'ACTIVE'
WHERE NOT EXISTS (
  SELECT 1
  FROM users
  WHERE email = 'manager@factoryos.local'
);

INSERT INTO tenant_memberships (
  tenant_id,
  user_id,
  status
)
SELECT
  'faaab63d-c447-46ce-950d-deebdd7f5f30',
  u.id,
  'ACTIVE'
FROM users u
WHERE u.email = 'manager@factoryos.local'
  AND NOT EXISTS (
    SELECT 1
    FROM tenant_memberships tm
    WHERE tm.tenant_id = 'faaab63d-c447-46ce-950d-deebdd7f5f30'
      AND tm.user_id = u.id
  );

INSERT INTO roles (
  tenant_id,
  code,
  name,
  description,
  is_system
)
SELECT
  'faaab63d-c447-46ce-950d-deebdd7f5f30',
  'FACTORY_MANAGER',
  'Factory Manager',
  'Factory scoped manager role',
  false
WHERE NOT EXISTS (
  SELECT 1
  FROM roles
  WHERE tenant_id = 'faaab63d-c447-46ce-950d-deebdd7f5f30'
    AND code = 'FACTORY_MANAGER'
);

INSERT INTO role_permissions (
  role_id,
  permission_id
)
SELECT
  r.id,
  p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.tenant_id = 'faaab63d-c447-46ce-950d-deebdd7f5f30'
  AND r.code = 'FACTORY_MANAGER'
  AND p.code = 'iam.access.read'
  AND NOT EXISTS (
    SELECT 1
    FROM role_permissions rp
    WHERE rp.role_id = r.id
      AND rp.permission_id = p.id
  );

INSERT INTO user_roles (
  membership_id,
  role_id,
  factory_id
)
SELECT
  tm.id,
  r.id,
  f.id
FROM tenant_memberships tm
JOIN users u
  ON u.id = tm.user_id
JOIN roles r
  ON r.tenant_id = tm.tenant_id
 AND r.code = 'FACTORY_MANAGER'
JOIN factories f
  ON f.tenant_id = tm.tenant_id
 AND f.code = 'FAC-A'
WHERE u.email = 'manager@factoryos.local'
  AND tm.status = 'ACTIVE'
  AND NOT EXISTS (
    SELECT 1
    FROM user_roles ur
    WHERE ur.membership_id = tm.id
      AND ur.role_id = r.id
      AND ur.factory_id = f.id
  );

COMMIT;