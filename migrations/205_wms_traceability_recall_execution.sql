BEGIN;

-- A declared recall is immutable, scoped evidence. It records a bounded impact
-- set plus the status actions taken in the same transaction.
CREATE TABLE IF NOT EXISTS wms_traceability_recall_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  source_unit_id UUID NOT NULL,
  reason VARCHAR(1800) NOT NULL,
  max_depth INTEGER NOT NULL,
  node_limit INTEGER NOT NULL,
  impacted_unit_count INTEGER NOT NULL,
  impact_fingerprint CHAR(64) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  declared_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_wms_traceability_recall_case_id_scope
    UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_wms_traceability_recall_case_idempotency
    UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_wms_traceability_recall_case_source
    FOREIGN KEY (source_unit_id, tenant_id, factory_id)
    REFERENCES traceability_units (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_traceability_recall_case_actor
    FOREIGN KEY (declared_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_wms_traceability_recall_reason
    CHECK (length(btrim(reason)) > 0),
  CONSTRAINT chk_wms_traceability_recall_depth
    CHECK (max_depth BETWEEN 1 AND 12),
  CONSTRAINT chk_wms_traceability_recall_node_limit
    CHECK (node_limit BETWEEN 1 AND 500),
  CONSTRAINT chk_wms_traceability_recall_unit_count
    CHECK (impacted_unit_count BETWEEN 1 AND node_limit),
  CONSTRAINT chk_wms_traceability_recall_fingerprint
    CHECK (impact_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_wms_traceability_recall_key
    CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_wms_traceability_recall_request_hash
    CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS wms_traceability_recall_case_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  recall_case_id UUID NOT NULL,
  unit_id UUID NOT NULL,
  unit_code_snapshot VARCHAR(160) NOT NULL,
  unit_type_snapshot VARCHAR(24) NOT NULL,
  depth INTEGER NOT NULL,
  status_before VARCHAR(16) NOT NULL,
  unit_action VARCHAR(32) NOT NULL,
  status_event_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_wms_traceability_recall_case_unit_id_scope
    UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_wms_traceability_recall_case_unit
    UNIQUE (recall_case_id, unit_id),
  CONSTRAINT fk_wms_traceability_recall_case_unit_case
    FOREIGN KEY (recall_case_id, tenant_id, factory_id)
    REFERENCES wms_traceability_recall_cases (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_traceability_recall_case_unit_identity
    FOREIGN KEY (unit_id, tenant_id, factory_id)
    REFERENCES traceability_units (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_wms_traceability_recall_case_unit_status_event
    FOREIGN KEY (status_event_id)
    REFERENCES traceability_unit_status_events (id) ON DELETE RESTRICT,
  CONSTRAINT chk_wms_traceability_recall_unit_depth CHECK (depth BETWEEN 0 AND 12),
  CONSTRAINT chk_wms_traceability_recall_unit_status
    CHECK (status_before IN ('ACTIVE', 'QUARANTINED', 'RECALLED', 'DISPOSED', 'SHIPPED')),
  CONSTRAINT chk_wms_traceability_recall_unit_action CHECK (
    (unit_action = 'RECALLED' AND status_before IN ('ACTIVE', 'QUARANTINED') AND status_event_id IS NOT NULL)
    OR (unit_action = 'ALREADY_RECALLED' AND status_before = 'RECALLED' AND status_event_id IS NULL)
    OR (unit_action = 'SHIPPED_REVIEW_REQUIRED' AND status_before = 'SHIPPED' AND status_event_id IS NULL)
    OR (unit_action = 'ALREADY_DISPOSED' AND status_before = 'DISPOSED' AND status_event_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_wms_traceability_recall_case_created
  ON wms_traceability_recall_cases (tenant_id, factory_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_wms_traceability_recall_case_units_unit
  ON wms_traceability_recall_case_units (tenant_id, factory_id, unit_id, created_at DESC);

ALTER TABLE wms_traceability_recall_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_traceability_recall_cases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wms_traceability_recall_cases_tenant_isolation ON wms_traceability_recall_cases;
CREATE POLICY wms_traceability_recall_cases_tenant_isolation ON wms_traceability_recall_cases
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE wms_traceability_recall_case_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_traceability_recall_case_units FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wms_traceability_recall_case_units_tenant_isolation ON wms_traceability_recall_case_units;
CREATE POLICY wms_traceability_recall_case_units_tenant_isolation ON wms_traceability_recall_case_units
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_guard_wms_traceability_recall_case()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'WMS traceability recall cases are immutable evidence'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.declared_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'recall case actor must match the authenticated user'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM traceability_units u
    WHERE u.id=NEW.source_unit_id AND u.tenant_id=NEW.tenant_id AND u.factory_id=NEW.factory_id
  ) THEN
    RAISE EXCEPTION 'recall source unit must belong to the same tenant and factory'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_wms_traceability_recall_case_guard ON wms_traceability_recall_cases;
CREATE TRIGGER trg_wms_traceability_recall_case_guard
BEFORE INSERT OR UPDATE OR DELETE ON wms_traceability_recall_cases
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_wms_traceability_recall_case();

CREATE OR REPLACE FUNCTION factoryos_guard_wms_traceability_recall_case_unit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'WMS traceability recall case membership is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.unit_action='RECALLED' AND NOT EXISTS (
    SELECT 1
    FROM traceability_unit_status_events e
    JOIN traceability_units u
      ON u.id=e.unit_id AND u.tenant_id=e.tenant_id AND u.factory_id=e.factory_id
    WHERE e.id=NEW.status_event_id
      AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
      AND e.unit_id=NEW.unit_id AND e.to_status='RECALLED'
      AND u.status='RECALLED' AND u.version=e.version
  ) THEN
    RAISE EXCEPTION 'recalled case membership must reference its applied status event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_wms_traceability_recall_case_unit_guard ON wms_traceability_recall_case_units;
CREATE TRIGGER trg_wms_traceability_recall_case_unit_guard
BEFORE INSERT OR UPDATE OR DELETE ON wms_traceability_recall_case_units
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_wms_traceability_recall_case_unit();

CREATE OR REPLACE FUNCTION factoryos_assert_wms_traceability_recall_case()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit_count INTEGER;
BEGIN
  SELECT count(*)::integer INTO v_unit_count
  FROM wms_traceability_recall_case_units cu
  WHERE cu.recall_case_id=NEW.id AND cu.tenant_id=NEW.tenant_id AND cu.factory_id=NEW.factory_id;
  IF v_unit_count <> NEW.impacted_unit_count OR NOT EXISTS (
    SELECT 1 FROM wms_traceability_recall_case_units cu
    WHERE cu.recall_case_id=NEW.id AND cu.tenant_id=NEW.tenant_id AND cu.factory_id=NEW.factory_id
      AND cu.unit_id=NEW.source_unit_id AND cu.depth=0
  ) THEN
    RAISE EXCEPTION 'recall case must commit with a complete unit membership snapshot'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id
      AND a.resource_type='WMS_RECALL_CASE' AND a.resource_id=NEW.id AND a.action='DECLARED'
  ) OR NOT EXISTS (
    SELECT 1 FROM outbox_events o
    WHERE o.tenant_id=NEW.tenant_id AND o.factory_id=NEW.factory_id
      AND o.aggregate_type='WMS_RECALL_CASE' AND o.aggregate_id=NEW.id
      AND o.event_type='WMS.RECALL_DECLARED'
  ) THEN
    RAISE EXCEPTION 'recall case requires transactional audit and outbox evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS ctr_wms_traceability_recall_case_evidence ON wms_traceability_recall_cases;
CREATE CONSTRAINT TRIGGER ctr_wms_traceability_recall_case_evidence
AFTER INSERT ON wms_traceability_recall_cases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_wms_traceability_recall_case();

INSERT INTO schema_migrations(version, checksum)
VALUES ('205_wms_traceability_recall_execution', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
