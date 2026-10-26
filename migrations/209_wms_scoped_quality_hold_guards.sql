BEGIN;

-- Keep all traceability-aware quality guards consistent: a hold targeting a
-- specific lot/serial must not block an independently inspected sibling lot
-- of the same SKU. A hold without a traceability identity remains item-wide.
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
  v_source_received_at TIMESTAMPTZ;
  v_source_unit_code VARCHAR(160);
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

  SELECT u.quantity, u.unit, u.inventory_item_id, u.unit_type, u.product_role,
         u.status, u.expires_at, u.created_at, u.unit_code,
         COALESCE(gr.posted_at, gr.received_at, u.created_at)
    INTO v_source_quantity, v_source_unit, v_source_item, v_source_type, v_source_role,
         v_source_status, v_source_expiry, v_source_created, v_source_unit_code, v_source_received_at
  FROM traceability_units u
  LEFT JOIN goods_receipts gr
    ON gr.id = u.goods_receipt_id AND gr.tenant_id = u.tenant_id AND gr.factory_id = u.factory_id
  WHERE u.id = NEW.source_unit_id AND u.tenant_id = NEW.tenant_id AND u.factory_id = NEW.factory_id
  FOR UPDATE OF u;

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

  IF NEW.relationship_type IN ('CONSUMED_INTO', 'PROCESSED_INTO') AND v_source_role = 'MATERIAL' THEN
    -- Resolve policy in the same precedence as the reservation allocator:
    -- material override, sector override, factory override, factory settings.
    SELECT COALESCE(
      (SELECT p.allocation_policy
       FROM inventory_material_allocation_policies p
       WHERE p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id
         AND p.policy_scope = 'MATERIAL' AND p.inventory_item_id = v_source_item),
      (SELECT p.allocation_policy
       FROM inventory_material_allocation_policies p
       JOIN inventory_items i ON i.id = v_source_item
         AND i.tenant_id = p.tenant_id AND i.factory_id = p.factory_id
       WHERE p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id
         AND p.policy_scope = 'SECTOR' AND lower(p.sector_code) = lower(i.sector_code)),
      (SELECT p.allocation_policy
       FROM inventory_material_allocation_policies p
       WHERE p.tenant_id = NEW.tenant_id AND p.factory_id = NEW.factory_id
         AND p.policy_scope = 'FACTORY'),
      (SELECT ts.allocation_policy
       FROM traceability_settings ts
       WHERE ts.tenant_id = NEW.tenant_id AND ts.factory_id = NEW.factory_id),
      'FIFO'
    ) INTO v_policy;

    IF v_policy = 'LOT' AND v_source_type <> 'LOT' THEN
      RAISE EXCEPTION 'material allocation policy requires a LOT source identity'
        USING ERRCODE = '23514';
    ELSIF v_policy = 'SERIAL' AND v_source_type <> 'SERIAL' THEN
      RAISE EXCEPTION 'material allocation policy requires a SERIAL source identity'
        USING ERRCODE = '23514';
    ELSIF v_policy = 'FEFO' AND v_source_expiry IS NOT NULL AND v_source_expiry < CURRENT_DATE THEN
      RAISE EXCEPTION 'expired material cannot be consumed under FEFO allocation policy'
        USING ERRCODE = '23514';
    ELSIF v_policy IN ('FIFO', 'FEFO') THEN
      IF v_source_item IS NULL THEN
        RAISE EXCEPTION 'FIFO/FEFO genealogy requires a source identity mapped to an inventory item'
          USING ERRCODE = '23514';
      END IF;

      -- The allocation service consumes only active, unexpired, unheld stock in
      -- active picking bins. Look at its remaining unreserved balance here too:
      -- original registered quantity alone would incorrectly block valid issues
      -- after legacy consumption that predates genealogy evidence.
      SELECT EXISTS (
        SELECT 1
        FROM traceability_units c
        LEFT JOIN goods_receipts cgr
          ON cgr.id = c.goods_receipt_id AND cgr.tenant_id = c.tenant_id AND cgr.factory_id = c.factory_id
        JOIN inventory_traceability_location_balances tlb
          ON tlb.traceability_unit_id = c.id
         AND tlb.tenant_id = c.tenant_id AND tlb.factory_id = c.factory_id
         AND tlb.item_id = c.inventory_item_id
        JOIN inventory_locations l
          ON l.id = tlb.location_id AND l.tenant_id = tlb.tenant_id AND l.factory_id = tlb.factory_id
        LEFT JOIN inventory_locations parent
          ON parent.id = l.parent_location_id AND parent.tenant_id = l.tenant_id AND parent.factory_id = l.factory_id
        WHERE c.tenant_id = NEW.tenant_id AND c.factory_id = NEW.factory_id
          AND c.inventory_item_id = v_source_item AND c.product_role = 'MATERIAL'
          AND c.unit_type = v_source_type AND c.id <> NEW.source_unit_id
          AND c.status = 'ACTIVE'
          AND (c.expires_at IS NULL OR c.expires_at >= CURRENT_DATE)
          AND NOT (c.attributes @> '{"damaged":true}'::jsonb)
          AND NOT (c.attributes @> '{"held":true}'::jsonb)
          AND NOT (c.attributes @> '{"quarantined":true}'::jsonb)
          AND upper(COALESCE(c.attributes->>'condition', '')) NOT IN ('DAMAGED','HELD','QUARANTINED','EXPIRED')
          AND NOT EXISTS (
            SELECT 1 FROM quality_holds qh
            WHERE qh.tenant_id = c.tenant_id AND qh.factory_id = c.factory_id
              AND qh.status = 'ACTIVE'
              AND (
                qh.traceability_unit_id = c.id
                OR (qh.traceability_unit_id IS NULL AND qh.inventory_item_id = c.inventory_item_id)
              )
          )
          AND l.status = 'ACTIVE' AND l.picking_enabled = TRUE AND l.location_type = 'BIN'
          AND parent.location_type IN ('WAREHOUSE', 'STAGING') AND parent.status = 'ACTIVE'
          AND tlb.quantity_on_hand > tlb.quantity_reserved
          AND (
            (v_policy = 'FIFO' AND (
              COALESCE(cgr.posted_at, cgr.received_at, c.created_at) < v_source_received_at
              OR (
                COALESCE(cgr.posted_at, cgr.received_at, c.created_at) = v_source_received_at
                AND (lower(c.unit_code), c.id) < (lower(v_source_unit_code), NEW.source_unit_id)
              )
            ))
            OR
            (v_policy = 'FEFO' AND (
              (c.expires_at IS NOT NULL AND v_source_expiry IS NULL)
              OR (v_source_expiry IS NOT NULL AND c.expires_at IS NOT NULL AND c.expires_at < v_source_expiry)
              OR (
                c.expires_at IS NOT DISTINCT FROM v_source_expiry
                AND (
                  COALESCE(cgr.posted_at, cgr.received_at, c.created_at) < v_source_received_at
                  OR (
                    COALESCE(cgr.posted_at, cgr.received_at, c.created_at) = v_source_received_at
                    AND (lower(c.unit_code), c.id) < (lower(v_source_unit_code), NEW.source_unit_id)
                  )
                )
              )
            ))
          )
      ) INTO v_earlier_candidate;
      IF v_earlier_candidate THEN
        RAISE EXCEPTION 'an earlier eligible unreserved material identity must be consumed first under % policy', v_policy
          USING ERRCODE = '23514';
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
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_wms_packing_content()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_container wms_packing_containers%ROWTYPE;
  v_source traceability_units%ROWTYPE;
  v_source_container wms_packing_containers%ROWTYPE;
  v_event product_genealogy_events%ROWTYPE;
  v_location_quantity NUMERIC(18,4);
  v_location_reserved NUMERIC(18,4);
  v_already_packed NUMERIC(18,4);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'WMS packing content evidence is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'packing content actor must match the authenticated user'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_container
  FROM wms_packing_containers
  WHERE container_unit_id = NEW.container_unit_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
  FOR UPDATE;
  IF NOT FOUND OR v_container.status <> 'OPEN' OR v_container.item_id <> NEW.item_id
     OR v_container.location_id <> NEW.location_id OR v_container.unit <> NEW.unit THEN
    RAISE EXCEPTION 'packing content must target an open same-item container at the same physical location'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_source
  FROM traceability_units
  WHERE id = NEW.source_unit_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
  FOR UPDATE;
  IF NOT FOUND OR v_source.status <> 'ACTIVE' OR v_source.unit <> NEW.unit THEN
    RAISE EXCEPTION 'packing source must be an active same-UOM traceability identity'
      USING ERRCODE = '23514';
  END IF;

  IF v_container.container_type = 'CARTON' THEN
    IF v_source.unit_type <> 'LOT' OR v_source.product_role <> 'FINISHED_GOOD'
       OR v_source.inventory_item_id <> NEW.item_id OR NEW.source_container_unit_id IS NOT NULL THEN
      RAISE EXCEPTION 'cartons may only contain finished-good lot quantities'
        USING ERRCODE = '23514';
    END IF;
    SELECT quantity_on_hand, quantity_reserved INTO v_location_quantity, v_location_reserved
    FROM inventory_traceability_location_balances
    WHERE tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id AND item_id = NEW.item_id
      AND traceability_unit_id = NEW.source_unit_id AND location_id = NEW.location_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'finished-good lot has no tracked stock at this location'
        USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(sum(pc.quantity),0)::numeric(18,4)
      INTO v_already_packed
    FROM wms_packing_contents pc
    JOIN wms_packing_containers existing_carton
      ON existing_carton.container_unit_id=pc.container_unit_id
     AND existing_carton.tenant_id=pc.tenant_id AND existing_carton.factory_id=pc.factory_id
    WHERE pc.tenant_id=NEW.tenant_id AND pc.factory_id=NEW.factory_id
      AND pc.item_id=NEW.item_id AND pc.source_unit_id=NEW.source_unit_id
      AND pc.source_container_unit_id IS NULL
      AND existing_carton.container_type='CARTON'
      AND existing_carton.status <> 'DISPATCHED';
    IF v_location_quantity - v_location_reserved - v_already_packed < NEW.quantity THEN
      RAISE EXCEPTION 'packing quantity exceeds finished-good lot quantity not already packed into live cartons'
        USING ERRCODE = '23514';
    END IF;
    IF (v_source.expires_at IS NOT NULL AND v_source.expires_at < CURRENT_DATE)
       OR COALESCE(v_source.attributes @> '{"damaged":true}'::jsonb, FALSE)
       OR COALESCE(v_source.attributes @> '{"held":true}'::jsonb, FALSE)
       OR COALESCE(v_source.attributes @> '{"quarantined":true}'::jsonb, FALSE)
       OR upper(COALESCE(v_source.attributes->>'condition','')) IN ('DAMAGED','HELD','QUARANTINED','EXPIRED')
       OR EXISTS (
         SELECT 1 FROM quality_holds qh WHERE qh.tenant_id=NEW.tenant_id AND qh.factory_id=NEW.factory_id
          AND qh.status='ACTIVE'
          AND (
            qh.traceability_unit_id=NEW.source_unit_id
            OR (qh.traceability_unit_id IS NULL AND qh.inventory_item_id=NEW.item_id)
          )
       ) THEN
      RAISE EXCEPTION 'held, expired, damaged or quarantined finished-good lots cannot be packed'
        USING ERRCODE = '23514';
    END IF;
  ELSIF v_container.container_type = 'PALLET' THEN
    IF v_source.unit_type <> 'CARTON' OR v_source.product_role <> 'PACKAGING'
       OR NEW.source_container_unit_id IS DISTINCT FROM NEW.source_unit_id THEN
      RAISE EXCEPTION 'pallets may only contain sealed cartons'
        USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_source_container
    FROM wms_packing_containers
    WHERE container_unit_id = NEW.source_unit_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id
    FOR UPDATE;
    IF NOT FOUND OR v_source_container.container_type <> 'CARTON'
       OR v_source_container.status <> 'SEALED'
       OR v_source_container.item_id <> NEW.item_id OR v_source_container.location_id <> NEW.location_id
       OR v_source_container.packed_quantity IS DISTINCT FROM NEW.quantity THEN
      RAISE EXCEPTION 'pallet contents must be whole sealed same-item cartons at the same location'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported packing container type'
      USING ERRCODE = '23514';
  END IF;

  IF v_container.packed_quantity + NEW.quantity > v_container.capacity_quantity THEN
    RAISE EXCEPTION 'packing would exceed the container capacity'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_event
  FROM product_genealogy_events
  WHERE id = NEW.genealogy_event_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
  IF NOT FOUND OR v_event.source_unit_id <> NEW.source_unit_id
     OR v_event.target_unit_id <> NEW.container_unit_id
     OR v_event.relationship_type <> 'PACKED_INTO'
     OR v_event.quantity IS DISTINCT FROM NEW.quantity OR v_event.unit <> NEW.unit THEN
    RAISE EXCEPTION 'packing content must match its immutable PACKED_INTO genealogy event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

INSERT INTO schema_migrations(version, checksum)
VALUES ('209_wms_scoped_quality_hold_guards', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
