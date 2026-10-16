BEGIN;

-- WP02: factory-scoped warehouse locations, bins and location-to-location transfer evidence.
CREATE TABLE inventory_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  parent_location_id UUID,
  location_code VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  location_type VARCHAR(20) NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_inventory_location_id_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT fk_inventory_location_factory_tenant
    FOREIGN KEY (factory_id, tenant_id) REFERENCES factories (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_location_parent_scope
    FOREIGN KEY (parent_location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_location_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_location_code CHECK (length(btrim(location_code)) > 0),
  CONSTRAINT chk_inventory_location_name CHECK (length(btrim(name)) > 0),
  CONSTRAINT chk_inventory_location_type CHECK (location_type IN ('WAREHOUSE', 'BIN', 'STAGING', 'VIRTUAL')),
  CONSTRAINT chk_inventory_location_status CHECK (status IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT chk_inventory_location_default CHECK (
    (is_default = TRUE AND location_type = 'VIRTUAL' AND parent_location_id IS NULL)
    OR (is_default = FALSE AND location_type <> 'VIRTUAL')
  ),
  CONSTRAINT chk_inventory_location_not_self_parent CHECK (parent_location_id IS NULL OR parent_location_id <> id)
);

CREATE UNIQUE INDEX uq_inventory_location_factory_code
  ON inventory_locations (tenant_id, factory_id, lower(location_code));
CREATE UNIQUE INDEX uq_inventory_location_default_factory
  ON inventory_locations (tenant_id, factory_id) WHERE is_default = TRUE;
CREATE INDEX idx_inventory_location_factory_status
  ON inventory_locations (tenant_id, factory_id, status, location_type, location_code);
CREATE INDEX idx_inventory_location_parent
  ON inventory_locations (tenant_id, factory_id, parent_location_id)
  WHERE parent_location_id IS NOT NULL;

-- Every factory receives an immutable virtual location for legacy/global stock adjustments.
INSERT INTO inventory_locations (
  tenant_id, factory_id, location_code, name, location_type, is_default
)
SELECT f.tenant_id, f.id, 'UNASSIGNED', 'Unassigned stock', 'VIRTUAL', TRUE
FROM factories f
WHERE NOT EXISTS (
  SELECT 1 FROM inventory_locations l
  WHERE l.tenant_id = f.tenant_id AND l.factory_id = f.id AND l.is_default = TRUE
);

CREATE TABLE inventory_location_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  location_id UUID NOT NULL,
  quantity_on_hand NUMERIC(18, 4) NOT NULL DEFAULT 0,
  version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_inventory_location_balance_item_location
    UNIQUE (tenant_id, factory_id, item_id, location_id),
  CONSTRAINT fk_inventory_location_balance_item_scope
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_location_balance_location_scope
    FOREIGN KEY (location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_location_balance_nonnegative CHECK (quantity_on_hand >= 0),
  CONSTRAINT chk_inventory_location_balance_version CHECK (version > 0)
);

CREATE INDEX idx_inventory_location_balance_item
  ON inventory_location_balances (tenant_id, factory_id, item_id, location_id);
CREATE INDEX idx_inventory_location_balance_location
  ON inventory_location_balances (tenant_id, factory_id, location_id, item_id);

-- Backfill existing aggregate stock to the default location before installing sync triggers.
INSERT INTO inventory_location_balances (
  tenant_id, factory_id, item_id, location_id, quantity_on_hand
)
SELECT b.tenant_id, b.factory_id, b.item_id, l.id, b.quantity_on_hand
FROM inventory_stock_balances b
JOIN inventory_locations l
  ON l.tenant_id = b.tenant_id
 AND l.factory_id = b.factory_id
 AND l.is_default = TRUE
ON CONFLICT (tenant_id, factory_id, item_id, location_id)
DO UPDATE SET quantity_on_hand = EXCLUDED.quantity_on_hand,
              version = inventory_location_balances.version + 1,
              updated_at = clock_timestamp();

ALTER TABLE inventory_movements
  ADD COLUMN location_id UUID;

ALTER TABLE inventory_movements
  ADD CONSTRAINT fk_inventory_movement_location_scope
  FOREIGN KEY (location_id, tenant_id, factory_id)
  REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT;

CREATE INDEX idx_inventory_movement_location_created
  ON inventory_movements (tenant_id, factory_id, location_id, created_at DESC, id DESC)
  WHERE location_id IS NOT NULL;

CREATE TABLE inventory_location_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  item_id UUID NOT NULL,
  source_location_id UUID NOT NULL,
  destination_location_id UUID NOT NULL,
  quantity NUMERIC(18, 4) NOT NULL,
  source_quantity_before NUMERIC(18, 4) NOT NULL,
  source_quantity_after NUMERIC(18, 4) NOT NULL,
  destination_quantity_before NUMERIC(18, 4) NOT NULL,
  destination_quantity_after NUMERIC(18, 4) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  notes TEXT,
  created_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_inventory_location_transfer_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_inventory_location_transfer_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_inventory_location_transfer_item
    FOREIGN KEY (item_id, tenant_id, factory_id)
    REFERENCES inventory_items (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_location_transfer_source
    FOREIGN KEY (source_location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_location_transfer_destination
    FOREIGN KEY (destination_location_id, tenant_id, factory_id)
    REFERENCES inventory_locations (id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_location_transfer_actor
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_location_transfer_quantity CHECK (quantity > 0),
  CONSTRAINT chk_inventory_location_transfer_source_before CHECK (source_quantity_before >= quantity),
  CONSTRAINT chk_inventory_location_transfer_source_after CHECK (source_quantity_after >= 0),
  CONSTRAINT chk_inventory_location_transfer_destination_before CHECK (destination_quantity_before >= 0),
  CONSTRAINT chk_inventory_location_transfer_key CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT chk_inventory_location_transfer_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_inventory_location_transfer_distinct_locations CHECK (source_location_id <> destination_location_id),
  CONSTRAINT chk_inventory_location_transfer_source_delta CHECK (
    source_quantity_after = source_quantity_before - quantity
  ),
  CONSTRAINT chk_inventory_location_transfer_destination_delta CHECK (
    destination_quantity_after = destination_quantity_before + quantity
  )
);

CREATE INDEX idx_inventory_location_transfer_item_created
  ON inventory_location_transfers (tenant_id, factory_id, item_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION factoryos_validate_inventory_location_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_parent_type VARCHAR(20);
  v_parent_status VARCHAR(20);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_default THEN
      RAISE EXCEPTION 'default inventory location cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.is_default THEN
    IF TG_OP = 'UPDATE' AND (
      NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
      OR NEW.location_code IS DISTINCT FROM OLD.location_code
      OR NEW.location_type IS DISTINCT FROM OLD.location_type
      OR NEW.is_default IS DISTINCT FROM OLD.is_default
      OR NEW.parent_location_id IS DISTINCT FROM OLD.parent_location_id
    ) THEN
      RAISE EXCEPTION 'default inventory location identity is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'default inventory location cannot be disabled'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.location_type = 'BIN' AND NEW.parent_location_id IS NULL THEN
    RAISE EXCEPTION 'bin locations must have a parent warehouse or staging location'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.parent_location_id IS NOT NULL THEN
    SELECT p.location_type, p.status
      INTO v_parent_type, v_parent_status
    FROM inventory_locations p
    WHERE p.id = NEW.parent_location_id
      AND p.tenant_id = NEW.tenant_id
      AND p.factory_id = NEW.factory_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'parent location must exist in the same tenant and factory'
        USING ERRCODE = '23503';
    END IF;
    IF v_parent_type NOT IN ('WAREHOUSE', 'STAGING') OR v_parent_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'parent location must be an active warehouse or staging location'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_locations_parent_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory_locations
FOR EACH ROW
EXECUTE FUNCTION factoryos_validate_inventory_location_parent();

-- Factories created after this migration receive the same default bucket as existing factories.
CREATE OR REPLACE FUNCTION factoryos_seed_default_inventory_location()
RETURNS trigger
LANGUAGE plpgsql
AS $
BEGIN
  INSERT INTO inventory_locations (
    tenant_id, factory_id, location_code, name, location_type, is_default
  )
  VALUES (NEW.tenant_id, NEW.id, 'UNASSIGNED', 'Unassigned stock', 'VIRTUAL', TRUE)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$;

CREATE TRIGGER factories_seed_default_inventory_location
AFTER INSERT ON factories
FOR EACH ROW
EXECUTE FUNCTION factoryos_seed_default_inventory_location();

CREATE OR REPLACE FUNCTION factoryos_sync_inventory_location_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_delta NUMERIC(18, 4);
  v_default_location_id UUID;
  v_requested_location_id UUID;
  v_remaining NUMERIC(18, 4);
  v_take NUMERIC(18, 4);
  v_balance RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_delta := NEW.quantity_on_hand;
  ELSE
    v_delta := NEW.quantity_on_hand - OLD.quantity_on_hand;
  END IF;

  IF v_delta = 0 THEN
    RETURN NEW;
  END IF;

  SELECT l.id INTO v_default_location_id
  FROM inventory_locations l
  WHERE l.tenant_id = NEW.tenant_id
    AND l.factory_id = NEW.factory_id
    AND l.is_default = TRUE
    AND l.status = 'ACTIVE';

  IF v_default_location_id IS NULL THEN
    RAISE EXCEPTION 'default inventory location is missing for this factory'
      USING ERRCODE = '23514';
  END IF;

  v_requested_location_id := NULLIF(current_setting('app.inventory_location_id', TRUE), '')::UUID;

  IF v_requested_location_id IS NOT NULL THEN
    IF v_delta > 0 THEN
      INSERT INTO inventory_location_balances (
        tenant_id, factory_id, item_id, location_id, quantity_on_hand
      )
      VALUES (
        NEW.tenant_id, NEW.factory_id, NEW.item_id, v_requested_location_id, v_delta
      )
      ON CONFLICT (tenant_id, factory_id, item_id, location_id)
      DO UPDATE SET
        quantity_on_hand = inventory_location_balances.quantity_on_hand + EXCLUDED.quantity_on_hand,
        version = inventory_location_balances.version + 1,
        updated_at = clock_timestamp();
    ELSE
      UPDATE inventory_location_balances
      SET quantity_on_hand = quantity_on_hand + v_delta,
          version = version + 1,
          updated_at = clock_timestamp()
      WHERE tenant_id = NEW.tenant_id
        AND factory_id = NEW.factory_id
        AND item_id = NEW.item_id
        AND location_id = v_requested_location_id
        AND quantity_on_hand + v_delta >= 0;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'insufficient stock at the selected inventory location'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF v_delta > 0 THEN
    INSERT INTO inventory_location_balances (
      tenant_id, factory_id, item_id, location_id, quantity_on_hand
    )
    VALUES (
      NEW.tenant_id, NEW.factory_id, NEW.item_id, v_default_location_id, v_delta
    )
    ON CONFLICT (tenant_id, factory_id, item_id, location_id)
    DO UPDATE SET
      quantity_on_hand = inventory_location_balances.quantity_on_hand + EXCLUDED.quantity_on_hand,
      version = inventory_location_balances.version + 1,
      updated_at = clock_timestamp();
    RETURN NEW;
  END IF;

  -- Legacy aggregate-only issues have no bin pick. Drain available bin stock
  -- deterministically so that the location totals continue to equal on-hand.
  v_remaining := -v_delta;
  FOR v_balance IN
    SELECT lb.location_id, lb.quantity_on_hand
    FROM inventory_location_balances lb
    WHERE lb.tenant_id = NEW.tenant_id
      AND lb.factory_id = NEW.factory_id
      AND lb.item_id = NEW.item_id
    ORDER BY lb.location_id
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining = 0;
    v_take := LEAST(v_balance.quantity_on_hand, v_remaining);
    IF v_take > 0 THEN
      UPDATE inventory_location_balances
      SET quantity_on_hand = quantity_on_hand - v_take,
          version = version + 1,
          updated_at = clock_timestamp()
      WHERE tenant_id = NEW.tenant_id
        AND factory_id = NEW.factory_id
        AND item_id = NEW.item_id
        AND location_id = v_balance.location_id;
      v_remaining := v_remaining - v_take;
    END IF;
  END LOOP;

  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'location stock totals are lower than the aggregate stock adjustment'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_stock_balance_location_sync
AFTER INSERT OR UPDATE OF quantity_on_hand ON inventory_stock_balances
FOR EACH ROW
EXECUTE FUNCTION factoryos_sync_inventory_location_balance();

CREATE OR REPLACE FUNCTION factoryos_prevent_inventory_location_transfer_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'inventory_location_transfers are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER inventory_location_transfers_immutable
BEFORE UPDATE OR DELETE ON inventory_location_transfers
FOR EACH ROW
EXECUTE FUNCTION factoryos_prevent_inventory_location_transfer_mutation();

ALTER TABLE inventory_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_locations FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_locations_tenant_isolation ON inventory_locations
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE inventory_location_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_location_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_location_balances_tenant_isolation ON inventory_location_balances
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE inventory_location_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_location_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_location_transfers_tenant_isolation ON inventory_location_transfers
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

COMMENT ON TABLE inventory_locations IS
  'Factory-scoped warehouses, bins and staging locations plus an immutable identity for the default unassigned-stock bucket.';
COMMENT ON TABLE inventory_location_balances IS
  'Per-item per-location on-hand quantities; database sync triggers keep the sum aligned with aggregate inventory_stock_balances.';
COMMENT ON TABLE inventory_location_transfers IS
  'Immutable, idempotent transfers between storage locations that preserve the item aggregate on-hand balance.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('064_inventory_storage_locations', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
