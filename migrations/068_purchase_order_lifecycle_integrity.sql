BEGIN;

-- Repair missing current-version snapshots from any existing PO rows before
-- enforcing that every subsequent aggregate version receives a history row.
INSERT INTO purchase_order_status_history (
  tenant_id, factory_id, purchase_order_id, from_status, to_status, version,
  actor_user_id, reason, created_at
)
SELECT
  po.tenant_id,
  po.factory_id,
  po.id,
  CASE WHEN po.version = 1 AND po.status = 'DRAFT' THEN NULL ELSE po.status END,
  po.status,
  po.version,
  CASE po.status
    WHEN 'SUBMITTED' THEN COALESCE(po.submitted_by_user_id, po.created_by_user_id)
    WHEN 'APPROVED' THEN COALESCE(po.approved_by_user_id, po.created_by_user_id)
    WHEN 'REJECTED' THEN COALESCE(po.rejected_by_user_id, po.created_by_user_id)
    WHEN 'CANCELLED' THEN COALESCE(po.cancelled_by_user_id, po.created_by_user_id)
    ELSE po.created_by_user_id
  END,
  'SYSTEM: Baseline history backfill during lifecycle integrity hardening',
  po.updated_at
FROM purchase_orders po
WHERE NOT EXISTS (
  SELECT 1
  FROM purchase_order_status_history h
  WHERE h.purchase_order_id = po.id
    AND h.version = po.version
);

CREATE OR REPLACE FUNCTION factoryos_guard_purchase_order_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchase orders cannot be deleted; use a lifecycle transition'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.version <> 1
       OR NEW.submitted_by_user_id IS NOT NULL OR NEW.submitted_at IS NOT NULL
       OR NEW.approved_by_user_id IS NOT NULL OR NEW.approved_at IS NOT NULL
       OR NEW.rejected_by_user_id IS NOT NULL OR NEW.rejected_at IS NOT NULL
       OR NEW.rejection_reason IS NOT NULL
       OR NEW.cancelled_by_user_id IS NOT NULL OR NEW.cancelled_at IS NOT NULL
       OR NEW.cancellation_reason IS NOT NULL THEN
      RAISE EXCEPTION 'purchase orders must be created as version-one drafts without lifecycle decisions'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
     OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
     OR NEW.po_number IS DISTINCT FROM OLD.po_number
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'purchase-order identity, supplier and creation provenance are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'purchase-order updates must increment version by exactly one'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status <> 'DRAFT'
     AND ROW(NEW.order_date, NEW.expected_delivery_date, NEW.currency, NEW.payment_terms_days, NEW.notes)
         IS DISTINCT FROM
         ROW(OLD.order_date, OLD.expected_delivery_date, OLD.currency, OLD.payment_terms_days, OLD.notes) THEN
    RAISE EXCEPTION 'commercial terms are frozen after a purchase order is submitted'
      USING ERRCODE = '23514';
  END IF;

  -- Once recorded, transition provenance must never be rewritten.
  IF OLD.submitted_by_user_id IS NOT NULL
     AND ROW(NEW.submitted_by_user_id, NEW.submitted_at)
         IS DISTINCT FROM ROW(OLD.submitted_by_user_id, OLD.submitted_at) THEN
    RAISE EXCEPTION 'submission provenance is immutable once recorded' USING ERRCODE = '55000';
  END IF;
  IF OLD.approved_by_user_id IS NOT NULL
     AND ROW(NEW.approved_by_user_id, NEW.approved_at)
         IS DISTINCT FROM ROW(OLD.approved_by_user_id, OLD.approved_at) THEN
    RAISE EXCEPTION 'approval provenance is immutable once recorded' USING ERRCODE = '55000';
  END IF;
  IF OLD.rejected_by_user_id IS NOT NULL
     AND ROW(NEW.rejected_by_user_id, NEW.rejected_at, NEW.rejection_reason)
         IS DISTINCT FROM ROW(OLD.rejected_by_user_id, OLD.rejected_at, OLD.rejection_reason) THEN
    RAISE EXCEPTION 'rejection provenance is immutable once recorded' USING ERRCODE = '55000';
  END IF;
  IF OLD.cancelled_by_user_id IS NOT NULL
     AND ROW(NEW.cancelled_by_user_id, NEW.cancelled_at, NEW.cancellation_reason)
         IS DISTINCT FROM ROW(OLD.cancelled_by_user_id, OLD.cancelled_at, OLD.cancellation_reason) THEN
    RAISE EXCEPTION 'cancellation provenance is immutable once recorded' USING ERRCODE = '55000';
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    IF ROW(
      NEW.submitted_by_user_id, NEW.submitted_at,
      NEW.approved_by_user_id, NEW.approved_at,
      NEW.rejected_by_user_id, NEW.rejected_at, NEW.rejection_reason,
      NEW.cancelled_by_user_id, NEW.cancelled_at, NEW.cancellation_reason
    ) IS DISTINCT FROM ROW(
      OLD.submitted_by_user_id, OLD.submitted_at,
      OLD.approved_by_user_id, OLD.approved_at,
      OLD.rejected_by_user_id, OLD.rejected_at, OLD.rejection_reason,
      OLD.cancelled_by_user_id, OLD.cancelled_at, OLD.cancellation_reason
    ) THEN
      RAISE EXCEPTION 'lifecycle decision fields may only change with the matching status transition'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    IF NOT (
      (OLD.status = 'DRAFT' AND NEW.status IN ('SUBMITTED', 'CANCELLED'))
      OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('APPROVED', 'REJECTED', 'CANCELLED'))
    ) THEN
      RAISE EXCEPTION 'invalid purchase-order transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;

    CASE NEW.status
      WHEN 'SUBMITTED' THEN
        IF NEW.submitted_by_user_id IS NULL OR NEW.submitted_at IS NULL
           OR ROW(
             NEW.approved_by_user_id, NEW.approved_at,
             NEW.rejected_by_user_id, NEW.rejected_at, NEW.rejection_reason,
             NEW.cancelled_by_user_id, NEW.cancelled_at, NEW.cancellation_reason
           ) IS DISTINCT FROM ROW(
             OLD.approved_by_user_id, OLD.approved_at,
             OLD.rejected_by_user_id, OLD.rejected_at, OLD.rejection_reason,
             OLD.cancelled_by_user_id, OLD.cancelled_at, OLD.cancellation_reason
           ) THEN
          RAISE EXCEPTION 'submission requires its own actor and timestamp and cannot set another decision'
            USING ERRCODE = '23514';
        END IF;
      WHEN 'APPROVED' THEN
        IF NEW.approved_by_user_id IS NULL OR NEW.approved_at IS NULL
           OR NEW.approved_by_user_id = NEW.created_by_user_id
           OR ROW(
             NEW.rejected_by_user_id, NEW.rejected_at, NEW.rejection_reason,
             NEW.cancelled_by_user_id, NEW.cancelled_at, NEW.cancellation_reason
           ) IS DISTINCT FROM ROW(
             OLD.rejected_by_user_id, OLD.rejected_at, OLD.rejection_reason,
             OLD.cancelled_by_user_id, OLD.cancelled_at, OLD.cancellation_reason
           ) THEN
          RAISE EXCEPTION 'approval requires a separate approver and cannot set another decision'
            USING ERRCODE = '23514';
        END IF;
      WHEN 'REJECTED' THEN
        IF NEW.rejected_by_user_id IS NULL OR NEW.rejected_at IS NULL
           OR length(btrim(COALESCE(NEW.rejection_reason, ''))) = 0
           OR ROW(
             NEW.approved_by_user_id, NEW.approved_at,
             NEW.cancelled_by_user_id, NEW.cancelled_at, NEW.cancellation_reason
           ) IS DISTINCT FROM ROW(
             OLD.approved_by_user_id, OLD.approved_at,
             OLD.cancelled_by_user_id, OLD.cancelled_at, OLD.cancellation_reason
           ) THEN
          RAISE EXCEPTION 'rejection requires actor, timestamp and reason and cannot set another decision'
            USING ERRCODE = '23514';
        END IF;
      WHEN 'CANCELLED' THEN
        IF NEW.cancelled_by_user_id IS NULL OR NEW.cancelled_at IS NULL
           OR length(btrim(COALESCE(NEW.cancellation_reason, ''))) = 0
           OR ROW(
             NEW.approved_by_user_id, NEW.approved_at,
             NEW.rejected_by_user_id, NEW.rejected_at, NEW.rejection_reason
           ) IS DISTINCT FROM ROW(
             OLD.approved_by_user_id, OLD.approved_at,
             OLD.rejected_by_user_id, OLD.rejected_at, OLD.rejection_reason
           ) THEN
          RAISE EXCEPTION 'cancellation requires actor, timestamp and reason and cannot set another decision'
            USING ERRCODE = '23514';
        END IF;
    END CASE;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_purchase_orders_lifecycle_guard ON purchase_orders;
CREATE TRIGGER trg_purchase_orders_lifecycle_guard
BEFORE INSERT OR UPDATE OR DELETE ON purchase_orders
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_purchase_order_lifecycle();

CREATE OR REPLACE FUNCTION factoryos_guard_purchase_order_line_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_order_id UUID;
  v_tenant_id UUID;
  v_factory_id UUID;
  v_status VARCHAR(24);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.purchase_order_id, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.purchase_order_id, OLD.created_at) THEN
      RAISE EXCEPTION 'purchase-order line identity and parent scope are immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_order_id := OLD.purchase_order_id;
    v_tenant_id := OLD.tenant_id;
    v_factory_id := OLD.factory_id;
  ELSE
    v_order_id := NEW.purchase_order_id;
    v_tenant_id := NEW.tenant_id;
    v_factory_id := NEW.factory_id;
  END IF;

  SELECT status INTO v_status
  FROM purchase_orders
  WHERE id = v_order_id AND tenant_id = v_tenant_id AND factory_id = v_factory_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase order line parent does not exist in the same tenant/factory scope'
      USING ERRCODE = '23503';
  END IF;
  IF v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'purchase-order lines are immutable after submission'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_validate_purchase_order_history_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_order purchase_orders%ROWTYPE;
  v_previous_status VARCHAR(24);
BEGIN
  SELECT * INTO v_order
  FROM purchase_orders
  WHERE id = NEW.purchase_order_id
    AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase-order history parent is missing from its tenant/factory scope'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.version <> v_order.version OR NEW.to_status IS DISTINCT FROM v_order.status THEN
    RAISE EXCEPTION 'purchase-order history must match the current aggregate version and status'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.version = 1 THEN
    IF NEW.from_status IS NOT NULL OR NEW.to_status <> 'DRAFT'
       OR NEW.actor_user_id <> v_order.created_by_user_id THEN
      RAISE EXCEPTION 'version-one history must represent draft creation by its creator'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT to_status INTO v_previous_status
  FROM purchase_order_status_history
  WHERE purchase_order_id = NEW.purchase_order_id
    AND version = NEW.version - 1;

  IF NOT FOUND OR v_previous_status IS DISTINCT FROM NEW.from_status THEN
    RAISE EXCEPTION 'purchase-order history must continue from the previous version status'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.from_status = NEW.to_status AND NEW.to_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'only draft edits may create same-status history entries'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.from_status = 'DRAFT' AND NEW.to_status = 'DRAFT' THEN
    IF NEW.actor_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'draft edit history actor must match the authenticated database user'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.to_status = 'SUBMITTED' THEN
    IF NEW.actor_user_id IS DISTINCT FROM v_order.submitted_by_user_id THEN
      RAISE EXCEPTION 'submission history actor must match the recorded submitter'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.to_status = 'APPROVED' THEN
    IF NEW.actor_user_id IS DISTINCT FROM v_order.approved_by_user_id THEN
      RAISE EXCEPTION 'approval history actor must match the recorded approver'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.to_status = 'REJECTED' THEN
    IF NEW.actor_user_id IS DISTINCT FROM v_order.rejected_by_user_id THEN
      RAISE EXCEPTION 'rejection history actor must match the recorded rejector'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.to_status = 'CANCELLED' THEN
    IF NEW.actor_user_id IS DISTINCT FROM v_order.cancelled_by_user_id THEN
      RAISE EXCEPTION 'cancellation history actor must match the recorded canceller'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_purchase_order_history_validate_insert ON purchase_order_status_history;
CREATE TRIGGER trg_purchase_order_history_validate_insert
BEFORE INSERT ON purchase_order_status_history
FOR EACH ROW EXECUTE FUNCTION factoryos_validate_purchase_order_history_insert();

CREATE OR REPLACE FUNCTION factoryos_assert_purchase_order_version_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status VARCHAR(24);
  v_version BIGINT;
BEGIN
  SELECT status, version INTO v_status, v_version
  FROM purchase_orders
  WHERE id = NEW.id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM purchase_order_status_history h
    WHERE h.purchase_order_id = NEW.id
      AND h.tenant_id = NEW.tenant_id
      AND h.factory_id = NEW.factory_id
      AND h.version = v_version
      AND h.to_status = v_status
  ) THEN
    RAISE EXCEPTION 'every committed purchase-order version must have a matching status-history record'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ctr_purchase_order_version_history ON purchase_orders;
CREATE CONSTRAINT TRIGGER ctr_purchase_order_version_history
AFTER INSERT OR UPDATE ON purchase_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_purchase_order_version_history();

INSERT INTO schema_migrations (version, checksum)
VALUES ('068_purchase_order_lifecycle_integrity', NULL)
ON CONFLICT (version) DO NOTHING;

COMMENT ON FUNCTION factoryos_guard_purchase_order_lifecycle() IS
  'Enforces immutable purchase-order identity/decision provenance, draft-only commercial editing, one-step versioning, and legal state transitions.';
COMMENT ON FUNCTION factoryos_validate_purchase_order_history_insert() IS
  'Requires each purchase-order history row to match the aggregate version, chain from its prior status, and identify the recorded lifecycle actor.';
COMMENT ON FUNCTION factoryos_assert_purchase_order_version_history() IS
  'Requires every committed purchase-order aggregate version to have a matching immutable status-history row.';

COMMIT;
