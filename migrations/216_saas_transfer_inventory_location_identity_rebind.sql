BEGIN;

-- Only a separately configured transfer-import database identity may rebind
-- the factory-generated default-location UUID. A session-level custom GUC alone
-- is not authority: the trigger also checks the login role's membership.
DO $transfer_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'factoryos_transfer_importer') THEN
    CREATE ROLE factoryos_transfer_importer NOLOGIN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'factoryos') THEN
    GRANT factoryos_transfer_importer TO factoryos;
  END IF;
END
$transfer_role$;

-- A target factory insert creates its required UNASSIGNED virtual location.
-- During an approved exact-schema transfer, the importer must rebind that
-- generated row to the source location's stable ID so movement/location FKs and
-- source/target manifests remain identical. The transaction-local flag is set
-- only around the transfer import's inventory_locations reconciliation.
CREATE OR REPLACE FUNCTION public.factoryos_validate_inventory_location_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_parent_type VARCHAR(20);
  v_parent_status VARCHAR(20);
  v_transfer_rebind boolean;
BEGIN
  v_transfer_rebind :=
    COALESCE(current_setting('app.saas_tenant_transfer_import', TRUE), '') = 'on';

  IF TG_OP = 'DELETE' THEN
    IF OLD.is_default THEN
      RAISE EXCEPTION 'default inventory location cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.is_default THEN
    IF TG_OP = 'UPDATE' AND (
      NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
      OR NEW.location_code IS DISTINCT FROM OLD.location_code
      OR NEW.location_type IS DISTINCT FROM OLD.location_type
      OR NEW.is_default IS DISTINCT FROM OLD.is_default
      OR NEW.parent_location_id IS DISTINCT FROM OLD.parent_location_id
    ) THEN
      -- A transfer may replace only the generated identity; scope and the
      -- canonical default-location key remain immutable even in this path.
      IF NOT v_transfer_rebind
        OR NOT pg_catalog.pg_has_role(session_user, 'factoryos_transfer_importer', 'member')
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
        OR NEW.location_code IS DISTINCT FROM OLD.location_code
        OR NEW.location_type IS DISTINCT FROM OLD.location_type
        OR NEW.is_default IS DISTINCT FROM OLD.is_default
        OR NEW.parent_location_id IS DISTINCT FROM OLD.parent_location_id THEN
        RAISE EXCEPTION 'default inventory location identity is immutable outside the governed tenant-transfer rebind'
          USING ERRCODE = '55000';
      END IF;
    END IF;
    IF NEW.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'default inventory location cannot be disabled'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.location_type = 'BIN' AND NEW.parent_location_id IS NULL THEN
    RAISE EXCEPTION 'bin locations must have a parent warehouse or staging location'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.parent_location_id IS NOT NULL THEN
    SELECT p.location_type, p.status
      INTO v_parent_type, v_parent_status
    FROM public.inventory_locations p
    WHERE p.id = NEW.parent_location_id
      AND p.tenant_id = NEW.tenant_id
      AND p.factory_id = NEW.factory_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'parent location must exist in the same tenant and factory'
        USING ERRCODE = '23503';
    END IF;
    IF v_parent_type NOT IN ('WAREHOUSE', 'STAGING') OR v_parent_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'parent location must be an active warehouse or staging location'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.factoryos_validate_inventory_location_parent() IS
  'Validates location parent scope and default-location identity; permits only a transaction-local exact-schema transfer to rebind a generated default location ID while preserving tenant/factory/default key.';

INSERT INTO schema_migrations(version, checksum)
VALUES ('216_saas_transfer_inventory_location_identity_rebind', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
