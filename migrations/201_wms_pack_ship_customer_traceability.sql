BEGIN;

-- Type-safe packaging and shipment genealogy: allow only finished-good identities
-- to be packed into cartons/pallets; carton-to-pallet nesting is supported.
-- Shipment links must bind a real package identity to customer/order references.
CREATE OR REPLACE FUNCTION factoryos_guard_pack_ship_genealogy_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_type VARCHAR(24);
  v_source_role VARCHAR(20);
  v_source_status VARCHAR(16);
  v_target_type VARCHAR(24);
  v_target_role VARCHAR(20);
  v_target_status VARCHAR(16);
  v_target_attributes JSONB;
BEGIN
  IF NEW.relationship_type NOT IN ('PACKED_INTO', 'SHIPPED_AS') THEN
    RETURN NEW;
  END IF;

  SELECT u.unit_type, u.product_role, u.status
    INTO v_source_type, v_source_role, v_source_status
  FROM traceability_units u
  WHERE u.id = NEW.source_unit_id
    AND u.tenant_id = NEW.tenant_id AND u.factory_id = NEW.factory_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pack/ship source identity must belong to the same factory'
      USING ERRCODE = '23503';
  END IF;

  SELECT u.unit_type, u.product_role, u.status, u.attributes
    INTO v_target_type, v_target_role, v_target_status, v_target_attributes
  FROM traceability_units u
  WHERE u.id = NEW.target_unit_id
    AND u.tenant_id = NEW.tenant_id AND u.factory_id = NEW.factory_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pack/ship target identity must belong to the same factory'
      USING ERRCODE = '23503';
  END IF;

  IF v_source_status <> 'ACTIVE' OR v_target_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'pack/ship genealogy requires active source and target identities'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.relationship_type = 'PACKED_INTO' THEN
    IF v_target_role <> 'PACKAGING' OR v_target_type NOT IN ('CARTON', 'PALLET') THEN
      RAISE EXCEPTION 'PACKED_INTO target must be a carton or pallet packaging identity'
        USING ERRCODE = '23514';
    END IF;
    IF NOT (
      (v_source_role = 'FINISHED_GOOD' AND v_source_type IN ('LOT', 'SERIAL', 'FINISHED_GOOD'))
      OR (v_source_role = 'PACKAGING' AND v_source_type = 'CARTON' AND v_target_type = 'PALLET')
    ) THEN
      RAISE EXCEPTION 'PACKED_INTO source must be finished-good stock or a carton nested into a pallet'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF v_source_role <> 'PACKAGING' OR v_source_type NOT IN ('CARTON', 'PALLET') THEN
    RAISE EXCEPTION 'SHIPPED_AS source must be a carton or pallet identity'
      USING ERRCODE = '23514';
  END IF;
  IF v_target_type <> 'SHIPMENT' OR v_target_role <> 'SHIPMENT' THEN
    RAISE EXCEPTION 'SHIPPED_AS target must be a shipment identity'
      USING ERRCODE = '23514';
  END IF;
  IF btrim(COALESCE(v_target_attributes->>'customer_reference', '')) = ''
    OR btrim(COALESCE(v_target_attributes->>'customer_order_reference', '')) = ''
    OR btrim(COALESCE(v_target_attributes->>'shipment_reference', '')) = '' THEN
    RAISE EXCEPTION 'shipment identity requires customer, customer-order and shipment references'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM product_genealogy_events packed
    WHERE packed.tenant_id = NEW.tenant_id AND packed.factory_id = NEW.factory_id
      AND packed.target_unit_id = NEW.source_unit_id
      AND packed.relationship_type = 'PACKED_INTO'
  ) THEN
    RAISE EXCEPTION 'only a package with recorded contents may be shipped'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM product_genealogy_events prior
    WHERE prior.tenant_id = NEW.tenant_id AND prior.factory_id = NEW.factory_id
      AND prior.source_unit_id = NEW.source_unit_id
      AND prior.relationship_type = 'SHIPPED_AS'
  ) THEN
    RAISE EXCEPTION 'a package identity may be dispatched in only one shipment'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_traceability_pack_ship_genealogy_guard ON product_genealogy_events;
CREATE TRIGGER trg_traceability_pack_ship_genealogy_guard
BEFORE INSERT ON product_genealogy_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_pack_ship_genealogy_event();

CREATE OR REPLACE FUNCTION factoryos_guard_shipment_customer_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.unit_type = 'SHIPMENT' THEN
    IF NEW.product_role <> 'SHIPMENT'
      OR btrim(COALESCE(NEW.attributes->>'customer_reference', '')) = ''
      OR btrim(COALESCE(NEW.attributes->>'customer_order_reference', '')) = ''
      OR btrim(COALESCE(NEW.attributes->>'shipment_reference', '')) = '' THEN
      RAISE EXCEPTION 'shipment identity requires customer_reference, customer_order_reference and shipment_reference'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.unit_type = 'SHIPMENT'
    AND NEW.status = 'SHIPPED'
    AND OLD.status <> 'SHIPPED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM product_genealogy_events e
      JOIN traceability_units p
        ON p.id = e.source_unit_id AND p.tenant_id = e.tenant_id AND p.factory_id = e.factory_id
      WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
        AND e.target_unit_id = NEW.id AND e.relationship_type = 'SHIPPED_AS'
        AND p.product_role = 'PACKAGING' AND p.unit_type IN ('CARTON', 'PALLET')
    ) THEN
      RAISE EXCEPTION 'shipment cannot transition to SHIPPED before a packaged carton/pallet is assigned'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_traceability_shipment_lifecycle_guard ON traceability_units;
CREATE TRIGGER trg_traceability_shipment_lifecycle_guard
BEFORE INSERT OR UPDATE ON traceability_units
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_shipment_customer_lifecycle();

COMMENT ON FUNCTION factoryos_guard_pack_ship_genealogy_event() IS
  'Enforces finished-good to carton/pallet packing, carton-to-pallet nesting, and package-to-shipment customer-reference traceability.';
COMMENT ON FUNCTION factoryos_guard_shipment_customer_lifecycle() IS
  'Requires shipment/customer/order references and prevents SHIPPED status before a package genealogy edge exists.';

INSERT INTO schema_migrations(version, checksum)
VALUES ('201_wms_pack_ship_customer_traceability', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
