BEGIN;

-- Replacing BOM lines must not cascade-delete approved, retired, or draft
-- alternate-material contracts. A version with alternate contract history must
-- be superseded by a new product version for material-list changes.
ALTER TABLE product_bom_alternates
  DROP CONSTRAINT fk_product_bom_alternate_line,
  ADD CONSTRAINT fk_product_bom_alternate_line
    FOREIGN KEY (bom_line_id,product_version_id,tenant_id,factory_id)
    REFERENCES product_bom_lines (id,product_version_id,tenant_id,factory_id)
    ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION factoryos_reject_product_self_component()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_finished_item_id UUID;
BEGIN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  SELECT p.inventory_item_id INTO v_finished_item_id
  FROM product_definitions p
  WHERE p.id=NEW.product_id AND p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BOM product definition was not found in the same factory'
      USING ERRCODE='23503';
  END IF;
  IF NEW.component_item_id=v_finished_item_id THEN
    RAISE EXCEPTION 'A product cannot consume its own finished-good inventory item'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_product_bom_no_self_component
BEFORE INSERT OR UPDATE ON product_bom_lines
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_product_self_component();

CREATE OR REPLACE FUNCTION factoryos_reject_product_self_alternate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_finished_item_id UUID;
BEGIN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  SELECT p.inventory_item_id INTO v_finished_item_id
  FROM product_definitions p
  WHERE p.id=NEW.product_id AND p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BOM product definition was not found in the same factory'
      USING ERRCODE='23503';
  END IF;
  IF NEW.alternate_item_id=v_finished_item_id THEN
    RAISE EXCEPTION 'A product cannot use its own finished-good inventory item as an alternate material'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_product_alternate_no_self_component
BEFORE INSERT OR UPDATE ON product_bom_alternates
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_product_self_alternate();

INSERT INTO schema_migrations(version,checksum)
VALUES('087_product_bom_contract_retention_guards',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
