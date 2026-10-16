BEGIN;

-- WP02 / Separate cycle-count capture from stock-adjustment approval.
INSERT INTO permissions (code, description)
VALUES
  ('inventory.cycle-count.review', 'Approve or reject a cycle count submitted by another user'),
  ('inventory.reconcile.direct', 'Perform an immediate privileged stock reconciliation outside the cycle-count review workflow')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (
  (p.code = 'inventory.cycle-count.review' AND r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER'))
  OR (p.code = 'inventory.reconcile.direct' AND r.code = 'ORG_ADMIN')
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Support scope-preserving references from cycle-count workflow records.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_inventory_stock_reconciliation_id_scope'
      AND conrelid = 'inventory_stock_reconciliations'::regclass
  ) THEN
    ALTER TABLE inventory_stock_reconciliations
      ADD CONSTRAINT uq_inventory_stock_reconciliation_id_scope
      UNIQUE (id, tenant_id, factory_id);
  END IF;
END;
$$;

CREATE TABLE inventory_cycle_count_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  counted_quantity NUMERIC(18, 4) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING_REVIEW',
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  notes TEXT,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reviewed_by_user_id UUID,
  reviewed_at TIMESTAMPTZ,
  review_decision VARCHAR(16),
  review_idempotency_key VARCHAR(255),
  review_request_hash VARCHAR(64),
  review_note TEXT,
  reconciliation_id UUID,
  CONSTRAINT uq_inventory_cycle_count_proposal_id_scope
    UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_inventory_cycle_count_proposal_idempotency
    UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_inventory_cycle_count_item_scope
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_reviewer
    FOREIGN KEY (reviewed_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cycle_count_reconciliation_scope
    FOREIGN KEY (reconciliation_id, tenant_id, factory_id)
    REFERENCES inventory_stock_reconciliations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_cycle_count_quantity
    CHECK (counted_quantity >= 0),
  CONSTRAINT chk_inventory_cycle_count_status
    CHECK (status IN ('PENDING_REVIEW', 'REJECTED', 'APPLIED')),
  CONSTRAINT chk_inventory_cycle_count_key
    CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_inventory_cycle_count_hash
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_inventory_cycle_count_review_fields
    CHECK (
      (status = 'PENDING_REVIEW'
        AND reviewed_by_user_id IS NULL
        AND reviewed_at IS NULL
        AND review_decision IS NULL
        AND review_idempotency_key IS NULL
        AND review_request_hash IS NULL
        AND reconciliation_id IS NULL)
      OR
      (status = 'REJECTED'
        AND reviewed_by_user_id IS NOT NULL
        AND reviewed_at IS NOT NULL
        AND review_decision = 'REJECT'
        AND review_idempotency_key IS NOT NULL
        AND review_request_hash IS NOT NULL
        AND review_request_hash ~ '^[0-9a-f]{64}$'
        AND length(btrim(COALESCE(review_note, ''))) > 0
        AND reconciliation_id IS NULL)
      OR
      (status = 'APPLIED'
        AND reviewed_by_user_id IS NOT NULL
        AND reviewed_at IS NOT NULL
        AND review_decision = 'APPROVE'
        AND review_idempotency_key IS NOT NULL
        AND review_request_hash ~ '^[0-9a-f]{64}$'
        AND reconciliation_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX uq_inventory_cycle_count_review_idempotency
  ON inventory_cycle_count_proposals (tenant_id, factory_id, review_idempotency_key)
  WHERE review_idempotency_key IS NOT NULL;

CREATE INDEX idx_inventory_cycle_count_factory_status_created
  ON inventory_cycle_count_proposals
  (tenant_id, factory_id, status, created_at DESC, id DESC);

CREATE INDEX idx_inventory_cycle_count_item_created
  ON inventory_cycle_count_proposals
  (tenant_id, factory_id, item_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_cycle_count_proposal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory_cycle_count_proposals are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
    OR NEW.item_id IS DISTINCT FROM OLD.item_id
    OR NEW.counted_quantity IS DISTINCT FROM OLD.counted_quantity
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.notes IS DISTINCT FROM OLD.notes
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'cycle-count proposal facts cannot be edited'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'PENDING_REVIEW' THEN
    RAISE EXCEPTION 'cycle-count review decision is terminal'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status NOT IN ('REJECTED', 'APPLIED')
    OR NEW.reviewed_by_user_id IS NULL
    OR NEW.reviewed_by_user_id = NEW.created_by_user_id
    OR NEW.reviewed_at IS NULL
    OR NEW.review_decision IS NULL
    OR NEW.review_decision NOT IN ('APPROVE', 'REJECT')
    OR NEW.review_idempotency_key IS NULL
    OR NEW.review_request_hash IS NULL
    OR NEW.review_request_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid cycle-count review transition or separation-of-duties violation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'REJECTED' AND (
    NEW.review_decision <> 'REJECT'
    OR NEW.reconciliation_id IS NOT NULL
    OR length(btrim(COALESCE(NEW.review_note, ''))) = 0
  ) THEN
    RAISE EXCEPTION 'rejected cycle counts require a reason and no stock reconciliation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'APPLIED' AND (
    NEW.review_decision <> 'APPROVE'
    OR NEW.reconciliation_id IS NULL
  ) THEN
    RAISE EXCEPTION 'approved cycle counts require the atomic stock reconciliation'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_cycle_count_proposals_guard
BEFORE UPDATE OR DELETE ON inventory_cycle_count_proposals
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_inventory_cycle_count_proposal();

ALTER TABLE inventory_cycle_count_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_cycle_count_proposals FORCE ROW LEVEL SECURITY;

CREATE POLICY inventory_cycle_count_proposals_tenant_isolation
ON inventory_cycle_count_proposals
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMENT ON TABLE inventory_cycle_count_proposals IS
  'Immutable physical cycle-count proposal with reviewer separation of duties. Count and stock adjustment are distinct; approval and the resulting reconciliation are committed in one transaction.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('062_inventory_cycle_count_approval', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;

        AND length(btrim(COALESCE(review_note, ''))) > 0
        AND reconciliation_id IS NULL)
      OR
      (status = 'APPLIED'
        AND reviewed_by_user_id IS NOT NULL
        AND reviewed_at IS NOT NULL
        AND review_decision = 'APPROVE'
        AND review_idempotency_key IS NOT NULL
        AND review_request_hash ~ '^[0-9a-f]{64}$'
        AND reconciliation_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX uq_inventory_cycle_count_review_idempotency
  ON inventory_cycle_count_proposals (tenant_id, factory_id, review_idempotency_key)
  WHERE review_idempotency_key IS NOT NULL;

CREATE INDEX idx_inventory_cycle_count_factory_status_created
  ON inventory_cycle_count_proposals
  (tenant_id, factory_id, status, created_at DESC, id DESC);

CREATE INDEX idx_inventory_cycle_count_item_created
  ON inventory_cycle_count_proposals
  (tenant_id, factory_id, item_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_cycle_count_proposal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory_cycle_count_proposals are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
    OR NEW.item_id IS DISTINCT FROM OLD.item_id
    OR NEW.counted_quantity IS DISTINCT FROM OLD.counted_quantity
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.notes IS DISTINCT FROM OLD.notes
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'cycle-count proposal facts cannot be edited'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'PENDING_REVIEW' THEN
    RAISE EXCEPTION 'cycle-count review decision is terminal'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status NOT IN ('REJECTED', 'APPLIED')
    OR NEW.reviewed_by_user_id IS NULL
    OR NEW.reviewed_by_user_id = NEW.created_by_user_id
    OR NEW.reviewed_at IS NULL
    OR NEW.review_decision NOT IN ('APPROVE', 'REJECT')
    OR NEW.review_idempotency_key IS NULL
    OR NEW.review_request_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid cycle-count review transition or separation-of-duties violation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'REJECTED' AND (
    NEW.review_decision <> 'REJECT'
    OR NEW.reconciliation_id IS NOT NULL
    OR length(btrim(COALESCE(NEW.review_note, ''))) = 0
  ) THEN
    RAISE EXCEPTION 'rejected cycle counts require a reason and no stock reconciliation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'APPLIED' AND (
    NEW.review_decision <> 'APPROVE'
    OR NEW.reconciliation_id IS NULL
  ) THEN
    RAISE EXCEPTION 'approved cycle counts require the atomic stock reconciliation'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_cycle_count_proposals_guard
BEFORE UPDATE OR DELETE ON inventory_cycle_count_proposals
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_inventory_cycle_count_proposal();

ALTER TABLE inventory_cycle_count_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_cycle_count_proposals FORCE ROW LEVEL SECURITY;

CREATE POLICY inventory_cycle_count_proposals_tenant_isolation
ON inventory_cycle_count_proposals
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMENT ON TABLE inventory_cycle_count_proposals IS
  'Immutable physical cycle-count proposal with reviewer separation of duties. Count and stock adjustment are distinct; approval and the resulting reconciliation are committed in one transaction.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('062_inventory_cycle_count_approval', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;

  THEN
    RAISE EXCEPTION 'invalid cycle-count review transition or separation-of-duties violation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'REJECTED' AND (
    NEW.review_decision <> 'REJECT'
    OR NEW.reconciliation_id IS NOT NULL
    OR length(btrim(COALESCE(NEW.review_note, ''))) = 0
  ) THEN
    RAISE EXCEPTION 'rejected cycle counts require a reason and no stock reconciliation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'APPLIED' AND (
    NEW.review_decision <> 'APPROVE'
    OR NEW.reconciliation_id IS NULL
  ) THEN
    RAISE EXCEPTION 'approved cycle counts require the atomic stock reconciliation'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_cycle_count_proposals_guard
BEFORE UPDATE OR DELETE ON inventory_cycle_count_proposals
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_inventory_cycle_count_proposal();

ALTER TABLE inventory_cycle_count_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_cycle_count_proposals FORCE ROW LEVEL SECURITY;

CREATE POLICY inventory_cycle_count_proposals_tenant_isolation
ON inventory_cycle_count_proposals
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMENT ON TABLE inventory_cycle_count_proposals IS
  'Immutable physical cycle-count proposal with reviewer separation of duties. Count and stock adjustment are distinct; approval and the resulting reconciliation are committed in one transaction.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('062_inventory_cycle_count_approval', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;

        AND length(btrim(COALESCE(review_note, ''))) > 0
        AND reconciliation_id IS NULL)
      OR
      (status = 'APPLIED'
        AND reviewed_by_user_id IS NOT NULL
        AND reviewed_at IS NOT NULL
        AND review_decision = 'APPROVE'
        AND review_idempotency_key IS NOT NULL
        AND review_request_hash ~ '^[0-9a-f]{64}$'
        AND reconciliation_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX uq_inventory_cycle_count_review_idempotency
  ON inventory_cycle_count_proposals (tenant_id, factory_id, review_idempotency_key)
  WHERE review_idempotency_key IS NOT NULL;

CREATE INDEX idx_inventory_cycle_count_factory_status_created
  ON inventory_cycle_count_proposals
  (tenant_id, factory_id, status, created_at DESC, id DESC);

CREATE INDEX idx_inventory_cycle_count_item_created
  ON inventory_cycle_count_proposals
  (tenant_id, factory_id, item_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_inventory_cycle_count_proposal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory_cycle_count_proposals are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
    OR NEW.item_id IS DISTINCT FROM OLD.item_id
    OR NEW.counted_quantity IS DISTINCT FROM OLD.counted_quantity
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.notes IS DISTINCT FROM OLD.notes
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'cycle-count proposal facts cannot be edited'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'PENDING_REVIEW' THEN
    RAISE EXCEPTION 'cycle-count review decision is terminal'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status NOT IN ('REJECTED', 'APPLIED')
    OR NEW.reviewed_by_user_id IS NULL
    OR NEW.reviewed_by_user_id = NEW.created_by_user_id
    OR NEW.reviewed_at IS NULL
    OR NEW.review_decision NOT IN ('APPROVE', 'REJECT')
    OR NEW.review_idempotency_key IS NULL
    OR NEW.review_request_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid cycle-count review transition or separation-of-duties violation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'REJECTED' AND (
    NEW.review_decision <> 'REJECT'
    OR NEW.reconciliation_id IS NOT NULL
    OR length(btrim(COALESCE(NEW.review_note, ''))) = 0
  ) THEN
    RAISE EXCEPTION 'rejected cycle counts require a reason and no stock reconciliation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'APPLIED' AND (
    NEW.review_decision <> 'APPROVE'
    OR NEW.reconciliation_id IS NULL
  ) THEN
    RAISE EXCEPTION 'approved cycle counts require the atomic stock reconciliation'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_cycle_count_proposals_guard
BEFORE UPDATE OR DELETE ON inventory_cycle_count_proposals
FOR EACH ROW
EXECUTE FUNCTION factoryos_guard_inventory_cycle_count_proposal();

ALTER TABLE inventory_cycle_count_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_cycle_count_proposals FORCE ROW LEVEL SECURITY;

CREATE POLICY inventory_cycle_count_proposals_tenant_isolation
ON inventory_cycle_count_proposals
USING (tenant_id = factoryos_current_tenant_id())
WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMENT ON TABLE inventory_cycle_count_proposals IS
  'Immutable physical cycle-count proposal with reviewer separation of duties. Count and stock adjustment are distinct; approval and the resulting reconciliation are committed in one transaction.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('062_inventory_cycle_count_approval', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
