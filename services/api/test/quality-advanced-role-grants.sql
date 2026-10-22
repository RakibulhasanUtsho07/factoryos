-- Run after migration 164 is replayed following development-role seeding.
BEGIN;

DO $quality_role_grants$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM roles WHERE code='FACTORY_MANAGER') THEN
    RAISE EXCEPTION 'FACTORY_MANAGER role must be seeded before checking advanced quality grants';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    JOIN roles r ON r.id=rp.role_id
    JOIN permissions p ON p.id=rp.permission_id
    WHERE r.code='FACTORY_MANAGER' AND p.code='quality.advanced.read'
  ) OR NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    JOIN roles r ON r.id=rp.role_id
    JOIN permissions p ON p.id=rp.permission_id
    WHERE r.code='FACTORY_MANAGER' AND p.code='quality.advanced.manage'
  ) THEN
    RAISE EXCEPTION 'FACTORY_MANAGER must have the advanced-quality read/manage grant';
  END IF;

  RAISE NOTICE 'Advanced quality read/manage grants for FACTORY_MANAGER passed';
END;
$quality_role_grants$;

ROLLBACK;
