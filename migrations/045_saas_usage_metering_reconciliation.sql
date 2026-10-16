BEGIN;
-- WP10-A: tenant-scoped immutable usage metering, effective-dated rates and invoice reconciliation.
INSERT INTO permissions(code,description) VALUES
 ('saas.usage.read','Read tenant usage reports and reconciliation history'),
 ('saas.usage.write','Record idempotent tenant usage events'),
 ('saas.rates.write','Create immutable effective-dated tenant usage rates'),
 ('saas.adjustments.write','Record auditable corrections to usage quantities and billed cost'),
 ('saas.reconciliation.write','Reconcile metered usage against an external invoice')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='ORG_ADMIN' AND r.is_system=true AND p.code IN
 ('saas.usage.read','saas.usage.write','saas.rates.write','saas.adjustments.write','saas.reconciliation.write')
ON CONFLICT(role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS saas_usage_rate_cards(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL,
 metric_code VARCHAR(40) NOT NULL,
 rate_version INTEGER NOT NULL,
 rate_minor_per_block BIGINT NOT NULL,
 block_quantity NUMERIC(24,6) NOT NULL,
 currency VARCHAR(3) NOT NULL,
 effective_from TIMESTAMPTZ NOT NULL,
 idempotency_key VARCHAR(128) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 created_by UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_saas_rate_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_rate_actor FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT uq_saas_rate_scope_id UNIQUE(id,tenant_id),
 CONSTRAINT chk_saas_rate_metric CHECK(metric_code IN('ACTIVE_USER','ROLE_ASSIGNMENT','TRANSACTION','STORAGE_BYTE_HOUR','TELEMETRY_EVENT','AI_INPUT_TOKEN','AI_OUTPUT_TOKEN','AI_TOOL_CALL','PREMIUM_WORKLOAD','INTEGRATION_CALL','EDGE_INFERENCE')),
 CONSTRAINT chk_saas_rate_version CHECK(rate_version BETWEEN 1 AND 1000000),
 CONSTRAINT chk_saas_rate_amount CHECK(rate_minor_per_block BETWEEN 0 AND 9000000000000000),
 CONSTRAINT chk_saas_rate_block CHECK(block_quantity > 0 AND block_quantity <= 1000000000000),
 CONSTRAINT chk_saas_rate_currency CHECK(currency ~ '^[A-Z]{3}$'),
 CONSTRAINT chk_saas_rate_key CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
 CONSTRAINT chk_saas_rate_hash CHECK(request_hash ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_rate_version ON saas_usage_rate_cards(tenant_id,metric_code,rate_version);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_rate_effective_time ON saas_usage_rate_cards(tenant_id,metric_code,effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_rate_idempotency ON saas_usage_rate_cards(tenant_id,idempotency_key);
CREATE INDEX IF NOT EXISTS idx_saas_rate_resolution ON saas_usage_rate_cards(tenant_id,metric_code,effective_from DESC);
ALTER TABLE saas_usage_rate_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_usage_rate_cards FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_usage_rate_cards_tenant_isolation ON saas_usage_rate_cards;
CREATE POLICY saas_usage_rate_cards_tenant_isolation ON saas_usage_rate_cards
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());

CREATE TABLE IF NOT EXISTS saas_usage_events(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL,
 factory_id UUID,
 metric_code VARCHAR(40) NOT NULL,
 capability_code VARCHAR(100) NOT NULL,
 workload_class VARCHAR(24) NOT NULL,
 quantity NUMERIC(24,6) NOT NULL,
 occurred_at TIMESTAMPTZ NOT NULL,
 source_system VARCHAR(24) NOT NULL,
 source_event_ref VARCHAR(255) NOT NULL,
 rate_card_id UUID,
 rate_version_snapshot INTEGER,
 rate_minor_per_block_snapshot BIGINT,
 rate_block_quantity_snapshot NUMERIC(24,6),
 currency VARCHAR(3),
 estimated_cost_minor BIGINT,
 request_hash VARCHAR(64) NOT NULL,
 idempotency_key VARCHAR(128) NOT NULL,
 recorded_by UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_saas_usage_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_usage_factory_scope FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_usage_rate_scope FOREIGN KEY(rate_card_id,tenant_id) REFERENCES saas_usage_rate_cards(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_usage_actor FOREIGN KEY(recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_saas_usage_metric CHECK(metric_code IN('ACTIVE_USER','ROLE_ASSIGNMENT','TRANSACTION','STORAGE_BYTE_HOUR','TELEMETRY_EVENT','AI_INPUT_TOKEN','AI_OUTPUT_TOKEN','AI_TOOL_CALL','PREMIUM_WORKLOAD','INTEGRATION_CALL','EDGE_INFERENCE')),
 CONSTRAINT chk_saas_usage_capability CHECK(capability_code ~ '^[a-z][a-z0-9._:-]{0,99}$'),
 CONSTRAINT chk_saas_usage_workload CHECK(workload_class IN('PRODUCTION','EVALUATION','RED_TEAM','SHADOW_MODE','DEVELOPMENT','NON_AI')),
 CONSTRAINT chk_saas_usage_quantity CHECK(quantity > 0 AND quantity <= 1000000000000),
 CONSTRAINT chk_saas_usage_source CHECK(source_system IN('API','AI_GATEWAY','TOOL_GATEWAY','TELEMETRY','CONNECTOR','EDGE_GATEWAY','MANUAL') AND LENGTH(BTRIM(source_event_ref)) BETWEEN 1 AND 255),
 CONSTRAINT chk_saas_usage_pricing CHECK(
   (rate_card_id IS NULL AND rate_version_snapshot IS NULL AND rate_minor_per_block_snapshot IS NULL AND rate_block_quantity_snapshot IS NULL AND currency IS NULL AND estimated_cost_minor IS NULL)
   OR
   (rate_card_id IS NOT NULL AND rate_version_snapshot IS NOT NULL AND rate_minor_per_block_snapshot IS NOT NULL AND rate_block_quantity_snapshot IS NOT NULL AND currency ~ '^[A-Z]{3}$' AND estimated_cost_minor >= 0)
 ),
 CONSTRAINT chk_saas_usage_hash CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT chk_saas_usage_idempotency CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_usage_idempotency ON saas_usage_events(tenant_id,idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_usage_source_event ON saas_usage_events(tenant_id,source_system,source_event_ref);
CREATE INDEX IF NOT EXISTS idx_saas_usage_period_metric ON saas_usage_events(tenant_id,occurred_at,metric_code);
CREATE INDEX IF NOT EXISTS idx_saas_usage_factory_period ON saas_usage_events(tenant_id,factory_id,occurred_at);
ALTER TABLE saas_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_usage_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_usage_events_tenant_isolation ON saas_usage_events;
CREATE POLICY saas_usage_events_tenant_isolation ON saas_usage_events
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());

CREATE TABLE IF NOT EXISTS saas_usage_adjustments(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL,
 factory_id UUID,
 period_start TIMESTAMPTZ NOT NULL,
 period_end TIMESTAMPTZ NOT NULL,
 metric_code VARCHAR(40),
 quantity_delta NUMERIC(24,6) NOT NULL DEFAULT 0,
 cost_delta_minor BIGINT NOT NULL DEFAULT 0,
 currency VARCHAR(3) NOT NULL,
 reason_code VARCHAR(32) NOT NULL,
 reason TEXT NOT NULL,
 reference_ref VARCHAR(255),
 request_hash VARCHAR(64) NOT NULL,
 idempotency_key VARCHAR(128) NOT NULL,
 created_by UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_saas_adjustment_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_adjustment_factory_scope FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_adjustment_actor FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_saas_adjustment_period CHECK(period_end > period_start AND period_end-period_start <= INTERVAL '366 days'),
 CONSTRAINT chk_saas_adjustment_metric CHECK(metric_code IS NULL OR metric_code IN('ACTIVE_USER','ROLE_ASSIGNMENT','TRANSACTION','STORAGE_BYTE_HOUR','TELEMETRY_EVENT','AI_INPUT_TOKEN','AI_OUTPUT_TOKEN','AI_TOOL_CALL','PREMIUM_WORKLOAD','INTEGRATION_CALL','EDGE_INFERENCE')),
 CONSTRAINT chk_saas_adjustment_nonzero CHECK(quantity_delta <> 0 OR cost_delta_minor <> 0),
 CONSTRAINT chk_saas_adjustment_currency CHECK(currency ~ '^[A-Z]{3}$'),
 CONSTRAINT chk_saas_adjustment_reason_code CHECK(reason_code IN('METER_CORRECTION','PRICING_CORRECTION','CUSTOMER_CREDIT','CUSTOMER_DEBIT','TAX_CORRECTION','OTHER')),
 CONSTRAINT chk_saas_adjustment_reason CHECK(LENGTH(BTRIM(reason)) BETWEEN 1 AND 2000),
 CONSTRAINT chk_saas_adjustment_reference CHECK(reference_ref IS NULL OR LENGTH(BTRIM(reference_ref)) BETWEEN 1 AND 255),
 CONSTRAINT chk_saas_adjustment_hash CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT chk_saas_adjustment_idempotency CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_adjustment_idempotency ON saas_usage_adjustments(tenant_id,idempotency_key);
CREATE INDEX IF NOT EXISTS idx_saas_adjustment_period ON saas_usage_adjustments(tenant_id,period_start,period_end,currency);
ALTER TABLE saas_usage_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_usage_adjustments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_usage_adjustments_tenant_isolation ON saas_usage_adjustments;
CREATE POLICY saas_usage_adjustments_tenant_isolation ON saas_usage_adjustments
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());

CREATE TABLE IF NOT EXISTS saas_usage_reconciliations(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL,
 factory_id UUID,
 invoice_reference VARCHAR(180) NOT NULL,
 reconciliation_version INTEGER NOT NULL,
 period_start TIMESTAMPTZ NOT NULL,
 period_end TIMESTAMPTZ NOT NULL,
 currency VARCHAR(3) NOT NULL,
 event_count BIGINT NOT NULL,
 unpriced_event_count BIGINT NOT NULL,
 ledger_estimated_amount_minor BIGINT,
 adjustment_amount_minor BIGINT NOT NULL,
 expected_amount_minor BIGINT,
 invoiced_amount_minor BIGINT NOT NULL,
 variance_minor BIGINT,
 status VARCHAR(24) NOT NULL,
 report_hash VARCHAR(64) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 idempotency_key VARCHAR(128) NOT NULL,
 recorded_by UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_saas_reconciliation_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_reconciliation_factory_scope FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_reconciliation_actor FOREIGN KEY(recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_saas_reconciliation_period CHECK(period_end > period_start AND period_end-period_start <= INTERVAL '35 days'),
 CONSTRAINT chk_saas_reconciliation_version CHECK(reconciliation_version BETWEEN 1 AND 1000000),
 CONSTRAINT chk_saas_reconciliation_invoice CHECK(LENGTH(BTRIM(invoice_reference)) BETWEEN 1 AND 180),
 CONSTRAINT chk_saas_reconciliation_currency CHECK(currency ~ '^[A-Z]{3}$'),
 CONSTRAINT chk_saas_reconciliation_counts CHECK(event_count >= 0 AND unpriced_event_count >= 0 AND unpriced_event_count <= event_count),
 CONSTRAINT chk_saas_reconciliation_status CHECK(status IN('MATCHED','VARIANCE','UNPRICED_USAGE')),
 CONSTRAINT chk_saas_reconciliation_amounts CHECK(
   (status='UNPRICED_USAGE' AND ledger_estimated_amount_minor IS NULL AND expected_amount_minor IS NULL AND variance_minor IS NULL AND unpriced_event_count > 0)
   OR
   (status IN('MATCHED','VARIANCE') AND ledger_estimated_amount_minor IS NOT NULL AND expected_amount_minor IS NOT NULL AND variance_minor IS NOT NULL AND unpriced_event_count=0)
 ),
 CONSTRAINT chk_saas_reconciliation_hashes CHECK(report_hash ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT chk_saas_reconciliation_idempotency CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_reconciliation_idempotency ON saas_usage_reconciliations(tenant_id,idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_reconciliation_tenant_invoice_version ON saas_usage_reconciliations(tenant_id,invoice_reference,reconciliation_version) WHERE factory_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_reconciliation_factory_invoice_version ON saas_usage_reconciliations(tenant_id,factory_id,invoice_reference,reconciliation_version) WHERE factory_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_saas_reconciliation_history ON saas_usage_reconciliations(tenant_id,created_at DESC,id DESC);
ALTER TABLE saas_usage_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_usage_reconciliations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_usage_reconciliations_tenant_isolation ON saas_usage_reconciliations;
CREATE POLICY saas_usage_reconciliations_tenant_isolation ON saas_usage_reconciliations
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION reject_saas_metering_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'SaaS metering records are immutable: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END;
$$;
DROP TRIGGER IF EXISTS trg_saas_rate_cards_immutable ON saas_usage_rate_cards;
CREATE TRIGGER trg_saas_rate_cards_immutable BEFORE UPDATE OR DELETE ON saas_usage_rate_cards FOR EACH ROW EXECUTE FUNCTION reject_saas_metering_mutation();
DROP TRIGGER IF EXISTS trg_saas_usage_events_immutable ON saas_usage_events;
CREATE TRIGGER trg_saas_usage_events_immutable BEFORE UPDATE OR DELETE ON saas_usage_events FOR EACH ROW EXECUTE FUNCTION reject_saas_metering_mutation();
DROP TRIGGER IF EXISTS trg_saas_usage_adjustments_immutable ON saas_usage_adjustments;
CREATE TRIGGER trg_saas_usage_adjustments_immutable BEFORE UPDATE OR DELETE ON saas_usage_adjustments FOR EACH ROW EXECUTE FUNCTION reject_saas_metering_mutation();
DROP TRIGGER IF EXISTS trg_saas_usage_reconciliations_immutable ON saas_usage_reconciliations;
CREATE TRIGGER trg_saas_usage_reconciliations_immutable BEFORE UPDATE OR DELETE ON saas_usage_reconciliations FOR EACH ROW EXECUTE FUNCTION reject_saas_metering_mutation();

INSERT INTO schema_migrations(version,checksum) VALUES('045_saas_usage_metering_reconciliation',NULL) ON CONFLICT(version) DO NOTHING;
COMMIT;
