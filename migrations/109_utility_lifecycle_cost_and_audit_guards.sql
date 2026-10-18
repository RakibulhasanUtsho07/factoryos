BEGIN;

CREATE OR REPLACE FUNCTION factoryos_guard_utility_meter()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_parent RECORD;
  v_seen UUID[] := ARRAY[]::UUID[];
  v_parent_id UUID;
  v_parent_status VARCHAR(16);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::TEXT || ':' || NEW.factory_id::TEXT || ':utility-meter-tree',0
  ));
  IF TG_OP='INSERT' THEN
    IF NEW.row_version<>1 OR NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'Utility meter registration must start at version 1 under authenticated actor'
        USING ERRCODE='42501';
    END IF;
  ELSE
    IF NEW.row_version<>OLD.row_version+1
       OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'Utility meter updates require authenticated actor and one version increment'
        USING ERRCODE='42501';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
       OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id THEN
      RAISE EXCEPTION 'Utility meter identity, scope and creation evidence are immutable'
        USING ERRCODE='23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status='ACTIVE' AND NEW.status IN ('INACTIVE','RETIRED')) OR
      (OLD.status='INACTIVE' AND NEW.status IN ('ACTIVE','RETIRED'))
    ) THEN
      RAISE EXCEPTION 'Invalid utility meter status transition: % -> %',OLD.status,NEW.status
        USING ERRCODE='23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status<>'ACTIVE' THEN
      IF EXISTS (SELECT 1 FROM utility_meters child
        WHERE child.parent_meter_id=OLD.id AND child.tenant_id=OLD.tenant_id
          AND child.factory_id=OLD.factory_id AND child.status='ACTIVE') THEN
        RAISE EXCEPTION 'Cannot deactivate a meter with active child meters' USING ERRCODE='23514';
      END IF;
      IF EXISTS (SELECT 1 FROM utility_events e
        WHERE e.meter_id=OLD.id AND e.tenant_id=OLD.tenant_id AND e.factory_id=OLD.factory_id
          AND e.status IN ('OPEN','ACKNOWLEDGED')) THEN
        RAISE EXCEPTION 'Resolve open utility events before deactivating a meter' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;

  IF NEW.parent_meter_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_meter_id=NEW.id THEN
    RAISE EXCEPTION 'A utility meter cannot be its own parent' USING ERRCODE='23514';
  END IF;
  SELECT id,parent_meter_id,status INTO v_parent
  FROM utility_meters
  WHERE id=NEW.parent_meter_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
  FOR SHARE;
  IF NOT FOUND OR v_parent.status<>'ACTIVE' THEN
    RAISE EXCEPTION 'Parent utility meter must be active and in the same factory' USING ERRCODE='23503';
  END IF;
  v_parent_id:=v_parent.parent_meter_id;
  v_seen:=array_append(v_seen,NEW.parent_meter_id);
  WHILE v_parent_id IS NOT NULL LOOP
    IF v_parent_id=NEW.id OR v_parent_id=ANY(v_seen) THEN
      RAISE EXCEPTION 'Utility meter hierarchy cannot contain a cycle' USING ERRCODE='23514';
    END IF;
    v_seen:=array_append(v_seen,v_parent_id);
    SELECT parent_meter_id INTO v_parent_id FROM utility_meters
      WHERE id=v_parent_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Utility meter hierarchy must remain within the same factory' USING ERRCODE='23503';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_validate_utility_meter_reading()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_meter RECORD;
  v_last RECORD;
  v_previous NUMERIC(24,8);
  v_expected NUMERIC(24,8);
  v_expected_cost NUMERIC(24,8);
BEGIN
  IF NEW.recorded_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Utility reading recorder must match authenticated database context' USING ERRCODE='42501';
  END IF;
  SELECT status,reading_mode,unit_code,multiplier_factor,unit_cost
    INTO v_meter FROM utility_meters
    WHERE id=NEW.meter_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id FOR UPDATE;
  IF NOT FOUND OR v_meter.status<>'ACTIVE' THEN
    RAISE EXCEPTION 'Utility reading requires an active meter in the same factory' USING ERRCODE='23514';
  END IF;
  IF NEW.unit_code<>v_meter.unit_code OR NEW.unit_cost_snapshot<>v_meter.unit_cost THEN
    RAISE EXCEPTION 'Reading unit and cost must snapshot the active meter configuration' USING ERRCODE='23514';
  END IF;
  SELECT reading_at,reading_value INTO v_last FROM utility_meter_readings
    WHERE meter_id=NEW.meter_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
    ORDER BY reading_at DESC,id DESC LIMIT 1 FOR UPDATE;
  IF FOUND AND NEW.reading_at<=v_last.reading_at THEN
    RAISE EXCEPTION 'Utility readings must be strictly time-ordered; use a correction workflow for late data'
      USING ERRCODE='23514';
  END IF;

  IF v_meter.reading_mode='CUMULATIVE' THEN
    v_previous:=CASE WHEN v_last.reading_at IS NULL THEN NULL ELSE v_last.reading_value END;
    IF NEW.previous_reading_value IS DISTINCT FROM v_previous THEN
      RAISE EXCEPTION 'Cumulative reading previous value does not match the locked meter ledger'
        USING ERRCODE='23514';
    END IF;
    IF v_previous IS NULL THEN
      v_expected:=0;
    ELSE
      IF NEW.reading_value<v_previous THEN
        RAISE EXCEPTION 'Cumulative meter value cannot decrease without a governed rollover/correction'
          USING ERRCODE='23514';
      END IF;
      v_expected:=ROUND((NEW.reading_value-v_previous)*v_meter.multiplier_factor,8);
    END IF;
  ELSE
    IF NEW.previous_reading_value IS NOT NULL THEN
      RAISE EXCEPTION 'Interval meters cannot set a previous cumulative reading' USING ERRCODE='23514';
    END IF;
    v_expected:=ROUND(NEW.reading_value*v_meter.multiplier_factor,8);
  END IF;
  v_expected_cost:=ROUND(v_expected*v_meter.unit_cost,8);
  IF NEW.consumption_quantity<>v_expected OR NEW.cost_amount<>v_expected_cost THEN
    RAISE EXCEPTION 'Consumption and cost must match the meter mode, multiplier and rate snapshot'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_guard_utility_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.row_version<>1 OR NEW.status<>'OPEN'
       OR NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'Utility events must start OPEN at version 1 under authenticated actor' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.row_version<>OLD.row_version+1
     OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Utility event transitions require authenticated actor and one version increment'
      USING ERRCODE='42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.factory_id IS DISTINCT FROM OLD.factory_id OR NEW.meter_id IS DISTINCT FROM OLD.meter_id
     OR NEW.event_number IS DISTINCT FROM OLD.event_number OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.severity IS DISTINCT FROM OLD.severity OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.description IS DISTINCT FROM OLD.description OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id THEN
    RAISE EXCEPTION 'Utility event occurrence evidence is immutable; append a separate event for new occurrences'
      USING ERRCODE='23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status='OPEN' AND NEW.status IN ('ACKNOWLEDGED','CANCELLED')) OR
    (OLD.status='ACKNOWLEDGED' AND NEW.status IN ('RESOLVED','CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'Invalid utility event transition: % -> %',OLD.status,NEW.status USING ERRCODE='23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND length(btrim(COALESCE(NEW.last_change_reason,'')))=0 THEN
    RAISE EXCEPTION 'Utility event transitions require an auditable reason' USING ERRCODE='23514';
  END IF;
  IF NEW.status='RESOLVED' AND (NEW.resolved_at IS NULL OR length(btrim(COALESCE(NEW.resolution,'')))=0) THEN
    RAISE EXCEPTION 'Resolving a utility event requires timestamp and resolution evidence' USING ERRCODE='23514';
  END IF;
  IF NEW.status<>'RESOLVED' AND NEW.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'Only resolved events may have resolved_at set' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_append_utility_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_row JSONB:=to_jsonb(NEW);
  v_type VARCHAR(24);
  v_actor UUID;
  v_version BIGINT;
  v_action VARCHAR(48);
BEGIN
  v_type:=CASE TG_TABLE_NAME
    WHEN 'utility_meters' THEN 'METER'
    WHEN 'utility_meter_readings' THEN 'READING'
    WHEN 'utility_events' THEN 'UTILITY_EVENT'
    ELSE NULL
  END;
  v_actor:=COALESCE(NULLIF(v_row->>'updated_by_user_id','')::UUID,
    NULLIF(v_row->>'created_by_user_id','')::UUID,
    NULLIF(v_row->>'recorded_by_user_id','')::UUID,
    factoryos_current_user_id());
  IF v_actor IS NULL OR v_type IS NULL THEN
    RAISE EXCEPTION 'Utility audit event requires authenticated actor and known entity' USING ERRCODE='42501';
  END IF;
  v_version:=COALESCE(NULLIF(v_row->>'row_version','')::BIGINT,1);
  v_action:=CASE
    WHEN TG_TABLE_NAME='utility_meter_readings' THEN 'READING_RECORDED'
    WHEN TG_OP='INSERT' THEN 'CREATED'
    ELSE COALESCE(v_row->>'status','UPDATED')
  END;
  INSERT INTO utility_audit_events(tenant_id,factory_id,entity_type,entity_id,entity_version,action,actor_user_id,reason,event_data,correlation_id)
  VALUES ((v_row->>'tenant_id')::UUID,(v_row->>'factory_id')::UUID,v_type,(v_row->>'id')::UUID,v_version,v_action,
    v_actor,COALESCE(v_row->>'last_change_reason',v_row->>'resolution',v_row->>'notes'),
    jsonb_strip_nulls(jsonb_build_object('status',v_row->>'status','meter_id',v_row->>'meter_id',
      'utility_type',v_row->>'utility_type','reading_at',v_row->>'reading_at',
      'consumption_quantity',v_row->>'consumption_quantity','cost_amount',v_row->>'cost_amount',
      'event_type',v_row->>'event_type','severity',v_row->>'severity','impact_minutes',v_row->>'impact_minutes')),
    NULLIF(v_row->>'correlation_id','')::UUID);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_prevent_utility_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Utility readings and audit evidence are append-only' USING ERRCODE='55000';
END;
$$;
CREATE OR REPLACE FUNCTION factoryos_prevent_utility_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Utility records are retained for audit; use lifecycle transitions' USING ERRCODE='55000';
END;
$$;

CREATE TRIGGER trg_utility_meter_guard BEFORE INSERT OR UPDATE ON utility_meters
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_utility_meter();
CREATE TRIGGER trg_utility_reading_guard BEFORE INSERT ON utility_meter_readings
  FOR EACH ROW EXECUTE FUNCTION factoryos_validate_utility_meter_reading();
CREATE TRIGGER trg_utility_event_guard BEFORE INSERT OR UPDATE ON utility_events
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_utility_event();
CREATE TRIGGER trg_utility_meter_audit AFTER INSERT OR UPDATE ON utility_meters
  FOR EACH ROW EXECUTE FUNCTION factoryos_append_utility_audit();
CREATE TRIGGER trg_utility_reading_audit AFTER INSERT ON utility_meter_readings
  FOR EACH ROW EXECUTE FUNCTION factoryos_append_utility_audit();
CREATE TRIGGER trg_utility_event_audit AFTER INSERT OR UPDATE ON utility_events
  FOR EACH ROW EXECUTE FUNCTION factoryos_append_utility_audit();
CREATE TRIGGER trg_utility_reading_immutable BEFORE UPDATE OR DELETE ON utility_meter_readings
  FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_utility_evidence_mutation();
CREATE TRIGGER trg_utility_audit_immutable BEFORE UPDATE OR DELETE ON utility_audit_events
  FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_utility_evidence_mutation();
CREATE TRIGGER trg_utility_meter_delete_guard BEFORE DELETE ON utility_meters
  FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_utility_delete();
CREATE TRIGGER trg_utility_event_delete_guard BEFORE DELETE ON utility_events
  FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_utility_delete();
CREATE TRIGGER trg_utility_audit_delete_guard BEFORE DELETE ON utility_audit_events
  FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_utility_delete();

INSERT INTO schema_migrations(version,checksum)
VALUES ('109_utility_lifecycle_cost_and_audit_guards',NULL)
ON CONFLICT(version) DO NOTHING;
COMMIT;
