BEGIN;
-- WP10-B: immutable SaaS budget policies, spend evaluations and scoped workload controls.
INSERT INTO permissions(code,description) VALUES
 ('saas.budgets.read','Read tenant budget policies and spend evaluations'),
 ('saas.budgets.write','Create effective-dated immutable tenant budget policies'),
 ('saas.workloads.control','Pause and resume explicitly non-critical AI workload classes')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='ORG_ADMIN' AND r.is_system=true
  AND p.code IN ('saas.budgets.read','saas.budgets.write','saas.workloads.control')
ON CONFLICT(role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS saas_usage_budgets(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL,
 factory_id UUID,
 budget_code VARCHAR(80) NOT NULL,
 policy_version INTEGER NOT NULL,
 period_kind VARCHAR(12) NOT NULL,
 metric_code VARCHAR(40),
 capability_code VARCHAR(100),
 workload_class VARCHAR(24),
 currency VARCHAR(3) NOT NULL,
 soft_limit_minor BIGINT NOT NULL,
 hard_limit_minor BIGINT NOT NULL,
 pause_noncritical_on_hard_limit BOOLEAN NOT NULL DEFAULT false,
 anomaly_multiplier NUMERIC(5,2) NOT NULL DEFAULT 3.00,
 anomaly_min_events INTEGER NOT NULL DEFAULT 10,
 effective_from TIMESTAMPTZ NOT NULL,
 effective_to TIMESTAMPTZ,
 idempotency_key VARCHAR(128) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 created_by UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_saas_budget_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_budget_factory_scope FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_budget_actor FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT uq_saas_budget_scope_id UNIQUE(id,tenant_id),
 CONSTRAINT chk_saas_budget_code CHECK(budget_code ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$'),
 CONSTRAINT chk_saas_budget_version CHECK(policy_version BETWEEN 1 AND 1000000),
 CONSTRAINT chk_saas_budget_period_kind CHECK(period_kind IN('DAILY','MONTHLY')),
 CONSTRAINT chk_saas_budget_metric CHECK(metric_code IS NULL OR metric_code IN('ACTIVE_USER','ROLE_ASSIGNMENT','TRANSACTION','STORAGE_BYTE_HOUR','TELEMETRY_EVENT','AI_INPUT_TOKEN','AI_OUTPUT_TOKEN','AI_TOOL_CALL','PREMIUM_WORKLOAD','INTEGRATION_CALL','EDGE_INFERENCE')),
 CONSTRAINT chk_saas_budget_capability CHECK(capability_code IS NULL OR capability_code ~ '^[a-z][a-z0-9._:-]{0,99}$'),
 CONSTRAINT chk_saas_budget_workload CHECK(workload_class IS NULL OR workload_class IN('PRODUCTION','EVALUATION','RED_TEAM','SHADOW_MODE','DEVELOPMENT','NON_AI')),
 CONSTRAINT chk_saas_budget_currency CHECK(currency ~ '^[A-Z]{3}$'),
 CONSTRAINT chk_saas_budget_limits CHECK(soft_limit_minor BETWEEN 0 AND 9000000000000000 AND hard_limit_minor BETWEEN soft_limit_minor AND 9000000000000000),
 CONSTRAINT chk_saas_budget_anomaly CHECK(anomaly_multiplier >= 1.50 AND anomaly_multiplier <= 100.00 AND anomaly_min_events BETWEEN 3 AND 100000),
 CONSTRAINT chk_saas_budget_window CHECK(effective_to IS NULL OR effective_to > effective_from),
 CONSTRAINT chk_saas_budget_idempotency CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
 CONSTRAINT chk_saas_budget_hash CHECK(request_hash ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_budget_idempotency ON saas_usage_budgets(tenant_id,idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_budget_tenant_code_version ON saas_usage_budgets(tenant_id,budget_code,policy_version) WHERE factory_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_budget_factory_code_version ON saas_usage_budgets(tenant_id,factory_id,budget_code,policy_version) WHERE factory_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_saas_budget_active_tenant ON saas_usage_budgets(tenant_id,effective_from DESC) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_saas_budget_scope_period ON saas_usage_budgets(tenant_id,factory_id,period_kind,currency);
ALTER TABLE saas_usage_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_usage_budgets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_usage_budgets_tenant_isolation ON saas_usage_budgets;
CREATE POLICY saas_usage_budgets_tenant_isolation ON saas_usage_budgets
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());

CREATE TABLE IF NOT EXISTS saas_budget_evaluations(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL,
 factory_id UUID,
 budget_id UUID NOT NULL,
 period_start TIMESTAMPTZ NOT NULL,
 period_end TIMESTAMPTZ NOT NULL,
 evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 event_count BIGINT NOT NULL,
 unpriced_event_count BIGINT NOT NULL,
 usage_cost_minor BIGINT NOT NULL,
 soft_limit_minor BIGINT NOT NULL,
 hard_limit_minor BIGINT NOT NULL,
 anomaly_window_cost_minor BIGINT NOT NULL DEFAULT 0,
 anomaly_baseline_hourly_minor NUMERIC(24,4) NOT NULL DEFAULT 0,
 status VARCHAR(24) NOT NULL,
 report_hash VARCHAR(64) NOT NULL,
 idempotency_key VARCHAR(128) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 evaluated_by UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_saas_budget_eval_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_budget_eval_factory_scope FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_budget_eval_budget_scope FOREIGN KEY(budget_id,tenant_id) REFERENCES saas_usage_budgets(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_budget_eval_actor FOREIGN KEY(evaluated_by) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT uq_saas_budget_eval_scope_id UNIQUE(id,tenant_id),
 CONSTRAINT chk_saas_budget_eval_period CHECK(period_end > period_start AND period_end-period_start <= INTERVAL '32 days'),
 CONSTRAINT chk_saas_budget_eval_counts CHECK(event_count >= 0 AND unpriced_event_count >= 0 AND unpriced_event_count <= event_count),
 CONSTRAINT chk_saas_budget_eval_amounts CHECK(usage_cost_minor BETWEEN 0 AND 9000000000000000 AND soft_limit_minor >= 0 AND hard_limit_minor >= soft_limit_minor AND anomaly_window_cost_minor >= 0 AND anomaly_baseline_hourly_minor >= 0),
 CONSTRAINT chk_saas_budget_eval_status CHECK(status IN('SAFE','WARNING','HARD_LIMIT','UNPRICED_USAGE','ANOMALY')),
 CONSTRAINT chk_saas_budget_eval_hash CHECK(report_hash ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT chk_saas_budget_eval_idempotency CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_budget_eval_idempotency ON saas_budget_evaluations(tenant_id,idempotency_key);
CREATE INDEX IF NOT EXISTS idx_saas_budget_eval_history ON saas_budget_evaluations(tenant_id,budget_id,evaluated_at DESC);
ALTER TABLE saas_budget_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_budget_evaluations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_budget_evaluations_tenant_isolation ON saas_budget_evaluations;
CREATE POLICY saas_budget_evaluations_tenant_isolation ON saas_budget_evaluations
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());

CREATE TABLE IF NOT EXISTS saas_workload_control_events(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL,
 factory_id UUID,
 control_key VARCHAR(80) NOT NULL DEFAULT 'AI.NONCRITICAL',
 workload_class VARCHAR(24) NOT NULL,
 control_state VARCHAR(12) NOT NULL,
 source VARCHAR(12) NOT NULL,
 reason_code VARCHAR(32) NOT NULL,
 reason_hash VARCHAR(64) NOT NULL,
 budget_id UUID,
 budget_evaluation_id UUID,
 idempotency_key VARCHAR(128) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,
 created_by UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT fk_saas_workload_control_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_workload_control_factory_scope FOREIGN KEY(factory_id,tenant_id) REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_workload_control_actor FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_workload_control_budget_scope FOREIGN KEY(budget_id,tenant_id) REFERENCES saas_usage_budgets(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_saas_workload_control_eval_scope FOREIGN KEY(budget_evaluation_id,tenant_id) REFERENCES saas_budget_evaluations(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT chk_saas_control_key CHECK(control_key ~ '^[A-Z0-9][A-Z0-9._:-]{0,79}$'),
 -- Only explicitly non-critical AI workloads can be paused. PROD and NON_AI are intentionally excluded.
 CONSTRAINT chk_saas_control_noncritical_only CHECK(workload_class IN('EVALUATION','RED_TEAM','SHADOW_MODE','DEVELOPMENT')),
 CONSTRAINT chk_saas_control_state CHECK(control_state IN('PAUSED','RESUMED')),
 CONSTRAINT chk_saas_control_source CHECK(source IN('MANUAL','BUDGET','ANOMALY')),
 CONSTRAINT chk_saas_control_reason CHECK(reason_code IN('ADMIN_PAUSE','ADMIN_RESUME','BUDGET_HARD_LIMIT','SPEND_ANOMALY','BUDGET_RECOVERED')),
 CONSTRAINT chk_saas_control_hashes CHECK(reason_hash ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT chk_saas_control_idempotency CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
 CONSTRAINT uq_saas_control_scope_id UNIQUE(id,tenant_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_workload_control_idempotency ON saas_workload_control_events(tenant_id,idempotency_key);
CREATE INDEX IF NOT EXISTS idx_saas_workload_control_latest ON saas_workload_control_events(tenant_id,factory_id,control_key,workload_class,created_at DESC,id DESC);
ALTER TABLE saas_workload_control_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_workload_control_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saas_workload_control_tenant_isolation ON saas_workload_control_events;
CREATE POLICY saas_workload_control_tenant_isolation ON saas_workload_control_events
 USING(tenant_id=factoryos_current_tenant_id()) WITH CHECK(tenant_id=factoryos_current_tenant_id());

DROP TRIGGER IF EXISTS trg_saas_usage_budgets_immutable ON saas_usage_budgets;
CREATE TRIGGER trg_saas_usage_budgets_immutable BEFORE UPDATE OR DELETE ON saas_usage_budgets FOR EACH ROW EXECUTE FUNCTION reject_saas_metering_mutation();
DROP TRIGGER IF EXISTS trg_saas_budget_evaluations_immutable ON saas_budget_evaluations;
CREATE TRIGGER trg_saas_budget_evaluations_immutable BEFORE UPDATE OR DELETE ON saas_budget_evaluations FOR EACH ROW EXECUTE FUNCTION reject_saas_metering_mutation();
DROP TRIGGER IF EXISTS trg_saas_workload_controls_immutable ON saas_workload_control_events;
CREATE TRIGGER trg_saas_workload_controls_immutable BEFORE UPDATE OR DELETE ON saas_workload_control_events FOR EACH ROW EXECUTE FUNCTION reject_saas_metering_mutation();

INSERT INTO schema_migrations(version,checksum) VALUES('038_saas_budget_controls',NULL) ON CONFLICT(version) DO NOTHING;
COMMIT;
