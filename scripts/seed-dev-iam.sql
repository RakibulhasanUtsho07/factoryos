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
  ),
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
  ),
  (
    'research.read',
    'Read approved research sources, claims, releases and topic watchlists'
  ),
  (
    'research.write',
    'Register and maintain research sources, claims, topic watchlists and release drafts'
  ),
  (
    'research.review',
    'Review research rights, claims, watchlists and knowledge release promotions'
  ),
  (
    'growth.read',
    'Read growth opportunities, scenarios, experiments and realized outcomes'
  ),
  (
    'growth.write',
    'Create and manage growth hypotheses, scenarios, experiments and validation unknowns'
  ),
  (
    'growth.review',
    'Accept or reject growth hypotheses and review validation decisions'
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
    'iam.permissions.read',
    'entitlements.read',
    'entitlements.write',
    'feature_flags.read',
    'feature_flags.write',
    'feature_flags.security_critical.write',
    'research.read',
    'research.write',
    'research.review',
    'growth.read',
    'growth.write',
    'growth.review',
    'mrp.read',
    'mrp.write',
    'production.workorders.read',
    'production.workorders.write',
    'production.workorders.release',
    'production.operations.operate',
    'production.output.report',
    'maintenance.assets.read',
    'maintenance.assets.manage',
    'maintenance.pm.read',
    'maintenance.pm.manage',
    'maintenance.workorders.read',
    'maintenance.workorders.manage',
    'maintenance.workorders.execute',
    'maintenance.parts.manage',
    'workforce.workers.read',
    'workforce.workers.manage',
    'workforce.skills.read',
    'workforce.skills.manage',
    'workforce.shifts.read',
    'workforce.shifts.manage',
    'workforce.staffing.read',
    'workforce.staffing.manage',
    'workforce.attendance.read',
    'workforce.attendance.capture',
    'workforce.attendance.correct',
    'workforce.overtime.read',
    'workforce.overtime.request',
    'workforce.overtime.approve',
    'workforce.productivity.read',
    'workforce.productivity.capture',
    'workforce.self.read',
    'utilities.meters.read',
    'utilities.meters.manage',
    'utilities.readings.read',
    'utilities.readings.capture',
    'utilities.events.read',
    'utilities.events.manage',
    'ehs.permits.read',
    'ehs.permits.manage',
    'ehs.permits.approve',
    'ehs.permits.execute',
    'ehs.incidents.read',
    'ehs.incidents.report',
    'ehs.incidents.manage',
    'ehs.corrective_actions.verify',
    'ot.devices.read',
    'ot.devices.write',
    'ot.devices.approve',
    'ot.telemetry.ingest',
    'ot.telemetry.read',
    'ot.opcua.read'
  );

COMMIT;