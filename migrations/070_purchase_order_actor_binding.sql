BEGIN;

-- Bind every PO creator and transition actor to the authenticated transaction
-- identity, and disallow a DRAFT -> CANCELLED write from inventing submit data.
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
    IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'purchase-order creator must match the authenticated database user'
        USING ERRCODE = '23514';
    END IF;
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
           OR NEW.submitted_by_user_id IS DISTINCT FROM factoryos_current_user_id()
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
           OR NEW.approved_by_user_id IS DISTINCT FROM factoryos_current_user_id()
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
           OR NEW.rejected_by_user_id IS DISTINCT FROM factoryos_current_user_id()
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
           OR NEW.cancelled_by_user_id IS DISTINCT FROM factoryos_current_user_id()
           OR length(btrim(COALESCE(NEW.cancellation_reason, ''))) = 0
           OR ROW(
             NEW.submitted_by_user_id, NEW.submitted_at,
             NEW.approved_by_user_id, NEW.approved_at,
             NEW.rejected_by_user_id, NEW.rejected_at, NEW.rejection_reason
           ) IS DISTINCT FROM ROW(
             OLD.submitted_by_user_id, OLD.submitted_at,
             OLD.approved_by_user_id, OLD.approved_at,
             OLD.rejected_by_user_id, OLD.rejected_at, OLD.rejection_reason
           ) THEN
          RAISE EXCEPTION 'cancellation requires the current actor, timestamp and reason without fabricating submission or another decision'
            USING ERRCODE = '23514';
        END IF;
    END CASE;
  END IF;

  RETURN NEW;
END;
$$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('070_purchase_order_actor_binding', NULL)
ON CONFLICT (version) DO NOTHING;

COMMENT ON FUNCTION factoryos_guard_purchase_order_lifecycle() IS
  'Enforces one-step versioning, legal transitions, write-once decision facts, session-bound actors, and prevents draft cancellation from fabricating submission history.';

COMMIT;
