BEGIN;

-- RFID tags resolve to the same immutable identity used by barcode/QR and genealogy.
ALTER TABLE traceability_units
  ADD COLUMN IF NOT EXISTS rfid_epc VARCHAR(128);
CREATE UNIQUE INDEX IF NOT EXISTS uq_traceability_rfid_epc_ci
  ON traceability_units (tenant_id, factory_id, upper(rfid_epc))
  WHERE rfid_epc IS NOT NULL;
ALTER TABLE traceability_units
  ADD CONSTRAINT chk_traceability_rfid_epc
  CHECK (
    rfid_epc IS NULL OR (
      length(btrim(rfid_epc)) BETWEEN 1 AND 128
      AND rfid_epc ~ '^[A-Za-z0-9._:-]+$'
    )
  );

-- Material master labels are not stock genealogy units. Permit a MATERIAL
-- template target while keeping actual traceability_units constrained to
-- physical lot/serial/container/finished-good identities.
ALTER TABLE traceability_label_templates
  DROP CONSTRAINT IF EXISTS chk_traceability_label_template_unit_types;
ALTER TABLE traceability_label_templates
  ADD CONSTRAINT chk_traceability_label_template_unit_types
  CHECK (
    cardinality(supported_unit_types) > 0
    AND supported_unit_types <@ ARRAY[
      'MATERIAL', 'LOT', 'SERIAL', 'PALLET', 'CARTON', 'BUNDLE', 'FINISHED_GOOD', 'SHIPMENT'
    ]::text[]
  );

-- A print/issue is immutable evidence linked to both a concrete identity and an
-- immutable template snapshot. Rendering is performed by the web/mobile client.
CREATE TABLE traceability_label_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  unit_id UUID,
  inventory_item_id UUID,
  template_id UUID NOT NULL,
  template_code_snapshot VARCHAR(100) NOT NULL,
  unit_code_snapshot VARCHAR(160) NOT NULL,
  barcode_value_snapshot VARCHAR(255) NOT NULL,
  symbology VARCHAR(24) NOT NULL,
  encoded_payload JSONB NOT NULL,
  label_layout_snapshot JSONB NOT NULL,
  copy_count INTEGER NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_traceability_label_issue_id_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_traceability_label_issue_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_traceability_label_issue_unit
    FOREIGN KEY (unit_id, tenant_id, factory_id)
    REFERENCES traceability_units (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traceability_label_issue_item
    FOREIGN KEY (inventory_item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_traceability_label_issue_template
    FOREIGN KEY (template_id, tenant_id, factory_id)
    REFERENCES traceability_label_templates (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_traceability_label_issue_target CHECK (
    (unit_id IS NOT NULL AND inventory_item_id IS NULL)
    OR (unit_id IS NULL AND inventory_item_id IS NOT NULL)
  ),
  CONSTRAINT fk_traceability_label_issue_actor
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_traceability_label_issue_symbology
    CHECK (symbology IN ('QR', 'CODE128', 'DATAMATRIX', 'GS1_128')),
  CONSTRAINT chk_traceability_label_issue_copy_count CHECK (copy_count BETWEEN 1 AND 100),
  CONSTRAINT chk_traceability_label_issue_payload CHECK (jsonb_typeof(encoded_payload) = 'object'),
  CONSTRAINT chk_traceability_label_issue_layout CHECK (jsonb_typeof(label_layout_snapshot) = 'object'),
  CONSTRAINT chk_traceability_label_issue_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_traceability_label_issue_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_traceability_label_issue_unit_created
  ON traceability_label_issues (tenant_id, factory_id, unit_id, created_at DESC, id DESC);
CREATE INDEX idx_traceability_label_issue_item_created
  ON traceability_label_issues (tenant_id, factory_id, inventory_item_id, created_at DESC, id DESC)
  WHERE inventory_item_id IS NOT NULL;

CREATE OR REPLACE FUNCTION factoryos_guard_traceability_label_issue()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'traceability label issue history is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'label issue actor must match the authenticated user'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_traceability_label_issue_guard
BEFORE INSERT OR UPDATE OR DELETE ON traceability_label_issues
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_traceability_label_issue();

CREATE OR REPLACE FUNCTION factoryos_assert_traceability_label_issue_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id
      AND a.resource_type = 'TRACEABILITY_LABEL_ISSUE'
      AND a.resource_id = NEW.id AND a.action = 'ISSUED'
  ) OR NOT EXISTS (
    SELECT 1 FROM outbox_events o
    WHERE o.tenant_id = NEW.tenant_id AND o.factory_id = NEW.factory_id
      AND o.aggregate_type = 'TRACEABILITY_LABEL_ISSUE'
      AND o.aggregate_id = NEW.id AND o.event_type = 'TRACEABILITY.LABEL_ISSUED'
  ) THEN
    RAISE EXCEPTION 'label issue requires transactional audit and outbox evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ctr_traceability_label_issue_evidence
AFTER INSERT ON traceability_label_issues
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_traceability_label_issue_evidence();

-- Server receipts are a durable mirror of the client-side encrypted offline queue.
-- They store the first terminal result for every device transaction ID.
CREATE TABLE mobile_offline_sync_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  device_id VARCHAR(128) NOT NULL,
  client_transaction_id UUID NOT NULL,
  operation VARCHAR(24) NOT NULL,
  item_id UUID,
  result_status VARCHAR(12) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  result JSONB NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_mobile_offline_sync_receipt_id_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_mobile_offline_sync_device_txn UNIQUE (tenant_id, factory_id, device_id, client_transaction_id),
  CONSTRAINT uq_mobile_offline_sync_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_mobile_offline_sync_item
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mobile_offline_sync_actor
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_mobile_offline_sync_operation CHECK (operation IN ('STOCK_MOVEMENT')),
  CONSTRAINT chk_mobile_offline_sync_status CHECK (result_status IN ('APPLIED', 'CONFLICT', 'REJECTED')),
  CONSTRAINT chk_mobile_offline_sync_device CHECK (length(btrim(device_id)) > 0),
  CONSTRAINT chk_mobile_offline_sync_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_mobile_offline_sync_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_mobile_offline_sync_result CHECK (jsonb_typeof(result) = 'object')
);
CREATE INDEX idx_mobile_offline_sync_item_created
  ON mobile_offline_sync_receipts (tenant_id, factory_id, item_id, created_at DESC);

CREATE TABLE mobile_offline_sync_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  device_id VARCHAR(128) NOT NULL,
  client_transaction_id UUID NOT NULL,
  receipt_id UUID,
  outcome VARCHAR(24) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  response JSONB NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_mobile_offline_sync_attempt_id_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT fk_mobile_offline_sync_attempt_receipt
    FOREIGN KEY (receipt_id, tenant_id, factory_id)
    REFERENCES mobile_offline_sync_receipts (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mobile_offline_sync_attempt_actor
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_mobile_offline_sync_attempt_outcome
    CHECK (outcome IN ('APPLIED', 'CONFLICT', 'REJECTED', 'REPLAYED', 'IDEMPOTENCY_CONFLICT')),
  CONSTRAINT chk_mobile_offline_sync_attempt_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_mobile_offline_sync_attempt_response CHECK (jsonb_typeof(response) = 'object')
);
CREATE INDEX idx_mobile_offline_sync_attempt_history
  ON mobile_offline_sync_attempts (tenant_id, factory_id, device_id, client_transaction_id, created_at DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_mobile_offline_sync_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'mobile offline sync evidence is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'mobile offline sync actor must match the authenticated user'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_mobile_offline_sync_receipt_guard
BEFORE INSERT OR UPDATE OR DELETE ON mobile_offline_sync_receipts
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_mobile_offline_sync_evidence();
CREATE TRIGGER trg_mobile_offline_sync_attempt_guard
BEFORE INSERT OR UPDATE OR DELETE ON mobile_offline_sync_attempts
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_mobile_offline_sync_evidence();

CREATE OR REPLACE FUNCTION factoryos_assert_mobile_offline_sync_receipt_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id
      AND a.resource_type = 'MOBILE_OFFLINE_SYNC_RECEIPT'
      AND a.resource_id = NEW.id AND a.action = 'RECORDED'
  ) OR NOT EXISTS (
    SELECT 1 FROM outbox_events o
    WHERE o.tenant_id = NEW.tenant_id AND o.factory_id = NEW.factory_id
      AND o.aggregate_type = 'MOBILE_OFFLINE_SYNC_RECEIPT'
      AND o.aggregate_id = NEW.id
      AND o.event_type = 'WMS.MOBILE_OFFLINE_SYNC_RESULT_RECORDED'
  ) THEN
    RAISE EXCEPTION 'offline sync receipt requires transactional audit and outbox evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ctr_mobile_offline_sync_receipt_evidence
AFTER INSERT ON mobile_offline_sync_receipts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_mobile_offline_sync_receipt_evidence();

-- RFID reads are persisted as one observation per distinct EPC per read batch.
-- duplicate_read_count preserves device diagnostics without inflating observed stock.
CREATE TABLE rfid_read_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  reader_id UUID NOT NULL,
  session_id UUID NOT NULL,
  item_id UUID NOT NULL,
  location_id UUID NOT NULL,
  expected_quantity NUMERIC(18,4) NOT NULL,
  observed_quantity NUMERIC(18,4) NOT NULL,
  variance_quantity NUMERIC(18,4) NOT NULL,
  duplicate_reads_suppressed INTEGER NOT NULL DEFAULT 0,
  matched_tag_count INTEGER NOT NULL DEFAULT 0,
  excluded_tag_count INTEGER NOT NULL DEFAULT 0,
  reconciliation_status VARCHAR(12) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_rfid_read_batch_id_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_rfid_read_batch_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT uq_rfid_reader_session UNIQUE (tenant_id, factory_id, reader_id, session_id),
  CONSTRAINT fk_rfid_read_batch_item
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_rfid_read_batch_location
    FOREIGN KEY (location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_rfid_read_batch_actor
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_rfid_read_batch_quantities CHECK (
    expected_quantity >= 0 AND observed_quantity >= 0
    AND variance_quantity = observed_quantity - expected_quantity
  ),
  CONSTRAINT chk_rfid_read_batch_counts CHECK (
    duplicate_reads_suppressed >= 0 AND matched_tag_count >= 0 AND excluded_tag_count >= 0
  ),
  CONSTRAINT chk_rfid_read_batch_status CHECK (reconciliation_status IN ('MATCHED', 'VARIANCE')),
  CONSTRAINT chk_rfid_read_batch_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_rfid_read_batch_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE rfid_read_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  epc VARCHAR(128) NOT NULL,
  traceability_unit_id UUID,
  observed_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  duplicate_read_count INTEGER NOT NULL DEFAULT 0,
  disposition VARCHAR(20) NOT NULL,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_rfid_observation_id_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_rfid_observation_batch_epc UNIQUE (batch_id, epc),
  CONSTRAINT fk_rfid_observation_batch
    FOREIGN KEY (batch_id, tenant_id, factory_id)
    REFERENCES rfid_read_batches (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_rfid_observation_unit
    FOREIGN KEY (traceability_unit_id, tenant_id, factory_id)
    REFERENCES traceability_units (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_rfid_observation_actor
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_rfid_observation_epc CHECK (length(btrim(epc)) BETWEEN 1 AND 128),
  CONSTRAINT chk_rfid_observation_quantities CHECK (observed_quantity >= 0 AND duplicate_read_count >= 0),
  CONSTRAINT chk_rfid_observation_disposition
    CHECK (disposition IN ('MATCHED', 'UNKNOWN_TAG', 'WRONG_ITEM', 'NOT_PRESENT', 'INELIGIBLE'))
);
CREATE INDEX idx_rfid_observation_batch_disposition
  ON rfid_read_observations (tenant_id, factory_id, batch_id, disposition);

CREATE OR REPLACE FUNCTION factoryos_guard_rfid_read_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'RFID read and reconciliation evidence is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'RFID read actor must match the authenticated user'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_rfid_read_batch_guard
BEFORE INSERT OR UPDATE OR DELETE ON rfid_read_batches
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_rfid_read_evidence();
CREATE TRIGGER trg_rfid_read_observation_guard
BEFORE INSERT OR UPDATE OR DELETE ON rfid_read_observations
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_rfid_read_evidence();

CREATE OR REPLACE FUNCTION factoryos_assert_rfid_read_batch_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id
      AND a.resource_type = 'RFID_READ_BATCH'
      AND a.resource_id = NEW.id AND a.action = 'RFID_RECONCILED'
  ) OR NOT EXISTS (
    SELECT 1 FROM outbox_events o
    WHERE o.tenant_id = NEW.tenant_id AND o.factory_id = NEW.factory_id
      AND o.aggregate_type = 'RFID_READ_BATCH'
      AND o.aggregate_id = NEW.id AND o.event_type = 'INVENTORY.RFID_RECONCILED'
  ) THEN
    RAISE EXCEPTION 'RFID reconciliation requires transactional audit and outbox evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ctr_rfid_read_batch_evidence
AFTER INSERT ON rfid_read_batches
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_rfid_read_batch_evidence();

-- Tenant-scoped RLS is enforced even for application queries that omit an explicit
-- tenant predicate. Composite FKs still bind every child row to the same factory.
ALTER TABLE traceability_label_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE traceability_label_issues FORCE ROW LEVEL SECURITY;
CREATE POLICY traceability_label_issues_tenant_isolation ON traceability_label_issues
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE mobile_offline_sync_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_offline_sync_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY mobile_offline_sync_receipts_tenant_isolation ON mobile_offline_sync_receipts
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE mobile_offline_sync_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_offline_sync_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY mobile_offline_sync_attempts_tenant_isolation ON mobile_offline_sync_attempts
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE rfid_read_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfid_read_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY rfid_read_batches_tenant_isolation ON rfid_read_batches
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE rfid_read_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfid_read_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY rfid_read_observations_tenant_isolation ON rfid_read_observations
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations (version, checksum)
VALUES ('161_wms_mobile_offline_rfid_label_contract', NULL)
ON CONFLICT (version) DO NOTHING;

COMMENT ON TABLE traceability_label_issues IS
  'Immutable, idempotent print/issue events linking rendered barcode/QR labels to traceability and genealogy identities.';
COMMENT ON TABLE mobile_offline_sync_receipts IS
  'First terminal server result for each offline mobile transaction; retries replay the result and never repeat stock effects.';
COMMENT ON TABLE mobile_offline_sync_attempts IS
  'Append-only history for offline sync application, replay, rejection and idempotency conflicts.';
COMMENT ON TABLE rfid_read_batches IS
  'Idempotent RFID sessions reconciled against authoritative per-bin on-hand quantities; ingestion suppresses duplicate EPC reads.';
COMMENT ON TABLE rfid_read_observations IS
  'One immutable observation per EPC per RFID batch, retaining duplicate counts and exclusion reason without inflating stock.';

COMMIT;
