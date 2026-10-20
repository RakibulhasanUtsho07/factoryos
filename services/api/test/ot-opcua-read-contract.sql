-- OPC UA read integration contract. Runs after the ordered PostgreSQL migration manifest.
DO $$
DECLARE
  action_check text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE code = 'ot.opcua.read') THEN
    RAISE EXCEPTION 'OPC UA read permission is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE r.code = 'ORG_ADMIN' AND p.code = 'ot.opcua.read'
  ) THEN
    RAISE EXCEPTION 'ORG_ADMIN must have the reviewed OPC UA read permission';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE r.code = 'FACTORY_MANAGER' AND p.code = 'ot.opcua.read'
  ) THEN
    RAISE EXCEPTION 'FACTORY_MANAGER must have the reviewed OPC UA read permission';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO action_check
  FROM pg_constraint
  WHERE conrelid = 'public.ot_device_history'::regclass
    AND conname = 'chk_ot_device_history_action';
  IF action_check IS NULL
     OR position('OPCUA_READ_COMPLETED' IN action_check) = 0
     OR position('OPCUA_READ_FAILED' IN action_check) = 0 THEN
    RAISE EXCEPTION 'OT device history must allow OPC UA read audit outcomes';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '157_ot_opcua_read_gateway') THEN
    RAISE EXCEPTION 'OPC UA read gateway migration registration is missing';
  END IF;
END;
$$;
