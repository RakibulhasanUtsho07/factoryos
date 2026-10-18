BEGIN;

-- FR-UFM-18: factory-scoped asset registry and versioned preventive-maintenance plans.
INSERT INTO permissions (code, description) VALUES
  ('maintenance.assets.read', 'Read the asset registry and hierarchy in the authorized factory'),
  ('maintenance.assets.manage', 'Create and maintain the factory asset registry'),
  ('maintenance.pm.read', 'Read preventive-maintenance plans and schedules'),
  ('maintenance.pm.manage', 'Create, approve, pause and retire preventive-maintenance plans'),
  ('maintenance.workorders.read', 'Read maintenance and breakdown work orders'),
  ('maintenance.workorders.manage', 'Create and plan maintenance work orders'),
  ('maintenance.workorders.execute', 'Execute tasks and complete maintenance work orders'),
  ('maintenance.parts.manage', 'Plan and issue maintenance spare parts through the inventory ledger')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code LIKE 'maintenance.%'
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE maintenance_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  parent_asset_id UUID,
  asset_code VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  asset_type VARCHAR(80) NOT NULL,
  manufacturer VARCHAR(160),
  model VARCHAR(160),
  serial_number VARCHAR(160),
  criticality VARCHAR(16) NOT NULL DEFAULT 'MEDIUM',
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  location VARCHAR(255),
  commissioned_on DATE,
  warranty_expires_on DATE,
  notes TEXT,
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_maintenance_asset_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_maintenance_asset_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_maintenance_asset_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_asset_factory FOREIGN KEY (factory_id, tenant_id)
    REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_asset_parent FOREIGN KEY (parent_asset_id, tenant_id, factory_id)
    REFERENCES maintenance_assets(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_asset_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_asset_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_maintenance_asset_code CHECK (length(btrim(asset_code)) BETWEEN 1 AND 100),
  CONSTRAINT chk_maintenance_asset_name CHECK (length(btrim(name)) BETWEEN 1 AND 255),
  CONSTRAINT chk_maintenance_asset_type CHECK (length(btrim(asset_type)) BETWEEN 1 AND 80),
  CONSTRAINT chk_maintenance_asset_criticality CHECK (criticality IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  CONSTRAINT chk_maintenance_asset_status CHECK (status IN ('ACTIVE','INACTIVE','RETIRED')),
  CONSTRAINT chk_maintenance_asset_not_self_parent CHECK (parent_asset_id IS NULL OR parent_asset_id <> id),
  CONSTRAINT chk_maintenance_asset_date_order CHECK (
    warranty_expires_on IS NULL OR commissioned_on IS NULL OR warranty_expires_on >= commissioned_on
  ),
  CONSTRAINT chk_maintenance_asset_version CHECK (row_version > 0),
  CONSTRAINT chk_maintenance_asset_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX uq_maintenance_asset_factory_code
  ON maintenance_assets (tenant_id, factory_id, lower(asset_code));
CREATE INDEX idx_maintenance_assets_parent
  ON maintenance_assets (tenant_id, factory_id, parent_asset_id, status);
CREATE INDEX idx_maintenance_assets_queue
  ON maintenance_assets (tenant_id, factory_id, status, criticality, asset_code);

CREATE OR REPLACE FUNCTION factoryos_guard_maintenance_asset_hierarchy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_parent UUID;
  v_seen UUID[] := ARRAY[]::UUID[];
BEGIN
  IF NEW.parent_asset_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_asset_id = NEW.id THEN
    RAISE EXCEPTION 'An asset cannot be its own parent' USING ERRCODE = '23514';
  END IF;

  v_parent := NEW.parent_asset_id;
  WHILE v_parent IS NOT NULL LOOP
    IF v_parent = NEW.id OR v_parent = ANY(v_seen) THEN
      RAISE EXCEPTION 'Asset hierarchy cannot contain a cycle' USING ERRCODE = '23514';
    END IF;
    v_seen := array_append(v_seen, v_parent);
    SELECT a.parent_asset_id INTO v_parent
    FROM maintenance_assets a
    WHERE a.id = v_parent AND a.tenant_id = NEW.tenant_id AND a.factory_id = NEW.factory_id;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_maintenance_asset_hierarchy_guard
BEFORE INSERT OR UPDATE OF parent_asset_id ON maintenance_assets
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_maintenance_asset_hierarchy();

CREATE TABLE maintenance_pm_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  asset_id UUID NOT NULL,
  plan_code VARCHAR(100) NOT NULL,
  revision INTEGER NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  interval_value INTEGER NOT NULL,
  interval_unit VARCHAR(8) NOT NULL,
  next_due_on DATE NOT NULL,
  estimated_duration_minutes INTEGER NOT NULL DEFAULT 60,
  requires_shutdown BOOLEAN NOT NULL DEFAULT FALSE,
  checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  approved_by_user_id UUID,
  approved_at TIMESTAMPTZ,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_maintenance_pm_plan_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_maintenance_pm_plan_revision UNIQUE (tenant_id, factory_id, asset_id, plan_code, revision),
  CONSTRAINT uq_maintenance_pm_plan_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_maintenance_pm_asset FOREIGN KEY (asset_id, tenant_id, factory_id)
    REFERENCES maintenance_assets(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_pm_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_pm_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_maintenance_pm_approver FOREIGN KEY (approved_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_maintenance_pm_revision CHECK (revision > 0),
  CONSTRAINT chk_maintenance_pm_interval CHECK (interval_value > 0 AND interval_unit IN ('DAY','WEEK','MONTH')),
  CONSTRAINT chk_maintenance_pm_duration CHECK (estimated_duration_minutes BETWEEN 1 AND 100000),
  CONSTRAINT chk_maintenance_pm_status CHECK (status IN ('DRAFT','ACTIVE','PAUSED','RETIRED')),
  CONSTRAINT chk_maintenance_pm_checklist CHECK (jsonb_typeof(checklist) = 'array'),
  CONSTRAINT chk_maintenance_pm_version CHECK (row_version > 0),
  CONSTRAINT chk_maintenance_pm_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_maintenance_pm_independent_approval CHECK (approved_by_user_id IS NULL OR approved_by_user_id <> created_by_user_id)
);

CREATE UNIQUE INDEX uq_maintenance_pm_active_revision
  ON maintenance_pm_plans (tenant_id, factory_id, asset_id, lower(plan_code))
  WHERE status = 'ACTIVE';
CREATE INDEX idx_maintenance_pm_due
  ON maintenance_pm_plans (tenant_id, factory_id, status, next_due_on, asset_id);

ALTER TABLE maintenance_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_assets_tenant_isolation ON maintenance_assets
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

ALTER TABLE maintenance_pm_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_pm_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance_pm_plans_tenant_isolation ON maintenance_pm_plans
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION factoryos_prevent_maintenance_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Maintenance audit events are append-only' USING ERRCODE = '55000';
END;
$$;

INSERT INTO schema_migrations(version, checksum)
VALUES ('099_maintenance_assets_and_pm_plans', NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
