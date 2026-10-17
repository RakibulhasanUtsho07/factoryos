BEGIN;

ALTER TABLE product_bom_lines
  ADD COLUMN inventory_base_unit VARCHAR(50),
  ADD COLUMN base_quantity_per NUMERIC(18,4),
  ADD COLUMN uom_conversion_rule_id UUID,
  ADD COLUMN uom_conversion_rule_version BIGINT,
  ADD COLUMN uom_factor_numerator NUMERIC(24,0),
  ADD COLUMN uom_factor_denominator NUMERIC(24,0),
  ADD COLUMN uom_rounding_mode VARCHAR(16);

ALTER TABLE product_bom_alternates
  ADD COLUMN inventory_base_unit VARCHAR(50),
  ADD COLUMN inventory_quantity_per_component NUMERIC(18,6),
  ADD COLUMN uom_conversion_rule_id UUID,
  ADD COLUMN uom_conversion_rule_version BIGINT,
  ADD COLUMN uom_factor_numerator NUMERIC(24,0),
  ADD COLUMN uom_factor_denominator NUMERIC(24,0),
  ADD COLUMN uom_rounding_mode VARCHAR(16);

DO $$
DECLARE v_line RECORD; v_rule RECORD; v_raw NUMERIC; v_normalized NUMERIC;
BEGIN
  FOR v_line IN
    SELECT b.id,b.tenant_id,b.factory_id,b.unit,b.quantity_per,i.unit AS base_unit
    FROM product_bom_lines b JOIN inventory_items i
      ON i.id=b.component_item_id AND i.tenant_id=b.tenant_id AND i.factory_id=b.factory_id
  LOOP
    IF upper(btrim(v_line.unit))=upper(btrim(v_line.base_unit)) THEN
      UPDATE product_bom_lines SET inventory_base_unit=v_line.base_unit,base_quantity_per=v_line.quantity_per,
        uom_conversion_rule_id=NULL,uom_conversion_rule_version=NULL,uom_factor_numerator=1,uom_factor_denominator=1,
        uom_rounding_mode='REJECT' WHERE id=v_line.id;
    ELSE
      SELECT r.id,r.version,r.factor_numerator,r.factor_denominator,r.rounding_mode INTO v_rule
      FROM uom_conversion_rules r
      JOIN uom_units f ON f.id=r.from_unit_id AND f.tenant_id=r.tenant_id AND f.factory_id=r.factory_id
      JOIN uom_units t ON t.id=r.to_unit_id AND t.tenant_id=r.tenant_id AND t.factory_id=r.factory_id
      WHERE r.tenant_id=v_line.tenant_id AND r.factory_id=v_line.factory_id AND r.status='APPROVED'
        AND upper(f.unit_code)=upper(btrim(v_line.unit)) AND upper(t.unit_code)=upper(btrim(v_line.base_unit))
      ORDER BY r.updated_at DESC,r.id LIMIT 1;
      IF NOT FOUND THEN RAISE EXCEPTION 'Cannot snapshot BOM line %: missing approved conversion from % to %',v_line.id,v_line.unit,v_line.base_unit; END IF;
      v_raw:=v_line.quantity_per*v_rule.factor_numerator/v_rule.factor_denominator;
      IF v_rule.rounding_mode='REJECT' AND v_raw<>round(v_raw,4) THEN
        RAISE EXCEPTION 'BOM line % conversion exceeds four decimal places',v_line.id;
      END IF;
      v_normalized:=CASE WHEN v_rule.rounding_mode='HALF_UP' THEN round(v_raw,4) ELSE v_raw END;
      IF v_normalized<=0 THEN RAISE EXCEPTION 'BOM line % converts to zero base quantity',v_line.id; END IF;
      UPDATE product_bom_lines SET inventory_base_unit=v_line.base_unit,base_quantity_per=v_normalized,
        uom_conversion_rule_id=v_rule.id,uom_conversion_rule_version=v_rule.version,
        uom_factor_numerator=v_rule.factor_numerator,uom_factor_denominator=v_rule.factor_denominator,
        uom_rounding_mode=v_rule.rounding_mode WHERE id=v_line.id;
    END IF;
  END LOOP;

  FOR v_line IN
    SELECT a.id,a.tenant_id,a.factory_id,a.unit,a.conversion_factor,i.unit AS base_unit
    FROM product_bom_alternates a JOIN inventory_items i
      ON i.id=a.alternate_item_id AND i.tenant_id=a.tenant_id AND i.factory_id=a.factory_id
  LOOP
    IF upper(btrim(v_line.unit))=upper(btrim(v_line.base_unit)) THEN
      UPDATE product_bom_alternates SET inventory_base_unit=v_line.base_unit,
        inventory_quantity_per_component=v_line.conversion_factor,uom_conversion_rule_id=NULL,
        uom_conversion_rule_version=NULL,uom_factor_numerator=1,uom_factor_denominator=1,uom_rounding_mode='REJECT'
      WHERE id=v_line.id;
    ELSE
      SELECT r.id,r.version,r.factor_numerator,r.factor_denominator,r.rounding_mode INTO v_rule
      FROM uom_conversion_rules r
      JOIN uom_units f ON f.id=r.from_unit_id AND f.tenant_id=r.tenant_id AND f.factory_id=r.factory_id
      JOIN uom_units t ON t.id=r.to_unit_id AND t.tenant_id=r.tenant_id AND t.factory_id=r.factory_id
      WHERE r.tenant_id=v_line.tenant_id AND r.factory_id=v_line.factory_id AND r.status='APPROVED'
        AND upper(f.unit_code)=upper(btrim(v_line.unit)) AND upper(t.unit_code)=upper(btrim(v_line.base_unit))
      ORDER BY r.updated_at DESC,r.id LIMIT 1;
      IF NOT FOUND THEN RAISE EXCEPTION 'Cannot snapshot alternate %: missing approved conversion from % to %',v_line.id,v_line.unit,v_line.base_unit; END IF;
      v_raw:=v_line.conversion_factor*v_rule.factor_numerator/v_rule.factor_denominator;
      IF v_rule.rounding_mode='REJECT' AND v_raw<>round(v_raw,6) THEN
        RAISE EXCEPTION 'Alternate % conversion exceeds six decimal places',v_line.id;
      END IF;
      v_normalized:=CASE WHEN v_rule.rounding_mode='HALF_UP' THEN round(v_raw,6) ELSE v_raw END;
      IF v_normalized<=0 THEN RAISE EXCEPTION 'Alternate % converts to zero base quantity',v_line.id; END IF;
      UPDATE product_bom_alternates SET inventory_base_unit=v_line.base_unit,
        inventory_quantity_per_component=v_normalized,uom_conversion_rule_id=v_rule.id,
        uom_conversion_rule_version=v_rule.version,uom_factor_numerator=v_rule.factor_numerator,
        uom_factor_denominator=v_rule.factor_denominator,uom_rounding_mode=v_rule.rounding_mode
      WHERE id=v_line.id;
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE product_bom_lines
  ALTER COLUMN inventory_base_unit SET NOT NULL,
  ALTER COLUMN base_quantity_per SET NOT NULL,
  ALTER COLUMN uom_factor_numerator SET NOT NULL,
  ALTER COLUMN uom_factor_denominator SET NOT NULL,
  ALTER COLUMN uom_rounding_mode SET NOT NULL,
  ADD CONSTRAINT fk_product_bom_line_uom_rule FOREIGN KEY (uom_conversion_rule_id,tenant_id,factory_id)
    REFERENCES uom_conversion_rules(id,tenant_id,factory_id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_product_bom_line_base_quantity CHECK (base_quantity_per>0),
  ADD CONSTRAINT chk_product_bom_line_uom_factor CHECK (uom_factor_numerator>0 AND uom_factor_denominator>0),
  ADD CONSTRAINT chk_product_bom_line_uom_snapshot CHECK (
    (uom_conversion_rule_id IS NULL AND uom_conversion_rule_version IS NULL AND uom_factor_numerator=1
      AND uom_factor_denominator=1 AND uom_rounding_mode='REJECT' AND upper(btrim(unit))=upper(btrim(inventory_base_unit)))
    OR (uom_conversion_rule_id IS NOT NULL AND uom_conversion_rule_version>0 AND uom_rounding_mode IN ('REJECT','HALF_UP'))
  );

ALTER TABLE product_bom_alternates
  ALTER COLUMN inventory_base_unit SET NOT NULL,
  ALTER COLUMN inventory_quantity_per_component SET NOT NULL,
  ALTER COLUMN uom_factor_numerator SET NOT NULL,
  ALTER COLUMN uom_factor_denominator SET NOT NULL,
  ALTER COLUMN uom_rounding_mode SET NOT NULL,
  ADD CONSTRAINT fk_product_bom_alternate_uom_rule FOREIGN KEY (uom_conversion_rule_id,tenant_id,factory_id)
    REFERENCES uom_conversion_rules(id,tenant_id,factory_id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_product_bom_alternate_base_quantity CHECK (inventory_quantity_per_component>0),
  ADD CONSTRAINT chk_product_bom_alternate_uom_factor CHECK (uom_factor_numerator>0 AND uom_factor_denominator>0),
  ADD CONSTRAINT chk_product_bom_alternate_uom_snapshot CHECK (
    (uom_conversion_rule_id IS NULL AND uom_conversion_rule_version IS NULL AND uom_factor_numerator=1
      AND uom_factor_denominator=1 AND uom_rounding_mode='REJECT' AND upper(btrim(unit))=upper(btrim(inventory_base_unit)))
    OR (uom_conversion_rule_id IS NOT NULL AND uom_conversion_rule_version>0 AND uom_rounding_mode IN ('REJECT','HALF_UP'))
  );

CREATE OR REPLACE FUNCTION factoryos_guard_product_bom_line()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_state VARCHAR(16); v_item_status VARCHAR(20); v_item_unit VARCHAR(50); v_rule RECORD; v_expected NUMERIC;
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'BOM inputs and UoM snapshots are immutable; replace the draft BOM line instead' USING ERRCODE='55000';
  END IF;
  SELECT state INTO v_state FROM product_versions
    WHERE id=COALESCE(NEW.product_version_id,OLD.product_version_id)
      AND tenant_id=COALESCE(NEW.tenant_id,OLD.tenant_id) AND factory_id=COALESCE(NEW.factory_id,OLD.factory_id) FOR UPDATE;
  IF NOT FOUND OR v_state<>'DRAFT' THEN RAISE EXCEPTION 'BOM lines may only change while product version is draft' USING ERRCODE='55000'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  SELECT status,unit INTO v_item_status,v_item_unit FROM inventory_items
    WHERE id=NEW.component_item_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
  IF NOT FOUND OR v_item_status<>'ACTIVE' THEN RAISE EXCEPTION 'BOM component must be active inventory in same factory' USING ERRCODE='23514'; END IF;
  IF NEW.inventory_base_unit IS DISTINCT FROM v_item_unit THEN RAISE EXCEPTION 'BOM base unit snapshot disagrees with inventory master' USING ERRCODE='23514'; END IF;
  IF NEW.uom_conversion_rule_id IS NULL THEN
    IF upper(btrim(NEW.unit))<>upper(btrim(v_item_unit)) OR NEW.uom_conversion_rule_version IS NOT NULL
      OR NEW.uom_factor_numerator<>1 OR NEW.uom_factor_denominator<>1 OR NEW.uom_rounding_mode<>'REJECT' THEN
      RAISE EXCEPTION 'BOM unit snapshot requires matching units or an approved conversion' USING ERRCODE='23514';
    END IF;
    v_expected:=NEW.quantity_per;
  ELSE
    SELECT r.version,r.factor_numerator,r.factor_denominator,r.rounding_mode INTO v_rule
    FROM uom_conversion_rules r
    JOIN uom_units f ON f.id=r.from_unit_id AND f.tenant_id=r.tenant_id AND f.factory_id=r.factory_id
    JOIN uom_units t ON t.id=r.to_unit_id AND t.tenant_id=r.tenant_id AND t.factory_id=r.factory_id
    WHERE r.id=NEW.uom_conversion_rule_id AND r.tenant_id=NEW.tenant_id AND r.factory_id=NEW.factory_id
      AND r.status='APPROVED' AND upper(f.unit_code)=upper(btrim(NEW.unit)) AND upper(t.unit_code)=upper(btrim(v_item_unit))
    FOR SHARE OF r;
    IF NOT FOUND OR v_rule.version<>NEW.uom_conversion_rule_version OR v_rule.factor_numerator<>NEW.uom_factor_numerator
      OR v_rule.factor_denominator<>NEW.uom_factor_denominator OR v_rule.rounding_mode<>NEW.uom_rounding_mode THEN
      RAISE EXCEPTION 'BOM snapshot must capture the currently approved directional UoM conversion' USING ERRCODE='23514';
    END IF;
    v_expected:=NEW.quantity_per*NEW.uom_factor_numerator/NEW.uom_factor_denominator;
    IF NEW.uom_rounding_mode='REJECT' AND v_expected<>round(v_expected,4) THEN RAISE EXCEPTION 'BOM conversion requires prohibited rounding' USING ERRCODE='23514'; END IF;
    IF NEW.uom_rounding_mode='HALF_UP' THEN v_expected:=round(v_expected,4); END IF;
  END IF;
  IF v_expected<=0 OR NEW.base_quantity_per<>v_expected THEN RAISE EXCEPTION 'BOM base quantity disagrees with UoM snapshot' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_product_bom_alternate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_state VARCHAR(16); v_component_item_id UUID; v_item_status VARCHAR(20); v_item_unit VARCHAR(50); v_rule RECORD; v_expected NUMERIC;
BEGIN
  IF TG_OP='UPDATE'
    AND ROW(NEW.id,NEW.tenant_id,NEW.factory_id,NEW.product_id,NEW.product_version_id,NEW.bom_line_id,NEW.alternate_item_id,
      NEW.conversion_factor,NEW.unit,NEW.rationale,NEW.idempotency_key,NEW.request_hash,NEW.created_by_user_id,NEW.created_at,
      NEW.inventory_base_unit,NEW.inventory_quantity_per_component,NEW.uom_conversion_rule_id,NEW.uom_conversion_rule_version,
      NEW.uom_factor_numerator,NEW.uom_factor_denominator,NEW.uom_rounding_mode)
    IS DISTINCT FROM
    ROW(OLD.id,OLD.tenant_id,OLD.factory_id,OLD.product_id,OLD.product_version_id,OLD.bom_line_id,OLD.alternate_item_id,
      OLD.conversion_factor,OLD.unit,OLD.rationale,OLD.idempotency_key,OLD.request_hash,OLD.created_by_user_id,OLD.created_at,
      OLD.inventory_base_unit,OLD.inventory_quantity_per_component,OLD.uom_conversion_rule_id,OLD.uom_conversion_rule_version,
      OLD.uom_factor_numerator,OLD.uom_factor_denominator,OLD.uom_rounding_mode) THEN
    RAISE EXCEPTION 'Alternate contract inputs and UoM snapshots are immutable' USING ERRCODE='55000';
  END IF;
  SELECT state INTO v_state FROM product_versions WHERE id=COALESCE(NEW.product_version_id,OLD.product_version_id)
    AND tenant_id=COALESCE(NEW.tenant_id,OLD.tenant_id) AND factory_id=COALESCE(NEW.factory_id,OLD.factory_id) FOR UPDATE;
  IF NOT FOUND OR v_state<>'DRAFT' THEN RAISE EXCEPTION 'Alternates may only change while product version is draft' USING ERRCODE='55000'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  SELECT component_item_id INTO v_component_item_id FROM product_bom_lines
    WHERE id=NEW.bom_line_id AND product_version_id=NEW.product_version_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Alternate must reference a BOM line in the same version' USING ERRCODE='23503'; END IF;
  IF v_component_item_id=NEW.alternate_item_id THEN RAISE EXCEPTION 'Alternate must differ from primary component' USING ERRCODE='23514'; END IF;
  SELECT status,unit INTO v_item_status,v_item_unit FROM inventory_items WHERE id=NEW.alternate_item_id
    AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Alternate inventory item does not exist in this factory' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND v_item_status<>'ACTIVE' THEN RAISE EXCEPTION 'Alternate must be active inventory in same factory' USING ERRCODE='23514'; END IF;
  IF NEW.status='APPROVED' AND v_item_status<>'ACTIVE' THEN RAISE EXCEPTION 'Alternate must be active inventory before approval' USING ERRCODE='23514'; END IF;
  IF NEW.inventory_base_unit IS DISTINCT FROM v_item_unit THEN RAISE EXCEPTION 'Alternate base unit snapshot disagrees with inventory master' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.uom_conversion_rule_id IS NULL THEN
      IF upper(btrim(NEW.unit))<>upper(btrim(v_item_unit)) OR NEW.uom_conversion_rule_version IS NOT NULL
        OR NEW.uom_factor_numerator<>1 OR NEW.uom_factor_denominator<>1 OR NEW.uom_rounding_mode<>'REJECT' THEN
        RAISE EXCEPTION 'Alternate unit snapshot requires matching units or an approved conversion' USING ERRCODE='23514';
      END IF;
      v_expected:=NEW.conversion_factor;
    ELSE
      SELECT r.version,r.factor_numerator,r.factor_denominator,r.rounding_mode INTO v_rule
      FROM uom_conversion_rules r
      JOIN uom_units f ON f.id=r.from_unit_id AND f.tenant_id=r.tenant_id AND f.factory_id=r.factory_id
      JOIN uom_units t ON t.id=r.to_unit_id AND t.tenant_id=r.tenant_id AND t.factory_id=r.factory_id
      WHERE r.id=NEW.uom_conversion_rule_id AND r.tenant_id=NEW.tenant_id AND r.factory_id=NEW.factory_id
        AND r.status='APPROVED' AND upper(f.unit_code)=upper(btrim(NEW.unit)) AND upper(t.unit_code)=upper(btrim(v_item_unit))
      FOR SHARE OF r;
      IF NOT FOUND OR v_rule.version<>NEW.uom_conversion_rule_version OR v_rule.factor_numerator<>NEW.uom_factor_numerator
        OR v_rule.factor_denominator<>NEW.uom_factor_denominator OR v_rule.rounding_mode<>NEW.uom_rounding_mode THEN
        RAISE EXCEPTION 'Alternate snapshot must capture currently approved directional UoM conversion' USING ERRCODE='23514';
      END IF;
      v_expected:=NEW.conversion_factor*NEW.uom_factor_numerator/NEW.uom_factor_denominator;
      IF NEW.uom_rounding_mode='REJECT' AND v_expected<>round(v_expected,6) THEN RAISE EXCEPTION 'Alternate conversion requires prohibited rounding' USING ERRCODE='23514'; END IF;
      IF NEW.uom_rounding_mode='HALF_UP' THEN v_expected:=round(v_expected,6); END IF;
    END IF;
    IF v_expected<=0 OR NEW.inventory_quantity_per_component<>v_expected THEN RAISE EXCEPTION 'Alternate quantity disagrees with UoM snapshot' USING ERRCODE='23514'; END IF;
    IF NEW.status<>'DRAFT' OR NEW.approved_by_user_id IS NOT NULL OR NEW.approved_at IS NOT NULL
      OR NEW.retired_by_user_id IS NOT NULL OR NEW.retired_at IS NOT NULL OR NEW.approval_idempotency_key IS NOT NULL
      OR NEW.approval_request_hash IS NOT NULL OR NEW.retirement_idempotency_key IS NOT NULL OR NEW.retirement_request_hash IS NOT NULL THEN
      RAISE EXCEPTION 'Alternates must start as clean drafts' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  ELSIF OLD.status='DRAFT' AND NEW.status='APPROVED' THEN
    IF NEW.approved_by_user_id IS NULL OR NEW.approved_at IS NULL OR NEW.approval_idempotency_key IS NULL
      OR NEW.approval_request_hash IS NULL OR NEW.approved_by_user_id=NEW.created_by_user_id
      OR NEW.retired_by_user_id IS NOT NULL OR NEW.retired_at IS NOT NULL
      OR NEW.retirement_idempotency_key IS NOT NULL OR NEW.retirement_request_hash IS NOT NULL THEN
      RAISE EXCEPTION 'Alternate approval requires independent approver and idempotency evidence' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  ELSIF OLD.status IN ('DRAFT','APPROVED') AND NEW.status='RETIRED' THEN
    IF NEW.retired_by_user_id IS NULL OR NEW.retired_at IS NULL OR NEW.retirement_idempotency_key IS NULL
      OR NEW.retirement_request_hash IS NULL OR NEW.retired_by_user_id=NEW.created_by_user_id
      OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
      OR NEW.approval_idempotency_key IS DISTINCT FROM OLD.approval_idempotency_key
      OR NEW.approval_request_hash IS DISTINCT FROM OLD.approval_request_hash THEN
      RAISE EXCEPTION 'Alternate retirement requires independent actor and preserved approval evidence' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Invalid alternate lifecycle transition' USING ERRCODE='55000';
END;
$$;

COMMENT ON COLUMN product_bom_lines.base_quantity_per IS
  'Inventory-base quantity per finished-good base unit, frozen with the approved UoM rule/version and rounding mode.';
COMMENT ON COLUMN product_bom_alternates.inventory_quantity_per_component IS
  'Alternate inventory-base quantity needed per primary component base unit, frozen with approved UoM conversion evidence.';

INSERT INTO schema_migrations(version,checksum)
VALUES('086_product_bom_uom_snapshots',NULL)
ON CONFLICT(version) DO NOTHING;
COMMIT;
