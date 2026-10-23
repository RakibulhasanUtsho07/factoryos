BEGIN;

-- Task 24: customer-facing commercial billing. Usage and rates remain the
-- immutable internal estimate ledger; only a separate close snapshot and a
-- provider-issued invoice can represent an issued commercial invoice.
INSERT INTO permissions(code,description) VALUES
  ('saas.billing.read','Read commercial billing closes and provider reconciliation evidence'),
  ('saas.billing.account.write','Configure a tenant commercial billing provider customer'),
  ('saas.billing.close','Prepare an immutable tenant usage billing close'),
  ('saas.billing.issue','Issue/retry a provider invoice and retry a failed invoice payment'),
  ('saas.billing.reconcile','Reconcile provider invoice, tax, totals and lifecycle state')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.is_system=true
  AND r.code IN ('ORG_ADMIN','FINANCE_MANAGER')
  AND p.code IN (
    'saas.billing.read','saas.billing.account.write','saas.billing.close',
    'saas.billing.issue','saas.billing.reconcile'
  )
ON CONFLICT(role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS saas_billing_provider_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  provider_code VARCHAR(20) NOT NULL DEFAULT 'stripe',
  provider_customer_id VARCHAR(120) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  collection_method VARCHAR(24) NOT NULL,
  days_until_due SMALLINT,
  automatic_tax_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  tax_behavior VARCHAR(12),
  version INTEGER NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_billing_account_tenant UNIQUE(tenant_id),
  CONSTRAINT uq_saas_billing_account_scope UNIQUE(id,tenant_id),
  CONSTRAINT chk_saas_billing_provider CHECK(provider_code='stripe'),
  CONSTRAINT chk_saas_billing_customer CHECK(provider_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  CONSTRAINT chk_saas_billing_currency CHECK(currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_saas_billing_collection CHECK(collection_method IN ('charge_automatically','send_invoice')),
  CONSTRAINT chk_saas_billing_due_days CHECK(
    (collection_method='send_invoice' AND days_until_due BETWEEN 1 AND 120)
    OR (collection_method='charge_automatically' AND days_until_due IS NULL)
  ),
  CONSTRAINT chk_saas_billing_tax_behavior CHECK(
    (automatic_tax_enabled=FALSE AND tax_behavior IS NULL)
    OR (automatic_tax_enabled=TRUE AND tax_behavior IN ('exclusive','inclusive'))
  ),
  CONSTRAINT chk_saas_billing_account_version CHECK(version BETWEEN 1 AND 1000000),
  CONSTRAINT chk_saas_billing_account_key CHECK(idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT chk_saas_billing_account_hash CHECK(request_hash ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_billing_provider_customer
  ON saas_billing_provider_accounts(provider_code,provider_customer_id);
CREATE INDEX IF NOT EXISTS idx_saas_billing_provider_account_version
  ON saas_billing_provider_accounts(tenant_id,version DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_saas_billing_provider_account()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'SaaS billing provider account history cannot be deleted'
      USING ERRCODE='55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.provider_code IS DISTINCT FROM OLD.provider_code
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'SaaS billing provider account updates must preserve scope and increment version exactly once'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS saas_billing_provider_account_guard ON saas_billing_provider_accounts;
CREATE TRIGGER saas_billing_provider_account_guard
BEFORE UPDATE OR DELETE ON saas_billing_provider_accounts
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_billing_provider_account();

CREATE TABLE IF NOT EXISTS saas_billing_provider_account_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  provider_account_id UUID NOT NULL,
  account_version INTEGER NOT NULL,
  action VARCHAR(20) NOT NULL,
  provider_code VARCHAR(20) NOT NULL,
  provider_customer_id VARCHAR(120) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  collection_method VARCHAR(24) NOT NULL,
  days_until_due SMALLINT,
  automatic_tax_enabled BOOLEAN NOT NULL,
  tax_behavior VARCHAR(12),
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_saas_billing_account_event_scope
    FOREIGN KEY(provider_account_id,tenant_id)
    REFERENCES saas_billing_provider_accounts(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT uq_saas_billing_account_event_version UNIQUE(provider_account_id,account_version),
  CONSTRAINT uq_saas_billing_account_event_idempotency UNIQUE(tenant_id,idempotency_key),
  CONSTRAINT chk_saas_billing_account_event_action CHECK(action IN ('CREATED','UPDATED')),
  CONSTRAINT chk_saas_billing_account_event_version CHECK(account_version BETWEEN 1 AND 1000000),
  CONSTRAINT chk_saas_billing_account_event_hash CHECK(request_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_saas_billing_account_events_history
  ON saas_billing_provider_account_events(tenant_id,provider_account_id,account_version DESC);
DROP TRIGGER IF EXISTS saas_billing_provider_account_events_immutable ON saas_billing_provider_account_events;
CREATE TRIGGER saas_billing_provider_account_events_immutable
  BEFORE UPDATE OR DELETE ON saas_billing_provider_account_events
  FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

CREATE TABLE IF NOT EXISTS saas_billing_close_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  provider_account_id UUID NOT NULL,
  provider_account_version INTEGER NOT NULL,
  provider_code VARCHAR(20) NOT NULL,
  provider_customer_id VARCHAR(120) NOT NULL,
  collection_method VARCHAR(24) NOT NULL,
  days_until_due SMALLINT,
  automatic_tax_enabled BOOLEAN NOT NULL,
  tax_behavior VARCHAR(12),
  currency VARCHAR(3) NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  usage_event_count BIGINT NOT NULL,
  adjustment_count BIGINT NOT NULL,
  usage_amount_minor NUMERIC(30,0) NOT NULL,
  adjustment_amount_minor NUMERIC(30,0) NOT NULL,
  expected_subtotal_minor NUMERIC(30,0) NOT NULL,
  lines JSONB NOT NULL,
  snapshot_hash VARCHAR(64) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  closed_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_saas_billing_close_scope UNIQUE(id,tenant_id),
  CONSTRAINT fk_saas_billing_close_account
    FOREIGN KEY(provider_account_id,tenant_id)
    REFERENCES saas_billing_provider_accounts(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT uq_saas_billing_close_idempotency UNIQUE(tenant_id,idempotency_key),
  CONSTRAINT uq_saas_billing_close_period UNIQUE(tenant_id,period_start,period_end,currency),
  CONSTRAINT chk_saas_billing_close_period CHECK(
    period_end>period_start AND period_end-period_start<=INTERVAL '35 days'
  ),
  CONSTRAINT chk_saas_billing_close_currency CHECK(currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_saas_billing_close_counts CHECK(usage_event_count>=0 AND adjustment_count>=0),
  CONSTRAINT chk_saas_billing_close_amounts CHECK(
    usage_amount_minor>=0 AND expected_subtotal_minor>=0
  ),
  CONSTRAINT chk_saas_billing_close_lines CHECK(
    jsonb_typeof(lines)='array' AND jsonb_array_length(lines)<=200
  ),
  CONSTRAINT chk_saas_billing_close_hashes CHECK(
    snapshot_hash ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT chk_saas_billing_close_key CHECK(idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
);
CREATE INDEX IF NOT EXISTS idx_saas_billing_close_history
  ON saas_billing_close_runs(tenant_id,created_at DESC,id DESC);
DROP TRIGGER IF EXISTS saas_billing_close_runs_immutable ON saas_billing_close_runs;
CREATE TRIGGER saas_billing_close_runs_immutable
  BEFORE UPDATE OR DELETE ON saas_billing_close_runs
  FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

CREATE TABLE IF NOT EXISTS saas_billing_close_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  close_id UUID NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  provider_invoice_id VARCHAR(120),
  provider_invoice_status VARCHAR(20),
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash VARCHAR(64),
  error_code VARCHAR(80),
  evidence_hash VARCHAR(64),
  actor_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_saas_billing_close_event_scope
    FOREIGN KEY(close_id,tenant_id) REFERENCES saas_billing_close_runs(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT uq_saas_billing_close_event_idempotency UNIQUE(tenant_id,idempotency_key),
  CONSTRAINT chk_saas_billing_close_event_type CHECK(event_type IN (
    'CLOSE_PREPARED','NO_CHARGE','INVOICE_DRAFTED','LINE_ITEM_ATTACHED','INVOICE_ISSUED',
    'ISSUE_FAILED','PAYMENT_RETRY_ATTEMPTED','PAYMENT_FAILED','INVOICE_PAID',
    'INVOICE_VOIDED','INVOICE_UNCOLLECTIBLE','WEBHOOK_OBSERVED','RECONCILED'
  )),
  CONSTRAINT chk_saas_billing_close_event_invoice_status CHECK(
    provider_invoice_status IS NULL OR provider_invoice_status IN ('draft','open','paid','void','uncollectible')
  ),
  CONSTRAINT chk_saas_billing_close_event_hashes CHECK(
    request_hash IS NULL OR request_hash ~ '^[a-f0-9]{64}$'
  )
);
CREATE INDEX IF NOT EXISTS idx_saas_billing_close_events_latest
  ON saas_billing_close_events(tenant_id,close_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_saas_billing_close_events_invoice
  ON saas_billing_close_events(tenant_id,provider_invoice_id,created_at DESC)
  WHERE provider_invoice_id IS NOT NULL;
DROP TRIGGER IF EXISTS saas_billing_close_events_immutable ON saas_billing_close_events;
CREATE TRIGGER saas_billing_close_events_immutable
  BEFORE UPDATE OR DELETE ON saas_billing_close_events
  FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

CREATE TABLE IF NOT EXISTS saas_billing_provider_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  provider_code VARCHAR(20) NOT NULL DEFAULT 'stripe',
  provider_event_id VARCHAR(120) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  close_id UUID NOT NULL,
  provider_invoice_id VARCHAR(120) NOT NULL,
  signature_timestamp BIGINT NOT NULL,
  payload_hash VARCHAR(64) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_saas_billing_webhook_close
    FOREIGN KEY(close_id,tenant_id) REFERENCES saas_billing_close_runs(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT uq_saas_billing_webhook_event UNIQUE(provider_code,provider_event_id),
  CONSTRAINT chk_saas_billing_webhook_provider CHECK(provider_code='stripe'),
  CONSTRAINT chk_saas_billing_webhook_event_id CHECK(provider_event_id ~ '^evt_[A-Za-z0-9]+$'),
  CONSTRAINT chk_saas_billing_webhook_invoice_id CHECK(provider_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  CONSTRAINT chk_saas_billing_webhook_hash CHECK(payload_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_saas_billing_webhook_close_history
  ON saas_billing_provider_webhook_events(tenant_id,close_id,received_at DESC);
DROP TRIGGER IF EXISTS saas_billing_provider_webhook_events_immutable ON saas_billing_provider_webhook_events;
CREATE TRIGGER saas_billing_provider_webhook_events_immutable
  BEFORE UPDATE OR DELETE ON saas_billing_provider_webhook_events
  FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

CREATE TABLE IF NOT EXISTS saas_billing_reconciliation_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  close_id UUID NOT NULL,
  provider_invoice_id VARCHAR(120) NOT NULL,
  provider_invoice_status VARCHAR(20) NOT NULL,
  provider_customer_id VARCHAR(120) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  expected_subtotal_minor NUMERIC(30,0) NOT NULL,
  provider_subtotal_minor NUMERIC(30,0) NOT NULL,
  provider_tax_minor NUMERIC(30,0) NOT NULL,
  provider_discount_minor NUMERIC(30,0) NOT NULL,
  provider_total_minor NUMERIC(30,0) NOT NULL,
  amount_due_minor NUMERIC(30,0) NOT NULL,
  amount_paid_minor NUMERIC(30,0) NOT NULL,
  automatic_tax_status VARCHAR(40),
  line_binding_valid BOOLEAN NOT NULL,
  status VARCHAR(32) NOT NULL,
  provider_snapshot_hash VARCHAR(64) NOT NULL,
  report_hash VARCHAR(64) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  recorded_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_saas_billing_reconciliation_close
    FOREIGN KEY(close_id,tenant_id) REFERENCES saas_billing_close_runs(id,tenant_id) ON DELETE RESTRICT,
  CONSTRAINT uq_saas_billing_reconciliation_idempotency UNIQUE(tenant_id,idempotency_key),
  CONSTRAINT uq_saas_billing_reconciliation_snapshot
    UNIQUE(tenant_id,close_id,provider_invoice_id,provider_snapshot_hash),
  CONSTRAINT chk_saas_billing_reconciliation_invoice_status CHECK(
    provider_invoice_status IN ('draft','open','paid','void','uncollectible')
  ),
  CONSTRAINT chk_saas_billing_reconciliation_currency CHECK(currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_saas_billing_reconciliation_status CHECK(status IN (
    'MATCHED_OPEN','MATCHED_PAID','VARIANCE','DRAFT','CUSTOMER_MISMATCH',
    'CURRENCY_MISMATCH','TAX_REVIEW','VOIDED','UNCOLLECTIBLE'
  )),
  CONSTRAINT chk_saas_billing_reconciliation_amounts CHECK(
    expected_subtotal_minor>=0 AND provider_subtotal_minor>=0 AND provider_tax_minor>=0
    AND provider_discount_minor>=0 AND provider_total_minor>=0
    AND amount_due_minor>=0 AND amount_paid_minor>=0
  ),
  CONSTRAINT chk_saas_billing_reconciliation_hashes CHECK(
    provider_snapshot_hash ~ '^[a-f0-9]{64}$' AND report_hash ~ '^[a-f0-9]{64}$'
    AND request_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT chk_saas_billing_reconciliation_key CHECK(idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
);
CREATE INDEX IF NOT EXISTS idx_saas_billing_reconciliation_history
  ON saas_billing_reconciliation_results(tenant_id,close_id,created_at DESC);
DROP TRIGGER IF EXISTS saas_billing_reconciliation_immutable ON saas_billing_reconciliation_results;
CREATE TRIGGER saas_billing_reconciliation_immutable
  BEFORE UPDATE OR DELETE ON saas_billing_reconciliation_results
  FOR EACH ROW EXECUTE FUNCTION factoryos_reject_versioned_mutation();

-- Account configuration updates are versioned. Every version has an immutable
-- event receipt; old closes preserve their own customer/tax/collection snapshot.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'saas_billing_provider_accounts',
    'saas_billing_provider_account_events',
    'saas_billing_close_runs',
    'saas_billing_close_events',
    'saas_billing_provider_webhook_events',
    'saas_billing_reconciliation_results'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',table_name || '_tenant_isolation',table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL USING (tenant_id=public.factoryos_current_tenant_id()) WITH CHECK (tenant_id=public.factoryos_current_tenant_id())',
      table_name || '_tenant_isolation',table_name
    );
    -- The restrictive fence is required even if another permissive policy is
    -- introduced later; matching tenant data cannot be exposed through OR semantics.
    EXECUTE format('DROP POLICY IF EXISTS fo_privacy_scope_enforce ON public.%I',table_name);
    EXECUTE format(
      'CREATE POLICY fo_privacy_scope_enforce ON public.%I AS RESTRICTIVE FOR ALL USING (tenant_id=public.factoryos_current_tenant_id()) WITH CHECK (tenant_id=public.factoryos_current_tenant_id())',
      table_name
    );

    INSERT INTO factoryos_governance.tenant_relation_inventory(
      schema_name,relation_name,scope_model,data_category,export_disposition,
      erasure_disposition,audit_requirement,rationale
    ) VALUES(
      'public',table_name,'DIRECT_TENANT_ID','SAAS_CONTROL_PLANE','EXCLUDED',
      'BLOCKED_FINANCE_REVIEW','DOMAIN_LEDGER_OR_AUDIT_REVIEW',
      'Commercial SaaS billing/control ledger; immutable invoice and reconciliation evidence is protected from generic tenant erasure until finance retention approval.'
    )
    ON CONFLICT(schema_name,relation_name) DO UPDATE SET
      scope_model=EXCLUDED.scope_model,data_category=EXCLUDED.data_category,
      export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
      audit_requirement=EXCLUDED.audit_requirement,rationale=EXCLUDED.rationale,classified_at=clock_timestamp();

    INSERT INTO factoryos_governance.tenant_relation_ownership_reviews(
      schema_name,relation_name,ownership_class,evidence_type,evidence_detail,
      scope_predicate,export_disposition,erasure_disposition,review_status
    ) VALUES(
      'public',table_name,'DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
      'Direct tenant_id ownership is enforced by ENABLE/FORCE RLS and a restrictive tenant predicate in migration 185.',
      'tenant_id = public.factoryos_current_tenant_id()','EXCLUDED','BLOCKED_FINANCE_REVIEW','VERIFIED'
    )
    ON CONFLICT(schema_name,relation_name) DO UPDATE SET
      ownership_class=EXCLUDED.ownership_class,evidence_type=EXCLUDED.evidence_type,
      evidence_detail=EXCLUDED.evidence_detail,scope_predicate=EXCLUDED.scope_predicate,
      export_disposition=EXCLUDED.export_disposition,erasure_disposition=EXCLUDED.erasure_disposition,
      review_status=EXCLUDED.review_status,reviewed_at=clock_timestamp();
  END LOOP;
END $$;

-- Serialize usage/adjustment writes with billing close using one tenant-scoped
-- advisory-lock key. The close service holds the session lock while it snapshots
-- all aggregates; ledger INSERT triggers take the matching xact lock and reject
-- late usage or adjustments if the period has already been closed.
CREATE OR REPLACE FUNCTION factoryos_guard_saas_billing_closed_period()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $billing_close_fence$
DECLARE
  already_closed BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('saas-billing-ledger:' || NEW.tenant_id::text, 0));

  IF TG_TABLE_NAME='saas_usage_events' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.saas_billing_close_runs c
      WHERE c.tenant_id=NEW.tenant_id
        AND NEW.occurred_at >= c.period_start
        AND NEW.occurred_at < c.period_end
        AND (NEW.currency IS NULL OR c.currency=NEW.currency)
    ) INTO already_closed;
    IF already_closed THEN
      RAISE EXCEPTION 'SaaS usage arrived in an already closed billing period; record an approved correction after finance review'
        USING ERRCODE='55000';
    END IF;
  ELSIF TG_TABLE_NAME='saas_usage_adjustments' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.saas_billing_close_runs c
      WHERE c.tenant_id=NEW.tenant_id
        AND NEW.period_start < c.period_end
        AND NEW.period_end > c.period_start
        AND c.currency=NEW.currency
    ) INTO already_closed;
    IF already_closed THEN
      RAISE EXCEPTION 'SaaS adjustment overlaps an already closed billing period; use an approved provider credit-note/tax-correction process'
        USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$billing_close_fence$;

DROP TRIGGER IF EXISTS saas_usage_events_billing_close_fence ON public.saas_usage_events;
CREATE TRIGGER saas_usage_events_billing_close_fence
BEFORE INSERT ON public.saas_usage_events
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_billing_closed_period();

DROP TRIGGER IF EXISTS saas_usage_adjustments_billing_close_fence ON public.saas_usage_adjustments;
CREATE TRIGGER saas_usage_adjustments_billing_close_fence
BEFORE INSERT ON public.saas_usage_adjustments
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_saas_billing_closed_period();

INSERT INTO schema_migrations(version,checksum)
VALUES('185_saas_commercial_billing_provider',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
