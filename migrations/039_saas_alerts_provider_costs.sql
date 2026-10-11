BEGIN;
-- WP10-C: durable in-app spend alerts and provider-cost invoice reconciliation.
INSERT INTO permissions(code,description) VALUES
 ('saas.alerts.read','Read tenant SaaS budget alerts'),
 ('saas.alerts.ack','Acknowledge tenant SaaS budget alerts'),
 ('saas.provider_costs.read','Read AI provider cost ledger and reconciliations'),
 ('saas.provider_costs.write','Record idempotent provider-reported AI cost events'),
 ('saas.provider_costs.reconcile','Reconcile provider cost ledger to a provider invoice')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='ORG_ADMIN' AND r.is_system=true
 AND p.code IN('saas.alerts.read','saas.alerts.ack','saas.provider_costs.read','saas.provider_costs.write','saas.provider_costs.reconcile')
ON CONFLICT(role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS saas_budget_alerts(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL,
 factory_id UUID,
 budget_id UUID NOT NULL,
 budget_evaluation_id UUID NOT NULL,
 alert_type VARCHAR(24) NOT NULL,
 severity VARCHAR(12) NOT NULL,
 title VARCHAR(180) NOT NULL,
 message_code VARCHAR(48) NOT NULL,
 payload JSONB NOT NULL DEFAULT '{}'::jsonb,
 payload_hash VARCHAR(64) NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_saas_budget_alert_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_budget_alert_factory_scope FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_budget_alert_budget_scope FOREIGN KEY(budget_id,tenant_id) REFERENCES saas_usage_budgets(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_budget_alert_eval_scope FOREIGN KEY(budget_evaluation_id,tenant_id) REFERENCES saas_budget_evaluations(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT chk_saas_budget_alert_type CHECK(alert_type IN('WARNING','HARD_LIMIT','UNPRICED_USAGE','ANOMALY')),
 CONSTRAINT chk_saas_budget_alert_severity CHECK(severity IN('INFO','WARNING','CRITICAL')),
 CONSTRAINT chk_saas_budget_alert_title CHECK(length(btrim(title)) BETWEEN 1 AND 180),
 CONSTRAINT chk_saas_budget_alert_message_code CHECK(message_code IN('BUDGET_SOFT_LIMIT','BUDGET_HARD_LIMIT','USAGE_UNPRICED','SPEND_ANOMALY')),
 CONSTRAINT chk_saas_budget_alert_payload CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=8192),
 CONSTRAINT chk_saas_budget_alert_hash CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT uq_saas_budget_alert_scope_id UNIQUE(id,tenant_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_budget_alert_evaluation_type ON saas_budget_alerts(tenant_id,budget_evaluation_id,alert_type);
CREATE INDEX IF NOT EXISTS idx_saas_budget_alert_inbox ON saas_budget_alerts(tenant_id,created_at DESC,id DESC);
ALTER TABLE saas_budget_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_budget_alerts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_budget_alerts_tenant_isolation ON saas_budget_alerts;
CREATE POLICY saas_budget_alerts_tenant_isolation ON saas_budget_alerts
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());

CREATE TABLE IF NOT EXISTS saas_budget_alert_acknowledgements(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL,
 alert_id UUID NOT NULL,
 acknowledged_by UUID NOT NULL,
 idempotency_key VARCHAR(128) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_saas_budget_alert_ack_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_budget_alert_ack_scope FOREIGN KEY(alert_id,tenant_id) REFERENCES saas_budget_alerts(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_budget_alert_ack_actor FOREIGN KEY(acknowledged_by) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_saas_budget_alert_ack_key CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
 CONSTRAINT chk_saas_budget_alert_ack_hash CHECK(request_hash ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_budget_alert_ack_actor ON saas_budget_alert_acknowledgements(tenant_id,alert_id,acknowledged_by);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_budget_alert_ack_idem ON saas_budget_alert_acknowledgements(tenant_id,idempotency_key);
CREATE INDEX IF NOT EXISTS idx_saas_budget_alert_ack_alert ON saas_budget_alert_acknowledgements(tenant_id,alert_id);
ALTER TABLE saas_budget_alert_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_budget_alert_acknowledgements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_budget_alert_ack_tenant_isolation ON saas_budget_alert_acknowledgements;
CREATE POLICY saas_budget_alert_ack_tenant_isolation ON saas_budget_alert_acknowledgements
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());

CREATE TABLE IF NOT EXISTS saas_provider_cost_events(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL,
 factory_id UUID,
 provider_code VARCHAR(60) NOT NULL,
 model_code VARCHAR(100),
 metric_code VARCHAR(40) NOT NULL,
 workload_class VARCHAR(24) NOT NULL,
 quantity NUMERIC(24,6) NOT NULL,
 currency VARCHAR(3) NOT NULL,
 provider_cost_minor BIGINT NOT NULL,
 occurred_at TIMESTAMPTZ NOT NULL,
 provider_invoice_reference VARCHAR(180),
 source_system VARCHAR(24) NOT NULL,
 source_event_ref VARCHAR(255) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 idempotency_key VARCHAR(128) NOT NULL,
 recorded_by UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_provider_cost_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CONSTRAINT fk_provider_cost_factory_scope FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_provider_cost_actor FOREIGN KEY(recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_provider_cost_provider CHECK(provider_code ~ '^[a-z][a-z0-9._:-]{0,59}$'),
 CONSTRAINT chk_provider_cost_model CHECK(model_code IS NULL OR model_code ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$'),
 CONSTRAINT chk_provider_cost_metric CHECK(metric_code IN('AI_INPUT_TOKEN','AI_OUTPUT_TOKEN','AI_TOOL_CALL','PREMIUM_WORKLOAD','EDGE_INFERENCE','INTEGRATION_CALL')),
 CONSTRAINT chk_provider_cost_workload CHECK(workload_class IN('PRODUCTION','EVALUATION','RED_TEAM','SHADOW_MODE','DEVELOPMENT','NON_AI')),
 CONSTRAINT chk_provider_cost_quantity CHECK(quantity > 0 AND quantity <= 1000000000000),
 CONSTRAINT chk_provider_cost_currency CHECK(currency ~ '^[A-Z]{3}$'),
 CONSTRAINT chk_provider_cost_amount CHECK(provider_cost_minor BETWEEN 0 AND 9000000000000000),
 CONSTRAINT chk_provider_cost_invoice CHECK(provider_invoice_reference IS NULL OR length(btrim(provider_invoice_reference)) BETWEEN 1 AND 180),
 CONSTRAINT chk_provider_cost_source CHECK(source_system IN('PROVIDER_EXPORT','PROVIDER_API','MANUAL') AND length(btrim(source_event_ref)) BETWEEN 1 AND 255),
 CONSTRAINT chk_provider_cost_hash CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT chk_provider_cost_idem CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_cost_idempotency ON saas_provider_cost_events(tenant_id,idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_cost_source_ref ON saas_provider_cost_events(tenant_id,provider_code,source_system,source_event_ref);
CREATE INDEX IF NOT EXISTS idx_provider_cost_period ON saas_provider_cost_events(tenant_id,provider_code,occurred_at,currency);
CREATE INDEX IF NOT EXISTS idx_provider_cost_invoice_ref ON saas_provider_cost_events(tenant_id,provider_code,provider_invoice_reference);
ALTER TABLE saas_provider_cost_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_provider_cost_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_provider_cost_events_tenant_isolation ON saas_provider_cost_events;
CREATE POLICY saas_provider_cost_events_tenant_isolation ON saas_provider_cost_events
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());

CREATE TABLE IF NOT EXISTS saas_provider_cost_reconciliations(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL,
 factory_id UUID,
 provider_code VARCHAR(60) NOT NULL,
 invoice_reference VARCHAR(180) NOT NULL,
 reconciliation_version INTEGER NOT NULL,
 period_start TIMESTAMPTZ NOT NULL,
 period_end TIMESTAMPTZ NOT NULL,
 currency VARCHAR(3) NOT NULL,
 event_count BIGINT NOT NULL,
 ledger_provider_cost_minor BIGINT NOT NULL,
 invoiced_provider_cost_minor BIGINT NOT NULL,
 variance_minor BIGINT NOT NULL,
 status VARCHAR(16) NOT NULL,
 report_hash VARCHAR(64) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 idempotency_key VARCHAR(128) NOT NULL,
 recorded_by UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_provider_cost_recon_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CONSTRAINT fk_provider_cost_recon_factory_scope FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_provider_cost_recon_actor FOREIGN KEY(recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_provider_cost_recon_provider CHECK(provider_code ~ '^[a-z][a-z0-9._:-]{0,59}$'),
 CONSTRAINT chk_provider_cost_recon_invoice CHECK(length(btrim(invoice_reference)) BETWEEN 1 AND 180),
 CONSTRAINT chk_provider_cost_recon_version CHECK(reconciliation_version BETWEEN 1 AND 1000000),
 CONSTRAINT chk_provider_cost_recon_period CHECK(period_end > period_start AND period_end-period_start <= INTERVAL '35 days'),
 CONSTRAINT chk_provider_cost_recon_currency CHECK(currency ~ '^[A-Z]{3}$'),
 CONSTRAINT chk_provider_cost_recon_count CHECK(event_count >= 0),
 CONSTRAINT chk_provider_cost_recon_status CHECK(status IN('MATCHED','VARIANCE','NO_PROVIDER_DATA')),
 CONSTRAINT chk_provider_cost_recon_amounts CHECK(ledger_provider_cost_minor >= 0 AND invoiced_provider_cost_minor >= 0 AND variance_minor=invoiced_provider_cost_minor-ledger_provider_cost_minor),
 CONSTRAINT chk_provider_cost_recon_hash CHECK(report_hash ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT chk_provider_cost_recon_idem CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_cost_recon_idempotency ON saas_provider_cost_reconciliations(tenant_id,idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_cost_recon_tenant_invoice_ver ON saas_provider_cost_reconciliations(tenant_id,provider_code,invoice_reference,reconciliation_version) WHERE factory_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_cost_recon_factory_invoice_ver ON saas_provider_cost_reconciliations(tenant_id,factory_id,provider_code,invoice_reference,reconciliation_version) WHERE factory_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_provider_cost_recon_history ON saas_provider_cost_reconciliations(tenant_id,provider_code,created_at DESC);
ALTER TABLE saas_provider_cost_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_provider_cost_reconciliations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_provider_cost_recon_tenant_isolation ON saas_provider_cost_reconciliations;
CREATE POLICY saas_provider_cost_recon_tenant_isolation ON saas_provider_cost_reconciliations
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());

CREATE OR REPLACE FUNCTION reject_saas_provider_cost_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'SaaS provider cost records are immutable: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END;
$$;
DROP TRIGGER IF EXISTS trg_saas_budget_alerts_immutable ON saas_budget_alerts;
CREATE TRIGGER trg_saas_budget_alerts_immutable BEFORE UPDATE OR DELETE ON saas_budget_alerts FOR EACH ROW EXECUTE FUNCTION reject_saas_metering_mutation();
DROP TRIGGER IF EXISTS trg_saas_budget_alert_ack_immutable ON saas_budget_alert_acknowledgements;
CREATE TRIGGER trg_saas_budget_alert_ack_immutable BEFORE UPDATE OR DELETE ON saas_budget_alert_acknowledgements FOR EACH ROW EXECUTE FUNCTION reject_saas_metering_mutation();
DROP TRIGGER IF EXISTS trg_saas_provider_cost_events_immutable ON saas_provider_cost_events;
CREATE TRIGGER trg_saas_provider_cost_events_immutable BEFORE UPDATE OR DELETE ON saas_provider_cost_events FOR EACH ROW EXECUTE FUNCTION reject_saas_provider_cost_mutation();
DROP TRIGGER IF EXISTS trg_saas_provider_cost_recon_immutable ON saas_provider_cost_reconciliations;
CREATE TRIGGER trg_saas_provider_cost_recon_immutable BEFORE UPDATE OR DELETE ON saas_provider_cost_reconciliations FOR EACH ROW EXECUTE FUNCTION reject_saas_provider_cost_mutation();

INSERT INTO schema_migrations(version,checksum) VALUES('039_saas_alerts_provider_costs',NULL) ON CONFLICT(version) DO NOTHING;
COMMIT;
