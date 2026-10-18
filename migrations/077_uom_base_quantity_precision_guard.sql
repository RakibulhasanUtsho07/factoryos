BEGIN;

-- Tighten the database-side guard so service and direct ledger writes share the
-- same target-unit precision contract. Canonical stock columns remain NUMERIC(18,4);
-- configured unit precision may be stricter than four.
CREATE OR REPLACE FUNCTION factoryos_fill_inventory_movement_uom_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $uom_movement_snapshot$
DECLARE
  v_item_unit VARCHAR(50);
  v_base_precision SMALLINT;
  v_target_precision SMALLINT;
  v_effective_precision SMALLINT;
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
  SELECT i.unit, u.decimal_precision
    INTO v_item_unit, v_base_precision
  FROM inventory_items i
  LEFT JOIN uom_units u
    ON u.tenant_id = i.tenant_id
   AND u.factory_id = i.factory_id
   AND u.unit_code = i.unit
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
    -- Direct/base-unit posts must obey registered precision as well. In
    -- particular, a PCS base unit must never accept a fractional piece.
    IF v_base_precision IS NOT NULL
       AND NEW.input_quantity <> trunc(NEW.input_quantity, LEAST(v_base_precision, 4)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inventory movement quantity exceeds base-unit precision';
    END IF;
    IF NEW.quantity IS DISTINCT FROM round(NEW.input_quantity, 4) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'base-unit movement quantity must match canonical input quantity';
    END IF;
    RETURN NEW;
  END IF;

  SELECT src.id, dst.id, r.from_unit_id, r.factor_numerator, r.factor_denominator,
         r.rounding_mode, src.decimal_precision, dst.decimal_precision
    INTO v_from_unit_id, v_to_unit_id, v_rule_from_unit_id,
         v_factor_numerator, v_factor_denominator, v_rounding_mode, v_source_precision, v_target_precision
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
  v_effective_precision := LEAST(v_target_precision, 4);
  v_exact_quantity := NEW.input_quantity * v_expected_numerator / v_expected_denominator;
  IF NEW.conversion_rounding_mode = 'REJECT'
     AND v_exact_quantity <> trunc(v_exact_quantity, v_effective_precision) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inventory movement conversion requires rounding but the approved rule rejects rounding';
  END IF;
  v_expected_quantity := round(v_exact_quantity, v_effective_precision);
  IF v_expected_quantity <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inventory movement conversion rounds to zero at base-unit precision';
  END IF;
  IF NEW.quantity IS DISTINCT FROM v_expected_quantity THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'inventory movement base quantity does not match its approved conversion factor';
  END IF;
  RETURN NEW;
END;
$uom_movement_snapshot$;

INSERT INTO schema_migrations (version)
VALUES ('077_uom_base_quantity_precision_guard')
ON CONFLICT (version) DO NOTHING;

COMMIT;
