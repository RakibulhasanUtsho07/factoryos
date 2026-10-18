BEGIN;

CREATE OR REPLACE FUNCTION factoryos_quality_guard_ncr_close()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'CLOSED' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NOT EXISTS (
      SELECT 1 FROM quality_ncr_actions a WHERE a.ncr_id = NEW.id AND a.action_type = 'CONTAINMENT'
        AND a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id
    )
      OR NOT EXISTS (
        SELECT 1 FROM quality_ncr_actions a WHERE a.ncr_id = NEW.id AND a.action_type = 'CORRECTIVE'
          AND a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id
      )
      OR NOT EXISTS (
        SELECT 1 FROM quality_ncr_actions a WHERE a.ncr_id = NEW.id AND a.action_type = 'PREVENTIVE'
          AND a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id
      )
      OR EXISTS (
        SELECT 1 FROM quality_defects d WHERE d.inspection_id = NEW.inspection_id
          AND d.tenant_id = NEW.tenant_id AND d.factory_id = NEW.factory_id AND d.status IN ('OPEN', 'REWORK')
      )
      OR NOT EXISTS (
        SELECT 1 FROM quality_inspections qi WHERE qi.id = NEW.inspection_id
          AND qi.tenant_id = NEW.tenant_id AND qi.factory_id = NEW.factory_id
          AND qi.status IN ('PASSED', 'DISPOSITIONED')
      )
      OR EXISTS (
        SELECT 1 FROM quality_holds h WHERE h.inspection_id = NEW.inspection_id
          AND h.tenant_id = NEW.tenant_id AND h.factory_id = NEW.factory_id AND h.status = 'ACTIVE'
      ) THEN
      RAISE EXCEPTION 'NCR closure requires CAPA evidence, resolved defects, a resolved inspection and no active quality hold'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

INSERT INTO schema_migrations(version, checksum)
VALUES ('095_quality_ncr_resolution_gate', NULL)
ON CONFLICT (version) DO NOTHING;

COMMENT ON FUNCTION factoryos_quality_guard_ncr_close() IS
  'NCR closure requires containment/corrective/preventive actions, no open/rework defects, a PASSED/DISPOSITIONED inspection and no active quality hold.';

COMMIT;
