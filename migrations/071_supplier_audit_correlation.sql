BEGIN;

CREATE OR REPLACE FUNCTION factoryos_audit_supplier_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_action VARCHAR(100);
  v_actor UUID;
  v_changed_fields JSONB := '[]'::jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'CREATE';
    v_actor := NEW.created_by_user_id;
    v_changed_fields := jsonb_build_array('created');
  ELSE
    v_actor := COALESCE(factoryos_current_user_id(), NEW.created_by_user_id);
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      v_action := 'STATUS_CHANGED';
    ELSE
      v_action := 'UPDATED';
    END IF;
    IF NEW.name IS DISTINCT FROM OLD.name THEN v_changed_fields := v_changed_fields || '["name"]'::jsonb; END IF;
    IF NEW.country_code IS DISTINCT FROM OLD.country_code THEN v_changed_fields := v_changed_fields || '["country_code"]'::jsonb; END IF;
    IF NEW.email IS DISTINCT FROM OLD.email THEN v_changed_fields := v_changed_fields || '["email"]'::jsonb; END IF;
    IF NEW.phone IS DISTINCT FROM OLD.phone THEN v_changed_fields := v_changed_fields || '["phone"]'::jsonb; END IF;
    IF NEW.tax_reference IS DISTINCT FROM OLD.tax_reference THEN v_changed_fields := v_changed_fields || '["tax_reference"]'::jsonb; END IF;
    IF NEW.payment_terms_days IS DISTINCT FROM OLD.payment_terms_days THEN v_changed_fields := v_changed_fields || '["payment_terms_days"]'::jsonb; END IF;
    IF NEW.currency IS DISTINCT FROM OLD.currency THEN v_changed_fields := v_changed_fields || '["currency"]'::jsonb; END IF;
    IF NEW.address IS DISTINCT FROM OLD.address THEN v_changed_fields := v_changed_fields || '["address"]'::jsonb; END IF;
    IF NEW.notes IS DISTINCT FROM OLD.notes THEN v_changed_fields := v_changed_fields || '["notes"]'::jsonb; END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN v_changed_fields := v_changed_fields || '["status"]'::jsonb; END IF;
  END IF;

  INSERT INTO audit_events (
    tenant_id, factory_id, actor_user_id, event_type, action,
    resource_type, resource_id, correlation_id, request_id, data_class, payload
  ) VALUES (
    NEW.tenant_id, NULL, v_actor, 'PROCUREMENT', v_action,
    'SUPPLIER', NEW.id,
    NULLIF(current_setting('app.trace_id', true), '')::uuid,
    NULLIF(current_setting('app.request_id', true), '')::uuid,
    'INTERNAL',
    jsonb_build_object(
      'supplier_id', NEW.id,
      'code', NEW.code,
      'name', NEW.name,
      'status', NEW.status,
      'version', NEW.version,
      'previous_status', CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END,
      'changed_fields', v_changed_fields
    )
  );

  RETURN NEW;
END;
$$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('071_supplier_audit_correlation', NULL)
ON CONFLICT (version) DO NOTHING;

COMMENT ON FUNCTION factoryos_audit_supplier_lifecycle() IS
  'Persists supplier creation, profile updates, and status changes transactionally with actor, request, trace and changed-field metadata.';

COMMIT;
