BEGIN;

INSERT INTO permissions (code, description)
VALUES
  ('quality.capa.verify', 'Independently verify completed containment, corrective and preventive action evidence'),
  ('quality.rework.manage', 'Approve, execute and verify quality rework orders'),
  ('quality.defects.trace', 'Link defects to traceability lots, serials, orders and production evidence')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.code IN ('quality.capa.verify', 'quality.defects.trace', 'quality.rework.manage')
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER', 'QUALITY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

ALTER TABLE quality_ncr_actions
  ADD COLUMN action_status VARCHAR(16) NOT NULL DEFAULT 'PLANNED',
  ADD COLUMN row_version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN started_by_user_id UUID,
  ADD COLUMN started_at TIMESTAMPTZ,
  ADD COLUMN completed_by_user_id UUID,
  ADD COLUMN completed_at TIMESTAMPTZ,
  ADD COLUMN completion_notes TEXT,
  ADD COLUMN completion_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN verified_by_user_id UUID,
  ADD COLUMN verified_at TIMESTAMPTZ,
  ADD COLUMN verification_notes TEXT,
  ADD COLUMN verification_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN updated_by_user_id UUID,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ADD CONSTRAINT fk_quality_ncr_action_starter FOREIGN KEY (started_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_quality_ncr_action_completer FOREIGN KEY (completed_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_quality_ncr_action_verifier FOREIGN KEY (verified_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_quality_ncr_action_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_quality_ncr_action_status CHECK (action_status IN ('PLANNED','IN_PROGRESS','COMPLETED','VERIFIED','REJECTED')),
  ADD CONSTRAINT chk_quality_ncr_action_version CHECK (row_version > 0),
  ADD CONSTRAINT chk_quality_ncr_action_evidence_shape CHECK (
    jsonb_typeof(completion_evidence) = 'object' AND jsonb_typeof(verification_evidence) = 'object'
  ),
  ADD CONSTRAINT chk_quality_ncr_action_stage_evidence CHECK (
    (action_status = 'PLANNED' AND started_by_user_id IS NULL AND started_at IS NULL
      AND completed_by_user_id IS NULL AND completed_at IS NULL
      AND verified_by_user_id IS NULL AND verified_at IS NULL)
    OR (action_status = 'IN_PROGRESS' AND started_by_user_id IS NOT NULL AND started_at IS NOT NULL
      AND completed_by_user_id IS NULL AND completed_at IS NULL
      AND verified_by_user_id IS NULL AND verified_at IS NULL)
    OR (action_status = 'COMPLETED' AND started_by_user_id IS NOT NULL AND started_at IS NOT NULL
      AND completed_by_user_id IS NOT NULL AND completed_at IS NOT NULL
      AND length(btrim(COALESCE(completion_notes,''))) > 0 AND completion_evidence <> '{}'::jsonb
      AND verified_by_user_id IS NULL AND verified_at IS NULL)
    OR (action_status IN ('VERIFIED','REJECTED') AND started_by_user_id IS NOT NULL AND started_at IS NOT NULL
      AND completed_by_user_id IS NOT NULL AND completed_at IS NOT NULL
      AND length(btrim(COALESCE(completion_notes,''))) > 0 AND completion_evidence <> '{}'::jsonb
      AND verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL
      AND length(btrim(COALESCE(verification_notes,''))) > 0 AND verification_evidence <> '{}'::jsonb)
  );

DROP TRIGGER trg_quality_ncr_actions_immutable ON quality_ncr_actions;

CREATE TABLE quality_ncr_action_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  ncr_id UUID NOT NULL,
  action_id UUID NOT NULL,
  version BIGINT NOT NULL,
  from_status VARCHAR(16),
  to_status VARCHAR(16) NOT NULL,
  command VARCHAR(24) NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  actor_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_quality_ncr_action_event_version UNIQUE (action_id, version),
  CONSTRAINT uq_quality_ncr_action_event_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_quality_ncr_action_event_ncr FOREIGN KEY (ncr_id, tenant_id, factory_id)
    REFERENCES quality_ncrs(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_ncr_action_event_action FOREIGN KEY (action_id, tenant_id, factory_id)
    REFERENCES quality_ncr_actions(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_ncr_action_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_ncr_action_event_status CHECK (
    (from_status IS NULL OR from_status IN ('PLANNED','IN_PROGRESS','COMPLETED','VERIFIED','REJECTED'))
    AND to_status IN ('PLANNED','IN_PROGRESS','COMPLETED','VERIFIED','REJECTED')
  ),
  CONSTRAINT chk_quality_ncr_action_event_command CHECK (command IN ('CREATED','START','COMPLETE','VERIFY_PASS','VERIFY_FAIL')),
  CONSTRAINT chk_quality_ncr_action_event_reason CHECK (length(btrim(reason)) > 0),
  CONSTRAINT chk_quality_ncr_action_event_evidence CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT chk_quality_ncr_action_event_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_quality_ncr_action_event_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_quality_ncr_action_event_history
  ON quality_ncr_action_events(tenant_id, factory_id, ncr_id, action_id, version);

CREATE OR REPLACE FUNCTION factoryos_guard_quality_ncr_action_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CAPA plans and lifecycle evidence cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.recorded_by_user_id IS DISTINCT FROM factoryos_current_user_id()
      OR NEW.action_status <> 'PLANNED' OR NEW.row_version <> 1
      OR NEW.updated_by_user_id IS NOT NULL
      OR NEW.started_by_user_id IS NOT NULL OR NEW.completed_by_user_id IS NOT NULL
      OR NEW.verified_by_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'CAPA action must start PLANNED under the authenticated actor' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.tenant_id, NEW.factory_id, NEW.ncr_id, NEW.action_type, NEW.action_text,
      NEW.responsible_user_id, NEW.due_date, NEW.idempotency_key, NEW.request_hash,
      NEW.recorded_by_user_id, NEW.correlation_id, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id, OLD.tenant_id, OLD.factory_id, OLD.ncr_id, OLD.action_type, OLD.action_text,
      OLD.responsible_user_id, OLD.due_date, OLD.idempotency_key, OLD.request_hash,
      OLD.recorded_by_user_id, OLD.correlation_id, OLD.created_at)
    OR OLD.action_status = 'VERIFIED'
    OR NEW.row_version <> OLD.row_version + 1
    OR NEW.updated_at <= OLD.updated_at
    OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'CAPA action identity is immutable and lifecycle writes require versioned actor evidence'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.action_status = 'PLANNED' AND NEW.action_status = 'IN_PROGRESS' THEN
    IF NEW.started_by_user_id IS DISTINCT FROM factoryos_current_user_id()
      OR NEW.started_at IS NULL OR NEW.completed_by_user_id IS NOT NULL OR NEW.completed_at IS NOT NULL
      OR NEW.verified_by_user_id IS NOT NULL OR NEW.verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'starting CAPA requires authenticated start evidence' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.action_status = 'IN_PROGRESS' AND NEW.action_status = 'COMPLETED' THEN
    IF NEW.completed_by_user_id IS DISTINCT FROM factoryos_current_user_id()
      OR NEW.completed_at IS NULL OR length(btrim(COALESCE(NEW.completion_notes,''))) = 0
      OR NEW.completion_evidence = '{}'::jsonb OR NEW.verified_by_user_id IS NOT NULL OR NEW.verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'CAPA completion requires notes and evidence before independent verification' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.action_status = 'COMPLETED' AND NEW.action_status IN ('VERIFIED','REJECTED') THEN
    IF NEW.verified_by_user_id IS DISTINCT FROM factoryos_current_user_id()
      OR NEW.verified_by_user_id = OLD.completed_by_user_id
      OR NEW.verified_at IS NULL OR length(btrim(COALESCE(NEW.verification_notes,''))) = 0
      OR NEW.verification_evidence = '{}'::jsonb THEN
      RAISE EXCEPTION 'CAPA verification requires evidence from a different actor than the completer'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.action_status = 'REJECTED' AND NEW.action_status = 'IN_PROGRESS' THEN
    IF NEW.started_by_user_id IS DISTINCT FROM factoryos_current_user_id()
      OR NEW.started_at IS NULL OR NEW.completed_by_user_id IS NOT NULL OR NEW.completed_at IS NOT NULL
      OR NEW.verified_by_user_id IS NOT NULL OR NEW.verified_at IS NOT NULL
      OR NEW.completion_notes IS NOT NULL OR NEW.completion_evidence <> '{}'::jsonb
      OR NEW.verification_notes IS NOT NULL OR NEW.verification_evidence <> '{}'::jsonb THEN
      RAISE EXCEPTION 'rejected CAPA action must be restarted with fresh evidence' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid CAPA action transition: % -> %', OLD.action_status, NEW.action_status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_ncr_action_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON quality_ncr_actions
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_ncr_action_lifecycle();

CREATE OR REPLACE FUNCTION factoryos_guard_quality_ncr_action_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_action quality_ncr_actions%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'CAPA action transition history is append-only' USING ERRCODE = '55000';
  END IF;
  IF NEW.actor_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'CAPA event actor must match the authenticated user' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_action FROM quality_ncr_actions
  WHERE id = NEW.action_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
  IF NOT FOUND OR v_action.ncr_id <> NEW.ncr_id OR v_action.row_version <> NEW.version
    OR v_action.action_status <> NEW.to_status THEN
    RAISE EXCEPTION 'CAPA event must describe the applied action version and status' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_ncr_action_event_guard
BEFORE INSERT OR UPDATE OR DELETE ON quality_ncr_action_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_ncr_action_event();
CREATE TRIGGER trg_quality_ncr_action_events_immutable
BEFORE UPDATE OR DELETE ON quality_ncr_action_events
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_quality_audit_mutation();

CREATE OR REPLACE FUNCTION factoryos_quality_guard_ncr_close()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'CLOSED' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NOT EXISTS (SELECT 1 FROM quality_ncr_actions a WHERE a.ncr_id = NEW.id
      AND a.action_type = 'CONTAINMENT' AND a.action_status = 'VERIFIED'
      AND a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id)
      OR NOT EXISTS (SELECT 1 FROM quality_ncr_actions a WHERE a.ncr_id = NEW.id
        AND a.action_type = 'CORRECTIVE' AND a.action_status = 'VERIFIED'
        AND a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id)
      OR NOT EXISTS (SELECT 1 FROM quality_ncr_actions a WHERE a.ncr_id = NEW.id
        AND a.action_type = 'PREVENTIVE' AND a.action_status = 'VERIFIED'
        AND a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id)
      OR EXISTS (SELECT 1 FROM quality_defects d WHERE d.inspection_id = NEW.inspection_id
        AND d.tenant_id = NEW.tenant_id AND d.factory_id = NEW.factory_id AND d.status IN ('OPEN', 'REWORK'))
      OR NOT EXISTS (SELECT 1 FROM quality_inspections qi WHERE qi.id = NEW.inspection_id
        AND qi.tenant_id = NEW.tenant_id AND qi.factory_id = NEW.factory_id
        AND qi.status IN ('PASSED', 'DISPOSITIONED'))
      OR EXISTS (SELECT 1 FROM quality_holds h WHERE h.inspection_id = NEW.inspection_id
        AND h.tenant_id = NEW.tenant_id AND h.factory_id = NEW.factory_id AND h.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'NCR closure requires CAPA evidence, verified CAPA actions, resolved defects, a resolved inspection and no active quality hold'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE quality_ncr_action_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_ncr_action_events FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_ncr_action_events_tenant_isolation ON quality_ncr_action_events
  USING (tenant_id = factoryos_current_tenant_id()) WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMENT ON TABLE quality_ncr_action_events IS
  'Append-only CAPA action lifecycle and independent verification evidence. Every change is versioned and attributable.';

INSERT INTO schema_migrations(version, checksum)
VALUES ('096_quality_capa_action_lifecycle', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
