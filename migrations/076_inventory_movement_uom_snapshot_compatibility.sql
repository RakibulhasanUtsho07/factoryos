BEGIN;

-- Preserve the full integer capacity of the canonical numeric(18,4) ledger
-- while retaining 8 decimal places for source-unit quantities.
ALTER TABLE inventory_movements
  ALTER COLUMN input_quantity TYPE NUMERIC(22,8);

CREATE OR REPLACE FUNCTION factoryos_fill_inventory_movement_uom_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $uom_movement_snapshot$
DECLARE
  v_item_unit VARCHAR(50);
  v_from_unit_id UUID;
  v_to_unit_id UUID;
  v_rule_from_unit_id UUID;
  v_factor_numerator NUMERIC(24,0);
  v_factor_denominator NUMERIC(24,0);
  v_rounding_mode VARCHAR(16);
  v_expected_numerator NUMERIC(24,0);
  v_expected_denominator NUMERIC(24,0);
  v_source_precision SMALLINT;
  v_exact_quantity NUMERIC;
  v_expected_quantity NUMERIC(18,4);
BEGIN
  SELECT i.unit INTO v_item_unit
  FROM inventory_items i
  WHERE i.id = NEW.item_id
    AND i.tenant_id = NEW.tenant_id
    AND i.factory_id = NEW.factory_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'inventory movement item must exist within the same tenant and factory';
  END IF;

  -- Legacy direct stock posts (e.g. GRN posting and integrations) do not yet
  -- provide source-unit metadata; treat these quantities as already canonical.
  IF NEW.input_quantity IS NULL THEN
    NEW.input_quantity := NEW.quantity;
  END IF;
  IF NEW.input_unit_code IS NULL OR length(btrim(NEW.input_unit_code)) = 0 THEN
    NEW.input_unit_code := v_item_unit;
  END IF;

  IF NEW.input_quantity <= 0 OR length(btrim(NEW.input_unit_code)) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inventory movement source quantity and unit must be positive/non-empty';
  END IF;

  IF NEW.conversion_rule_id IS NULL THEN
    IF NEW.input_unit_code IS DISTINCT FROM v_item_unit THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'a non-base input unit requires an approved conversion rule';
    END IF;
    IF NEW.conversion_factor_numerator IS NOT NULL
       OR NEW.conversion_factor_denominator IS NOT NULL
       OR NEW.conversion_rounding_mode IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'conversion snapshot fields require a conversion rule';
    END IF;
    RETURN NEW;
  END IF;

  SELECT src.id, dst.id, r.from_unit_id, r.factor_numerator, r.factor_denominator,
         r.rounding_mode, src.decimal_precision
    INTO v_from_unit_id, v_to_unit_id, v_rule_from_unit_id,
         v_factor_numerator, v_factor_denominator, v_rounding_mode, v_source_precision
  FROM inventory_items i
  JOIN uom_units src
    ON src.tenant_id = NEW.tenant_id
   AND src.factory_id = NEW.factory_id
   AND src.unit_code = NEW.input_unit_code
  JOIN uom_units dst
    ON dst.tenant_id = i.tenant_id
   AND dst.factory_id = i.factory_id
   AND dst.unit_code = i.unit
  JOIN uom_conversion_rules r
    ON r.id = NEW.conversion_rule_id
   AND r.tenant_id = NEW.tenant_id
   AND r.factory_id = NEW.factory_id
   AND r.status = 'APPROVED'
   AND (
     (r.from_unit_id = src.id AND r.to_unit_id = dst.id)
     OR (r.from_unit_id = dst.id AND r.to_unit_id = src.id)
   )
  WHERE i.id = NEW.item_id
    AND i.tenant_id = NEW.tenant_id
    AND i.factory_id = NEW.factory_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inventory movement conversion must use an approved rule matching input and base units';
  END IF;

  IF v_rule_from_unit_id = v_from_unit_id THEN
    v_expected_numerator := v_factor_numerator;
    v_expected_denominator := v_factor_denominator;
  ELSE
    v_expected_numerator := v_factor_denominator;
    v_expected_denominator := v_factor_numerator;
  END IF;

  IF NEW.conversion_factor_numerator IS DISTINCT FROM v_expected_numerator
     OR NEW.conversion_factor_denominator IS DISTINCT FROM v_expected_denominator
     OR NEW.conversion_rounding_mode IS DISTINCT FROM v_rounding_mode THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inventory movement conversion snapshot does not match the approved rule';
  END IF;
  IF NEW.input_quantity <> trunc(NEW.input_quantity, v_source_precision) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inventory movement input quantity exceeds source-unit precision';
  END IF;
  v_exact_quantity := NEW.input_quantity * v_expected_numerator / v_expected_denominator;
  IF NEW.conversion_rounding_mode = 'REJECT' AND v_exact_quantity <> trunc(v_exact_quantity, 4) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inventory movement conversion requires rounding but the approved rule rejects rounding';
  END IF;
  v_expected_quantity := round(v_exact_quantity, 4);
  IF NEW.quantity IS DISTINCT FROM v_expected_quantity THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inventory movement base quantity does not match its approved conversion factor';
  END IF;
  RETURN NEW;
END;
$uom_movement_snapshot$;

CREATE TRIGGER trg_inventory_movement_uom_snapshot
BEFORE INSERT ON inventory_movements
FOR EACH ROW EXECUTE FUNCTION factoryos_fill_inventory_movement_uom_snapshot();

INSERT INTO schema_migrations (version)
VALUES ('076_inventory_movement_uom_snapshot_compatibility')
ON CONFLICT (version) DO NOTHING;

COMMIT;
