BEGIN;

-- ------------------------------------------------------------
-- Admin / Control-plane permissions
-- ------------------------------------------------------------

INSERT INTO permissions (
    code,
    description
)
VALUES
    (
        'entitlements.read',
        'Read tenant entitlement configuration'
    ),
    (
        'entitlements.write',
        'Create new tenant entitlement versions'
    ),
    (
        'feature_flags.read',
        'Read and evaluate tenant feature flags'
    ),
    (
        'feature_flags.write',
        'Create tenant feature flag versions'
    ),
    (
        'feature_flags.security_critical.write',
        'Create security-critical tenant feature flag versions'
    )
ON CONFLICT (code)
DO NOTHING;


-- ------------------------------------------------------------
-- Existing system organization administrators
-- ------------------------------------------------------------
--
-- ORG_ADMIN is the development/control-plane administrator
-- role already used by seed-dev-iam.sql.
--
-- These permissions are granted here so an already-seeded
-- development administrator can immediately exercise the new
-- control-plane API.
--
-- Production policy can later refine this mapping when the
-- policy-service is introduced.
-- ------------------------------------------------------------

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
  AND r.is_system = true
  AND p.code IN (
      'entitlements.read',
      'entitlements.write',
      'feature_flags.read',
      'feature_flags.write',
      'feature_flags.security_critical.write'
  )
ON CONFLICT (
    role_id,
    permission_id
)
DO NOTHING;


-- ------------------------------------------------------------
-- Migration tracking
-- ------------------------------------------------------------

INSERT INTO schema_migrations (
    version,
    checksum
)
VALUES (
    '012_admin_control_plane_permissions',
    NULL
)
ON CONFLICT (version)
DO NOTHING;

COMMIT;