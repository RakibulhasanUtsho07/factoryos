BEGIN;

ALTER TABLE inventory_cycle_count_proposals
  ADD COLUMN variance_reason TEXT;

-- Existing proposals remain immutable after deployment. Historic variance records
-- cannot reconstruct a human reason that was never captured, so use an explicit
-- migration marker rather than silently presenting legacy notes as a reason.
UPDATE inventory_cycle_count_proposals
SET variance_reason = 'LEGACY_CYCLE_COUNT_VARIANCE_REASON_NOT_CAPTURED'
WHERE counted_quantity <> ledger_quantity_at_count
  AND variance_reason IS NULL;

ALTER TABLE inventory_cycle_count_proposals
  ADD CONSTRAINT chk_inventory_cycle_count_variance_reason
  CHECK (
    counted_quantity = ledger_quantity_at_count
    OR length(btrim(COALESCE(variance_reason, ''))) BETWEEN 1 AND 2000
  );

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
    OR NEW.variance_reason IS DISTINCT FROM OLD.variance_reason
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
    OR length(btrim(COALESCE(NEW.review_note, ''))) = 0
  ) THEN
    RAISE EXCEPTION 'rejected cycle counts require a reason and no stock reconciliation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'APPLIED' AND (
    NEW.review_decision <> 'APPROVE'
    OR NEW.reconciliation_id IS NULL
  ) THEN
    RAISE EXCEPTION 'approved cycle counts require the atomic stock reconciliation'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON COLUMN inventory_cycle_count_proposals.variance_reason IS
  'Immutable operator-provided reason required when the physical count differs from the captured ledger quantity. Legacy rows use an explicit migration marker.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('159_inventory_cycle_count_variance_reason', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
