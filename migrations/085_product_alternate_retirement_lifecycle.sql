BEGIN;
ALTER TABLE product_bom_alternates
  ADD COLUMN retired_by_user_id UUID,
  ADD COLUMN retired_at TIMESTAMPTZ,
  ADD COLUMN retirement_idempotency_key VARCHAR(255),
  ADD COLUMN retirement_request_hash CHAR(64);

ALTER TABLE product_bom_alternates
  ADD CONSTRAINT fk_product_bom_alternate_retirer
    FOREIGN KEY (retired_by_user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE product_bom_alternates
  DROP CONSTRAINT chk_product_bom_alternate_approval_pair,
  ADD CONSTRAINT chk_product_bom_alternate_lifecycle_metadata CHECK (
    (status='DRAFT' AND approved_by_user_id IS NULL AND approved_at IS NULL AND retired_by_user_id IS NULL AND retired_at IS NULL)
    OR
    (status='APPROVED' AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL AND retired_by_user_id IS NULL AND retired_at IS NULL)
    OR
    (status='RETIRED' AND retired_by_user_id IS NOT NULL AND retired_at IS NOT NULL
      AND retired_by_user_id <> created_by_user_id)
  ),
  ADD CONSTRAINT chk_product_bom_alternate_retirement_key_pair CHECK (
    (retirement_idempotency_key IS NULL AND retirement_request_hash IS NULL)
    OR (length(btrim(retirement_idempotency_key))>0 AND retirement_request_hash ~ '^[0-9a-f]{64}$')
  );

CREATE UNIQUE INDEX uq_product_alternate_retirement_idempotency
  ON product_bom_alternates(tenant_id,factory_id,retirement_idempotency_key)
  WHERE retirement_idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION factoryos_guard_product_bom_alternate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_state VARCHAR(16);
  v_component_item_id UUID;
  v_item_status VARCHAR(20);
BEGIN
  IF TG_OP='UPDATE'
     AND ROW(NEW.id,NEW.tenant_id,NEW.factory_id,NEW.product_id,NEW.product_version_id,
             NEW.bom_line_id,NEW.alternate_item_id,NEW.conversion_factor,NEW.unit,NEW.rationale,
             NEW.idempotency_key,NEW.request_hash,NEW.created_by_user_id,NEW.created_at)
       IS DISTINCT FROM
         ROW(OLD.id,OLD.tenant_id,OLD.factory_id,OLD.product_id,OLD.product_version_id,
             OLD.bom_line_id,OLD.alternate_item_id,OLD.conversion_factor,OLD.unit,OLD.rationale,
             OLD.idempotency_key,OLD.request_hash,OLD.created_by_user_id,OLD.created_at) THEN
    RAISE EXCEPTION 'alternate contract inputs are immutable; create a replacement contract'
      USING ERRCODE='55000';
  END IF;

  SELECT state INTO v_state FROM product_versions
  WHERE id=COALESCE(NEW.product_version_id,OLD.product_version_id)
    AND tenant_id=COALESCE(NEW.tenant_id,OLD.tenant_id)
    AND factory_id=COALESCE(NEW.factory_id,OLD.factory_id)
  FOR UPDATE;
  IF NOT FOUND OR v_state<>'DRAFT' THEN
    RAISE EXCEPTION 'alternate contracts may only change while their product version is draft'
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;

  SELECT component_item_id INTO v_component_item_id FROM product_bom_lines
  WHERE id=NEW.bom_line_id AND product_version_id=NEW.product_version_id
    AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'alternate material must reference a BOM line in the same product version'
      USING ERRCODE='23503';
  END IF;
  IF v_component_item_id=NEW.alternate_item_id THEN
    RAISE EXCEPTION 'alternate material must differ from the primary BOM component'
      USING ERRCODE='23514';
  END IF;
  SELECT status INTO v_item_status FROM inventory_items
  WHERE id=NEW.alternate_item_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
  IF NOT FOUND OR v_item_status<>'ACTIVE' THEN
    RAISE EXCEPTION 'alternate material must be active inventory in the same factory'
      USING ERRCODE='23514';
  END IF;

  IF TG_OP='INSERT' THEN
    IF NEW.status<>'DRAFT' OR NEW.approved_by_user_id IS NOT NULL OR NEW.approved_at IS NOT NULL
       OR NEW.retired_by_user_id IS NOT NULL OR NEW.retired_at IS NOT NULL
       OR NEW.approval_idempotency_key IS NOT NULL OR NEW.approval_request_hash IS NOT NULL
       OR NEW.retirement_idempotency_key IS NOT NULL OR NEW.retirement_request_hash IS NOT NULL THEN
      RAISE EXCEPTION 'alternate material contracts must start as clean drafts'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  ELSIF OLD.status='DRAFT' AND NEW.status='APPROVED' THEN
    IF NEW.approved_by_user_id IS NULL OR NEW.approved_at IS NULL
       OR NEW.approval_idempotency_key IS NULL OR NEW.approval_request_hash IS NULL
       OR NEW.approved_by_user_id=NEW.created_by_user_id
       OR NEW.retired_by_user_id IS NOT NULL OR NEW.retired_at IS NOT NULL
       OR NEW.retirement_idempotency_key IS NOT NULL OR NEW.retirement_request_hash IS NOT NULL THEN
      RAISE EXCEPTION 'alternate approval requires independent approver and idempotency evidence'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  ELSIF OLD.status IN ('DRAFT','APPROVED') AND NEW.status='RETIRED' THEN
    IF NEW.retired_by_user_id IS NULL OR NEW.retired_at IS NULL
       OR NEW.retirement_idempotency_key IS NULL OR NEW.retirement_request_hash IS NULL
       OR NEW.retired_by_user_id=NEW.created_by_user_id
       OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.approval_idempotency_key IS DISTINCT FROM OLD.approval_idempotency_key
       OR NEW.approval_request_hash IS DISTINCT FROM OLD.approval_request_hash THEN
      RAISE EXCEPTION 'alternate retirement requires independent actor, idempotency evidence and preserved approval provenance'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid alternate material state transition'
    USING ERRCODE='55000';
END;
$$;

INSERT INTO schema_migrations(version,checksum)
VALUES('085_product_alternate_retirement_lifecycle',NULL)
ON CONFLICT(version) DO NOTHING;
COMMIT;
