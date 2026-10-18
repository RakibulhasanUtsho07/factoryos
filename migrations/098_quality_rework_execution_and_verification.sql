BEGIN;

CREATE TABLE quality_rework_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  rework_number VARCHAR(100) NOT NULL,
  defect_id UUID NOT NULL,
  inspection_id UUID NOT NULL,
  ncr_id UUID,
  source_inventory_item_id UUID,
  source_traceability_unit_id UUID,
  source_order_id UUID,
  source_order_line_id UUID,
  source_work_order_id UUID,
  source_work_order_operation_id UUID,
  source_production_report_id UUID,
  source_goods_receipt_id UUID,
  source_goods_receipt_line_id UUID,
  input_quantity NUMERIC(18,4) NOT NULL,
  recovered_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  scrap_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  output_traceability_unit_id UUID,
  follow_up_inspection_id UUID,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  reason TEXT NOT NULL,
  instructions TEXT,
  completion_reason TEXT,
  verification_reason TEXT,
  cancellation_reason TEXT,
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  approved_by_user_id UUID,
  approved_at TIMESTAMPTZ,
  started_by_user_id UUID,
  started_at TIMESTAMPTZ,
  completed_by_user_id UUID,
  completed_at TIMESTAMPTZ,
  verified_by_user_id UUID,
  verified_at TIMESTAMPTZ,
  cancelled_by_user_id UUID,
  cancelled_at TIMESTAMPTZ,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_quality_rework_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_quality_rework_number UNIQUE (tenant_id, factory_id, rework_number),
  CONSTRAINT uq_quality_rework_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_quality_rework_defect FOREIGN KEY (defect_id, tenant_id, factory_id)
    REFERENCES quality_defects(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_inspection FOREIGN KEY (inspection_id, tenant_id, factory_id)
    REFERENCES quality_inspections(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_ncr FOREIGN KEY (ncr_id, tenant_id, factory_id)
    REFERENCES quality_ncrs(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_item FOREIGN KEY (source_inventory_item_id, tenant_id, factory_id)
    REFERENCES inventory_items(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_source_unit FOREIGN KEY (source_traceability_unit_id, tenant_id, factory_id)
    REFERENCES traceability_units(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_order FOREIGN KEY (source_order_id, tenant_id, factory_id)
    REFERENCES orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_order_line FOREIGN KEY (source_order_line_id, source_order_id, tenant_id, factory_id)
    REFERENCES order_lines(id, order_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_work_order FOREIGN KEY (source_work_order_id, tenant_id, factory_id)
    REFERENCES work_orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_operation FOREIGN KEY (source_work_order_operation_id, source_work_order_id, tenant_id, factory_id)
    REFERENCES work_order_operations(id, work_order_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_report FOREIGN KEY (source_production_report_id, source_order_id, source_order_line_id, tenant_id, factory_id)
    REFERENCES order_production_reports(id, order_id, order_line_id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_receipt FOREIGN KEY (source_goods_receipt_id, tenant_id, factory_id)
    REFERENCES goods_receipts(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_receipt_line FOREIGN KEY (source_goods_receipt_line_id, tenant_id, factory_id, source_goods_receipt_id)
    REFERENCES goods_receipt_lines(id, tenant_id, factory_id, goods_receipt_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_output_unit FOREIGN KEY (output_traceability_unit_id, tenant_id, factory_id)
    REFERENCES traceability_units(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_follow_up_inspection FOREIGN KEY (follow_up_inspection_id, tenant_id, factory_id)
    REFERENCES quality_inspections(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_approver FOREIGN KEY (approved_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_starter FOREIGN KEY (started_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_completer FOREIGN KEY (completed_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_verifier FOREIGN KEY (verified_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_canceller FOREIGN KEY (cancelled_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_rework_status CHECK (status IN ('DRAFT','APPROVED','IN_PROGRESS','COMPLETED','REWORK_REQUIRED','VERIFIED','CANCELLED')),
  CONSTRAINT chk_quality_rework_positive_quantity CHECK (input_quantity > 0 AND recovered_quantity >= 0 AND scrap_quantity >= 0),
  CONSTRAINT chk_quality_rework_decimal_precision CHECK (
    input_quantity * 10000 = round(input_quantity * 10000)
    AND recovered_quantity * 10000 = round(recovered_quantity * 10000)
    AND scrap_quantity * 10000 = round(scrap_quantity * 10000)
  ),
  CONSTRAINT chk_quality_rework_source CHECK (
    num_nonnulls(source_inventory_item_id,source_traceability_unit_id,source_order_line_id,
      source_work_order_id,source_production_report_id,source_goods_receipt_line_id) > 0
  ),
  CONSTRAINT chk_quality_rework_version CHECK (row_version > 0),
  CONSTRAINT chk_quality_rework_number_nonempty CHECK (length(btrim(rework_number)) > 0),
  CONSTRAINT chk_quality_rework_reason CHECK (length(btrim(reason)) > 0),
  CONSTRAINT chk_quality_rework_instructions CHECK (instructions IS NULL OR length(btrim(instructions)) > 0),
  CONSTRAINT chk_quality_rework_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_quality_rework_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_quality_rework_lifecycle_evidence CHECK (
    (status = 'DRAFT' AND approved_by_user_id IS NULL AND approved_at IS NULL
      AND started_by_user_id IS NULL AND started_at IS NULL
      AND completed_by_user_id IS NULL AND completed_at IS NULL
      AND verified_by_user_id IS NULL AND verified_at IS NULL
      AND cancelled_by_user_id IS NULL AND cancelled_at IS NULL
      AND recovered_quantity = 0 AND scrap_quantity = 0
      AND output_traceability_unit_id IS NULL AND follow_up_inspection_id IS NULL)
    OR (status = 'APPROVED' AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL
      AND started_by_user_id IS NULL AND started_at IS NULL
      AND completed_by_user_id IS NULL AND completed_at IS NULL
      AND verified_by_user_id IS NULL AND verified_at IS NULL
      AND cancelled_by_user_id IS NULL AND cancelled_at IS NULL
      AND recovered_quantity = 0 AND scrap_quantity = 0
      AND output_traceability_unit_id IS NULL AND follow_up_inspection_id IS NULL)
    OR (status = 'IN_PROGRESS' AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL
      AND started_by_user_id IS NOT NULL AND started_at IS NOT NULL
      AND completed_by_user_id IS NULL AND completed_at IS NULL
      AND verified_by_user_id IS NULL AND verified_at IS NULL
      AND cancelled_by_user_id IS NULL AND cancelled_at IS NULL
      AND recovered_quantity = 0 AND scrap_quantity = 0
      AND output_traceability_unit_id IS NULL AND follow_up_inspection_id IS NULL)
    OR (status IN ('COMPLETED','REWORK_REQUIRED','VERIFIED') AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL
      AND started_by_user_id IS NOT NULL AND started_at IS NOT NULL
      AND completed_by_user_id IS NOT NULL AND completed_at IS NOT NULL
      AND recovered_quantity + scrap_quantity = input_quantity
      AND length(btrim(COALESCE(completion_reason,''))) > 0
      AND ((recovered_quantity > 0 AND output_traceability_unit_id IS NOT NULL AND follow_up_inspection_id IS NOT NULL)
        OR (recovered_quantity = 0 AND scrap_quantity = input_quantity
          AND output_traceability_unit_id IS NULL AND follow_up_inspection_id IS NULL))
      AND ((status = 'COMPLETED' AND verified_by_user_id IS NULL AND verified_at IS NULL AND verification_reason IS NULL)
        OR (status IN ('REWORK_REQUIRED','VERIFIED') AND verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL
          AND length(btrim(COALESCE(verification_reason,''))) > 0)))
    OR (status = 'CANCELLED' AND cancelled_by_user_id IS NOT NULL AND cancelled_at IS NOT NULL
      AND length(btrim(COALESCE(cancellation_reason,''))) > 0
      AND completed_by_user_id IS NULL AND completed_at IS NULL
      AND verified_by_user_id IS NULL AND verified_at IS NULL)
  )
);

CREATE INDEX idx_quality_rework_defect_status
  ON quality_rework_orders(tenant_id, factory_id, defect_id, status, created_at DESC);
CREATE INDEX idx_quality_rework_queue
  ON quality_rework_orders(tenant_id, factory_id, status, created_at DESC);

CREATE TABLE quality_rework_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  rework_order_id UUID NOT NULL,
  version BIGINT NOT NULL,
  from_status VARCHAR(20),
  to_status VARCHAR(20) NOT NULL,
  command VARCHAR(20) NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  actor_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_quality_rework_event_version UNIQUE (rework_order_id, version),
  CONSTRAINT uq_quality_rework_event_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_quality_rework_event_order FOREIGN KEY (rework_order_id, tenant_id, factory_id)
    REFERENCES quality_rework_orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quality_rework_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quality_rework_event_status CHECK (
    (from_status IS NULL OR from_status IN ('DRAFT','APPROVED','IN_PROGRESS','COMPLETED','REWORK_REQUIRED','VERIFIED','CANCELLED'))
    AND to_status IN ('DRAFT','APPROVED','IN_PROGRESS','COMPLETED','REWORK_REQUIRED','VERIFIED','CANCELLED')
  ),
  CONSTRAINT chk_quality_rework_event_command CHECK (command IN ('CREATED','APPROVE','START','COMPLETE','VERIFY_PASS','VERIFY_FAIL','RESTART','CANCEL')),
  CONSTRAINT chk_quality_rework_event_reason CHECK (length(btrim(reason)) > 0),
  CONSTRAINT chk_quality_rework_event_json CHECK (jsonb_typeof(evidence)='object' AND jsonb_typeof(payload)='object'),
  CONSTRAINT chk_quality_rework_event_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_quality_rework_event_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_quality_rework_event_history
  ON quality_rework_events(tenant_id, factory_id, rework_order_id, version);

ALTER TABLE quality_defect_links
  ADD COLUMN rework_order_id UUID,
  DROP CONSTRAINT chk_quality_defect_link_type,
  DROP CONSTRAINT chk_quality_defect_link_target,
  DROP CONSTRAINT chk_quality_defect_link_source,
  ADD CONSTRAINT fk_quality_defect_link_rework FOREIGN KEY (rework_order_id, tenant_id, factory_id)
    REFERENCES quality_rework_orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_quality_defect_link_type CHECK (link_type IN (
    'INVENTORY_ITEM','TRACEABILITY_UNIT','ORDER','ORDER_LINE','WORK_ORDER',
    'WORK_ORDER_OPERATION','PRODUCTION_REPORT','GOODS_RECEIPT_LINE','REWORK_OUTPUT'
  )),
  ADD CONSTRAINT chk_quality_defect_link_target CHECK (
    (link_type = 'INVENTORY_ITEM' AND inventory_item_id IS NOT NULL
      AND traceability_unit_id IS NULL AND order_id IS NULL AND order_line_id IS NULL
      AND work_order_id IS NULL AND work_order_operation_id IS NULL AND production_report_id IS NULL
      AND goods_receipt_id IS NULL AND goods_receipt_line_id IS NULL AND rework_order_id IS NULL)
    OR (link_type = 'TRACEABILITY_UNIT' AND traceability_unit_id IS NOT NULL
      AND inventory_item_id IS NULL AND order_id IS NULL AND order_line_id IS NULL
      AND work_order_id IS NULL AND work_order_operation_id IS NULL AND production_report_id IS NULL
      AND goods_receipt_id IS NULL AND goods_receipt_line_id IS NULL AND rework_order_id IS NULL)
    OR (link_type = 'ORDER' AND order_id IS NOT NULL AND order_line_id IS NULL
      AND inventory_item_id IS NULL AND traceability_unit_id IS NULL
      AND work_order_id IS NULL AND work_order_operation_id IS NULL AND production_report_id IS NULL
      AND goods_receipt_id IS NULL AND goods_receipt_line_id IS NULL AND rework_order_id IS NULL)
    OR (link_type = 'ORDER_LINE' AND order_id IS NOT NULL AND order_line_id IS NOT NULL
      AND inventory_item_id IS NULL AND traceability_unit_id IS NULL
      AND work_order_id IS NULL AND work_order_operation_id IS NULL AND production_report_id IS NULL
      AND goods_receipt_id IS NULL AND goods_receipt_line_id IS NULL AND rework_order_id IS NULL)
    OR (link_type = 'WORK_ORDER' AND work_order_id IS NOT NULL AND work_order_operation_id IS NULL
      AND inventory_item_id IS NULL AND traceability_unit_id IS NULL AND order_id IS NULL AND order_line_id IS NULL
      AND production_report_id IS NULL AND goods_receipt_id IS NULL AND goods_receipt_line_id IS NULL AND rework_order_id IS NULL)
    OR (link_type = 'WORK_ORDER_OPERATION' AND work_order_id IS NOT NULL AND work_order_operation_id IS NOT NULL
      AND inventory_item_id IS NULL AND traceability_unit_id IS NULL AND order_id IS NULL AND order_line_id IS NULL
      AND production_report_id IS NULL AND goods_receipt_id IS NULL AND goods_receipt_line_id IS NULL AND rework_order_id IS NULL)
    OR (link_type = 'PRODUCTION_REPORT' AND production_report_id IS NOT NULL
      AND inventory_item_id IS NULL AND traceability_unit_id IS NULL AND order_id IS NULL AND order_line_id IS NULL
      AND work_order_id IS NULL AND work_order_operation_id IS NULL
      AND goods_receipt_id IS NULL AND goods_receipt_line_id IS NULL AND rework_order_id IS NULL)
    OR (link_type = 'GOODS_RECEIPT_LINE' AND goods_receipt_id IS NOT NULL AND goods_receipt_line_id IS NOT NULL
      AND inventory_item_id IS NULL AND traceability_unit_id IS NULL AND order_id IS NULL AND order_line_id IS NULL
      AND work_order_id IS NULL AND work_order_operation_id IS NULL AND production_report_id IS NULL AND rework_order_id IS NULL)
    OR (link_type = 'REWORK_OUTPUT' AND traceability_unit_id IS NOT NULL AND rework_order_id IS NOT NULL
      AND inventory_item_id IS NULL AND order_id IS NULL AND order_line_id IS NULL
      AND work_order_id IS NULL AND work_order_operation_id IS NULL AND production_report_id IS NULL
      AND goods_receipt_id IS NULL AND goods_receipt_line_id IS NULL)
  ),
  ADD CONSTRAINT chk_quality_defect_link_source CHECK (link_source IN ('INSPECTION_TARGET','OPERATOR','REWORK_OUTPUT'));

CREATE OR REPLACE FUNCTION factoryos_guard_quality_rework_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_defect quality_defects%ROWTYPE;
  v_inspection quality_inspections%ROWTYPE;
  v_item UUID;
  v_output traceability_units%ROWTYPE;
  v_followup quality_inspections%ROWTYPE;
  v_total NUMERIC(18,4);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality rework execution evidence cannot be deleted' USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
      OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
      OR NEW.status <> 'DRAFT' OR NEW.row_version <> 1
      OR NEW.approved_by_user_id IS NOT NULL OR NEW.started_by_user_id IS NOT NULL
      OR NEW.completed_by_user_id IS NOT NULL OR NEW.verified_by_user_id IS NOT NULL
      OR NEW.cancelled_by_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'rework order must begin as DRAFT under the authenticated actor' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF ROW(NEW.id,NEW.tenant_id,NEW.factory_id,NEW.rework_number,NEW.defect_id,NEW.inspection_id,NEW.ncr_id,
      NEW.source_inventory_item_id,NEW.source_traceability_unit_id,NEW.source_order_id,NEW.source_order_line_id,
      NEW.source_work_order_id,NEW.source_work_order_operation_id,NEW.source_production_report_id,
      NEW.source_goods_receipt_id,NEW.source_goods_receipt_line_id,NEW.input_quantity,NEW.reason,NEW.instructions,
      NEW.idempotency_key,NEW.request_hash,NEW.created_by_user_id,NEW.correlation_id,NEW.created_at)
      IS DISTINCT FROM
      ROW(OLD.id,OLD.tenant_id,OLD.factory_id,OLD.rework_number,OLD.defect_id,OLD.inspection_id,OLD.ncr_id,
      OLD.source_inventory_item_id,OLD.source_traceability_unit_id,OLD.source_order_id,OLD.source_order_line_id,
      OLD.source_work_order_id,OLD.source_work_order_operation_id,OLD.source_production_report_id,
      OLD.source_goods_receipt_id,OLD.source_goods_receipt_line_id,OLD.input_quantity,OLD.reason,OLD.instructions,
      OLD.idempotency_key,OLD.request_hash,OLD.created_by_user_id,OLD.correlation_id,OLD.created_at)
      OR NEW.row_version <> OLD.row_version + 1
      OR NEW.updated_at <= OLD.updated_at
      OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'rework order identity is immutable and state changes require versioned actor evidence'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  SELECT * INTO v_defect FROM quality_defects d
  WHERE d.id=NEW.defect_id AND d.tenant_id=NEW.tenant_id AND d.factory_id=NEW.factory_id FOR SHARE;
  IF NOT FOUND OR v_defect.inspection_id <> NEW.inspection_id OR v_defect.status NOT IN ('OPEN','REWORK') THEN
    RAISE EXCEPTION 'rework must reference an open/rework defect from the same inspection' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_inspection FROM quality_inspections qi
  WHERE qi.id=NEW.inspection_id AND qi.tenant_id=NEW.tenant_id AND qi.factory_id=NEW.factory_id FOR SHARE;
  IF NOT FOUND OR v_inspection.status NOT IN ('FAILED','ON_HOLD','DISPOSITIONED') THEN
    RAISE EXCEPTION 'rework requires a failed/held/dispositioned source inspection' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM quality_holds h WHERE h.inspection_id=NEW.inspection_id
      AND h.tenant_id=NEW.tenant_id AND h.factory_id=NEW.factory_id AND h.status='ACTIVE')
    AND (NEW.source_traceability_unit_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM quality_holds h WHERE h.traceability_unit_id=NEW.source_traceability_unit_id
        AND h.tenant_id=NEW.tenant_id AND h.factory_id=NEW.factory_id AND h.status='ACTIVE')) THEN
    RAISE EXCEPTION 'rework requires an active quality hold on the inspected source' USING ERRCODE = '23514';
  END IF;
  IF NEW.source_traceability_unit_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM quality_defect_links l WHERE l.defect_id=NEW.defect_id
        AND l.traceability_unit_id=NEW.source_traceability_unit_id
        AND l.tenant_id=NEW.tenant_id AND l.factory_id=NEW.factory_id) THEN
    RAISE EXCEPTION 'rework source lot/serial must be linked to the defect' USING ERRCODE = '23514';
  END IF;
  IF NEW.ncr_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM quality_ncrs n WHERE n.id=NEW.ncr_id AND n.inspection_id=NEW.inspection_id
        AND n.tenant_id=NEW.tenant_id AND n.factory_id=NEW.factory_id AND n.status <> 'CLOSED') THEN
    RAISE EXCEPTION 'rework NCR must belong to the same inspection and remain open' USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(r.input_quantity),0)::numeric(18,4) INTO v_total
  FROM quality_rework_orders r WHERE r.defect_id=NEW.defect_id
    AND r.tenant_id=NEW.tenant_id AND r.factory_id=NEW.factory_id
    AND r.status <> 'CANCELLED' AND r.id IS DISTINCT FROM NEW.id;
  IF TG_OP = 'INSERT' AND v_total + NEW.input_quantity > v_defect.affected_quantity THEN
    RAISE EXCEPTION 'rework quantities across tasks cannot exceed the defect affected quantity' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status='DRAFT' AND NEW.status='APPROVED' THEN
      IF NEW.approved_by_user_id IS DISTINCT FROM factoryos_current_user_id() OR NEW.approved_at IS NULL THEN
        RAISE EXCEPTION 'rework approval requires actor and timestamp evidence' USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.status='APPROVED' OR OLD.status='REWORK_REQUIRED' THEN
      IF NEW.status='IN_PROGRESS' THEN
        IF NEW.started_by_user_id IS DISTINCT FROM factoryos_current_user_id() OR NEW.started_at IS NULL THEN
          RAISE EXCEPTION 'rework start requires actor and timestamp evidence' USING ERRCODE = '23514';
        END IF;
      ELSIF NOT (OLD.status='APPROVED' AND NEW.status='CANCELLED')
        AND NOT (OLD.status='REWORK_REQUIRED' AND NEW.status='CANCELLED') THEN
        RAISE EXCEPTION 'invalid rework transition: % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.status='IN_PROGRESS' THEN
      IF NEW.status='COMPLETED' THEN
        IF NEW.completed_by_user_id IS DISTINCT FROM factoryos_current_user_id() OR NEW.completed_at IS NULL
          OR length(btrim(COALESCE(NEW.completion_reason,'')))=0
          OR NEW.recovered_quantity + NEW.scrap_quantity <> NEW.input_quantity THEN
          RAISE EXCEPTION 'rework completion requires a reconciled quantity split and completion evidence' USING ERRCODE = '23514';
        END IF;
      ELSIF NEW.status <> 'CANCELLED' THEN
        RAISE EXCEPTION 'invalid rework transition: % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.status='COMPLETED' THEN
      IF NEW.status NOT IN ('VERIFIED','REWORK_REQUIRED')
        OR NEW.verified_by_user_id IS DISTINCT FROM factoryos_current_user_id()
        OR NEW.verified_at IS NULL OR length(btrim(COALESCE(NEW.verification_reason,'')))=0
        OR NEW.verified_by_user_id=OLD.completed_by_user_id THEN
        RAISE EXCEPTION 'rework review requires an independent verifier and reason' USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.status='VERIFIED' OR OLD.status='CANCELLED' THEN
      RAISE EXCEPTION 'verified/cancelled rework is terminal' USING ERRCODE = '55000';
    ELSE
      RAISE EXCEPTION 'invalid rework transition: % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status IN ('COMPLETED','REWORK_REQUIRED','VERIFIED') AND NEW.recovered_quantity > 0 THEN
    SELECT * INTO v_output FROM traceability_units u
    WHERE u.id=NEW.output_traceability_unit_id AND u.tenant_id=NEW.tenant_id AND u.factory_id=NEW.factory_id;
    IF NOT FOUND OR v_output.status <> 'ACTIVE' OR v_output.quantity <> NEW.recovered_quantity
      OR (NEW.source_inventory_item_id IS NOT NULL AND v_output.inventory_item_id <> NEW.source_inventory_item_id) THEN
      RAISE EXCEPTION 'rework output lot/serial must be active, match recovered quantity and use the same item' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_followup FROM quality_inspections qi
    WHERE qi.id=NEW.follow_up_inspection_id AND qi.tenant_id=NEW.tenant_id AND qi.factory_id=NEW.factory_id;
    IF NOT FOUND OR v_followup.target_type <> 'TRACEABILITY_UNIT'
      OR v_followup.target_id <> NEW.output_traceability_unit_id
      OR v_followup.inspection_type NOT IN ('IN_PROCESS','FINAL','INVENTORY')
      OR v_followup.status IN ('CANCELLED','DISPOSITIONED') THEN
      RAISE EXCEPTION 'rework output must have its own follow-up inspection on the exact output lot/serial' USING ERRCODE = '23514';
    END IF;
    IF NEW.status='VERIFIED' AND v_followup.status <> 'PASSED' THEN
      RAISE EXCEPTION 'rework may be verified only after its follow-up inspection passes' USING ERRCODE = '23514';
    END IF;
    IF NEW.status='REWORK_REQUIRED' AND v_followup.status NOT IN ('FAILED','ON_HOLD') THEN
      RAISE EXCEPTION 'failed rework verification requires a failed or held follow-up inspection' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status IN ('COMPLETED','REWORK_REQUIRED','VERIFIED') AND NEW.recovered_quantity = 0 THEN
    IF NEW.scrap_quantity <> NEW.input_quantity OR NEW.output_traceability_unit_id IS NOT NULL OR NEW.follow_up_inspection_id IS NOT NULL THEN
      RAISE EXCEPTION 'fully scrapped rework must reconcile all input and cannot claim a recovered output lot' USING ERRCODE = '23514';
    END IF;
    IF NEW.status='REWORK_REQUIRED' THEN
      RAISE EXCEPTION 'fully scrapped rework cannot be restarted for rework; use an explicit replacement task' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status='CANCELLED' THEN
    IF NEW.cancelled_by_user_id IS DISTINCT FROM factoryos_current_user_id()
      OR NEW.cancelled_at IS NULL OR length(btrim(COALESCE(NEW.cancellation_reason,'')))=0
      OR OLD.status NOT IN ('DRAFT','APPROVED','IN_PROGRESS','REWORK_REQUIRED') THEN
      RAISE EXCEPTION 'rework cancellation requires actor, reason and a cancellable state' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_rework_order_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON quality_rework_orders
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_rework_order();

CREATE OR REPLACE FUNCTION factoryos_guard_quality_rework_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_rework quality_rework_orders%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'rework event history is append-only' USING ERRCODE = '55000';
  END IF;
  IF NEW.actor_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'rework event actor must match authenticated user' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_rework FROM quality_rework_orders r
  WHERE r.id=NEW.rework_order_id AND r.tenant_id=NEW.tenant_id AND r.factory_id=NEW.factory_id;
  IF NOT FOUND OR v_rework.row_version <> NEW.version OR v_rework.status <> NEW.to_status THEN
    RAISE EXCEPTION 'rework event must describe the applied rework version and status' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_rework_event_guard
BEFORE INSERT OR UPDATE OR DELETE ON quality_rework_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_rework_event();
CREATE TRIGGER trg_quality_rework_events_immutable
BEFORE UPDATE OR DELETE ON quality_rework_events
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_quality_audit_mutation();

CREATE OR REPLACE FUNCTION factoryos_assert_quality_rework_event_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM quality_rework_events e
      WHERE e.id=NEW.id AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
        AND e.rework_order_id=NEW.id AND e.version=NEW.row_version AND e.to_status=NEW.status) THEN
    RAISE EXCEPTION 'rework order requires an event matching its committed lifecycle version' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

-- Event IDs and aggregate IDs are intentionally different. Bind the deferred evidence guard to the row state.
CREATE OR REPLACE FUNCTION factoryos_assert_quality_rework_state_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM quality_rework_events e
      WHERE e.rework_order_id=NEW.id AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
        AND e.version=NEW.row_version AND e.to_status=NEW.status) THEN
    RAISE EXCEPTION 'rework order requires an event matching its committed lifecycle version' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ctr_quality_rework_state_event
AFTER INSERT OR UPDATE ON quality_rework_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_quality_rework_state_event();

CREATE OR REPLACE FUNCTION factoryos_assert_quality_rework_event_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM quality_audit_events a
      WHERE a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id
        AND a.action_type='QUALITY_REWORK_EVENT' AND a.payload->>'rework_event_id'=NEW.id::text)
    OR NOT EXISTS (SELECT 1 FROM outbox_events o
      WHERE o.tenant_id=NEW.tenant_id AND o.factory_id=NEW.factory_id
        AND o.aggregate_type='QUALITY_REWORK' AND o.aggregate_id=NEW.rework_order_id
        AND o.event_type='QUALITY.REWORK_CHANGED' AND o.payload->>'rework_event_id'=NEW.id::text) THEN
    RAISE EXCEPTION 'rework transitions require transactional audit and outbox evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ctr_quality_rework_event_audit
AFTER INSERT ON quality_rework_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_quality_rework_event_audit();

CREATE OR REPLACE FUNCTION factoryos_guard_quality_rework_output_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_rework quality_rework_orders%ROWTYPE;
BEGIN
  IF NEW.link_source <> 'REWORK_OUTPUT' THEN RETURN NEW; END IF;
  SELECT * INTO v_rework FROM quality_rework_orders r
  WHERE r.id=NEW.rework_order_id AND r.tenant_id=NEW.tenant_id AND r.factory_id=NEW.factory_id;
  IF NOT FOUND OR v_rework.defect_id <> NEW.defect_id
    OR v_rework.output_traceability_unit_id <> NEW.traceability_unit_id
    OR v_rework.recovered_quantity <= 0 OR v_rework.status NOT IN ('COMPLETED','REWORK_REQUIRED','VERIFIED') THEN
    RAISE EXCEPTION 'rework output links must match a recorded recovered lot/serial for this defect'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_quality_rework_output_link_guard
BEFORE INSERT ON quality_defect_links
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quality_rework_output_link();

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
      OR EXISTS (SELECT 1 FROM quality_rework_orders r WHERE r.ncr_id = NEW.id
        AND r.tenant_id = NEW.tenant_id AND r.factory_id = NEW.factory_id
        AND r.status NOT IN ('VERIFIED','CANCELLED'))
      OR NOT EXISTS (SELECT 1 FROM quality_inspections qi WHERE qi.id = NEW.inspection_id
        AND qi.tenant_id = NEW.tenant_id AND qi.factory_id = NEW.factory_id
        AND qi.status IN ('PASSED', 'DISPOSITIONED'))
      OR EXISTS (SELECT 1 FROM quality_holds h WHERE h.inspection_id = NEW.inspection_id
        AND h.tenant_id = NEW.tenant_id AND h.factory_id = NEW.factory_id AND h.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'NCR closure requires CAPA evidence, verified CAPA actions, resolved rework and defects, a resolved inspection and no active quality hold'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE quality_rework_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_rework_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_rework_orders_tenant_isolation ON quality_rework_orders
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());
ALTER TABLE quality_rework_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_rework_events FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_rework_events_tenant_isolation ON quality_rework_events
  USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id());

INSERT INTO schema_migrations(version, checksum)
VALUES ('098_quality_rework_execution_and_verification', NULL)
ON CONFLICT (version) DO NOTHING;

COMMENT ON TABLE quality_rework_orders IS
  'Versioned rework work queue linked to defects, holds, lots/serials, order lines and source production evidence. Recovery requires a separate lot identity and follow-up inspection; no inventory balance is silently posted.';
COMMENT ON TABLE quality_rework_events IS
  'Append-only approved/in-progress/completed/rework-required/verified/cancelled execution history with quantity reconciliation and audit/outbox evidence.';

COMMIT;
