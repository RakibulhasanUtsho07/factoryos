BEGIN;

-- Energy/utility slice: metering hierarchy, source-to-cost mapping, append-only
-- readings and auditable utility events. All quantities are stored in the meter's
-- declared unit after applying the configured multiplier.

INSERT INTO permissions (code, description) VALUES
  ('utilities.meters.read', 'Read utility meter hierarchy and source-to-cost mapping in an authorized factory'),
  ('utilities.meters.manage', 'Register and maintain utility meters and cost mapping'),
  ('utilities.readings.read', 'Read utility readings, consumption, cost and normalized intensity'),
  ('utilities.readings.capture', 'Capture idempotent utility readings from manual, API or connected sources'),
  ('utilities.events.read', 'Read utility outage, leak, pressure and energy events'),
  ('utilities.events.manage', 'Record and transition utility events with resolution evidence')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code LIKE 'utilities.%'
WHERE r.code IN ('ORG_ADMIN','FACTORY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE utility_meters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  parent_meter_id UUID,
  meter_code VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  utility_type VARCHAR(24) NOT NULL,
  reading_mode VARCHAR(16) NOT NULL,
  unit_code VARCHAR(24) NOT NULL,
  multiplier_factor NUMERIC(18,8) NOT NULL DEFAULT 1,
  unit_cost NUMERIC(18,8) NOT NULL DEFAULT 0,
  currency_code CHAR(3) NOT NULL DEFAULT 'BDT',
  cost_center_code VARCHAR(100),
  source_system_code VARCHAR(100),
  location VARCHAR(255),
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_utility_meter_scope UNIQUE (id,tenant_id,factory_id),
  CONSTRAINT uq_utility_meter_idempotency UNIQUE (tenant_id,factory_id,idempotency_key),
  CONSTRAINT fk_utility_meter_factory FOREIGN KEY (factory_id,tenant_id)
    REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_utility_meter_parent FOREIGN KEY (parent_meter_id,tenant_id,factory_id)
    REFERENCES utility_meters(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_utility_meter_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_utility_meter_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_utility_meter_code CHECK (length(btrim(meter_code)) BETWEEN 1 AND 100),
  CONSTRAINT chk_utility_meter_name CHECK (length(btrim(name)) BETWEEN 1 AND 255),
  CONSTRAINT chk_utility_meter_utility CHECK (utility_type IN ('ELECTRICITY','GAS','STEAM','WATER','COMPRESSED_AIR','FUEL','OTHER')),
  CONSTRAINT chk_utility_meter_mode CHECK (reading_mode IN ('CUMULATIVE','INTERVAL')),
  CONSTRAINT chk_utility_meter_unit CHECK (length(btrim(unit_code)) BETWEEN 1 AND 24),
  CONSTRAINT chk_utility_meter_multiplier CHECK (multiplier_factor > 0),
  CONSTRAINT chk_utility_meter_cost CHECK (unit_cost >= 0),
  CONSTRAINT chk_utility_meter_currency CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_utility_meter_status CHECK (status IN ('ACTIVE','INACTIVE','RETIRED')),
  CONSTRAINT chk_utility_meter_parent CHECK (parent_meter_id IS NULL OR parent_meter_id <> id),
  CONSTRAINT chk_utility_meter_version CHECK (row_version > 0),
  CONSTRAINT chk_utility_meter_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX uq_utility_meter_code
  ON utility_meters(tenant_id,factory_id,lower(meter_code));
CREATE INDEX idx_utility_meter_hierarchy
  ON utility_meters(tenant_id,factory_id,parent_meter_id,status);
CREATE INDEX idx_utility_meter_type
  ON utility_meters(tenant_id,factory_id,utility_type,status,meter_code);

CREATE TABLE utility_meter_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  meter_id UUID NOT NULL,
  reading_at TIMESTAMPTZ NOT NULL,
  reading_value NUMERIC(24,8) NOT NULL,
  previous_reading_value NUMERIC(24,8),
  consumption_quantity NUMERIC(24,8) NOT NULL,
  unit_code VARCHAR(24) NOT NULL,
  unit_cost_snapshot NUMERIC(18,8) NOT NULL,
  cost_amount NUMERIC(24,8) NOT NULL,
  production_quantity NUMERIC(24,8),
  intensity_per_unit NUMERIC(24,8) GENERATED ALWAYS AS (
    CASE WHEN production_quantity > 0 THEN consumption_quantity / production_quantity ELSE NULL END
  ) STORED,
  source_type VARCHAR(16) NOT NULL DEFAULT 'MANUAL',
  source_event_id VARCHAR(255),
  notes TEXT,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  recorded_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  request_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_utility_reading_scope UNIQUE (id,tenant_id,factory_id),
  CONSTRAINT uq_utility_reading_idempotency UNIQUE (tenant_id,factory_id,idempotency_key),
  CONSTRAINT fk_utility_reading_meter FOREIGN KEY (meter_id,tenant_id,factory_id)
    REFERENCES utility_meters(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_utility_reading_recorder FOREIGN KEY (recorded_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_utility_reading_value CHECK (reading_value >= 0),
  CONSTRAINT chk_utility_reading_previous CHECK (previous_reading_value IS NULL OR previous_reading_value >= 0),
  CONSTRAINT chk_utility_reading_consumption CHECK (consumption_quantity >= 0),
  CONSTRAINT chk_utility_reading_cost CHECK (unit_cost_snapshot >= 0 AND cost_amount >= 0),
  CONSTRAINT chk_utility_reading_production CHECK (production_quantity IS NULL OR production_quantity > 0),
  CONSTRAINT chk_utility_reading_source CHECK (source_type IN ('MANUAL','API','METER_GATEWAY','IMPORT')),
  CONSTRAINT chk_utility_reading_source_event CHECK (source_event_id IS NULL OR length(btrim(source_event_id)) BETWEEN 1 AND 255),
  CONSTRAINT chk_utility_reading_unit CHECK (length(btrim(unit_code)) BETWEEN 1 AND 24),
  CONSTRAINT chk_utility_reading_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX uq_utility_reading_source_event
  ON utility_meter_readings(tenant_id,factory_id,source_type,source_event_id)
  WHERE source_event_id IS NOT NULL;
CREATE INDEX idx_utility_reading_meter_time
  ON utility_meter_readings(tenant_id,factory_id,meter_id,reading_at DESC,id DESC);

CREATE TABLE utility_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  meter_id UUID,
  event_number VARCHAR(100) NOT NULL,
  event_type VARCHAR(24) NOT NULL,
  severity VARCHAR(12) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  impact_minutes INTEGER NOT NULL DEFAULT 0,
  impact_quantity NUMERIC(24,8),
  cause TEXT,
  resolution TEXT,
  last_change_reason TEXT,
  row_version BIGINT NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_utility_event_scope UNIQUE (id,tenant_id,factory_id),
  CONSTRAINT uq_utility_event_number UNIQUE (tenant_id,factory_id,event_number),
  CONSTRAINT uq_utility_event_idempotency UNIQUE (tenant_id,factory_id,idempotency_key),
  CONSTRAINT fk_utility_event_meter FOREIGN KEY (meter_id,tenant_id,factory_id)
    REFERENCES utility_meters(id,tenant_id,factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_utility_event_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_utility_event_updater FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_utility_event_type CHECK (event_type IN ('OUTAGE','PEAK_LOAD','LEAK','PRESSURE_DROP','METER_FAULT','EFFICIENCY_EXCEPTION','OTHER')),
  CONSTRAINT chk_utility_event_severity CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  CONSTRAINT chk_utility_event_status CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED','CANCELLED')),
  CONSTRAINT chk_utility_event_title CHECK (length(btrim(title)) BETWEEN 1 AND 255),
  CONSTRAINT chk_utility_event_description CHECK (length(btrim(description)) > 0),
  CONSTRAINT chk_utility_event_impact CHECK (impact_minutes >= 0 AND (impact_quantity IS NULL OR impact_quantity >= 0)),
  CONSTRAINT chk_utility_event_resolution CHECK (
    (status='RESOLVED' AND resolved_at IS NOT NULL AND length(btrim(COALESCE(resolution,'')))>0)
    OR (status<>'RESOLVED' AND resolved_at IS NULL)
  ),
  CONSTRAINT chk_utility_event_version CHECK (row_version > 0),
  CONSTRAINT chk_utility_event_hash CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_utility_event_queue
  ON utility_events(tenant_id,factory_id,status,severity,occurred_at DESC);

CREATE TABLE utility_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  factory_id UUID NOT NULL,
  entity_type VARCHAR(24) NOT NULL,
  entity_id UUID NOT NULL,
  entity_version BIGINT NOT NULL,
  action VARCHAR(48) NOT NULL,
  actor_user_id UUID NOT NULL,
  reason TEXT,
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_utility_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_utility_audit_entity CHECK (entity_type IN ('METER','READING','UTILITY_EVENT')),
  CONSTRAINT chk_utility_audit_version CHECK (entity_version > 0),
  CONSTRAINT chk_utility_audit_data CHECK (jsonb_typeof(event_data)='object')
);
CREATE INDEX idx_utility_audit_entity
  ON utility_audit_events(tenant_id,factory_id,entity_type,entity_id,created_at DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['utility_meters','utility_meter_readings','utility_events','utility_audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id())',
      t||'_tenant_isolation',t);
  END LOOP;
END;
$$;

INSERT INTO schema_migrations(version,checksum)
VALUES ('108_energy_utility_events',NULL)
ON CONFLICT(version) DO NOTHING;
COMMIT;
