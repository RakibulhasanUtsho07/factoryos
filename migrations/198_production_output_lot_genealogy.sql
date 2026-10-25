BEGIN;

-- WP02: make every new production output posting traceable to its finished-good
-- lot and (when present) its non-sellable scrap evidence, without backfilling
-- historical stock to an identity that may no longer exist physically.
ALTER TABLE production_output_postings
  ADD COLUMN IF NOT EXISTS traceability_unit_id UUID,
  ADD COLUMN IF NOT EXISTS scrap_traceability_unit_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'production_output_postings'::regclass
      AND conname = 'fk_production_output_posting_traceability_unit'
  ) THEN
    ALTER TABLE production_output_postings
      ADD CONSTRAINT fk_production_output_posting_traceability_unit
      FOREIGN KEY (traceability_unit_id, tenant_id, factory_id, finished_item_id)
      REFERENCES traceability_units (id, tenant_id, factory_id, inventory_item_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'production_output_postings'::regclass
      AND conname = 'fk_production_output_posting_scrap_traceability_unit'
  ) THEN
    ALTER TABLE production_output_postings
      ADD CONSTRAINT fk_production_output_posting_scrap_traceability_unit
      FOREIGN KEY (scrap_traceability_unit_id, tenant_id, factory_id)
      REFERENCES traceability_units (id, tenant_id, factory_id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_production_output_posting_traceability_unit
  ON production_output_postings (traceability_unit_id)
  WHERE traceability_unit_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_production_output_posting_scrap_traceability_unit
  ON production_output_postings (scrap_traceability_unit_id)
  WHERE scrap_traceability_unit_id IS NOT NULL;

CREATE OR REPLACE FUNCTION factoryos_guard_production_output_traceability_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_report_order_id UUID;
  v_report_order_line_id UUID;
  v_trace RECORD;
BEGIN
  SELECT r.order_id, r.order_line_id
    INTO v_report_order_id, v_report_order_line_id
  FROM order_production_reports r
  WHERE r.id = NEW.production_report_id
    AND r.tenant_id = NEW.tenant_id
    AND r.factory_id = NEW.factory_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'production traceability requires a report in the same tenant/factory'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.good_quantity > 0 THEN
    IF NEW.traceability_unit_id IS NULL THEN
      RAISE EXCEPTION 'positive accepted good output requires a finished-good traceability lot'
        USING ERRCODE = '23514';
    END IF;

    SELECT u.unit_type, u.product_role, u.inventory_item_id, u.quantity,
           u.unit, u.status, u.production_report_id, u.order_id, u.order_line_id
      INTO v_trace
    FROM traceability_units u
    WHERE u.id = NEW.traceability_unit_id
      AND u.tenant_id = NEW.tenant_id
      AND u.factory_id = NEW.factory_id
    FOR SHARE;

    IF NOT FOUND
      OR v_trace.unit_type <> 'LOT'
      OR v_trace.product_role <> 'FINISHED_GOOD'
      OR v_trace.inventory_item_id IS DISTINCT FROM NEW.finished_item_id
      OR v_trace.quantity IS DISTINCT FROM NEW.good_quantity
      OR v_trace.status <> 'ACTIVE'
      OR v_trace.production_report_id IS DISTINCT FROM NEW.production_report_id
      OR v_trace.order_id IS DISTINCT FROM v_report_order_id
      OR v_trace.order_line_id IS DISTINCT FROM v_report_order_line_id
    THEN
      RAISE EXCEPTION 'finished-good traceability lot must match the report, item, order line and accepted good quantity'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.traceability_unit_id IS NOT NULL THEN
    RAISE EXCEPTION 'scrap-only output cannot have a sellable finished-good lot'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.scrap_quantity > 0 THEN
    IF NEW.scrap_traceability_unit_id IS NULL THEN
      RAISE EXCEPTION 'positive scrap quantity requires a non-sellable scrap traceability identity'
        USING ERRCODE = '23514';
    END IF;

    SELECT u.unit_type, u.product_role, u.inventory_item_id, u.quantity,
           u.unit, u.status, u.attributes
      INTO v_trace
    FROM traceability_units u
    WHERE u.id = NEW.scrap_traceability_unit_id
      AND u.tenant_id = NEW.tenant_id
      AND u.factory_id = NEW.factory_id
    FOR SHARE;

    IF NOT FOUND
      OR v_trace.unit_type <> 'LOT'
      OR v_trace.product_role <> 'OTHER'
      OR v_trace.inventory_item_id IS NOT NULL
      OR v_trace.quantity IS DISTINCT FROM NEW.scrap_quantity
      OR v_trace.status <> 'ACTIVE'
      OR v_trace.attributes->>'kind' <> 'PRODUCTION_SCRAP'
      OR v_trace.attributes->>'production_report_id' <> NEW.production_report_id::text
      OR v_trace.attributes->>'finished_item_id' <> NEW.finished_item_id::text
    THEN
      RAISE EXCEPTION 'scrap traceability identity must match this report and remain outside sellable inventory'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.scrap_traceability_unit_id IS NOT NULL THEN
    RAISE EXCEPTION 'zero scrap quantity cannot have a scrap traceability identity'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_production_output_posting_traceability_link ON production_output_postings;
CREATE TRIGGER trg_production_output_posting_traceability_link
BEFORE INSERT ON production_output_postings
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_production_output_traceability_link();

CREATE OR REPLACE FUNCTION factoryos_guard_product_genealogy_event()
RETURNS trigger
LANGUAGE plpgsql
AS $
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
              AND (qh.inventory_item_id = c.inventory_item_id OR qh.traceability_unit_id = c.id)
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
$;

COMMENT ON COLUMN production_output_postings.traceability_unit_id IS
  'Finished-good lot created atomically with accepted good output; NULL only when the report has zero good quantity or for historical rows predating this gate.';
COMMENT ON COLUMN production_output_postings.scrap_traceability_unit_id IS
  'Non-sellable evidence identity for scrap output; it has no inventory item or stock balance and is never received as finished goods.';

INSERT INTO schema_migrations(version, checksum)
VALUES ('198_production_output_lot_genealogy', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
