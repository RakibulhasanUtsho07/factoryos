BEGIN;

-- WP05 canonical decision contract: fingerprint the envelope once, then
-- maintain an append-only state-transition ledger and explicit evidence refs.
ALTER TABLE ai_decision_envelopes
  ADD COLUMN IF NOT EXISTS envelope_version VARCHAR(20) NOT NULL DEFAULT '1.0.0';
ALTER TABLE ai_decision_envelopes
  ADD COLUMN IF NOT EXISTS request_hash VARCHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_ai_decision_envelope_version'
  ) THEN
    ALTER TABLE ai_decision_envelopes ADD CONSTRAINT chk_ai_decision_envelope_version
      CHECK (LENGTH(BTRIM(envelope_version)) > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_ai_decision_request_hash'
  ) THEN
    ALTER TABLE ai_decision_envelopes ADD CONSTRAINT chk_ai_decision_request_hash
      CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS ai_decision_lifecycle_states (
  decision_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  current_state VARCHAR(40) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_ai_decision_lifecycle_decision
    FOREIGN KEY (decision_id, tenant_id, factory_id)
    REFERENCES ai_decision_envelopes (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT uq_ai_decision_lifecycle_scope
    UNIQUE (decision_id, tenant_id, factory_id),
  CONSTRAINT chk_ai_decision_lifecycle_state
    CHECK (current_state IN (
      'CREATED', 'CONTEXT_READY', 'VERIFIED', 'REVIEW_REQUIRED', 'BLOCKED',
      'ACTION_PENDING_APPROVAL', 'ACTION_AUTHORIZED', 'EXECUTING',
      'COMPLETED', 'FAILED', 'OUTCOME_CAPTURED', 'CANCELLED'
    )),
  CONSTRAINT chk_ai_decision_lifecycle_version CHECK (version >= 1)
);

CREATE TABLE IF NOT EXISTS ai_decision_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  decision_id UUID NOT NULL,
  sequence_no INTEGER NOT NULL,
  from_state VARCHAR(40),
  to_state VARCHAR(40) NOT NULL,
  transition_reason VARCHAR(120) NOT NULL,
  context_package_id UUID,
  verification_run_id UUID,
  action_intent_id UUID,
  execution_record_id UUID,
  outcome_id UUID,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  actor_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_ai_decision_lifecycle_event_decision
    FOREIGN KEY (decision_id, tenant_id, factory_id)
    REFERENCES ai_decision_envelopes (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ai_decision_lifecycle_event_actor
    FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ai_decision_lifecycle_event_context
    FOREIGN KEY (context_package_id, tenant_id, factory_id)
    REFERENCES ai_context_packages (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ai_decision_lifecycle_event_verification
    FOREIGN KEY (verification_run_id, tenant_id, factory_id)
    REFERENCES ai_verification_runs (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ai_decision_lifecycle_event_action
    FOREIGN KEY (action_intent_id, tenant_id, factory_id)
    REFERENCES ai_action_intents (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ai_decision_lifecycle_event_execution
    FOREIGN KEY (execution_record_id, tenant_id, factory_id)
    REFERENCES ai_execution_records (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ai_decision_lifecycle_event_outcome
    FOREIGN KEY (outcome_id, tenant_id, factory_id)
    REFERENCES ai_outcome_links (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT uq_ai_decision_lifecycle_event_sequence
    UNIQUE (decision_id, tenant_id, factory_id, sequence_no),
  CONSTRAINT chk_ai_decision_lifecycle_event_sequence CHECK (sequence_no >= 1),
  CONSTRAINT chk_ai_decision_lifecycle_event_refs CHECK (jsonb_typeof(evidence_refs) = 'array'),
  CONSTRAINT chk_ai_decision_lifecycle_event_metadata CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT chk_ai_decision_lifecycle_event_reason CHECK (LENGTH(BTRIM(transition_reason)) > 0),
  CONSTRAINT chk_ai_decision_lifecycle_event_state CHECK (to_state IN (
    'CREATED', 'CONTEXT_READY', 'VERIFIED', 'REVIEW_REQUIRED', 'BLOCKED',
    'ACTION_PENDING_APPROVAL', 'ACTION_AUTHORIZED', 'EXECUTING',
    'COMPLETED', 'FAILED', 'OUTCOME_CAPTURED', 'CANCELLED'
  ))
);

CREATE INDEX IF NOT EXISTS idx_ai_decision_lifecycle_events_timeline
  ON ai_decision_lifecycle_events (tenant_id, factory_id, decision_id, sequence_no);
CREATE INDEX IF NOT EXISTS idx_ai_decision_lifecycle_events_context
  ON ai_decision_lifecycle_events (tenant_id, factory_id, context_package_id)
  WHERE context_package_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_context_evidence_refs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  decision_id UUID NOT NULL,
  context_package_id UUID NOT NULL,
  evidence_id UUID NOT NULL,
  source_type VARCHAR(100) NOT NULL,
  source_ref VARCHAR(500) NOT NULL,
  content_hash VARCHAR(128),
  source_timestamp TIMESTAMPTZ,
  source_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_ai_context_evidence_context
    FOREIGN KEY (context_package_id, tenant_id, factory_id)
    REFERENCES ai_context_packages (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ai_context_evidence_decision
    FOREIGN KEY (decision_id, tenant_id, factory_id)
    REFERENCES ai_decision_envelopes (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT uq_ai_context_evidence_reference
    UNIQUE (context_package_id, evidence_id),
  CONSTRAINT chk_ai_context_evidence_snapshot CHECK (jsonb_typeof(source_snapshot) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_ai_context_evidence_decision
  ON ai_context_evidence_refs (tenant_id, factory_id, decision_id, context_package_id);

-- Preserve evidence identifiers and source hashes from existing immutable context
-- snapshots, so upgraded decisions remain inspectable without rewriting history.
INSERT INTO ai_context_evidence_refs (
  tenant_id, factory_id, decision_id, context_package_id, evidence_id,
  source_type, source_ref, content_hash, source_timestamp, source_snapshot
)
SELECT c.tenant_id, c.factory_id, c.decision_id, c.id,
       (src->>'id')::uuid,
       COALESCE(NULLIF(src->>'sourceType', ''), 'UNKNOWN'),
       COALESCE(src->>'sourceRef', ''),
       NULLIF(src->>'contentHash', ''),
       NULLIF(src->>'sourceTimestamp', '')::timestamptz,
       src
FROM ai_context_packages c
CROSS JOIN LATERAL jsonb_array_elements(c.sources) src
WHERE src->>'type' = 'BUSINESS_EVIDENCE'
  AND NULLIF(src->>'id', '') IS NOT NULL
ON CONFLICT (context_package_id, evidence_id) DO NOTHING;

-- Historical rows get a clearly labelled baseline snapshot. The complete
-- post-upgrade stage history is produced by database triggers below.
INSERT INTO ai_decision_lifecycle_states (
  decision_id, tenant_id, factory_id, current_state, version, updated_at
)
SELECT d.id, d.tenant_id, d.factory_id,
  CASE
    WHEN EXISTS (SELECT 1 FROM ai_outcome_links o
                 WHERE o.decision_id = d.id AND o.tenant_id = d.tenant_id AND o.factory_id = d.factory_id)
      THEN 'OUTCOME_CAPTURED'
    WHEN EXISTS (SELECT 1 FROM ai_execution_records e
                 WHERE e.decision_id = d.id AND e.tenant_id = d.tenant_id AND e.factory_id = d.factory_id)
      THEN (SELECT CASE WHEN e.status = 'SUCCEEDED' THEN 'COMPLETED' ELSE 'FAILED' END
            FROM ai_execution_records e
            WHERE e.decision_id = d.id AND e.tenant_id = d.tenant_id AND e.factory_id = d.factory_id
            ORDER BY e.started_at DESC LIMIT 1)
    WHEN EXISTS (SELECT 1 FROM ai_action_intents a
                 WHERE a.decision_id = d.id AND a.tenant_id = d.tenant_id AND a.factory_id = d.factory_id)
      THEN (SELECT CASE a.authorization_status
              WHEN 'AUTHORIZED' THEN 'ACTION_AUTHORIZED'
              WHEN 'APPROVAL_REQUIRED' THEN 'ACTION_PENDING_APPROVAL'
              ELSE 'BLOCKED' END
            FROM ai_action_intents a
            WHERE a.decision_id = d.id AND a.tenant_id = d.tenant_id AND a.factory_id = d.factory_id
            ORDER BY a.created_at DESC LIMIT 1)
    WHEN EXISTS (SELECT 1 FROM ai_verification_runs v
                 WHERE v.decision_id = d.id AND v.tenant_id = d.tenant_id AND v.factory_id = d.factory_id)
      THEN (SELECT CASE v.status
              WHEN 'PASSED' THEN 'VERIFIED'
              WHEN 'REVIEW_REQUIRED' THEN 'REVIEW_REQUIRED'
              ELSE 'BLOCKED' END
            FROM ai_verification_runs v
            WHERE v.decision_id = d.id AND v.tenant_id = d.tenant_id AND v.factory_id = d.factory_id
            ORDER BY v.created_at DESC LIMIT 1)
    WHEN EXISTS (SELECT 1 FROM ai_context_packages c
                 WHERE c.decision_id = d.id AND c.tenant_id = d.tenant_id AND c.factory_id = d.factory_id)
      THEN 'CONTEXT_READY'
    ELSE 'CREATED'
  END,
  1, d.created_at
FROM ai_decision_envelopes d
ON CONFLICT (decision_id) DO NOTHING;

INSERT INTO ai_decision_lifecycle_events (
  tenant_id, factory_id, decision_id, sequence_no, from_state, to_state,
  transition_reason, evidence_refs, metadata, actor_id, occurred_at
)
SELECT s.tenant_id, s.factory_id, s.decision_id, 1, NULL, s.current_state,
       'LEGACY_BACKFILL', '[]'::jsonb,
       jsonb_build_object('legacyBaseline', true, 'historyBeforeMigrationAvailable', false),
       d.actor_id, d.created_at
FROM ai_decision_lifecycle_states s
JOIN ai_decision_envelopes d ON d.id = s.decision_id
ON CONFLICT (decision_id, tenant_id, factory_id, sequence_no) DO NOTHING;

CREATE OR REPLACE FUNCTION factoryos_guard_ai_decision_lifecycle_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_allowed BOOLEAN := FALSE;
BEGIN
  IF NEW.decision_id <> OLD.decision_id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.factory_id <> OLD.factory_id
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'AI decision lifecycle identity and timestamp are immutable';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'AI decision lifecycle version must increase exactly once';
  END IF;
  IF OLD.current_state = NEW.current_state THEN
    v_allowed := TRUE;
  ELSE
    v_allowed := CASE OLD.current_state
      WHEN 'CREATED' THEN NEW.current_state IN ('CONTEXT_READY','VERIFIED','REVIEW_REQUIRED','BLOCKED','ACTION_PENDING_APPROVAL','ACTION_AUTHORIZED','COMPLETED','FAILED','OUTCOME_CAPTURED','CANCELLED')
      WHEN 'CONTEXT_READY' THEN NEW.current_state IN ('CONTEXT_READY','VERIFIED','REVIEW_REQUIRED','BLOCKED','ACTION_PENDING_APPROVAL','ACTION_AUTHORIZED','COMPLETED','FAILED','OUTCOME_CAPTURED','CANCELLED')
      WHEN 'VERIFIED' THEN NEW.current_state IN ('CONTEXT_READY','VERIFIED','REVIEW_REQUIRED','BLOCKED','ACTION_PENDING_APPROVAL','ACTION_AUTHORIZED','COMPLETED','FAILED','OUTCOME_CAPTURED','CANCELLED')
      WHEN 'REVIEW_REQUIRED' THEN NEW.current_state IN ('VERIFIED','REVIEW_REQUIRED','BLOCKED','ACTION_PENDING_APPROVAL','ACTION_AUTHORIZED','COMPLETED','FAILED','OUTCOME_CAPTURED','CANCELLED')
      WHEN 'BLOCKED' THEN NEW.current_state IN ('CONTEXT_READY','VERIFIED','REVIEW_REQUIRED','BLOCKED','ACTION_PENDING_APPROVAL','ACTION_AUTHORIZED','CANCELLED')
      WHEN 'ACTION_PENDING_APPROVAL' THEN NEW.current_state IN ('ACTION_PENDING_APPROVAL','ACTION_AUTHORIZED','BLOCKED','FAILED','CANCELLED')
      WHEN 'ACTION_AUTHORIZED' THEN NEW.current_state IN ('ACTION_AUTHORIZED','ACTION_PENDING_APPROVAL','EXECUTING','COMPLETED','FAILED','OUTCOME_CAPTURED','CANCELLED')
      WHEN 'EXECUTING' THEN NEW.current_state IN ('EXECUTING','COMPLETED','FAILED','CANCELLED')
      WHEN 'COMPLETED' THEN NEW.current_state IN ('COMPLETED','OUTCOME_CAPTURED')
      WHEN 'FAILED' THEN NEW.current_state IN ('FAILED','CONTEXT_READY','VERIFIED','ACTION_PENDING_APPROVAL','ACTION_AUTHORIZED','OUTCOME_CAPTURED','CANCELLED')
      WHEN 'OUTCOME_CAPTURED' THEN NEW.current_state IN ('OUTCOME_CAPTURED','CONTEXT_READY','VERIFIED','CANCELLED')
      WHEN 'CANCELLED' THEN NEW.current_state = 'CANCELLED'
      ELSE FALSE
    END;
  END IF;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Invalid AI decision lifecycle transition: % -> %',
      OLD.current_state, NEW.current_state;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_validate_ai_decision_lifecycle_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ai_decision_lifecycle_events e
    WHERE e.decision_id = NEW.decision_id
      AND e.tenant_id = NEW.tenant_id
      AND e.factory_id = NEW.factory_id
      AND e.sequence_no = NEW.version
      AND e.to_state = NEW.current_state
  ) THEN
    RAISE EXCEPTION 'AI lifecycle state version % has no corresponding immutable event', NEW.version;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_reject_ai_decision_lifecycle_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AI decision lifecycle events are immutable';
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_reject_ai_context_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AI context evidence references are immutable';
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_transition_ai_decision_lifecycle(
  p_tenant_id UUID,
  p_factory_id UUID,
  p_decision_id UUID,
  p_actor_id UUID,
  p_to_state VARCHAR,
  p_reason VARCHAR,
  p_context_package_id UUID DEFAULT NULL,
  p_verification_run_id UUID DEFAULT NULL,
  p_action_intent_id UUID DEFAULT NULL,
  p_execution_record_id UUID DEFAULT NULL,
  p_outcome_id UUID DEFAULT NULL,
  p_evidence_refs JSONB DEFAULT '[]'::jsonb,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE(event_id UUID, current_state VARCHAR, version INTEGER)
LANGUAGE plpgsql
AS $$
DECLARE
  v_state ai_decision_lifecycle_states%ROWTYPE;
  v_version INTEGER;
  v_event_id UUID;
BEGIN
  IF jsonb_typeof(COALESCE(p_evidence_refs, '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(p_metadata, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'AI lifecycle evidence references must be an array and metadata an object';
  END IF;

  SELECT * INTO v_state
  FROM ai_decision_lifecycle_states s
  WHERE s.decision_id = p_decision_id
    AND s.tenant_id = p_tenant_id
    AND s.factory_id = p_factory_id
  FOR UPDATE;

  IF NOT FOUND THEN
    IF p_to_state <> 'CREATED' THEN
      RAISE EXCEPTION 'AI decision lifecycle must begin at CREATED';
    END IF;
    INSERT INTO ai_decision_lifecycle_states (
      decision_id, tenant_id, factory_id, current_state, version, updated_at
    ) VALUES (p_decision_id, p_tenant_id, p_factory_id, 'CREATED', 1, clock_timestamp());
    INSERT INTO ai_decision_lifecycle_events (
      tenant_id, factory_id, decision_id, sequence_no, from_state, to_state,
      transition_reason, context_package_id, verification_run_id, action_intent_id,
      execution_record_id, outcome_id, evidence_refs, metadata, actor_id
    ) VALUES (
      p_tenant_id, p_factory_id, p_decision_id, 1, NULL, 'CREATED',
      p_reason, p_context_package_id, p_verification_run_id, p_action_intent_id,
      p_execution_record_id, p_outcome_id, COALESCE(p_evidence_refs, '[]'::jsonb),
      COALESCE(p_metadata, '{}'::jsonb), p_actor_id
    ) RETURNING id INTO v_event_id;
    RETURN QUERY SELECT v_event_id, 'CREATED'::varchar, 1;
    RETURN;
  END IF;

  UPDATE ai_decision_lifecycle_states
  SET current_state = p_to_state,
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE decision_id = p_decision_id
    AND tenant_id = p_tenant_id
    AND factory_id = p_factory_id
  RETURNING version INTO v_version;

  INSERT INTO ai_decision_lifecycle_events (
    tenant_id, factory_id, decision_id, sequence_no, from_state, to_state,
    transition_reason, context_package_id, verification_run_id, action_intent_id,
    execution_record_id, outcome_id, evidence_refs, metadata, actor_id
  ) VALUES (
    p_tenant_id, p_factory_id, p_decision_id, v_version, v_state.current_state, p_to_state,
    p_reason, p_context_package_id, p_verification_run_id, p_action_intent_id,
    p_execution_record_id, p_outcome_id, COALESCE(p_evidence_refs, '[]'::jsonb),
    COALESCE(p_metadata, '{}'::jsonb), p_actor_id
  ) RETURNING id INTO v_event_id;

  RETURN QUERY SELECT v_event_id, p_to_state, v_version;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_capture_ai_decision_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_actor UUID;
  v_state VARCHAR(40);
  v_reason VARCHAR(120);
  v_context UUID;
  v_verification UUID;
  v_action UUID;
  v_execution UUID;
  v_outcome UUID;
  v_evidence_refs JSONB := '[]'::jsonb;
  v_metadata JSONB := '{}'::jsonb;
BEGIN
  IF TG_TABLE_NAME = 'ai_decision_envelopes' THEN
    PERFORM factoryos_transition_ai_decision_lifecycle(
      NEW.tenant_id, NEW.factory_id, NEW.id, NEW.actor_id,
      'CREATED', 'DECISION_CREATED', NULL, NULL, NULL, NULL, NULL,
      '[]'::jsonb, jsonb_build_object('envelopeVersion', NEW.envelope_version, 'requestHashPresent', NEW.request_hash IS NOT NULL)
    );
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'ai_context_packages' THEN
    v_actor := (SELECT d.actor_id FROM ai_decision_envelopes d
                WHERE d.id = NEW.decision_id AND d.tenant_id = NEW.tenant_id AND d.factory_id = NEW.factory_id);
    v_state := 'CONTEXT_READY';
    v_reason := 'CONTEXT_RESOLVED';
    v_context := NEW.id;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'evidenceId', src->>'id', 'sourceRef', src->>'sourceRef', 'contentHash', src->>'contentHash'
    )), '[]'::jsonb) INTO v_evidence_refs
    FROM jsonb_array_elements(NEW.sources) src
    WHERE src->>'type' = 'BUSINESS_EVIDENCE';
    v_metadata := jsonb_build_object('contextVersion', NEW.context_version, 'packageHash', NEW.package_hash);
  ELSIF TG_TABLE_NAME = 'ai_verification_runs' THEN
    v_actor := (SELECT d.actor_id FROM ai_decision_envelopes d
                WHERE d.id = NEW.decision_id AND d.tenant_id = NEW.tenant_id AND d.factory_id = NEW.factory_id);
    v_state := CASE NEW.status WHEN 'PASSED' THEN 'VERIFIED' WHEN 'REVIEW_REQUIRED' THEN 'REVIEW_REQUIRED' ELSE 'BLOCKED' END;
    v_reason := CASE NEW.status WHEN 'PASSED' THEN 'VERIFICATION_PASSED' WHEN 'REVIEW_REQUIRED' THEN 'VERIFICATION_REVIEW_REQUIRED' ELSE 'VERIFICATION_BLOCKED' END;
    v_context := NEW.context_package_id;
    v_verification := NEW.id;
    v_metadata := jsonb_build_object('verificationStatus', NEW.status);
  ELSIF TG_TABLE_NAME = 'ai_action_intents' THEN
    v_actor := NEW.created_by;
    v_action := NEW.id;
    v_state := CASE NEW.authorization_status WHEN 'AUTHORIZED' THEN 'ACTION_AUTHORIZED' WHEN 'APPROVAL_REQUIRED' THEN 'ACTION_PENDING_APPROVAL' ELSE 'BLOCKED' END;
    v_reason := CASE NEW.authorization_status WHEN 'AUTHORIZED' THEN 'ACTION_AUTHORIZED' WHEN 'APPROVAL_REQUIRED' THEN 'ACTION_APPROVAL_REQUIRED' ELSE 'ACTION_DENIED' END;
    v_metadata := jsonb_build_object('actionType', NEW.action_type, 'authorizationStatus', NEW.authorization_status, 'riskClass', NEW.risk_class);
  ELSIF TG_TABLE_NAME = 'ai_execution_records' THEN
    SELECT a.created_by INTO v_actor
    FROM ai_action_intents a
    WHERE a.id = NEW.action_intent_id AND a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id;
    v_action := NEW.action_intent_id;
    v_execution := NEW.id;
    v_state := CASE NEW.status WHEN 'SUCCEEDED' THEN 'COMPLETED' ELSE 'FAILED' END;
    v_reason := CASE NEW.status WHEN 'SUCCEEDED' THEN 'EXECUTION_SUCCEEDED' ELSE 'EXECUTION_FAILED' END;
    v_metadata := jsonb_build_object('executionKey', NEW.execution_key, 'executionStatus', NEW.status, 'inputsHash', NEW.inputs_hash);
  ELSIF TG_TABLE_NAME = 'ai_outcome_links' THEN
    v_actor := NEW.created_by;
    v_action := NEW.action_intent_id;
    v_execution := NEW.execution_record_id;
    v_outcome := NEW.id;
    v_state := 'OUTCOME_CAPTURED';
    v_reason := 'OUTCOME_RECORDED';
    v_metadata := jsonb_build_object('outcomeStatus', NEW.status);
  ELSE
    RAISE EXCEPTION 'Unsupported AI lifecycle source table %', TG_TABLE_NAME;
  END IF;

  IF v_actor IS NULL THEN
    SELECT d.actor_id INTO v_actor FROM ai_decision_envelopes d
    WHERE d.id = NEW.decision_id AND d.tenant_id = NEW.tenant_id AND d.factory_id = NEW.factory_id;
  END IF;

  PERFORM factoryos_transition_ai_decision_lifecycle(
    NEW.tenant_id, NEW.factory_id, NEW.decision_id, v_actor, v_state, v_reason,
    v_context, v_verification, v_action, v_execution, v_outcome,
    v_evidence_refs, v_metadata
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_capture_ai_context_evidence_refs()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO ai_context_evidence_refs (
    tenant_id, factory_id, decision_id, context_package_id, evidence_id,
    source_type, source_ref, content_hash, source_timestamp, source_snapshot
  )
  SELECT NEW.tenant_id, NEW.factory_id, NEW.decision_id, NEW.id,
         (src->>'id')::uuid,
         COALESCE(NULLIF(src->>'sourceType', ''), 'UNKNOWN'),
         COALESCE(src->>'sourceRef', ''),
         NULLIF(src->>'contentHash', ''),
         NULLIF(src->>'sourceTimestamp', '')::timestamptz,
         src
  FROM jsonb_array_elements(NEW.sources) src
  WHERE src->>'type' = 'BUSINESS_EVIDENCE'
    AND NULLIF(src->>'id', '') IS NOT NULL
  ON CONFLICT (context_package_id, evidence_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION factoryos_validate_ai_decision_lifecycle_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ai_decision_lifecycle_events e
    WHERE e.decision_id = NEW.decision_id AND e.tenant_id = NEW.tenant_id
      AND e.factory_id = NEW.factory_id AND e.sequence_no = NEW.version
      AND e.to_state = NEW.current_state
  ) THEN
    RAISE EXCEPTION 'AI lifecycle state version % has no corresponding immutable event', NEW.version;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ai_decision_lifecycle_state_guard ON ai_decision_lifecycle_states;
CREATE TRIGGER ai_decision_lifecycle_state_guard
BEFORE UPDATE ON ai_decision_lifecycle_states
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_ai_decision_lifecycle_state();

DROP TRIGGER IF EXISTS ai_decision_lifecycle_event_immutable ON ai_decision_lifecycle_events;
CREATE TRIGGER ai_decision_lifecycle_event_immutable
BEFORE UPDATE OR DELETE ON ai_decision_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_ai_decision_lifecycle_event_mutation();

DROP TRIGGER IF EXISTS ai_context_evidence_immutable ON ai_context_evidence_refs;
CREATE TRIGGER ai_context_evidence_immutable
BEFORE UPDATE OR DELETE ON ai_context_evidence_refs
FOR EACH ROW EXECUTE FUNCTION factoryos_reject_ai_context_evidence_mutation();

DROP TRIGGER IF EXISTS ai_decision_lifecycle_state_has_event ON ai_decision_lifecycle_states;
CREATE CONSTRAINT TRIGGER ai_decision_lifecycle_state_has_event
AFTER INSERT OR UPDATE ON ai_decision_lifecycle_states
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_validate_ai_decision_lifecycle_event();

DROP TRIGGER IF EXISTS ai_decision_lifecycle_from_decision ON ai_decision_envelopes;
CREATE TRIGGER ai_decision_lifecycle_from_decision
AFTER INSERT ON ai_decision_envelopes
FOR EACH ROW EXECUTE FUNCTION factoryos_capture_ai_decision_lifecycle();

DROP TRIGGER IF EXISTS ai_decision_lifecycle_from_context ON ai_context_packages;
CREATE TRIGGER ai_decision_lifecycle_from_context
AFTER INSERT ON ai_context_packages
FOR EACH ROW EXECUTE FUNCTION factoryos_capture_ai_decision_lifecycle();

DROP TRIGGER IF EXISTS ai_decision_lifecycle_from_verification ON ai_verification_runs;
CREATE TRIGGER ai_decision_lifecycle_from_verification
AFTER INSERT ON ai_verification_runs
FOR EACH ROW EXECUTE FUNCTION factoryos_capture_ai_decision_lifecycle();

DROP TRIGGER IF EXISTS ai_decision_lifecycle_from_action ON ai_action_intents;
CREATE TRIGGER ai_decision_lifecycle_from_action
AFTER INSERT ON ai_action_intents
FOR EACH ROW EXECUTE FUNCTION factoryos_capture_ai_decision_lifecycle();

DROP TRIGGER IF EXISTS ai_decision_lifecycle_from_execution ON ai_execution_records;
CREATE TRIGGER ai_decision_lifecycle_from_execution
AFTER INSERT ON ai_execution_records
FOR EACH ROW EXECUTE FUNCTION factoryos_capture_ai_decision_lifecycle();

DROP TRIGGER IF EXISTS ai_decision_lifecycle_from_outcome ON ai_outcome_links;
CREATE TRIGGER ai_decision_lifecycle_from_outcome
AFTER INSERT ON ai_outcome_links
FOR EACH ROW EXECUTE FUNCTION factoryos_capture_ai_decision_lifecycle();

ALTER TABLE ai_decision_lifecycle_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_decision_lifecycle_states FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_decision_lifecycle_states_tenant_isolation ON ai_decision_lifecycle_states;
CREATE POLICY ai_decision_lifecycle_states_tenant_isolation ON ai_decision_lifecycle_states
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE ai_decision_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_decision_lifecycle_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_decision_lifecycle_events_tenant_isolation ON ai_decision_lifecycle_events;
CREATE POLICY ai_decision_lifecycle_events_tenant_isolation ON ai_decision_lifecycle_events
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE ai_context_evidence_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_context_evidence_refs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_context_evidence_refs_tenant_isolation ON ai_context_evidence_refs;
CREATE POLICY ai_context_evidence_refs_tenant_isolation ON ai_context_evidence_refs
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO permissions (code, description)
VALUES
  ('ai.decisions.lifecycle.read', 'Read append-only AI decision lifecycle and evidence references'),
  ('ai.decisions.lifecycle.write', 'Record allowed AI decision lifecycle transitions')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN' AND r.is_system = true
  AND p.code IN ('ai.decisions.lifecycle.read', 'ai.decisions.lifecycle.write')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO schema_migrations (version, checksum)
VALUES ('147_ai_decision_envelope_lifecycle_replay', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
