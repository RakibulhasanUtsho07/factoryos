BEGIN;

-- WP07-A / SRS v2.1 FR-MNT-01
-- Machine register and auditable downtime logging.
-- The machine status is lifecycle state; active downtime is derived from an
-- open machine_downtime_events row and is not inferred from a model.

INSERT INTO permissions (code, description)
VALUES
  ('maintenance.machines.read', 'Read the machine register in the authorized factory scope'),
  ('maintenance.machines.write', 'Create machine register entries in the authorized factory scope'),
  ('maintenance.downtime.read', 'Read machine downtime events in the authorized factory scope'),
  ('maintenance.downtime.write', 'Log and close machine downtime events in the authorized factory scope')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE (
  (r.code = 'ORG_ADMIN' AND r.is_system = true)
  OR (r.code = 'FACTORY_MANAGER' AND r.is_system = false)
)
AND p.code IN (
  'maintenance.machines.read',
  'maintenance.machines.write',
  'maintenance.downtime.read',
  'maintenance.downtime.write'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS maintenance_machines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  machine_code VARCHAR(100) NOT NULL,
  machine_type VARCHAR(100) NOT NULL,
  line_code VARCHAR(100) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  notes TEXT,
  created_by_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version BIGINT NOT NULL DEFAULT 1,

  CONSTRAINT uq_maintenance_machines_code
    UNIQUE (tenant_id, factory_id, machine_code),
  CONSTRAINT uq_maintenance_machines_scope
    UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT fk_maintenance_machines_factory_tenant
    FOREIGN KEY (factory_id, tenant_id)
    REFERENCES factories (id, tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_maintenance_machine_code_nonempty
    CHECK (LENGTH(BTRIM(machine_code)) > 0),
  CONSTRAINT chk_maintenance_machine_type_nonempty
    CHECK (LENGTH(BTRIM(machine_type)) > 0),
  CONSTRAINT chk_maintenance_machine_line_nonempty
    CHECK (LENGTH(BTRIM(line_code)) > 0),
  CONSTRAINT chk_maintenance_machine_status
    CHECK (status IN ('ACTIVE', 'INACTIVE', 'RETIRED'))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_machines_factory_status
  ON maintenance_machines (tenant_id, factory_id, status, machine_code);

ALTER TABLE maintenance_machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_machines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS maintenance_machines_tenant_isolation
  ON maintenance_machines;

CREATE POLICY maintenance_machines_tenant_isolation
  ON maintenance_machines
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

CREATE TABLE IF NOT EXISTS machine_downtime_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  machine_id UUID NOT NULL,
  reason_code VARCHAR(100) NOT NULL,
  description VARCHAR(1000),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  created_by_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  closed_by_user_id UUID REFERENCES users (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version BIGINT NOT NULL DEFAULT 1,

  CONSTRAINT fk_machine_downtime_machine_scope
    FOREIGN KEY (machine_id, tenant_id, factory_id)
    REFERENCES maintenance_machines (id, tenant_id, factory_id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_machine_downtime_reason_nonempty
    CHECK (LENGTH(BTRIM(reason_code)) > 0),
  CONSTRAINT chk_machine_downtime_time_order
    CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT chk_machine_downtime_closer
    CHECK (
      (ended_at IS NULL AND closed_by_user_id IS NULL)
      OR (ended_at IS NOT NULL AND closed_by_user_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_machine_downtime_factory_started
  ON machine_downtime_events (tenant_id, factory_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_machine_downtime_machine_started
  ON machine_downtime_events (tenant_id, factory_id, machine_id, started_at DESC);

-- A machine can have only one unclosed downtime event at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_machine_downtime_one_open_per_machine
  ON machine_downtime_events (tenant_id, factory_id, machine_id)
  WHERE ended_at IS NULL;

ALTER TABLE machine_downtime_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE machine_downtime_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS machine_downtime_events_tenant_isolation
  ON machine_downtime_events;

CREATE POLICY machine_downtime_events_tenant_isolation
  ON machine_downtime_events
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

INSERT INTO schema_migrations (version)
VALUES ('029_maintenance_machine_downtime')
ON CONFLICT (version) DO NOTHING;

COMMIT;
