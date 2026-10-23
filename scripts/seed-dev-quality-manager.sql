-- Seed a dedicated factory-scoped quality manager for development and PostgreSQL CI.
BEGIN;

INSERT INTO users (external_subject,email,display_name,status)
SELECT 'local-dev-quality-manager-001','quality.manager@factoryos.local','Factory A Quality Manager','ACTIVE'
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE email='quality.manager@factoryos.local'
);

INSERT INTO tenant_memberships (tenant_id,user_id,status)
SELECT 'faaab63d-c447-46ce-950d-deebdd7f5f30'::uuid,u.id,'ACTIVE'
FROM users u
WHERE u.email='quality.manager@factoryos.local'
  AND NOT EXISTS (
    SELECT 1 FROM tenant_memberships tm
    WHERE tm.tenant_id='faaab63d-c447-46ce-950d-deebdd7f5f30'::uuid
      AND tm.user_id=u.id
  );

INSERT INTO roles (tenant_id,code,name,description,is_system)
SELECT 'faaab63d-c447-46ce-950d-deebdd7f5f30'::uuid,'QUALITY_MANAGER',
  'Quality Manager','Factory-scoped quality inspection, disposition, rework and advanced sampling role',false
WHERE NOT EXISTS (
  SELECT 1 FROM roles
  WHERE tenant_id='faaab63d-c447-46ce-950d-deebdd7f5f30'::uuid AND code='QUALITY_MANAGER'
);

-- The quality manager receives only the quality-domain permissions needed for their workflow.
INSERT INTO role_permissions (role_id,permission_id)
SELECT r.id,p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.tenant_id='faaab63d-c447-46ce-950d-deebdd7f5f30'::uuid
  AND r.code='QUALITY_MANAGER'
  AND p.code IN (
    'quality.inspections.read','quality.inspections.write','quality.defects.write',
    'quality.disposition.decide','quality.ncr.manage','quality.plans.manage',
    'quality.capa.verify','quality.rework.manage','quality.defects.trace',
    'quality.advanced.read','quality.advanced.manage'
  )
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id=r.id AND rp.permission_id=p.id
  );

INSERT INTO user_roles (membership_id,role_id,factory_id)
SELECT tm.id,r.id,'24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7'::uuid
FROM tenant_memberships tm
JOIN users u ON u.id=tm.user_id
JOIN roles r ON r.tenant_id=tm.tenant_id AND r.code='QUALITY_MANAGER'
JOIN factories f ON f.id='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7'::uuid
  AND f.tenant_id=tm.tenant_id
WHERE u.email='quality.manager@factoryos.local'
  AND tm.tenant_id='faaab63d-c447-46ce-950d-deebdd7f5f30'::uuid
  AND tm.status='ACTIVE'
  AND NOT EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.membership_id=tm.id AND ur.role_id=r.id AND ur.factory_id=f.id
  );

COMMIT;
