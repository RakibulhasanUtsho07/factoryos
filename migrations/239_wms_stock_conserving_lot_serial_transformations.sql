-- WP02 / SRS v2.1 FR-WMS-02, FR-WMS-04 and FR-WMS-09.
-- Real LOT split/merge commands conserve aggregate and per-location stock,
-- reject reserved/held/unreconciled sources, and bind genealogy to command evidence.
BEGIN;


-- Preserve the original GRN/FIFO precedence when a source identity is split or merged.
ALTER TABLE traceability_units
  ADD COLUMN IF NOT EXISTS allocation_received_at_override TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION factoryos_guard_traceability_received_at_override()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.allocation_received_at_override IS NOT NULL
       AND current_setting('app.traceability_transformation', TRUE) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'allocation receipt timestamp override is reserved for stock-conserving LOT/SERIAL commands'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.allocation_received_at_override IS DISTINCT FROM OLD.allocation_received_at_override
     AND current_setting('app.traceability_transformation', TRUE) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'allocation receipt timestamp override is immutable outside stock-conserving LOT/SERIAL commands'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_traceability_received_at_override_guard ON traceability_units;
CREATE TRIGGER a_traceability_received_at_override_guard
BEFORE INSERT OR UPDATE OF allocation_received_at_override ON traceability_units
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_traceability_received_at_override();


CREATE TABLE IF NOT EXISTS inventory_traceability_transformations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  inventory_item_id UUID NOT NULL,
  operation_type VARCHAR(8) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  reason TEXT NOT NULL,
  total_quantity NUMERIC(18,4) NOT NULL,
  unit VARCHAR(50) NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_inventory_traceability_transformation_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_inventory_traceability_transformation_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_inventory_traceability_transformation_item
    FOREIGN KEY (inventory_item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_traceability_transformation_actor
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_traceability_transformation_operation CHECK (operation_type IN ('SPLIT', 'MERGE')),
  CONSTRAINT chk_inventory_traceability_transformation_hash CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_inventory_traceability_transformation_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT chk_inventory_traceability_transformation_quantity CHECK (total_quantity > 0),
  CONSTRAINT chk_inventory_traceability_transformation_unit CHECK (length(btrim(unit)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_inventory_traceability_transformations_item_created
  ON inventory_traceability_transformations (tenant_id, factory_id, inventory_item_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS inventory_traceability_transformation_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  transformation_id UUID NOT NULL,
  source_unit_id UUID NOT NULL,
  target_unit_id UUID NOT NULL,
  location_id UUID NOT NULL,
  relationship_type VARCHAR(24) NOT NULL,
  quantity NUMERIC(18,4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_inventory_traceability_transformation_line UNIQUE
    (tenant_id, factory_id, transformation_id, source_unit_id, target_unit_id, location_id),
  CONSTRAINT fk_inventory_traceability_transformation_line_command
    FOREIGN KEY (transformation_id, tenant_id, factory_id)
    REFERENCES inventory_traceability_transformations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_traceability_transformation_line_source
    FOREIGN KEY (source_unit_id, tenant_id, factory_id)
    REFERENCES traceability_units (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_traceability_transformation_line_target
    FOREIGN KEY (target_unit_id, tenant_id, factory_id)
    REFERENCES traceability_units (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_traceability_transformation_line_location
    FOREIGN KEY (location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_traceability_transformation_line_type CHECK
    (relationship_type IN ('SPLIT_INTO', 'MERGED_INTO')),
  CONSTRAINT chk_inventory_traceability_transformation_line_quantity CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_inventory_traceability_transformation_lines_source
  ON inventory_traceability_transformation_lines (tenant_id, factory_id, source_unit_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_inventory_traceability_transformation_lines_target
  ON inventory_traceability_transformation_lines (tenant_id, factory_id, target_unit_id, created_at, id);

ALTER TABLE product_genealogy_events
  ADD COLUMN IF NOT EXISTS transformation_id UUID;

DO $transformation_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_product_genealogy_transformation_command'
      AND conrelid = 'product_genealogy_events'::regclass
  ) THEN
    ALTER TABLE product_genealogy_events
      ADD CONSTRAINT fk_product_genealogy_transformation_command
      FOREIGN KEY (transformation_id, tenant_id, factory_id)
      REFERENCES inventory_traceability_transformations (id, tenant_id, factory_id) ON DELETE RESTRICT;
  END IF;
END;
$transformation_fk$;

CREATE OR REPLACE FUNCTION factoryos_guard_traceability_transformation_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_operation VARCHAR(8);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'lot/serial transformation lines are append-only'
      USING ERRCODE = '55000';
  END IF;
  SELECT operation_type INTO v_operation
  FROM inventory_traceability_transformations
  WHERE id = NEW.transformation_id
    AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
  IF NOT FOUND
     OR (v_operation = 'SPLIT' AND NEW.relationship_type <> 'SPLIT_INTO')
     OR (v_operation = 'MERGE' AND NEW.relationship_type <> 'MERGED_INTO') THEN
    RAISE EXCEPTION 'transformation line does not match its command operation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_traceability_transformation_line_guard
  ON inventory_traceability_transformation_lines;
CREATE TRIGGER inventory_traceability_transformation_line_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory_traceability_transformation_lines
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_traceability_transformation_line();

CREATE OR REPLACE FUNCTION factoryos_guard_traceability_transformation_header()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'lot/serial transformation command evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'lot/serial transformation actor must match the authenticated user'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_traceability_transformation_header_guard
  ON inventory_traceability_transformations;
CREATE TRIGGER inventory_traceability_transformation_header_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory_traceability_transformations
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_traceability_transformation_header();

CREATE OR REPLACE FUNCTION factoryos_assert_traceability_transformation_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id
      AND a.resource_type = 'WMS_LOT_SERIAL_TRANSFORMATION'
      AND a.resource_id = NEW.id AND a.action = 'COMPLETED'
  ) OR NOT EXISTS (
    SELECT 1 FROM outbox_events o
    WHERE o.tenant_id = NEW.tenant_id AND o.factory_id = NEW.factory_id
      AND o.aggregate_type = 'WMS_LOT_SERIAL_TRANSFORMATION'
      AND o.aggregate_id = NEW.id
      AND o.event_type = 'WMS.LOT_SERIAL_TRANSFORMATION_COMPLETED'
  ) OR NOT EXISTS (
    SELECT 1 FROM inventory_traceability_transformation_lines l
    WHERE l.tenant_id = NEW.tenant_id AND l.factory_id = NEW.factory_id
      AND l.transformation_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'lot/serial transformation requires line, audit and outbox evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ctr_inventory_traceability_transformation_evidence
  ON inventory_traceability_transformations;
CREATE CONSTRAINT TRIGGER ctr_inventory_traceability_transformation_evidence
AFTER INSERT ON inventory_traceability_transformations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_traceability_transformation_evidence();

-- Migration 238 remains fail-closed for all ordinary genealogy writes. It now
-- admits only edges exactly backed by a scoped command line written in this tx.
CREATE OR REPLACE FUNCTION factoryos_require_stock_conserving_genealogy_transformation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_operation VARCHAR(8);
  v_line_quantity NUMERIC(18,4);
BEGIN
  IF NEW.relationship_type NOT IN ('SPLIT_INTO', 'MERGED_INTO') THEN
    RETURN NEW;
  END IF;
  IF NEW.transformation_id IS NULL THEN
    RAISE EXCEPTION
      'SPLIT_INTO and MERGED_INTO require a dedicated stock-conserving transformation command; generic genealogy writes are blocked'
      USING ERRCODE = '23514';
  END IF;

  SELECT h.operation_type, COALESCE(SUM(l.quantity), 0)
    INTO v_operation, v_line_quantity
  FROM inventory_traceability_transformations h
  JOIN inventory_traceability_transformation_lines l
    ON l.transformation_id = h.id
   AND l.tenant_id = h.tenant_id AND l.factory_id = h.factory_id
  WHERE h.id = NEW.transformation_id
    AND h.tenant_id = NEW.tenant_id AND h.factory_id = NEW.factory_id
    AND l.source_unit_id = NEW.source_unit_id
    AND l.target_unit_id = NEW.target_unit_id
    AND l.relationship_type = NEW.relationship_type
  GROUP BY h.operation_type;

  IF v_operation IS DISTINCT FROM CASE NEW.relationship_type
      WHEN 'SPLIT_INTO' THEN 'SPLIT' ELSE 'MERGE' END
     OR v_line_quantity IS DISTINCT FROM NEW.quantity THEN
    RAISE EXCEPTION
      'transformation genealogy edge must exactly match its immutable command line quantity and endpoints'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Avoid the generic traceability-unit seed hook assigning extra UNASSIGNED stock
-- to new child identities. The command binds every output identity explicitly
-- to the exact existing source BINs in the same transaction.
CREATE OR REPLACE FUNCTION factoryos_seed_inventory_traceability_location_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_location_id UUID;
  v_location_quantity NUMERIC(18,4);
  v_tracked_quantity NUMERIC(18,4);
  v_bind_quantity NUMERIC(18,4);
BEGIN
  IF current_setting('app.traceability_transformation', TRUE) = 'on'
     OR NEW.inventory_item_id IS NULL
     OR NEW.product_role <> 'MATERIAL'
     OR NEW.unit_type NOT IN ('LOT', 'SERIAL')
     OR NEW.status IN ('SHIPPED', 'DISPOSED') THEN
    RETURN NEW;
  END IF;

  SELECT l.id INTO v_location_id
  FROM inventory_locations l
  WHERE l.tenant_id = NEW.tenant_id
    AND l.factory_id = NEW.factory_id
    AND l.is_default = TRUE
    AND l.location_type = 'VIRTUAL'
    AND l.status = 'ACTIVE'
  FOR UPDATE;

  IF v_location_id IS NULL THEN
    RAISE EXCEPTION 'material lot/serial registration requires the factory UNASSIGNED stock bucket'
      USING ERRCODE = '23514';
  END IF;

  SELECT lb.quantity_on_hand INTO v_location_quantity
  FROM inventory_location_balances lb
  WHERE lb.tenant_id = NEW.tenant_id
    AND lb.factory_id = NEW.factory_id
    AND lb.item_id = NEW.inventory_item_id
    AND lb.location_id = v_location_id
  FOR UPDATE;

  SELECT COALESCE(SUM(tlb.quantity_on_hand), 0)
    INTO v_tracked_quantity
  FROM inventory_traceability_location_balances tlb
  WHERE tlb.tenant_id = NEW.tenant_id
    AND tlb.factory_id = NEW.factory_id
    AND tlb.item_id = NEW.inventory_item_id
    AND tlb.location_id = v_location_id;

  v_bind_quantity := LEAST(
    NEW.quantity,
    GREATEST(COALESCE(v_location_quantity, 0) - COALESCE(v_tracked_quantity, 0), 0)
  );

  INSERT INTO inventory_traceability_location_balances (
    tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand
  )
  VALUES (
    NEW.tenant_id, NEW.factory_id, NEW.inventory_item_id, NEW.id, v_location_id, v_bind_quantity
  );
  RETURN NEW;
END;
$$;

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
         COALESCE(gr.posted_at, gr.received_at, u.allocation_received_at_override, u.created_at)
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
              COALESCE(cgr.posted_at, cgr.received_at, c.allocation_received_at_override, c.created_at) < v_source_received_at
              OR (
                COALESCE(cgr.posted_at, cgr.received_at, c.allocation_received_at_override, c.created_at) = v_source_received_at
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
                  COALESCE(cgr.posted_at, cgr.received_at, c.allocation_received_at_override, c.created_at) < v_source_received_at
                  OR (
                    COALESCE(cgr.posted_at, cgr.received_at, c.allocation_received_at_override, c.created_at) = v_source_received_at
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

CREATE OR REPLACE FUNCTION factoryos_execute_lot_serial_transformation(
  p_operation TEXT,
  p_tenant_id UUID,
  p_factory_id UUID,
  p_actor_id UUID,
  p_source_unit_ids UUID[],
  p_target_unit_code TEXT,
  p_outputs JSONB,
  p_reason TEXT,
  p_idempotency_key TEXT,
  p_request_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_operation TEXT := upper(btrim(p_operation));
  v_actor UUID := factoryos_current_user_id();
  v_tenant UUID := factoryos_current_tenant_id();
  v_transformation_id UUID;
  v_correlation_id UUID;
  v_item_id UUID;
  v_item_count INTEGER;
  v_source_count INTEGER;
  v_first_source_set BOOLEAN := FALSE;
  v_unit TEXT;
  v_source_received_at TIMESTAMPTZ;
  v_first_source_received_at TIMESTAMPTZ;
  v_policy VARCHAR(12);
  v_output_unit_type TEXT;
  v_output_type_count INTEGER;
  v_total NUMERIC(18,4) := 0;
  v_consumed NUMERIC(18,4);
  v_tracked NUMERIC(18,4);
  v_reserved NUMERIC(18,4);
  v_source traceability_units%ROWTYPE;
  v_first_source traceability_units%ROWTYPE;
  v_output JSONB;
  v_output_location JSONB;
  v_target_id UUID;
  v_target_type TEXT;
  v_target_code TEXT;
  v_target_barcode TEXT;
  v_target_quantity NUMERIC(18,4);
  v_location RECORD;
  v_source_id UUID;
  v_source_quantity NUMERIC(18,4);
  v_source_locations JSONB;
  v_location_total NUMERIC(18,4);
  v_edge_quantity NUMERIC(18,4);
  v_target_ids JSONB := '[]'::jsonb;
  v_existing RECORD;
  v_status_version BIGINT;
  v_status_from TEXT;
  v_status_reason TEXT;
  v_event_id UUID;
BEGIN
  IF v_operation NOT IN ('SPLIT', 'MERGE') THEN
    RAISE EXCEPTION 'operation must be SPLIT or MERGE' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_id IS NULL OR p_factory_id IS NULL OR p_actor_id IS NULL
     OR p_source_unit_ids IS NULL OR cardinality(p_source_unit_ids) = 0
     OR p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) NOT BETWEEN 1 AND 255
     OR p_request_hash IS NULL OR p_request_hash !~ '^[a-f0-9]{64}$'
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'transformation scope, source identities, key, request hash and reason are required'
      USING ERRCODE = '22023';
  END IF;
  IF v_tenant IS DISTINCT FROM p_tenant_id OR v_actor IS DISTINCT FROM p_actor_id THEN
    RAISE EXCEPTION 'transformation scope must match authenticated tenant and actor context'
      USING ERRCODE = '42501';
  END IF;
  IF cardinality(p_source_unit_ids) <> (
    SELECT count(DISTINCT x) FROM unnest(p_source_unit_ids) AS t(x)
  ) THEN
    RAISE EXCEPTION 'source_unit_ids must not contain duplicates' USING ERRCODE = '22023';
  END IF;
  IF cardinality(p_source_unit_ids) > 100
     OR (v_operation = 'SPLIT' AND cardinality(p_source_unit_ids) <> 1)
     OR (v_operation = 'MERGE' AND cardinality(p_source_unit_ids) < 2) THEN
    RAISE EXCEPTION 'SPLIT requires one source LOT; MERGE requires between 2 and 100 source LOTs'
      USING ERRCODE = '22023';
  END IF;
  IF v_operation = 'SPLIT'
     AND (jsonb_typeof(p_outputs) IS DISTINCT FROM 'array'
       OR jsonb_array_length(CASE WHEN jsonb_typeof(p_outputs) = 'array' THEN p_outputs ELSE '[]'::jsonb END) NOT BETWEEN 2 AND 100) THEN
    RAISE EXCEPTION 'SPLIT requires between 2 and 100 output LOT/SERIAL identities'
      USING ERRCODE = '22023';
  END IF;
  IF v_operation = 'MERGE' AND (p_outputs IS NULL OR p_outputs <> '[]'::jsonb) THEN
    RAISE EXCEPTION 'MERGE does not accept a client-supplied output allocation array'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || p_factory_id::text || ':product-genealogy-graph', 0
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':' || p_factory_id::text || ':lot-serial-transformation:' || p_idempotency_key, 0
  ));

  SELECT id, request_hash
    INTO v_existing
  FROM inventory_traceability_transformations
  WHERE tenant_id = p_tenant_id AND factory_id = p_factory_id
    AND idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'Idempotency-Key was already used for a different LOT/SERIAL transformation'
        USING ERRCODE = '23505';
    END IF;
    SELECT COALESCE(jsonb_agg(DISTINCT l.target_unit_id ORDER BY l.target_unit_id), '[]'::jsonb)
      INTO v_target_ids
    FROM inventory_traceability_transformation_lines l
    WHERE l.tenant_id = p_tenant_id AND l.factory_id = p_factory_id
      AND l.transformation_id = v_existing.id;
    RETURN jsonb_build_object(
      'transformation_id', v_existing.id,
      'operation_type', v_operation,
      'target_unit_ids', v_target_ids,
      'replayed', TRUE
    );
  END IF;

  SELECT count(*), count(DISTINCT u.inventory_item_id), (array_agg(DISTINCT u.inventory_item_id))[1]
    INTO v_source_count, v_item_count, v_item_id
  FROM traceability_units u
  WHERE u.id = ANY(p_source_unit_ids)
    AND u.tenant_id = p_tenant_id AND u.factory_id = p_factory_id;
  IF v_source_count <> cardinality(p_source_unit_ids) THEN
    RAISE EXCEPTION 'one or more source LOT identities do not exist in this factory'
      USING ERRCODE = '23503';
  END IF;
  IF v_item_count <> 1 OR v_item_id IS NULL THEN
    RAISE EXCEPTION 'all source LOT identities must belong to one inventory item in this factory'
      USING ERRCODE = '23514';
  END IF;

  -- Lock roots in the same item -> aggregate -> location -> identity order used
  -- by reservation/issue paths, avoiding a transformation-vs-reservation race.
  PERFORM 1 FROM inventory_items i
  WHERE i.id = v_item_id AND i.tenant_id = p_tenant_id AND i.factory_id = p_factory_id
    AND i.status = 'ACTIVE'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transformation inventory item is missing or inactive'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM inventory_stock_balances b
  WHERE b.tenant_id = p_tenant_id AND b.factory_id = p_factory_id AND b.item_id = v_item_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transformation requires the aggregate inventory stock balance'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM inventory_location_balances b
  WHERE b.tenant_id = p_tenant_id AND b.factory_id = p_factory_id AND b.item_id = v_item_id
  FOR UPDATE;
  PERFORM 1 FROM inventory_traceability_location_balances b
  WHERE b.tenant_id = p_tenant_id AND b.factory_id = p_factory_id
    AND b.item_id = v_item_id AND b.traceability_unit_id = ANY(p_source_unit_ids)
  FOR UPDATE;

  -- Validate source identities only after the common lock roots have been taken.
  FOR v_source IN
    SELECT u.*
    FROM traceability_units u
    WHERE u.id = ANY(p_source_unit_ids)
      AND u.tenant_id = p_tenant_id AND u.factory_id = p_factory_id
    ORDER BY u.id
    FOR UPDATE
  LOOP
    IF v_source.unit_type <> 'LOT' OR v_source.product_role <> 'MATERIAL'
       OR v_source.status <> 'ACTIVE' OR v_source.inventory_item_id IS NULL THEN
      RAISE EXCEPTION 'only ACTIVE material LOT identities mapped to an inventory item can be transformed'
        USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(
      (SELECT COALESCE(gr.posted_at, gr.received_at)
       FROM goods_receipts gr
       WHERE gr.id = v_source.goods_receipt_id
         AND gr.tenant_id = v_source.tenant_id AND gr.factory_id = v_source.factory_id),
      v_source.allocation_received_at_override,
      v_source.created_at
    ) INTO v_source_received_at;
    IF v_source.attributes @> '{"damaged":true}'::jsonb
       OR v_source.attributes @> '{"held":true}'::jsonb
       OR v_source.attributes @> '{"quarantined":true}'::jsonb
       OR upper(COALESCE(v_source.attributes->>'condition', '')) IN ('DAMAGED','HELD','QUARANTINED','EXPIRED')
       OR (v_source.expires_at IS NOT NULL AND v_source.expires_at < CURRENT_DATE)
       OR EXISTS (
         SELECT 1 FROM quality_holds qh
         WHERE qh.tenant_id = p_tenant_id AND qh.factory_id = p_factory_id
           AND qh.status = 'ACTIVE'
           AND (qh.inventory_item_id = v_source.inventory_item_id OR qh.traceability_unit_id = v_source.id)
       ) THEN
      RAISE EXCEPTION 'expired, damaged, quarantined, recalled or quality-held LOT stock cannot be transformed'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM product_genealogy_events e
      WHERE e.tenant_id = p_tenant_id AND e.factory_id = p_factory_id
        AND e.source_unit_id = v_source.id
        AND e.relationship_type NOT IN ('CONSUMED_INTO', 'PROCESSED_INTO')
    ) THEN
      RAISE EXCEPTION 'LOT source has prior non-consumption genealogy; owner reconciliation is required before transformation'
        USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(SUM(e.quantity), 0)::numeric(18,4)
      INTO v_consumed
    FROM product_genealogy_events e
    WHERE e.tenant_id = p_tenant_id AND e.factory_id = p_factory_id
      AND e.source_unit_id = v_source.id
      AND e.relationship_type IN ('CONSUMED_INTO', 'PROCESSED_INTO');
    SELECT COALESCE(SUM(b.quantity_on_hand), 0)::numeric(18,4),
           COALESCE(SUM(b.quantity_reserved), 0)::numeric(18,4)
      INTO v_tracked, v_reserved
    FROM inventory_traceability_location_balances b
    WHERE b.tenant_id = p_tenant_id AND b.factory_id = p_factory_id
      AND b.item_id = v_source.inventory_item_id
      AND b.traceability_unit_id = v_source.id;

    IF v_reserved <> 0 OR EXISTS (
      SELECT 1 FROM inventory_reservation_traceability_allocations a
      WHERE a.tenant_id = p_tenant_id AND a.factory_id = p_factory_id
        AND a.traceability_unit_id = v_source.id
        AND a.allocated_quantity > a.consumed_quantity + a.released_quantity
    ) THEN
      RAISE EXCEPTION 'LOT with active reserved quantity or allocation cannot be transformed; release the reservation first'
        USING ERRCODE = '23514';
    END IF;
    IF v_tracked <= 0 OR v_tracked <> v_source.quantity - v_consumed THEN
      RAISE EXCEPTION
        'LOT tracked on-hand (%) must exactly equal registered unconsumed quantity (%) before transformation',
        v_tracked, v_source.quantity - v_consumed
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM inventory_traceability_location_balances b
      JOIN inventory_locations l
        ON l.id = b.location_id AND l.tenant_id = b.tenant_id AND l.factory_id = b.factory_id
      WHERE b.tenant_id = p_tenant_id AND b.factory_id = p_factory_id
        AND b.traceability_unit_id = v_source.id AND b.quantity_on_hand > 0
        AND (l.status <> 'ACTIVE'
          OR NOT (l.location_type = 'BIN' OR (l.is_default AND l.location_type = 'VIRTUAL')))
    ) THEN
      RAISE EXCEPTION 'LOT stock must be in active BIN or UNASSIGNED locations before transformation'
        USING ERRCODE = '23514';
    END IF;

    IF NOT v_first_source_set THEN
      v_unit := v_source.unit;
      v_first_source := v_source;
      v_first_source_received_at := v_source_received_at;
      v_first_source_set := TRUE;
    ELSIF upper(v_source.unit) <> upper(v_unit) THEN
      RAISE EXCEPTION 'all merged source LOTs must use the same base unit'
        USING ERRCODE = '23514';
    END IF;
    IF v_total > 0 AND (
      v_source.manufactured_at IS DISTINCT FROM v_first_source.manufactured_at
      OR v_source.expires_at IS DISTINCT FROM v_first_source.expires_at
      OR v_source.attributes IS DISTINCT FROM v_first_source.attributes
      OR v_source_received_at IS DISTINCT FROM v_first_source_received_at
    ) THEN
      RAISE EXCEPTION 'LOTs with different manufacturing, expiry or condition metadata cannot be merged'
        USING ERRCODE = '23514';
    END IF;
    v_total := v_total + v_tracked;
  END LOOP;

  SELECT COALESCE(
    (SELECT p.allocation_policy
     FROM inventory_material_allocation_policies p
     WHERE p.tenant_id = p_tenant_id AND p.factory_id = p_factory_id
       AND p.policy_scope = 'MATERIAL' AND p.inventory_item_id = v_item_id),
    (SELECT p.allocation_policy
     FROM inventory_material_allocation_policies p
     JOIN inventory_items i ON i.id = v_item_id AND i.tenant_id = p.tenant_id AND i.factory_id = p.factory_id
     WHERE p.tenant_id = p_tenant_id AND p.factory_id = p_factory_id
       AND p.policy_scope = 'SECTOR' AND lower(p.sector_code) = lower(i.sector_code)),
    (SELECT p.allocation_policy
     FROM inventory_material_allocation_policies p
     WHERE p.tenant_id = p_tenant_id AND p.factory_id = p_factory_id AND p.policy_scope = 'FACTORY'),
    (SELECT ts.allocation_policy
     FROM traceability_settings ts
     WHERE ts.tenant_id = p_tenant_id AND ts.factory_id = p_factory_id),
    'FIFO'
  ) INTO v_policy;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'source_unit_id', b.traceability_unit_id,
           'location_id', b.location_id,
           'quantity', b.quantity_on_hand
         ) ORDER BY b.traceability_unit_id, b.location_id), '[]'::jsonb)
    INTO v_source_locations
  FROM inventory_traceability_location_balances b
  WHERE b.tenant_id = p_tenant_id AND b.factory_id = p_factory_id
    AND b.item_id = v_item_id AND b.traceability_unit_id = ANY(p_source_unit_ids);

  v_correlation_id := COALESCE(
    NULLIF(current_setting('app.trace_id', TRUE), '')::uuid,
    NULLIF(current_setting('app.request_id', TRUE), '')::uuid,
    gen_random_uuid()
  );
  v_transformation_id := gen_random_uuid();

  IF v_operation = 'SPLIT' THEN
    IF p_target_unit_code IS NOT NULL THEN
      RAISE EXCEPTION 'SPLIT uses each output unit_code; target_unit_code is not accepted'
        USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_outputs) o
      WHERE jsonb_typeof(o) <> 'object'
         OR upper(COALESCE(o->>'unit_type','')) NOT IN ('LOT','SERIAL')
         OR length(btrim(COALESCE(o->>'unit_code',''))) NOT BETWEEN 1 AND 160
         OR length(btrim(COALESCE(o->>'barcode_value', o->>'unit_code',''))) NOT BETWEEN 1 AND 255
         OR COALESCE(o->>'quantity','') !~ '^[0-9]+(\.[0-9]{1,4})?$'
         OR (o->>'quantity')::numeric <= 0
         OR jsonb_typeof(o->'locations') IS DISTINCT FROM 'array'
         OR jsonb_array_length(CASE WHEN jsonb_typeof(o->'locations') = 'array' THEN o->'locations' ELSE '[]'::jsonb END) = 0
         OR (upper(COALESCE(o->>'unit_type','')) = 'SERIAL' AND (
              (o->>'quantity')::numeric <> 1
              OR jsonb_array_length(CASE WHEN jsonb_typeof(o->'locations') = 'array' THEN o->'locations' ELSE '[]'::jsonb END) <> 1
              OR COALESCE(o->'locations'->0->>'quantity','') !~ '^1(\.0{1,4})?$'
            ))
    ) THEN
      RAISE EXCEPTION 'SPLIT outputs must be LOT/SERIAL identities with positive four-decimal BIN allocations; each SERIAL is exactly one unit in one location'
        USING ERRCODE = '22023';
    END IF;
    SELECT count(DISTINCT upper(o->>'unit_type')), min(upper(o->>'unit_type'))
      INTO v_output_type_count, v_output_unit_type
    FROM jsonb_array_elements(p_outputs) o;
    IF v_output_type_count <> 1 THEN
      RAISE EXCEPTION 'one split command must create either all LOT outputs or all SERIAL outputs; mixed identity types are not supported'
        USING ERRCODE = '23514';
    END IF;
    IF (v_policy = 'LOT' AND v_output_unit_type <> 'LOT')
       OR (v_policy = 'SERIAL' AND v_output_unit_type <> 'SERIAL') THEN
      RAISE EXCEPTION 'split output identity type must follow the effective material allocation policy %', v_policy
        USING ERRCODE = '23514';
    END IF;
    IF v_policy IN ('FIFO','FEFO') AND v_output_unit_type = 'SERIAL'
       AND EXISTS (
         SELECT 1
         FROM traceability_units u
         JOIN inventory_traceability_location_balances b
           ON b.traceability_unit_id = u.id AND b.tenant_id = u.tenant_id
          AND b.factory_id = u.factory_id AND b.item_id = u.inventory_item_id
         WHERE u.tenant_id = p_tenant_id AND u.factory_id = p_factory_id
           AND u.inventory_item_id = v_item_id AND u.id <> p_source_unit_ids[1]
           AND u.unit_type = 'LOT' AND u.product_role = 'MATERIAL'
           AND u.status = 'ACTIVE' AND b.quantity_on_hand > 0
       ) THEN
      RAISE EXCEPTION 'LOT-to-SERIAL split is not eligible while another active LOT identity still carries stock; transform the remaining LOT stock first'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT lower(o->>'unit_code')
      FROM jsonb_array_elements(p_outputs) o
      GROUP BY lower(o->>'unit_code')
      HAVING count(*) > 1
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_outputs) o
      CROSS JOIN LATERAL jsonb_array_elements(o->'locations') loc
      GROUP BY lower(o->>'unit_code'), (loc->>'location_id')
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'SPLIT output unit codes and per-output locations must be unique'
        USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_outputs) o
      CROSS JOIN LATERAL jsonb_array_elements(o->'locations') loc
      WHERE COALESCE(loc->>'location_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         OR COALESCE(loc->>'quantity','') !~ '^[0-9]+(\.[0-9]{1,4})?$'
         OR (loc->>'quantity')::numeric <= 0
    ) THEN
      RAISE EXCEPTION 'SPLIT output locations require valid UUIDs and positive four-decimal quantities'
        USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_outputs) o
      WHERE (SELECT COALESCE(SUM((loc->>'quantity')::numeric),0)
             FROM jsonb_array_elements(o->'locations') loc) <> (o->>'quantity')::numeric
    ) THEN
      RAISE EXCEPTION 'each SPLIT output quantity must exactly equal its location allocation total'
        USING ERRCODE = '23514';
    END IF;
    IF (SELECT COALESCE(SUM((o->>'quantity')::numeric),0) FROM jsonb_array_elements(p_outputs) o) <> v_total THEN
      RAISE EXCEPTION 'SPLIT output quantities must conserve the complete source LOT on-hand quantity'
        USING ERRCODE = '23514';
    END IF;
    FOR v_location IN
      SELECT (loc->>'location_id')::uuid AS location_id
      FROM jsonb_array_elements(p_outputs) o
      CROSS JOIN LATERAL jsonb_array_elements(o->'locations') loc
      GROUP BY (loc->>'location_id')::uuid
    LOOP
      SELECT COALESCE(SUM((loc->>'quantity')::numeric),0)::numeric(18,4)
        INTO v_location_total
      FROM jsonb_array_elements(p_outputs) o
      CROSS JOIN LATERAL jsonb_array_elements(o->'locations') loc
      WHERE (loc->>'location_id')::uuid = v_location.location_id;
      IF v_location_total IS DISTINCT FROM COALESCE((
        SELECT SUM((s->>'quantity')::numeric)::numeric(18,4)
        FROM jsonb_array_elements(v_source_locations) s
        WHERE (s->>'source_unit_id')::uuid = p_source_unit_ids[1]
          AND (s->>'location_id')::uuid = v_location.location_id
      ), 0::numeric(18,4)) THEN
        RAISE EXCEPTION 'SPLIT allocations must conserve source quantity in every existing BIN/UNASSIGNED location'
          USING ERRCODE = '23514';
      END IF;
    END LOOP;
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_source_locations) s
      WHERE (s->>'source_unit_id')::uuid = p_source_unit_ids[1]
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_outputs) o
          CROSS JOIN LATERAL jsonb_array_elements(o->'locations') loc
          WHERE (loc->>'location_id')::uuid = (s->>'location_id')::uuid
        )
        AND (s->>'quantity')::numeric > 0
    ) THEN
      RAISE EXCEPTION 'SPLIT omitted a source location with on-hand stock'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    v_target_code := upper(btrim(COALESCE(p_target_unit_code,'')));
    IF length(v_target_code) NOT BETWEEN 1 AND 160 THEN
      RAISE EXCEPTION 'MERGE target_unit_code is required and must contain at most 160 characters'
        USING ERRCODE = '22023';
    END IF;
    IF p_outputs <> '[]'::jsonb THEN
      RAISE EXCEPTION 'MERGE output allocations are derived from source location balances'
        USING ERRCODE = '22023';
    END IF;
    IF v_policy = 'SERIAL' THEN
      RAISE EXCEPTION 'MERGE creates a LOT identity and is not allowed by the SERIAL material allocation policy'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO inventory_traceability_transformations (
    id, tenant_id, factory_id, inventory_item_id, operation_type, idempotency_key,
    request_hash, reason, total_quantity, unit, created_by_user_id, correlation_id
  ) VALUES (
    v_transformation_id, p_tenant_id, p_factory_id, v_item_id, v_operation, p_idempotency_key,
    p_request_hash, btrim(p_reason), v_total, v_unit, p_actor_id, v_correlation_id
  );

  PERFORM set_config('app.traceability_transformation', 'on', TRUE);

  IF v_operation = 'SPLIT' THEN
    UPDATE inventory_traceability_location_balances
    SET quantity_on_hand = 0, quantity_reserved = 0,
        version = version + 1, updated_at = clock_timestamp()
    WHERE tenant_id = p_tenant_id AND factory_id = p_factory_id
      AND traceability_unit_id = p_source_unit_ids[1];

    FOR v_output IN SELECT value FROM jsonb_array_elements(p_outputs)
    LOOP
      v_target_id := gen_random_uuid();
      v_target_type := upper(v_output->>'unit_type');
      v_target_code := upper(btrim(v_output->>'unit_code'));
      v_target_barcode := upper(btrim(COALESCE(v_output->>'barcode_value', v_target_code)));
      v_target_quantity := (v_output->>'quantity')::numeric(18,4);

      INSERT INTO traceability_units (
        id, tenant_id, factory_id, unit_type, product_role, unit_code, barcode_value,
        inventory_item_id, quantity, unit, external_reference, manufactured_at, expires_at,
        allocation_received_at_override, attributes, idempotency_key, request_hash, created_by_user_id, correlation_id
      ) VALUES (
        v_target_id, p_tenant_id, p_factory_id, v_target_type, 'MATERIAL',
        v_target_code, v_target_barcode, v_item_id, v_target_quantity, v_unit,
        'LOT_SERIAL_TRANSFORMATION:' || v_transformation_id::text,
        v_first_source.manufactured_at, v_first_source.expires_at, v_first_source_received_at,
        v_first_source.attributes || jsonb_build_object('transformed_from_unit_id', p_source_unit_ids[1]),
        'transformation:' || v_transformation_id::text || ':unit:' || v_target_id::text,
        p_request_hash, p_actor_id, v_correlation_id
      );

      FOR v_output_location IN SELECT value FROM jsonb_array_elements(v_output->'locations')
      LOOP
        INSERT INTO inventory_traceability_transformation_lines (
          tenant_id, factory_id, transformation_id, source_unit_id, target_unit_id,
          location_id, relationship_type, quantity
        ) VALUES (
          p_tenant_id, p_factory_id, v_transformation_id, p_source_unit_ids[1], v_target_id,
          (v_output_location->>'location_id')::uuid, 'SPLIT_INTO',
          (v_output_location->>'quantity')::numeric(18,4)
        );
        INSERT INTO inventory_traceability_location_balances (
          tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand, quantity_reserved
        ) VALUES (
          p_tenant_id, p_factory_id, v_item_id, v_target_id,
          (v_output_location->>'location_id')::uuid,
          (v_output_location->>'quantity')::numeric(18,4), 0
        );
      END LOOP;

      INSERT INTO product_genealogy_events (
        tenant_id, factory_id, source_unit_id, target_unit_id, relationship_type,
        transformation_id, quantity, unit, evidence, notes, idempotency_key,
        request_hash, created_by_user_id, correlation_id
      ) VALUES (
        p_tenant_id, p_factory_id, p_source_unit_ids[1], v_target_id, 'SPLIT_INTO',
        v_transformation_id, v_target_quantity, v_unit,
        jsonb_build_object('transformation_id', v_transformation_id, 'operation', 'SPLIT'),
        btrim(p_reason),
        'transformation:' || v_transformation_id::text || ':genealogy:' || v_target_id::text,
        p_request_hash, p_actor_id, v_correlation_id
      ) RETURNING id INTO v_event_id;

      INSERT INTO outbox_events (
        tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
      ) VALUES (
        p_tenant_id, p_factory_id, 'TRACEABILITY_UNIT', v_target_id,
        'TRACEABILITY.UNIT_REGISTERED',
        jsonb_build_object('unit_id', v_target_id, 'unit_type', v_target_type,
          'product_role', 'MATERIAL', 'unit_code', v_target_code,
          'quantity', v_target_quantity, 'unit', v_unit,
          'transformation_id', v_transformation_id)
      );
      INSERT INTO audit_events (
        tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
        correlation_id, request_id, data_class, payload
      ) VALUES (
        p_tenant_id, p_factory_id, p_actor_id, 'TRACEABILITY', 'REGISTERED',
        'TRACEABILITY_UNIT', v_target_id, v_correlation_id,
        NULLIF(current_setting('app.request_id', TRUE), '')::uuid, 'INTERNAL',
        jsonb_build_object('unit_type', v_target_type, 'product_role', 'MATERIAL',
          'unit_code', v_target_code, 'quantity', v_target_quantity,
          'transformation_id', v_transformation_id)
      );
      INSERT INTO outbox_events (
        tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
      ) VALUES (
        p_tenant_id, p_factory_id, 'PRODUCT_GENEALOGY_EVENT', v_event_id,
        'TRACEABILITY.GENEALOGY_RECORDED',
        jsonb_build_object('genealogy_event_id', v_event_id, 'source_unit_id', p_source_unit_ids[1],
          'target_unit_id', v_target_id, 'relationship_type', 'SPLIT_INTO',
          'quantity', v_target_quantity, 'unit', v_unit, 'transformation_id', v_transformation_id)
      );
      INSERT INTO audit_events (
        tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
        correlation_id, request_id, data_class, payload
      ) VALUES (
        p_tenant_id, p_factory_id, p_actor_id, 'TRACEABILITY', 'RECORDED',
        'PRODUCT_GENEALOGY_EVENT', v_event_id, v_correlation_id,
        NULLIF(current_setting('app.request_id', TRUE), '')::uuid, 'INTERNAL',
        jsonb_build_object('sourceUnitId', p_source_unit_ids[1], 'targetUnitId', v_target_id,
          'relationshipType', 'SPLIT_INTO', 'quantity', v_target_quantity,
          'unit', v_unit, 'transformationId', v_transformation_id)
      );
      v_target_ids := v_target_ids || jsonb_build_array(v_target_id);
    END LOOP;
  ELSE
    v_target_id := gen_random_uuid();
    INSERT INTO traceability_units (
      id, tenant_id, factory_id, unit_type, product_role, unit_code, barcode_value,
      inventory_item_id, quantity, unit, external_reference, manufactured_at, expires_at,
      allocation_received_at_override, attributes, idempotency_key, request_hash, created_by_user_id, correlation_id
    ) VALUES (
      v_target_id, p_tenant_id, p_factory_id, 'LOT', 'MATERIAL',
      v_target_code, v_target_code, v_item_id, v_total, v_unit,
      'LOT_SERIAL_TRANSFORMATION:' || v_transformation_id::text,
      v_first_source.manufactured_at, v_first_source.expires_at, v_first_source_received_at,
      v_first_source.attributes || jsonb_build_object('merged_from_unit_ids', to_jsonb(p_source_unit_ids)),
      'transformation:' || v_transformation_id::text || ':unit:' || v_target_id::text,
      p_request_hash, p_actor_id, v_correlation_id
    );

    FOR v_location IN
      SELECT (s->>'location_id')::uuid AS location_id,
             SUM((s->>'quantity')::numeric)::numeric(18,4) AS location_quantity
      FROM jsonb_array_elements(v_source_locations) s
      GROUP BY (s->>'location_id')::uuid
      ORDER BY (s->>'location_id')::uuid
    LOOP
      IF v_location.location_quantity > 0 THEN
        INSERT INTO inventory_traceability_location_balances (
          tenant_id, factory_id, item_id, traceability_unit_id, location_id, quantity_on_hand, quantity_reserved
        ) VALUES (
          p_tenant_id, p_factory_id, v_item_id, v_target_id,
          v_location.location_id, v_location.location_quantity, 0
        );
      END IF;
    END LOOP;

    UPDATE inventory_traceability_location_balances
    SET quantity_on_hand = 0, quantity_reserved = 0,
        version = version + 1, updated_at = clock_timestamp()
    WHERE tenant_id = p_tenant_id AND factory_id = p_factory_id
      AND traceability_unit_id = ANY(p_source_unit_ids);

    FOREACH v_source_id IN ARRAY p_source_unit_ids
    LOOP
      SELECT COALESCE(SUM((s->>'quantity')::numeric),0)::numeric(18,4)
        INTO v_edge_quantity
      FROM jsonb_array_elements(v_source_locations) s
      WHERE (s->>'source_unit_id')::uuid = v_source_id;

      FOR v_location IN
        SELECT (s->>'location_id')::uuid AS location_id,
               SUM((s->>'quantity')::numeric)::numeric(18,4) AS quantity
        FROM jsonb_array_elements(v_source_locations) s
        WHERE (s->>'source_unit_id')::uuid = v_source_id
        GROUP BY (s->>'location_id')::uuid
        ORDER BY (s->>'location_id')::uuid
      LOOP
        IF v_location.quantity > 0 THEN
          INSERT INTO inventory_traceability_transformation_lines (
            tenant_id, factory_id, transformation_id, source_unit_id, target_unit_id,
            location_id, relationship_type, quantity
          ) VALUES (
            p_tenant_id, p_factory_id, v_transformation_id, v_source_id, v_target_id,
            v_location.location_id, 'MERGED_INTO', v_location.quantity
          );
        END IF;
      END LOOP;

      INSERT INTO product_genealogy_events (
        tenant_id, factory_id, source_unit_id, target_unit_id, relationship_type,
        transformation_id, quantity, unit, evidence, notes, idempotency_key,
        request_hash, created_by_user_id, correlation_id
      ) VALUES (
        p_tenant_id, p_factory_id, v_source_id, v_target_id, 'MERGED_INTO',
        v_transformation_id, v_edge_quantity, v_unit,
        jsonb_build_object('transformation_id', v_transformation_id, 'operation', 'MERGE'),
        btrim(p_reason),
        'transformation:' || v_transformation_id::text || ':genealogy:' || v_source_id::text,
        p_request_hash, p_actor_id, v_correlation_id
      ) RETURNING id INTO v_event_id;

      INSERT INTO outbox_events (
        tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
      ) VALUES (
        p_tenant_id, p_factory_id, 'PRODUCT_GENEALOGY_EVENT', v_event_id,
        'TRACEABILITY.GENEALOGY_RECORDED',
        jsonb_build_object('genealogy_event_id', v_event_id, 'source_unit_id', v_source_id,
          'target_unit_id', v_target_id, 'relationship_type', 'MERGED_INTO',
          'quantity', v_edge_quantity, 'unit', v_unit, 'transformation_id', v_transformation_id)
      );
      INSERT INTO audit_events (
        tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
        correlation_id, request_id, data_class, payload
      ) VALUES (
        p_tenant_id, p_factory_id, p_actor_id, 'TRACEABILITY', 'RECORDED',
        'PRODUCT_GENEALOGY_EVENT', v_event_id, v_correlation_id,
        NULLIF(current_setting('app.request_id', TRUE), '')::uuid, 'INTERNAL',
        jsonb_build_object('sourceUnitId', v_source_id, 'targetUnitId', v_target_id,
          'relationshipType', 'MERGED_INTO', 'quantity', v_edge_quantity,
          'unit', v_unit, 'transformationId', v_transformation_id)
      );
    END LOOP;

    INSERT INTO outbox_events (
      tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
    ) VALUES (
      p_tenant_id, p_factory_id, 'TRACEABILITY_UNIT', v_target_id,
      'TRACEABILITY.UNIT_REGISTERED',
      jsonb_build_object('unit_id', v_target_id, 'unit_type', 'LOT',
        'product_role', 'MATERIAL', 'unit_code', v_target_code,
        'quantity', v_total, 'unit', v_unit, 'transformation_id', v_transformation_id)
    );
    INSERT INTO audit_events (
      tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
      correlation_id, request_id, data_class, payload
    ) VALUES (
      p_tenant_id, p_factory_id, p_actor_id, 'TRACEABILITY', 'REGISTERED',
      'TRACEABILITY_UNIT', v_target_id, v_correlation_id,
      NULLIF(current_setting('app.request_id', TRUE), '')::uuid, 'INTERNAL',
      jsonb_build_object('unit_type', 'LOT', 'product_role', 'MATERIAL',
        'unit_code', v_target_code, 'quantity', v_total, 'transformation_id', v_transformation_id)
    );
    v_target_ids := jsonb_build_array(v_target_id);
  END IF;

  -- A source identity with no remaining physical quantity is terminal. Status
  -- history, audit and outbox are committed with its transformation evidence.
  FOREACH v_source_id IN ARRAY p_source_unit_ids
  LOOP
    SELECT status, version INTO v_status_from, v_status_version
    FROM traceability_units
    WHERE id = v_source_id AND tenant_id = p_tenant_id AND factory_id = p_factory_id
    FOR UPDATE;
    UPDATE traceability_units
    SET status = 'DISPOSED',
        version = version + 1,
        updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
    WHERE id = v_source_id AND tenant_id = p_tenant_id AND factory_id = p_factory_id
    RETURNING version INTO v_status_version;
    v_status_reason := 'Consumed by stock-conserving ' || v_operation || ' transformation ' || v_transformation_id::text || ': ' || btrim(p_reason);

    INSERT INTO traceability_unit_status_events (
      tenant_id, factory_id, unit_id, version, from_status, to_status, reason,
      idempotency_key, request_hash, changed_by_user_id, correlation_id
    ) VALUES (
      p_tenant_id, p_factory_id, v_source_id, v_status_version, v_status_from, 'DISPOSED',
      v_status_reason, 'transformation:' || v_transformation_id::text || ':status:' || v_source_id::text,
      p_request_hash, p_actor_id, v_correlation_id
    );
    INSERT INTO outbox_events (
      tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
    ) VALUES (
      p_tenant_id, p_factory_id, 'TRACEABILITY_UNIT', v_source_id,
      'TRACEABILITY.UNIT_STATUS_CHANGED',
      jsonb_build_object('unit_id', v_source_id, 'from_status', v_status_from,
        'to_status', 'DISPOSED', 'version', v_status_version,
        'reason', v_status_reason, 'transformation_id', v_transformation_id)
    );
    INSERT INTO audit_events (
      tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
      correlation_id, request_id, data_class, payload
    ) VALUES (
      p_tenant_id, p_factory_id, p_actor_id, 'TRACEABILITY', 'STATUS_CHANGED',
      'TRACEABILITY_UNIT', v_source_id, v_correlation_id,
      NULLIF(current_setting('app.request_id', TRUE), '')::uuid, 'INTERNAL',
      jsonb_build_object('from_status', v_status_from, 'to_status', 'DISPOSED',
        'version', v_status_version, 'reason', v_status_reason,
        'transformation_id', v_transformation_id)
    );
  END LOOP;

  INSERT INTO outbox_events (
    tenant_id, factory_id, aggregate_type, aggregate_id, event_type, payload
  ) VALUES (
    p_tenant_id, p_factory_id, 'WMS_LOT_SERIAL_TRANSFORMATION', v_transformation_id,
    'WMS.LOT_SERIAL_TRANSFORMATION_COMPLETED',
    jsonb_build_object('transformation_id', v_transformation_id, 'operation_type', v_operation,
      'source_unit_ids', to_jsonb(p_source_unit_ids), 'target_unit_ids', v_target_ids,
      'inventory_item_id', v_item_id, 'total_quantity', v_total, 'unit', v_unit, 'reason', btrim(p_reason))
  );
  INSERT INTO audit_events (
    tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
    correlation_id, request_id, data_class, payload
  ) VALUES (
    p_tenant_id, p_factory_id, p_actor_id, 'WMS', 'COMPLETED',
    'WMS_LOT_SERIAL_TRANSFORMATION', v_transformation_id, v_correlation_id,
    NULLIF(current_setting('app.request_id', TRUE), '')::uuid, 'INTERNAL',
    jsonb_build_object('operation_type', v_operation, 'source_unit_ids', to_jsonb(p_source_unit_ids),
      'target_unit_ids', v_target_ids, 'inventory_item_id', v_item_id,
      'total_quantity', v_total, 'unit', v_unit, 'reason', btrim(p_reason))
  );

  PERFORM set_config('app.traceability_transformation', '', TRUE);
  RETURN jsonb_build_object(
    'transformation_id', v_transformation_id,
    'operation_type', v_operation,
    'target_unit_ids', v_target_ids,
    'replayed', FALSE
  );
END;
$$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('239_wms_stock_conserving_lot_serial_transformations', NULL)
ON CONFLICT (version) DO NOTHING;

ALTER TABLE inventory_traceability_transformations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_traceability_transformations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_traceability_transformations_tenant_isolation
  ON inventory_traceability_transformations;
CREATE POLICY inventory_traceability_transformations_tenant_isolation
  ON inventory_traceability_transformations
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE inventory_traceability_transformation_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_traceability_transformation_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_traceability_transformation_lines_tenant_isolation
  ON inventory_traceability_transformation_lines;
CREATE POLICY inventory_traceability_transformation_lines_tenant_isolation
  ON inventory_traceability_transformation_lines
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMIT;
