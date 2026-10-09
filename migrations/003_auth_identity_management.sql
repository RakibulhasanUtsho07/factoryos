BEGIN;

INSERT INTO permissions (
    code,
    description
)
VALUES (
    'iam.users.identities.write',
    'Link or manage external authentication identities for tenant users'
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
INNER JOIN permissions p
    ON p.code = 'iam.users.identities.write'
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('003_auth_identity_management')
ON CONFLICT (version) DO NOTHING;

COMMIT;