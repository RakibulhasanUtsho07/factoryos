BEGIN;

-- Every tenant receives a least-privilege worker role that can read only the
-- authenticated user's own linked-worker attendance and overtime records.
CREATE OR REPLACE FUNCTION factoryos_seed_workforce_worker_role()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_role_id UUID;
BEGIN
  INSERT INTO roles (tenant_id,code,name,description,is_system)
  VALUES (NEW.id,'WORKER','Factory Worker','Least-privilege access to the linked worker own attendance and overtime records',TRUE)
  ON CONFLICT (tenant_id,code) DO NOTHING;

  SELECT id INTO v_role_id FROM roles WHERE tenant_id=NEW.id AND code='WORKER';
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'Could not establish the default worker self-service role for tenant %',NEW.id;
  END IF;

  INSERT INTO role_permissions (role_id,permission_id)
  SELECT v_role_id,p.id FROM permissions p WHERE p.code='workforce.self.read'
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tenants_seed_workforce_worker_role
AFTER INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION factoryos_seed_workforce_worker_role();

-- Backfill tenant records created before this migration was applied.
INSERT INTO roles (tenant_id,code,name,description,is_system)
SELECT t.id,'WORKER','Factory Worker',
       'Least-privilege access to the linked worker own attendance and overtime records',TRUE
FROM tenants t
ON CONFLICT (tenant_id,code) DO NOTHING;

INSERT INTO role_permissions (role_id,permission_id)
SELECT r.id,p.id
FROM roles r
JOIN permissions p ON p.code='workforce.self.read'
WHERE r.code='WORKER'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version,checksum)
VALUES ('105_workforce_self_service_role',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
