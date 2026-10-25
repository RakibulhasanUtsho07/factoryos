BEGIN;

-- Apply the same effective policy and availability filters to direct genealogy writes
-- as the reservation planner uses for tracked material allocation.
CREATE OR REPLACE FUNCTION factoryos_guard_product_genealogy_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_quantity NUMERIC(18,4);
  v_source_unit VARCHAR(50);
  v_source_item UUID;
  v_source_type VARCHAR(24);
  v_source_role VARCHAR(20);
  v_source_status VARCHAR(16);
  v_source_expiry DATE;
  v_source_created TIMESTAMPTZ;
  v_target_status VARCHAR(16);
  v_policy VARCHAR(12);
  v_cycle BOOLEAN;
  v_prior_quantity NUMERIC(18,4);
  v_earlier_candidate BOOLEAN;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'product genealogy evidence is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'genealogy event actor must match the authenticated user'
      USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::text || ':' || NEW.factory_id::text || ':product-genealogy-graph', 0
  ));

  SELECT u.quantity, u.unit, u.inventory_item_id, u.unit_type, u.product_role, u.status, u.expires_at, u.created_at
    INTO v_source_quantity, v_source_unit, v_source_item, v_source_type, v_source_role, v_source_status, v_source_expiry, v_source_created
  FROM traceability_units u
  WHERE u.id = NEW.source_unit_id AND u.tenant_id = NEW.tenant_id AND u.factory_id = NEW.factory_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'genealogy source unit is missing from this factory'
      USING ERRCODE = '23503';
  END IF;
  SELECT u.status INTO v_target_status
  FROM traceability_units u
  WHERE u.id = NEW.target_unit_id AND u.tenant_id = NEW.tenant_id AND u.factory_id = NEW.factory_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'genealogy target unit is missing from this factory'
      USING ERRCODE = '23503';
  END IF;
  IF v_source_status IN ('QUARANTINED', 'RECALLED', 'DISPOSED', 'SHIPPED')
     OR v_target_status IN ('QUARANTINED', 'RECALLED', 'DISPOSED', 'SHIPPED') THEN
    RAISE EXCEPTION 'genealogy cannot be changed using quarantined, recalled, disposed or shipped identities'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.quantity > v_source_quantity THEN
    RAISE EXCEPTION 'genealogy quantity cannot exceed the source lot/serial quantity'
      USING ERRCODE = '23514';
  END IF;
  NEW.unit := v_source_unit;

  SELECT COALESCE(sum(e.quantity), 0)::numeric(18,4)
    INTO v_prior_quantity
  FROM product_genealogy_events e
  WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    AND e.source_unit_id = NEW.source_unit_id;
  IF v_prior_quantity + NEW.quantity > v_source_quantity THEN
    RAISE EXCEPTION 'cumulative genealogy relationship quantity cannot exceed source identity quantity'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.relationship_type IN ('CONSUMED_INTO', 'PROCESSED_INTO') THEN
    SELECT COALESCE(sum(e.quantity), 0)::numeric(18,4)
      INTO v_prior_quantity
    FROM product_genealogy_events e
    WHERE e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
      AND e.source_unit_id = NEW.source_unit_id
      AND e.relationship_type IN ('CONSUMED_INTO', 'PROCESSED_INTO');
    IF v_prior_quantity + NEW.quantity > v_source_quantity THEN
      RAISE EXCEPTION 'cumulative genealogy consumption cannot exceed source quantity'
        USING ERRCODE = '23514';
    END IF;

    IF v_source_role = 'MATERIAL' THEN
      SELECT COALESCE(
        (
          SELECT p.allocation_policy
          FROM inventory_material_allocation_policies p
          WHERE p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id
            AND p.policy_scope = 'MATERIAL' AND p.inventory_item_id = v_source_item
        ),
        (
          SELECT p.allocation_policy
          FROM inventory_material_allocation_policies p
          JOIN inventory_items i
            ON i.id = v_source_item AND i.tenant_id = p.tenant_id AND i.factory_id = p.factory_id
          WHERE p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id
            AND p.policy_scope = 'SECTOR'
            AND i.sector_code IS NOT NULL
            AND lower(p.sector_code) = lower(i.sector_code)
        ),
        (
          SELECT p.allocation_policy
          FROM inventory_material_allocation_policies p
          WHERE p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id
            AND p.policy_scope = 'FACTORY'
        ),
        ts.allocation_policy,
        'FIFO'
      ) INTO v_policy
      FROM traceability_settings ts
      WHERE ts.tenant_id = NEW.tenant_id AND ts.factory_id = NEW.factory_id
      FOR SHARE OF ts;
      IF v_policy = 'LOT' AND v_source_type <> 'LOT' THEN
        RAISE EXCEPTION 'factory allocation policy requires material lots'
          USING ERRCODE = '23514';
      ELSIF v_policy = 'SERIAL' AND v_source_type <> 'SERIAL' THEN
        RAISE EXCEPTION 'factory allocation policy requires material serial identities'
          USING ERRCODE = '23514';
      ELSIF v_policy = 'FEFO' AND v_source_expiry IS NOT NULL AND v_source_expiry < CURRENT_DATE THEN
        RAISE EXCEPTION 'expired material cannot be consumed under FEFO allocation policy'
          USING ERRCODE = '23514';
      ELSIF v_policy IN ('FIFO', 'FEFO') THEN
        IF v_source_item IS NULL THEN
          RAISE EXCEPTION 'FIFO/FEFO genealogy requires a source identity mapped to an inventory item'
            USING ERRCODE = '23514';
        END IF;
        SELECT EXISTS (
          SELECT 1
          FROM traceability_units c
          WHERE c.tenant_id = NEW.tenant_id AND c.factory_id = NEW.factory_id
            AND c.inventory_item_id = v_source_item
            AND c.product_role = 'MATERIAL'
            AND c.unit_type IN ('LOT', 'SERIAL')
            AND c.id <> NEW.source_unit_id
            AND c.status = 'ACTIVE'
            AND (c.expires_at IS NULL OR c.expires_at >= CURRENT_DATE)
            AND EXISTS (
              SELECT 1
              FROM inventory_traceability_location_balances tlb
              JOIN inventory_locations l
                ON l.id = tlb.location_id AND l.tenant_id = tlb.tenant_id AND l.factory_id = tlb.factory_id
              LEFT JOIN inventory_locations parent
                ON parent.id = l.parent_location_id AND parent.tenant_id = l.tenant_id AND parent.factory_id = l.factory_id
              WHERE tlb.tenant_id = c.tenant_id AND tlb.factory_id = c.factory_id
                AND tlb.item_id = c.inventory_item_id AND tlb.traceability_unit_id = c.id
                AND tlb.quantity_on_hand > tlb.quantity_reserved
                AND l.status = 'ACTIVE' AND l.picking_enabled = TRUE AND l.location_type = 'BIN'
                AND parent.location_type IN ('WAREHOUSE', 'STAGING') AND parent.status = 'ACTIVE'
            )
            AND NOT (c.attributes @> '{"damaged":true}'::jsonb)
            AND NOT (c.attributes @> '{"held":true}'::jsonb)
            AND NOT (c.attributes @> '{"quarantined":true}'::jsonb)
            AND upper(COALESCE(c.attributes->>'condition','')) NOT IN ('DAMAGED','HELD','QUARANTINED','EXPIRED')
            AND NOT EXISTS (
              SELECT 1 FROM quality_holds qh
              WHERE qh.tenant_id = c.tenant_id AND qh.factory_id = c.factory_id
                AND qh.status = 'ACTIVE'
                AND (qh.inventory_item_id = c.inventory_item_id OR qh.traceability_unit_id = c.id)
            )
            AND (
              (v_policy = 'FIFO' AND (c.created_at, c.id) < (v_source_created, NEW.source_unit_id))
              OR
              (v_policy = 'FEFO' AND (
                (c.expires_at IS NOT NULL AND v_source_expiry IS NULL)
                OR c.expires_at < v_source_expiry
                OR (c.expires_at IS NOT DISTINCT FROM v_source_expiry
                    AND (c.created_at, c.id) < (v_source_created, NEW.source_unit_id))
              ))
            )
        ) INTO v_earlier_candidate;
        IF v_earlier_candidate THEN
          RAISE EXCEPTION 'an earlier eligible material identity must be consumed first under % policy', v_policy
            USING ERRCODE = '23514';
        END IF;
      END IF;
    END IF;
  END IF;

  WITH RECURSIVE descendants(unit_id, visited) AS (
    SELECT NEW.target_unit_id, ARRAY[NEW.target_unit_id]::uuid[]
    UNION ALL
    SELECT e.target_unit_id, d.visited || e.target_unit_id
    FROM descendants d
    JOIN product_genealogy_events e
      ON e.source_unit_id = d.unit_id AND e.tenant_id = NEW.tenant_id AND e.factory_id = NEW.factory_id
    WHERE NOT e.target_unit_id = ANY(d.visited)
  )
  SELECT EXISTS (SELECT 1 FROM descendants WHERE unit_id = NEW.source_unit_id) INTO v_cycle;
  IF v_cycle THEN
    RAISE EXCEPTION 'genealogy relationship would create a traceability cycle'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;;

INSERT INTO schema_migrations(version, checksum)
VALUES ('198_wp02_production_output_genealogy', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
