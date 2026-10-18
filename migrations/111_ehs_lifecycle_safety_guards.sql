BEGIN;

CREATE OR REPLACE FUNCTION factoryos_prevent_ehs_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'EHS permits, incidents, corrective actions and audit evidence are retained; use lifecycle transitions'
    USING ERRCODE='55000';
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_ehs_permit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_point JSONB;
  v_match BOOLEAN;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'DRAFT' OR NEW.row_version<>1
       OR NEW.requested_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.approved_by_user_id IS NOT NULL OR NEW.activated_by_user_id IS NOT NULL
       OR NEW.closed_by_user_id IS NOT NULL OR NEW.isolation_verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'Safety permits must begin as unapproved DRAFT records under the authenticated requester'
        USING ERRCODE='42501';
    END IF;
    IF NEW.requires_isolation AND jsonb_array_length(NEW.isolation_points)=0 THEN
      RAISE EXCEPTION 'Permit requiring isolation must declare at least one isolation point'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.row_version<>OLD.row_version+1
     OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Permit updates require the authenticated actor and exactly one version increment'
      USING ERRCODE='42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.factory_id IS DISTINCT FROM OLD.factory_id OR NEW.work_order_id IS DISTINCT FROM OLD.work_order_id
     OR NEW.permit_number IS DISTINCT FROM OLD.permit_number OR NEW.permit_type IS DISTINCT FROM OLD.permit_type
     OR NEW.risk_level IS DISTINCT FROM OLD.risk_level OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.work_scope IS DISTINCT FROM OLD.work_scope OR NEW.location IS DISTINCT FROM OLD.location
     OR NEW.requires_isolation IS DISTINCT FROM OLD.requires_isolation
     OR NEW.isolation_points IS DISTINCT FROM OLD.isolation_points
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id THEN
    RAISE EXCEPTION 'Permit scope and requested work are immutable; create a new permit for scope/time changes'
      USING ERRCODE='23514';
  END IF;
  IF length(btrim(COALESCE(NEW.last_change_reason,'')))=0 THEN
    RAISE EXCEPTION 'Permit lifecycle changes require an auditable reason' USING ERRCODE='23514';
  END IF;

  IF NEW.isolation_verification IS DISTINCT FROM OLD.isolation_verification
     OR NEW.isolation_verified_at IS DISTINCT FROM OLD.isolation_verified_at
     OR NEW.isolation_verified_by_user_id IS DISTINCT FROM OLD.isolation_verified_by_user_id THEN
    IF OLD.isolation_verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'Isolation verification is immutable after recording; issue a new permit if isolation changes'
        USING ERRCODE='23514';
    END IF;
    IF NEW.isolation_verified_at IS NULL
       OR NEW.isolation_verified_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.isolation_verified_at IS NULL OR jsonb_typeof(NEW.isolation_verification)<>'array'
       OR jsonb_array_length(NEW.isolation_verification)=0 THEN
      RAISE EXCEPTION 'Isolation verification requires authenticated verifier, timestamp and checklist evidence'
        USING ERRCODE='42501';
    END IF;
    IF NOT NEW.requires_isolation THEN
      RAISE EXCEPTION 'Isolation verification cannot be added to a permit that does not require isolation'
        USING ERRCODE='23514';
    END IF;
    FOR v_point IN SELECT value FROM jsonb_array_elements(NEW.isolation_points) LOOP
      SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.isolation_verification) v(value)
        WHERE v.value->>'code'=v_point->>'code'
          AND lower(COALESCE(v.value->>'verified','false'))='true'
          AND length(btrim(COALESCE(v.value->>'evidence','')))>0
      ) INTO v_match;
      IF NOT v_match THEN
        RAISE EXCEPTION 'Every declared isolation point needs a positive verified result and evidence'
          USING ERRCODE='23514';
      END IF;
    END LOOP;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status='DRAFT' AND NEW.status IN ('PENDING_APPROVAL','CANCELLED')) OR
      (OLD.status='PENDING_APPROVAL' AND NEW.status IN ('APPROVED','REJECTED','CANCELLED')) OR
      (OLD.status='APPROVED' AND NEW.status IN ('ACTIVE','CANCELLED')) OR
      (OLD.status='ACTIVE' AND NEW.status IN ('CLOSED','EXPIRED'))
    ) THEN
      RAISE EXCEPTION 'Invalid permit transition: % -> %',OLD.status,NEW.status USING ERRCODE='23514';
    END IF;
    IF NEW.status IN ('APPROVED','REJECTED') THEN
      IF NEW.approved_by_user_id IS DISTINCT FROM factoryos_current_user_id()
         OR NEW.approved_by_user_id=NEW.requested_by_user_id OR NEW.approved_at IS NULL
         OR length(btrim(COALESCE(NEW.decision_reason,'')))=0 THEN
        RAISE EXCEPTION 'Permit approval/rejection requires an independent approver and a reason'
          USING ERRCODE='42501';
      END IF;
    ELSIF NEW.status='ACTIVE' THEN
      IF OLD.status<>'APPROVED' OR clock_timestamp()<NEW.valid_from OR clock_timestamp()>=NEW.expires_at THEN
        RAISE EXCEPTION 'Permit can only be activated during its validity window after approval'
          USING ERRCODE='23514';
      END IF;
      IF NEW.requires_isolation AND (NEW.isolation_verified_at IS NULL OR NEW.isolation_verified_by_user_id IS NULL) THEN
        RAISE EXCEPTION 'High-risk permit cannot activate before verified isolation' USING ERRCODE='23514';
      END IF;
      IF NEW.activated_by_user_id IS DISTINCT FROM factoryos_current_user_id() OR NEW.activated_at IS NULL THEN
        RAISE EXCEPTION 'Permit activation requires authenticated activator and timestamp' USING ERRCODE='42501';
      END IF;
    ELSIF NEW.status='CLOSED' THEN
      IF NEW.closed_by_user_id IS DISTINCT FROM factoryos_current_user_id() OR NEW.closed_at IS NULL
         OR NEW.closure_evidence='{}'::jsonb OR length(btrim(COALESCE(NEW.closure_reason,'')))=0 THEN
        RAISE EXCEPTION 'Permit close-out requires actor, timestamp, reason and evidence' USING ERRCODE='23514';
      END IF;
    ELSIF NEW.status='EXPIRED' THEN
      IF clock_timestamp()<NEW.expires_at THEN
        RAISE EXCEPTION 'A permit cannot be marked expired before its expiry time' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;

  IF NEW.status='REJECTED' AND (NEW.approved_by_user_id IS NULL OR length(btrim(COALESCE(NEW.decision_reason,'')))=0) THEN
    RAISE EXCEPTION 'Rejected permits require decision actor and reason' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_ehs_incident()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'OPEN' OR NEW.row_version<>1
       OR NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'Safety reports must start OPEN at version 1 under the authenticated reporter'
        USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.row_version<>OLD.row_version+1
     OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Incident updates require authenticated actor and one version increment' USING ERRCODE='42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.factory_id IS DISTINCT FROM OLD.factory_id OR NEW.incident_number IS DISTINCT FROM OLD.incident_number
     OR NEW.incident_type IS DISTINCT FROM OLD.incident_type OR NEW.severity IS DISTINCT FROM OLD.severity
     OR NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.location IS DISTINCT FROM OLD.location OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id THEN
    RAISE EXCEPTION 'Incident occurrence evidence is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status='OPEN' AND NEW.status IN ('INVESTIGATING','CANCELLED')) OR
      (OLD.status='INVESTIGATING' AND NEW.status IN ('ACTION_REQUIRED','RESOLVED','CANCELLED')) OR
      (OLD.status='ACTION_REQUIRED' AND NEW.status IN ('INVESTIGATING','RESOLVED','CANCELLED')) OR
      (OLD.status='RESOLVED' AND NEW.status IN ('CLOSED','INVESTIGATING'))
    ) THEN
      RAISE EXCEPTION 'Invalid incident transition: % -> %',OLD.status,NEW.status USING ERRCODE='23514';
    END IF;
    IF NEW.status='CLOSED' THEN
      IF NEW.closed_by_user_id IS DISTINCT FROM factoryos_current_user_id()
         OR NEW.closed_at IS NULL OR NEW.closed_by_user_id=NEW.created_by_user_id
         OR (NEW.assigned_owner_user_id IS NOT NULL AND NEW.closed_by_user_id=NEW.assigned_owner_user_id)
         OR length(btrim(COALESCE(NEW.root_cause,'')))=0 OR NEW.closure_evidence='{}'::jsonb THEN
        RAISE EXCEPTION 'Incident closure requires independent verifier, root cause and closure evidence'
          USING ERRCODE='23514';
      END IF;
      IF EXISTS (SELECT 1 FROM ehs_corrective_actions a
        WHERE a.incident_id=OLD.id AND a.tenant_id=OLD.tenant_id AND a.factory_id=OLD.factory_id
          AND a.status NOT IN ('VERIFIED','CANCELLED')) THEN
        RAISE EXCEPTION 'Incident cannot close while corrective actions remain unverified'
          USING ERRCODE='23514';
      END IF;
    END IF;
    IF NEW.status='RESOLVED' AND (
      length(btrim(COALESCE(NEW.root_cause,'')))=0 OR NEW.closure_evidence='{}'::jsonb
    ) THEN
      RAISE EXCEPTION 'Incident resolution requires root-cause analysis and evidence' USING ERRCODE='23514';
    END IF;
    IF length(btrim(COALESCE(NEW.last_change_reason,'')))=0 THEN
      RAISE EXCEPTION 'Incident status transition requires a reason' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_ehs_corrective_action()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_incident_status VARCHAR(20);
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'OPEN' OR NEW.row_version<>1
       OR NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'Corrective actions must start OPEN under authenticated creator' USING ERRCODE='42501';
    END IF;
    SELECT status INTO v_incident_status FROM ehs_incidents
      WHERE id=NEW.incident_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id FOR UPDATE;
    IF NOT FOUND OR v_incident_status IN ('RESOLVED','CLOSED','CANCELLED') THEN
      RAISE EXCEPTION 'Corrective actions can only be attached to an active incident' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.row_version<>OLD.row_version+1
     OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Corrective-action updates require authenticated actor and one version increment' USING ERRCODE='42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.factory_id IS DISTINCT FROM OLD.factory_id OR NEW.incident_id IS DISTINCT FROM OLD.incident_id
     OR NEW.action_number IS DISTINCT FROM OLD.action_number OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.assigned_owner_user_id IS DISTINCT FROM OLD.assigned_owner_user_id OR NEW.due_at IS DISTINCT FROM OLD.due_at
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id THEN
    RAISE EXCEPTION 'Corrective-action scope and original commitment are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status='OPEN' AND NEW.status IN ('IN_PROGRESS','CANCELLED')) OR
      (OLD.status='IN_PROGRESS' AND NEW.status IN ('READY_FOR_VERIFICATION','CANCELLED')) OR
      (OLD.status='READY_FOR_VERIFICATION' AND NEW.status IN ('VERIFIED','IN_PROGRESS'))
    ) THEN
      RAISE EXCEPTION 'Invalid corrective-action transition: % -> %',OLD.status,NEW.status USING ERRCODE='23514';
    END IF;
    IF NEW.status='READY_FOR_VERIFICATION' THEN
      IF NEW.submitted_by_user_id IS DISTINCT FROM factoryos_current_user_id()
         OR NEW.submitted_at IS NULL OR NEW.completion_evidence='{}'::jsonb
         OR length(btrim(COALESCE(NEW.root_cause,'')))=0 THEN
        RAISE EXCEPTION 'Corrective-action submission requires root-cause detail and completion evidence' USING ERRCODE='23514';
      END IF;
    ELSIF NEW.status='VERIFIED' THEN
      IF NEW.verified_by_user_id IS DISTINCT FROM factoryos_current_user_id()
         OR NEW.verified_by_user_id=NEW.assigned_owner_user_id
         OR NEW.verified_by_user_id=NEW.submitted_by_user_id
         OR NEW.verified_by_user_id=NEW.created_by_user_id
         OR NEW.verified_at IS NULL OR NEW.verification_evidence='{}'::jsonb THEN
        RAISE EXCEPTION 'Corrective-action verification must be independent and evidence-backed' USING ERRCODE='42501';
      END IF;
    ELSIF NEW.status='IN_PROGRESS' AND OLD.status='READY_FOR_VERIFICATION' THEN
      NEW.submitted_by_user_id:=NULL;
      NEW.submitted_at:=NULL;
    END IF;
    IF length(btrim(COALESCE(NEW.last_change_reason,'')))=0 THEN
      RAISE EXCEPTION 'Corrective-action transition requires an auditable reason' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_append_ehs_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_row JSONB:=to_jsonb(NEW);
  v_type VARCHAR(32);
  v_actor UUID;
  v_version BIGINT;
  v_action VARCHAR(48);
BEGIN
  v_type:=CASE TG_TABLE_NAME
    WHEN 'ehs_safety_permits' THEN 'PERMIT'
    WHEN 'ehs_incidents' THEN 'INCIDENT'
    WHEN 'ehs_corrective_actions' THEN 'CORRECTIVE_ACTION'
    ELSE NULL
  END;
  v_actor:=COALESCE(NULLIF(v_row->>'updated_by_user_id','')::UUID,
    NULLIF(v_row->>'requested_by_user_id','')::UUID,
    NULLIF(v_row->>'created_by_user_id','')::UUID,
    factoryos_current_user_id());
  IF v_actor IS NULL OR v_type IS NULL THEN
    RAISE EXCEPTION 'EHS audit requires authenticated actor and known entity' USING ERRCODE='42501';
  END IF;
  v_version:=COALESCE(NULLIF(v_row->>'row_version','')::BIGINT,1);
  v_action:=CASE
    WHEN TG_OP='INSERT' THEN 'CREATED'
    ELSE COALESCE(v_row->>'status','UPDATED')
  END;
  INSERT INTO ehs_audit_events(tenant_id,factory_id,entity_type,entity_id,entity_version,action,actor_user_id,reason,event_data,correlation_id)
  VALUES ((v_row->>'tenant_id')::UUID,(v_row->>'factory_id')::UUID,v_type,(v_row->>'id')::UUID,v_version,v_action,
    v_actor,COALESCE(v_row->>'last_change_reason',v_row->>'decision_reason',v_row->>'closure_reason'),
    jsonb_strip_nulls(jsonb_build_object('status',v_row->>'status','severity',v_row->>'severity',
      'permit_type',v_row->>'permit_type','incident_type',v_row->>'incident_type',
      'action_number',v_row->>'action_number','risk_level',v_row->>'risk_level')),
    NULLIF(v_row->>'correlation_id','')::UUID);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_prevent_ehs_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'EHS audit evidence is append-only' USING ERRCODE='55000';
END;
$$;

CREATE TRIGGER trg_ehs_permit_guard BEFORE INSERT OR UPDATE ON ehs_safety_permits
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_ehs_permit();
CREATE TRIGGER trg_ehs_incident_guard BEFORE INSERT OR UPDATE ON ehs_incidents
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_ehs_incident();
CREATE TRIGGER trg_ehs_corrective_action_guard BEFORE INSERT OR UPDATE ON ehs_corrective_actions
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_ehs_corrective_action();
CREATE TRIGGER trg_ehs_permit_audit AFTER INSERT OR UPDATE ON ehs_safety_permits
  FOR EACH ROW EXECUTE FUNCTION factoryos_append_ehs_audit();
CREATE TRIGGER trg_ehs_incident_audit AFTER INSERT OR UPDATE ON ehs_incidents
  FOR EACH ROW EXECUTE FUNCTION factoryos_append_ehs_audit();
CREATE TRIGGER trg_ehs_action_audit AFTER INSERT OR UPDATE ON ehs_corrective_actions
  FOR EACH ROW EXECUTE FUNCTION factoryos_append_ehs_audit();
CREATE TRIGGER trg_ehs_audit_immutable BEFORE UPDATE OR DELETE ON ehs_audit_events
  FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_ehs_evidence_mutation();

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ehs_safety_permits','ehs_incidents','ehs_corrective_actions','ehs_audit_events'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_ehs_delete()',
      'trg_'||t||'_delete_guard',t);
  END LOOP;
END;
$$;

INSERT INTO schema_migrations(version,checksum)
VALUES ('111_ehs_lifecycle_safety_guards',NULL)
ON CONFLICT(version) DO NOTHING;
COMMIT;
