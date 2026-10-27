BEGIN;

-- This is a durable request to notify a customer/site, not evidence that a
-- message was sent or delivered. Provider delivery is a separate integration.
CREATE TABLE IF NOT EXISTS wms_traceability_recall_notification_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  recall_case_id UUID NOT NULL,
  recipient_type VARCHAR(16) NOT NULL,
  recipient_reference VARCHAR(255) NOT NULL,
  channel VARCHAR(16) NOT NULL,
  reason VARCHAR(1800),
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  requested_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_wms_recall_notification_intent_id_scope
    UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_wms_recall_notification_intent_recipient_binding
    UNIQUE (id, tenant_id, factory_id, recall_case_id, recipient_type, recipient_reference),
  CONSTRAINT uq_wms_recall_notification_intent_idempotency
    UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_wms_recall_notification_intent_case
    FOREIGN KEY (recall_case_id, tenant_id, factory_id)
    REFERENCES wms_traceability_recall_cases (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_recall_notification_intent_actor
    FOREIGN KEY (requested_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_wms_recall_notification_intent_recipient_type
    CHECK (recipient_type IN ('CUSTOMER', 'SITE')),
  CONSTRAINT chk_wms_recall_notification_intent_recipient_reference
    CHECK (recipient_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$' AND position('://' in recipient_reference) = 0),
  CONSTRAINT chk_wms_recall_notification_intent_channel
    CHECK (channel IN ('EMAIL', 'PORTAL', 'EDI', 'MANUAL')),
  CONSTRAINT chk_wms_recall_notification_intent_reason
    CHECK (reason IS NULL OR length(btrim(reason)) > 0),
  CONSTRAINT chk_wms_recall_notification_intent_key
    CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_wms_recall_notification_intent_hash
    CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_wms_recall_notification_intent_case
  ON wms_traceability_recall_notification_intents (tenant_id, factory_id, recall_case_id, created_at, id);

CREATE TABLE IF NOT EXISTS wms_traceability_recall_notification_acknowledgements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  recall_case_id UUID NOT NULL,
  notification_intent_id UUID NOT NULL,
  recipient_type VARCHAR(16) NOT NULL,
  recipient_reference VARCHAR(255) NOT NULL,
  outcome VARCHAR(32) NOT NULL,
  notes VARCHAR(1800),
  evidence_reference VARCHAR(500),
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  recorded_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  acknowledgement_source VARCHAR(24) NOT NULL DEFAULT 'OPERATOR_REPORTED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_wms_recall_notification_ack_id_scope
    UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_wms_recall_notification_ack_intent
    UNIQUE (notification_intent_id, tenant_id, factory_id),
  CONSTRAINT uq_wms_recall_notification_ack_idempotency
    UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_wms_recall_notification_ack_case
    FOREIGN KEY (recall_case_id, tenant_id, factory_id)
    REFERENCES wms_traceability_recall_cases (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_recall_notification_ack_intent_recipient
    FOREIGN KEY (notification_intent_id, tenant_id, factory_id, recall_case_id, recipient_type, recipient_reference)
    REFERENCES wms_traceability_recall_notification_intents
      (id, tenant_id, factory_id, recall_case_id, recipient_type, recipient_reference) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_recall_notification_ack_actor
    FOREIGN KEY (recorded_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_wms_recall_notification_ack_recipient_type
    CHECK (recipient_type IN ('CUSTOMER', 'SITE')),
  CONSTRAINT chk_wms_recall_notification_ack_outcome
    CHECK (outcome IN ('RECEIVED', 'NO_ACTION_REQUIRED', 'ACTION_IN_PROGRESS', 'ACTION_COMPLETED', 'UNABLE_TO_CONFIRM')),
  CONSTRAINT chk_wms_recall_notification_ack_notes
    CHECK (notes IS NULL OR length(btrim(notes)) > 0),
  CONSTRAINT chk_wms_recall_notification_ack_evidence
    CHECK (evidence_reference IS NULL OR (evidence_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' AND position('://' in evidence_reference) = 0)),
  CONSTRAINT chk_wms_recall_notification_ack_source
    CHECK (acknowledgement_source = 'OPERATOR_REPORTED'),
  CONSTRAINT chk_wms_recall_notification_ack_key
    CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_wms_recall_notification_ack_hash
    CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_wms_recall_notification_ack_case
  ON wms_traceability_recall_notification_acknowledgements (tenant_id, factory_id, recall_case_id, created_at, id);

ALTER TABLE wms_traceability_recall_notification_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_traceability_recall_notification_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wms_traceability_recall_notification_intents_tenant_isolation
  ON wms_traceability_recall_notification_intents;
CREATE POLICY wms_traceability_recall_notification_intents_tenant_isolation
  ON wms_traceability_recall_notification_intents
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE wms_traceability_recall_notification_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_traceability_recall_notification_acknowledgements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wms_traceability_recall_notification_ack_tenant_isolation
  ON wms_traceability_recall_notification_acknowledgements;
CREATE POLICY wms_traceability_recall_notification_ack_tenant_isolation
  ON wms_traceability_recall_notification_acknowledgements
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_wms_recall_notification_intent()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Recall notification intents are immutable evidence' USING ERRCODE = '55000';
  END IF;
  IF NEW.requested_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Recall notification actor must match the authenticated user' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM wms_traceability_recall_cases c
    WHERE c.id=NEW.recall_case_id AND c.tenant_id=NEW.tenant_id AND c.factory_id=NEW.factory_id
  ) THEN
    RAISE EXCEPTION 'Recall notification intent must reference a case in the same tenant/factory' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_wms_recall_notification_intent_guard ON wms_traceability_recall_notification_intents;
CREATE TRIGGER trg_wms_recall_notification_intent_guard
BEFORE INSERT OR UPDATE OR DELETE ON wms_traceability_recall_notification_intents
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_wms_recall_notification_intent();

CREATE OR REPLACE FUNCTION factoryos_guard_wms_recall_notification_acknowledgement()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Recall notification acknowledgements are append-only evidence' USING ERRCODE = '55000';
  END IF;
  IF NEW.recorded_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Recall acknowledgement actor must match the authenticated user' USING ERRCODE = '23514';
  END IF;
  IF NEW.acknowledgement_source <> 'OPERATOR_REPORTED' THEN
    RAISE EXCEPTION 'Unauthenticated acknowledgement sources are not accepted' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM wms_traceability_recall_notification_intents n
    WHERE n.id=NEW.notification_intent_id AND n.recall_case_id=NEW.recall_case_id
      AND n.tenant_id=NEW.tenant_id AND n.factory_id=NEW.factory_id
      AND n.recipient_type=NEW.recipient_type AND n.recipient_reference=NEW.recipient_reference
  ) THEN
    RAISE EXCEPTION 'Recall acknowledgement must match its notification intent and recipient' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_wms_recall_notification_ack_guard ON wms_traceability_recall_notification_acknowledgements;
CREATE TRIGGER trg_wms_recall_notification_ack_guard
BEFORE INSERT OR UPDATE OR DELETE ON wms_traceability_recall_notification_acknowledgements
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_wms_recall_notification_acknowledgement();

CREATE OR REPLACE FUNCTION factoryos_assert_wms_recall_notification_intent_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id
      AND a.resource_type='WMS_RECALL_NOTIFICATION_INTENT' AND a.resource_id=NEW.id
      AND a.action='NOTIFICATION_INTENT_RECORDED'
  ) OR NOT EXISTS (
    SELECT 1 FROM outbox_events o
    WHERE o.tenant_id=NEW.tenant_id AND o.factory_id=NEW.factory_id
      AND o.aggregate_type='WMS_RECALL_NOTIFICATION_INTENT' AND o.aggregate_id=NEW.id
      AND o.event_type='WMS.RECALL_NOTIFICATION_REQUESTED'
  ) THEN
    RAISE EXCEPTION 'Recall notification intent requires transactional audit and outbox evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS ctr_wms_recall_notification_intent_evidence ON wms_traceability_recall_notification_intents;
CREATE CONSTRAINT TRIGGER ctr_wms_recall_notification_intent_evidence
AFTER INSERT ON wms_traceability_recall_notification_intents
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION factoryos_assert_wms_recall_notification_intent_evidence();

CREATE OR REPLACE FUNCTION factoryos_assert_wms_recall_notification_ack_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id
      AND a.resource_type='WMS_RECALL_NOTIFICATION_ACKNOWLEDGEMENT' AND a.resource_id=NEW.id
      AND a.action='ACKNOWLEDGEMENT_RECORDED'
  ) OR NOT EXISTS (
    SELECT 1 FROM outbox_events o
    WHERE o.tenant_id=NEW.tenant_id AND o.factory_id=NEW.factory_id
      AND o.aggregate_type='WMS_RECALL_NOTIFICATION_ACKNOWLEDGEMENT' AND o.aggregate_id=NEW.id
      AND o.event_type='WMS.RECALL_NOTIFICATION_ACKNOWLEDGED'
  ) THEN
    RAISE EXCEPTION 'Recall acknowledgement requires transactional audit and outbox evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS ctr_wms_recall_notification_ack_evidence ON wms_traceability_recall_notification_acknowledgements;
CREATE CONSTRAINT TRIGGER ctr_wms_recall_notification_ack_evidence
AFTER INSERT ON wms_traceability_recall_notification_acknowledgements
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION factoryos_assert_wms_recall_notification_ack_evidence();

INSERT INTO schema_migrations(version, checksum)
VALUES ('206_wms_recall_notification_acknowledgements', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
