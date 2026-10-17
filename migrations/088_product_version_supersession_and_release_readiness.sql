BEGIN;

ALTER TABLE product_versions
  ADD COLUMN effective_to_override DATE,
  ADD COLUMN superseded_by_version_id UUID;

-- Versions retired before this migration must remain historically resolvable up to
-- their original end date, or through today if their end date was open-ended.
-- Existing lifecycle trigger correctly rejects arbitrary updates to released revisions.
-- Disable just that state-machine trigger while backfilling the new derived cutoff; the
-- migration holds an exclusive table lock and the trigger is re-enabled before commit.
ALTER TABLE product_versions DISABLE TRIGGER trg_product_version_guard;
UPDATE product_versions
SET effective_to_override=CASE
  WHEN effective_from>CURRENT_DATE THEN effective_from-1
  WHEN effective_to IS NOT NULL AND effective_to<CURRENT_DATE THEN effective_to
  ELSE CURRENT_DATE
END
WHERE state='RETIRED' AND effective_to_override IS NULL;
ALTER TABLE product_versions ENABLE TRIGGER trg_product_version_guard;

ALTER TABLE product_versions
  ADD CONSTRAINT fk_product_version_superseded_by
    FOREIGN KEY (superseded_by_version_id,tenant_id,factory_id,product_id)
    REFERENCES product_versions (id,tenant_id,factory_id,product_id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_product_version_override_state CHECK (
    effective_to_override IS NULL OR
    (state='RETIRED' AND (effective_to IS NULL OR effective_to_override<=effective_to))
  ),
  ADD CONSTRAINT chk_product_version_supersession_pair CHECK (
    superseded_by_version_id IS NULL OR
    (state='RETIRED' AND effective_to_override IS NOT NULL AND superseded_by_version_id<>id)
  );

CREATE UNIQUE INDEX uq_product_version_single_superseder
  ON product_versions (tenant_id,factory_id,superseded_by_version_id)
  WHERE superseded_by_version_id IS NOT NULL;

CREATE OR REPLACE FUNCTION factoryos_guard_product_version_effective_override()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_successor_from DATE;
  v_expected_cutoff DATE;
BEGIN
  IF NEW.effective_to_override IS NOT DISTINCT FROM OLD.effective_to_override
     AND NEW.superseded_by_version_id IS NOT DISTINCT FROM OLD.superseded_by_version_id THEN
    RETURN NEW;
  END IF;

  IF OLD.state<>'APPROVED' OR NEW.state<>'RETIRED'
     OR OLD.effective_to_override IS NOT NULL
     OR NEW.effective_to_override IS NULL THEN
    RAISE EXCEPTION 'effective interval can only be closed once when retiring an approved product version'
      USING ERRCODE='55000';
  END IF;

  IF NEW.superseded_by_version_id IS NOT NULL THEN
    SELECT effective_from INTO v_successor_from
    FROM product_versions
    WHERE id=NEW.superseded_by_version_id AND tenant_id=NEW.tenant_id
      AND factory_id=NEW.factory_id AND product_id=NEW.product_id
    FOR SHARE;
    IF NOT FOUND OR NEW.effective_to_override<>v_successor_from-1 THEN
      RAISE EXCEPTION 'supersession cutoff must be the calendar day before the successor version starts'
        USING ERRCODE='23514';
    END IF;
  ELSE
    v_expected_cutoff:=CASE
      WHEN OLD.effective_from>CURRENT_DATE THEN OLD.effective_from-1
      WHEN OLD.effective_to IS NOT NULL AND OLD.effective_to<CURRENT_DATE THEN OLD.effective_to
      ELSE CURRENT_DATE
    END;
    IF NEW.effective_to_override<>v_expected_cutoff THEN
      RAISE EXCEPTION 'manual retirement cutoff must preserve historical dates without extending the effective interval'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_product_version_effective_override_guard
BEFORE UPDATE OF effective_to_override,superseded_by_version_id ON product_versions
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_product_version_effective_override();

CREATE OR REPLACE FUNCTION factoryos_validate_product_version_release_readiness()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_product_status VARCHAR(16);
  v_inventory_status VARCHAR(20);
  v_invalid_components INTEGER;
  v_invalid_work_centres INTEGER;
  v_invalid_alternates INTEGER;
BEGIN
  SELECT p.status,i.status INTO v_product_status,v_inventory_status
  FROM product_definitions p
  JOIN inventory_items i ON i.id=p.inventory_item_id AND i.tenant_id=p.tenant_id AND i.factory_id=p.factory_id
  WHERE p.id=NEW.product_id AND p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id
  FOR SHARE OF p,i;
  IF NOT FOUND OR v_product_status<>'ACTIVE' OR v_inventory_status<>'ACTIVE' THEN
    RAISE EXCEPTION 'Product and finished-good inventory item must both be active at version release'
      USING ERRCODE='23514';
  END IF;

  SELECT count(*) INTO v_invalid_components
  FROM product_bom_lines b
  LEFT JOIN inventory_items i ON i.id=b.component_item_id AND i.tenant_id=b.tenant_id AND i.factory_id=b.factory_id
  WHERE b.product_version_id=NEW.id AND b.tenant_id=NEW.tenant_id AND b.factory_id=NEW.factory_id
    AND (i.id IS NULL OR i.status<>'ACTIVE' OR b.inventory_base_unit IS DISTINCT FROM i.unit
      OR b.component_item_id=(SELECT p.inventory_item_id FROM product_definitions p
          WHERE p.id=NEW.product_id AND p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id));
  IF v_invalid_components>0 THEN
    RAISE EXCEPTION 'BOM contains disabled, mismatched, or self-consuming inventory items'
      USING ERRCODE='23514';
  END IF;

  SELECT count(*) INTO v_invalid_work_centres
  FROM product_routing_steps r
  LEFT JOIN manufacturing_work_centres w ON w.id=r.work_centre_id AND w.tenant_id=r.tenant_id AND w.factory_id=r.factory_id
  WHERE r.product_version_id=NEW.id AND r.tenant_id=NEW.tenant_id AND r.factory_id=NEW.factory_id
    AND (w.id IS NULL OR w.status<>'ACTIVE');
  IF v_invalid_work_centres>0 THEN
    RAISE EXCEPTION 'Routing references a disabled or missing work centre'
      USING ERRCODE='23514';
  END IF;

  SELECT count(*) INTO v_invalid_alternates
  FROM product_bom_alternates a
  LEFT JOIN inventory_items i ON i.id=a.alternate_item_id AND i.tenant_id=a.tenant_id AND i.factory_id=a.factory_id
  WHERE a.product_version_id=NEW.id AND a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id
    AND a.status='APPROVED'
    AND (i.id IS NULL OR i.status<>'ACTIVE'
      OR a.inventory_base_unit IS DISTINCT FROM i.unit
      OR a.alternate_item_id=(SELECT p.inventory_item_id FROM product_definitions p
          WHERE p.id=NEW.product_id AND p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id));
  IF v_invalid_alternates>0 THEN
    RAISE EXCEPTION 'Approved alternate contracts reference disabled, mismatched, or self-consuming inventory items'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_product_version_release_readiness
BEFORE UPDATE OF state ON product_versions
FOR EACH ROW
WHEN (OLD.state='DRAFT' AND NEW.state='APPROVED')
EXECUTE FUNCTION factoryos_validate_product_version_release_readiness();

INSERT INTO schema_migrations(version,checksum)
VALUES('088_product_version_supersession_and_release_readiness',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
