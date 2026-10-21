BEGIN;

-- WMS cycle-count approval must record why non-zero physical variances are applied.
ALTER TABLE inventory_cycle_count_proposals
  ADD COLUMN IF NOT EXISTS variance_reason_code VARCHAR(32);

ALTER TABLE inventory_stock_reconciliations
  ADD COLUMN IF NOT EXISTS variance_reason_code VARCHAR(32);

-- Preserve honest provenance for old approvals; new API submissions cannot use
-- LEGACY_UNSPECIFIED and must provide a reviewed reason for every non-zero delta.
UPDATE inventory_stock_reconciliations
SET variance_reason_code = 'LEGACY_UNSPECIFIED'
WHERE reason_code = 'CYCLE_COUNT'
  AND quantity_delta <> 0
  AND variance_reason_code IS NULL;

UPDATE inventory_cycle_count_proposals
SET variance_reason_code = 'LEGACY_UNSPECIFIED'
WHERE status = 'APPLIED'
  AND counted_quantity <> ledger_quantity_at_count
  AND variance_reason_code IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_cycle_count_variance_reason_code'
      AND conrelid = 'inventory_cycle_count_proposals'::regclass
  ) THEN
    ALTER TABLE inventory_cycle_count_proposals
      ADD CONSTRAINT chk_inventory_cycle_count_variance_reason_code
      CHECK (
        variance_reason_code IS NULL
        OR variance_reason_code IN (
          'COUNTING_ERROR', 'DAMAGE', 'LOSS', 'FOUND_STOCK',
          'RECEIPT_ERROR', 'PICKING_ERROR', 'OTHER', 'LEGACY_UNSPECIFIED'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_cycle_count_variance_reason_state'
      AND conrelid = 'inventory_cycle_count_proposals'::regclass
  ) THEN
    ALTER TABLE inventory_cycle_count_proposals
      ADD CONSTRAINT chk_inventory_cycle_count_variance_reason_state
      CHECK (
        (status IN ('PENDING_REVIEW', 'REJECTED') AND variance_reason_code IS NULL)
        OR (
          status = 'APPLIED'
          AND (
            (counted_quantity = ledger_quantity_at_count AND variance_reason_code IS NULL)
            OR (
              counted_quantity <> ledger_quantity_at_count
              AND variance_reason_code IS NOT NULL
            )
          )
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_stock_reconciliation_variance_reason_code'
      AND conrelid = 'inventory_stock_reconciliations'::regclass
  ) THEN
    ALTER TABLE inventory_stock_reconciliations
      ADD CONSTRAINT chk_inventory_stock_reconciliation_variance_reason_code
      CHECK (
        variance_reason_code IS NULL
        OR variance_reason_code IN (
          'COUNTING_ERROR', 'DAMAGE', 'LOSS', 'FOUND_STOCK',
          'RECEIPT_ERROR', 'PICKING_ERROR', 'OTHER', 'LEGACY_UNSPECIFIED'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_inventory_stock_reconciliation_variance_reason_state'
      AND conrelid = 'inventory_stock_reconciliations'::regclass
  ) THEN
    ALTER TABLE inventory_stock_reconciliations
      ADD CONSTRAINT chk_inventory_stock_reconciliation_variance_reason_state
      CHECK (
        (
          reason_code = 'CYCLE_COUNT'
          AND (
            (quantity_delta = 0 AND variance_reason_code IS NULL)
            OR (quantity_delta <> 0 AND variance_reason_code IS NOT NULL)
          )
        )
        OR (reason_code <> 'CYCLE_COUNT' AND variance_reason_code IS NULL)
      );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_cycle_count_proposal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory_cycle_count_proposals are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
    OR NEW.item_id IS DISTINCT FROM OLD.item_id
    OR NEW.counted_quantity IS DISTINCT FROM OLD.counted_quantity
    OR NEW.ledger_quantity_at_count IS DISTINCT FROM OLD.ledger_quantity_at_count
    OR NEW.balance_version_at_count IS DISTINCT FROM OLD.balance_version_at_count
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.notes IS DISTINCT FROM OLD.notes
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'cycle-count proposal facts cannot be edited'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'PENDING_REVIEW' THEN
    RAISE EXCEPTION 'cycle-count review decision is terminal'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status NOT IN ('REJECTED', 'APPLIED')
    OR NEW.reviewed_by_user_id IS NULL
    OR NEW.reviewed_by_user_id = NEW.created_by_user_id
    OR NEW.reviewed_at IS NULL
    OR NEW.review_decision IS NULL
    OR NEW.review_decision NOT IN ('APPROVE', 'REJECT')
    OR NEW.review_idempotency_key IS NULL
    OR NEW.review_request_hash IS NULL
    OR NEW.review_request_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid cycle-count review transition or separation-of-duties violation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'REJECTED' AND (
    NEW.review_decision <> 'REJECT'
    OR NEW.reconciliation_id IS NOT NULL
    OR NEW.variance_reason_code IS NOT NULL
    OR length(btrim(COALESCE(NEW.review_note, ''))) = 0
  ) THEN
    RAISE EXCEPTION 'rejected cycle counts require a reason and no stock reconciliation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'APPLIED' AND (
    NEW.review_decision <> 'APPROVE'
    OR NEW.reconciliation_id IS NULL
    OR (
      NEW.counted_quantity <> NEW.ledger_quantity_at_count
      AND NEW.variance_reason_code IS NULL
    )
    OR (
      NEW.counted_quantity = NEW.ledger_quantity_at_count
      AND NEW.variance_reason_code IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'approved cycle counts require an atomic reconciliation and a variance reason exactly when stock changes'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('159_inventory_cycle_count_variance_reason', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
