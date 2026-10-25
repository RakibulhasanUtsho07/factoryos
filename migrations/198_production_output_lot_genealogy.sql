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

COMMENT ON COLUMN production_output_postings.traceability_unit_id IS
  'Finished-good lot created atomically with accepted good output; NULL only when the report has zero good quantity or for historical rows predating this gate.';
COMMENT ON COLUMN production_output_postings.scrap_traceability_unit_id IS
  'Non-sellable evidence identity for scrap output; it has no inventory item or stock balance and is never received as finished goods.';

INSERT INTO schema_migrations(version, checksum)
VALUES ('198_production_output_lot_genealogy', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
