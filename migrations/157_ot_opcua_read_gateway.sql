BEGIN;

-- Only the API's read-only adapter calls this permission. Endpoint resolution and
-- credential handling are delegated to the separately trusted OT gateway.
INSERT INTO permissions(code, description)
VALUES ('ot.opcua.read', 'Read allowlisted OPC UA node values through the configured OT gateway')
ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN' AND r.is_system = true AND p.code = 'ot.opcua.read'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'FACTORY_MANAGER' AND r.is_system = false AND p.code = 'ot.opcua.read'
ON CONFLICT (role_id, permission_id) DO NOTHING;

ALTER TABLE ot_device_history DROP CONSTRAINT IF EXISTS chk_ot_device_history_action;
ALTER TABLE ot_device_history ADD CONSTRAINT chk_ot_device_history_action CHECK (action IN (
  'REGISTERED', 'ACTIVATED', 'PAUSED', 'RESUMED', 'REVOKED',
  'TELEMETRY_BATCH_INGESTED', 'OPCUA_READ_COMPLETED', 'OPCUA_READ_FAILED'
));

INSERT INTO schema_migrations(version, checksum)
VALUES ('157_ot_opcua_read_gateway', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
