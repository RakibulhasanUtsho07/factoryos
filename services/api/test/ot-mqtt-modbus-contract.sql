-- MQTT/Modbus permission, role, migration and append-only audit contract.
DO $$
DECLARE action_check text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE code = 'ot.mqtt.ingest') THEN
    RAISE EXCEPTION 'MQTT ingest permission is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE code = 'ot.modbus.read') THEN
    RAISE EXCEPTION 'Modbus read permission is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM role_permissions rp JOIN roles r ON r.id=rp.role_id
      JOIN permissions p ON p.id=rp.permission_id
    WHERE r.code='ORG_ADMIN' AND p.code='ot.mqtt.ingest'
  ) THEN RAISE EXCEPTION 'ORG_ADMIN lacks MQTT ingest permission'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM role_permissions rp JOIN roles r ON r.id=rp.role_id
      JOIN permissions p ON p.id=rp.permission_id
    WHERE r.code='ORG_ADMIN' AND p.code='ot.modbus.read'
  ) THEN RAISE EXCEPTION 'ORG_ADMIN lacks Modbus read permission'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM role_permissions rp JOIN roles r ON r.id=rp.role_id
      JOIN permissions p ON p.id=rp.permission_id
    WHERE r.code='FACTORY_MANAGER' AND p.code='ot.mqtt.ingest'
  ) THEN RAISE EXCEPTION 'FACTORY_MANAGER lacks MQTT ingest permission'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM role_permissions rp JOIN roles r ON r.id=rp.role_id
      JOIN permissions p ON p.id=rp.permission_id
    WHERE r.code='FACTORY_MANAGER' AND p.code='ot.modbus.read'
  ) THEN RAISE EXCEPTION 'FACTORY_MANAGER lacks Modbus read permission'; END IF;

  SELECT pg_get_constraintdef(oid) INTO action_check
  FROM pg_constraint
  WHERE conrelid='public.ot_device_history'::regclass
    AND conname='chk_ot_device_history_action';
  IF action_check IS NULL
    OR position('MODBUS_READ_COMPLETED' IN action_check)=0
    OR position('MODBUS_READ_FAILED' IN action_check)=0 THEN
    RAISE EXCEPTION 'OT history must allow Modbus read success/failure outcomes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='158_ot_mqtt_modbus_gateway') THEN
    RAISE EXCEPTION 'MQTT/Modbus gateway migration registration is missing';
  END IF;
END;
$$;
