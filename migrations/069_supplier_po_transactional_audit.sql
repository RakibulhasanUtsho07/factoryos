BEGIN;

CREATE OR REPLACE FUNCTION factoryos_audit_supplier_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_action VARCHAR(100);
  v_actor UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'CREATE';
    v_actor := NEW.created_by_user_id;
  ELSE
    v_actor := COALESCE(factoryos_current_user_id(), NEW.created_by_user_id);
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      v_action := 'STATUS_CHANGED';
    ELSE
      v_action := 'UPDATED';
    END IF;
  END IF;

  INSERT INTO audit_events (
    tenant_id, factory_id, actor_user_id, event_type, action,
    resource_type, resource_id, correlation_id, request_id, data_class, payload
  ) VALUES (
    NEW.tenant_id, NULL, v_actor, 'PROCUREMENT', v_action,
    'SUPPLIER', NEW.id, NULL, NULL, 'INTERNAL',
    jsonb_build_object(
      'supplier_id', NEW.id,
      'code', NEW.code,
      'name', NEW.name,
      'status', NEW.status,
      'version', NEW.version,
      'previous_status', CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_suppliers_transactional_audit ON suppliers;
CREATE TRIGGER trg_suppliers_transactional_audit
AFTER INSERT OR UPDATE ON suppliers
FOR EACH ROW EXECUTE FUNCTION factoryos_audit_supplier_lifecycle();

CREATE OR REPLACE FUNCTION factoryos_audit_purchase_order_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_po_number VARCHAR(100);
  v_action VARCHAR(100);
BEGIN
  SELECT po_number INTO v_po_number
  FROM purchase_orders
  WHERE id = NEW.purchase_order_id
    AND tenant_id = NEW.tenant_id
    AND factory_id = NEW.factory_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cannot audit history without its purchase-order parent'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.from_status IS NULL THEN
    v_action := 'CREATE';
  ELSIF NEW.from_status = NEW.to_status THEN
    v_action := 'DRAFT_UPDATED';
  ELSE
    v_action := 'STATUS_CHANGED';
  END IF;

  INSERT INTO audit_events (
    tenant_id, factory_id, actor_user_id, event_type, action,
    resource_type, resource_id, correlation_id, request_id, data_class, payload
  ) VALUES (
    NEW.tenant_id, NEW.factory_id, NEW.actor_user_id, 'PROCUREMENT', v_action,
    'PURCHASE_ORDER', NEW.purchase_order_id, NEW.trace_id, NEW.request_id, 'INTERNAL',
    jsonb_build_object(
      'purchase_order_id', NEW.purchase_order_id,
      'po_number', v_po_number,
      'from_status', NEW.from_status,
      'to_status', NEW.to_status,
      'version', NEW.version,
      'reason', NEW.reason
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_purchase_order_history_transactional_audit ON purchase_order_status_history;
CREATE TRIGGER trg_purchase_order_history_transactional_audit
AFTER INSERT ON purchase_order_status_history
FOR EACH ROW EXECUTE FUNCTION factoryos_audit_purchase_order_history();

INSERT INTO schema_migrations (version, checksum)
VALUES ('069_supplier_po_transactional_audit', NULL)
ON CONFLICT (version) DO NOTHING;

COMMENT ON FUNCTION factoryos_audit_supplier_lifecycle() IS
  'Persists supplier creation and update audit events in the same transaction as supplier mutations.';
COMMENT ON FUNCTION factoryos_audit_purchase_order_history() IS
  'Persists each PO aggregate-version history entry as an audit event in the same transaction.';

COMMIT;
