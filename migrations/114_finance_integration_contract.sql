BEGIN;

-- FactoryOS Finance Integration Contract / FR-FIN-08 and FR-FIN-09.
-- External accounting platforms remain the system of record. This migration
-- stores read-side connector configuration, immutable financial facts, and
-- operational quantity/rate reconciliation only; it does not create posting APIs.

INSERT INTO permissions (code, description)
VALUES
 ('finance.connectors.read','Read configured finance system-of-record connectors'),
 ('finance.connectors.write','Register read-side finance connector configurations'),
 ('finance.connectors.approve','Approve or reject finance connector configurations'),
 ('finance.facts.read','Read source-governed financial facts and lineage'),
 ('finance.facts.ingest','Ingest idempotent facts from an approved finance connector'),
 ('finance.reconciliation.read','Read costing quantity and rate reconciliation findings'),
 ('finance.reconciliation.review','Review and explain finance reconciliation findings'),
 ('finance.margin.read','Read actual and forecast margin inputs from governed facts'),
 ('finance.working_capital.read','Read receivable, payable, inventory and cash forecast inputs')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='ORG_ADMIN' AND r.is_system=true
  AND p.code IN (
   'finance.connectors.read','finance.connectors.write','finance.connectors.approve',
   'finance.facts.read','finance.facts.ingest','finance.reconciliation.read',
   'finance.reconciliation.review','finance.margin.read','finance.working_capital.read'
  )
ON CONFLICT (role_id,permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='FACTORY_MANAGER' AND r.is_system=false
  AND p.code IN (
   'finance.connectors.read','finance.facts.read','finance.facts.ingest',
   'finance.reconciliation.read','finance.margin.read','finance.working_capital.read'
  )
ON CONFLICT (role_id,permission_id) DO NOTHING;

CREATE OR REPLACE FUNCTION factoryos_finance_json_has_sensitive_key(p_value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $
DECLARE
 entry record;
 child jsonb;
BEGIN
 IF jsonb_typeof(p_value)='object' THEN
   FOR entry IN SELECT key,value FROM jsonb_each(p_value) LOOP
     IF entry.key ~* '(password|token|secret|credential|api.?key|authorization|private.?key|client.?secret)'
        OR factoryos_finance_json_has_sensitive_key(entry.value) THEN
       RETURN true;
     END IF;
   END LOOP;
 ELSIF jsonb_typeof(p_value)='array' THEN
   FOR child IN SELECT value FROM jsonb_array_elements(p_value) LOOP
     IF factoryos_finance_json_has_sensitive_key(child) THEN RETURN true; END IF;
   END LOOP;
 END IF;
 RETURN false;
END $;

CREATE TABLE finance_connectors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 factory_id uuid NOT NULL,
 connector_code varchar(64) NOT NULL,
 display_name varchar(160) NOT NULL,
 source_system varchar(120) NOT NULL,
 domain varchar(30) NOT NULL,
 integration_mode varchar(24) NOT NULL,
 endpoint_url text,
 secret_reference text,
 configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
 status varchar(24) NOT NULL DEFAULT 'PENDING_APPROVAL',
 row_version integer NOT NULL DEFAULT 1,
 idempotency_key varchar(200) NOT NULL,
 request_hash varchar(64) NOT NULL,
 created_by_user_id uuid NOT NULL,
 reviewed_by_user_id uuid,
 reviewed_at timestamptz,
 paused_at timestamptz,
 decision_reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT uq_finance_connector_scope UNIQUE(id,tenant_id,factory_id),
 CONSTRAINT uq_finance_connector_code UNIQUE(tenant_id,factory_id,connector_code),
 CONSTRAINT uq_finance_connector_idempotency UNIQUE(tenant_id,factory_id,idempotency_key),
 CONSTRAINT fk_finance_connector_factory FOREIGN KEY(factory_id,tenant_id)
   REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_finance_connector_creator FOREIGN KEY(created_by_user_id)
   REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT fk_finance_connector_reviewer FOREIGN KEY(reviewed_by_user_id)
   REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_finance_connector_code CHECK(connector_code ~ '^[A-Z0-9][A-Z0-9._-]{1,63}$'),
 CONSTRAINT chk_finance_connector_name CHECK(length(btrim(display_name)) BETWEEN 2 AND 160),
 CONSTRAINT chk_finance_connector_source CHECK(length(btrim(source_system)) BETWEEN 2 AND 120),
 CONSTRAINT chk_finance_connector_domain CHECK(domain IN ('GL','AP','AR','BANK_RECONCILIATION','TAX_EINVOICE','CUSTOM')),
 CONSTRAINT chk_finance_connector_mode CHECK(integration_mode IN ('MANUAL','REST_API','WEBHOOK','FILE_IMPORT')),
 CONSTRAINT chk_finance_connector_status CHECK(status IN ('PENDING_APPROVAL','ACTIVE','PAUSED','REJECTED')),
 CONSTRAINT chk_finance_connector_row_version CHECK(row_version > 0),
 CONSTRAINT chk_finance_connector_request_hash CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 CONSTRAINT chk_finance_connector_endpoint CHECK(endpoint_url IS NULL OR (endpoint_url ~ '^https://' AND endpoint_url !~* '[?&](password|token|secret|credential|api[_-]?key|authorization|private[_-]?key|client[_-]?secret)=')),
 CONSTRAINT chk_finance_connector_secret_ref CHECK(secret_reference IS NULL OR secret_reference ~ '^(vault|secret)://[A-Za-z0-9._/-]+$'),
 CONSTRAINT chk_finance_connector_mode_endpoint CHECK(integration_mode NOT IN ('REST_API','WEBHOOK') OR endpoint_url IS NOT NULL),
 CONSTRAINT chk_finance_connector_config_object CHECK(jsonb_typeof(configuration)='object' AND NOT factoryos_finance_json_has_sensitive_key(configuration)),
 CONSTRAINT chk_finance_connector_decision CHECK(
   (status='PENDING_APPROVAL' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL)
   OR (status IN ('ACTIVE','REJECTED') AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
   OR (status='PAUSED' AND reviewed_by_user_id IS NOT NULL AND paused_at IS NOT NULL)
 )
);
CREATE INDEX idx_finance_connectors_scope_status
 ON finance_connectors(tenant_id,factory_id,status,domain,created_at DESC);

CREATE TABLE finance_connector_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 factory_id uuid NOT NULL,
 connector_id uuid NOT NULL,
 external_batch_ref varchar(200) NOT NULL,
 idempotency_key varchar(200) NOT NULL,
 request_hash varchar(64) NOT NULL,
 status varchar(20) NOT NULL DEFAULT 'COMPLETED',
 received_count integer NOT NULL,
 accepted_count integer NOT NULL,
 mismatch_count integer NOT NULL DEFAULT 0,
 source_occurred_at timestamptz,
 actor_user_id uuid NOT NULL,
 request_id uuid,
 trace_id uuid,
 completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT uq_finance_run_scope UNIQUE(id,tenant_id,factory_id,connector_id),
 CONSTRAINT uq_finance_run_idempotency UNIQUE(tenant_id,factory_id,connector_id,idempotency_key),
 CONSTRAINT uq_finance_run_batch UNIQUE(tenant_id,factory_id,connector_id,external_batch_ref),
 CONSTRAINT fk_finance_run_connector FOREIGN KEY(connector_id,tenant_id,factory_id)
   REFERENCES finance_connectors(id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_finance_run_actor FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_finance_run_status CHECK(status IN ('COMPLETED','COMPLETED_WITH_MISMATCHES')),
 CONSTRAINT chk_finance_run_status_counts CHECK(
   (status='COMPLETED' AND mismatch_count=0)
   OR (status='COMPLETED_WITH_MISMATCHES' AND mismatch_count>0)
 ),
 CONSTRAINT chk_finance_run_counts CHECK(
   received_count BETWEEN 1 AND 500 AND accepted_count=received_count
   AND mismatch_count BETWEEN 0 AND accepted_count
 ),
 CONSTRAINT chk_finance_run_hash CHECK(request_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_finance_runs_scope_time
 ON finance_connector_runs(tenant_id,factory_id,connector_id,completed_at DESC);

CREATE TABLE financial_facts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 factory_id uuid NOT NULL,
 connector_id uuid NOT NULL,
 connector_run_id uuid NOT NULL,
 external_fact_id varchar(200) NOT NULL,
 source_fact_key varchar(200) NOT NULL,
 fact_type varchar(36) NOT NULL,
 source_record_type varchar(80) NOT NULL,
 source_record_ref varchar(240) NOT NULL,
 effective_at timestamptz NOT NULL,
 due_at timestamptz,
 currency char(3) NOT NULL,
 amount numeric(24,8) NOT NULL,
 customer_ref varchar(200),
 product_id uuid,
 product_ref varchar(200),
 order_id uuid,
 order_ref varchar(200),
 cost_center_ref varchar(160),
 shipment_ref varchar(200),
 source_quantity numeric(24,8),
 source_rate numeric(24,8),
 source_uom_code varchar(24),
 metadata_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
 fact_hash varchar(64) NOT NULL,
 ingested_by_user_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT uq_financial_fact_scope UNIQUE(id,tenant_id,factory_id),
 CONSTRAINT uq_financial_fact_external_id UNIQUE(tenant_id,factory_id,connector_id,external_fact_id),
 CONSTRAINT fk_financial_fact_run FOREIGN KEY(connector_run_id,tenant_id,factory_id,connector_id)
   REFERENCES finance_connector_runs(id,tenant_id,factory_id,connector_id) ON DELETE RESTRICT,
 CONSTRAINT fk_financial_fact_connector FOREIGN KEY(connector_id,tenant_id,factory_id)
   REFERENCES finance_connectors(id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_financial_fact_factory FOREIGN KEY(factory_id,tenant_id)
   REFERENCES factories(id,tenant_id) ON DELETE RESTRICT,
 CONSTRAINT fk_financial_fact_product FOREIGN KEY(product_id,tenant_id,factory_id)
   REFERENCES product_definitions(id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_financial_fact_order FOREIGN KEY(order_id,tenant_id,factory_id)
   REFERENCES orders(id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_financial_fact_actor FOREIGN KEY(ingested_by_user_id)
   REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_financial_fact_type CHECK(fact_type IN (
   'GL_BALANCE','AR_OPEN','AP_OPEN','BANK_BALANCE','INVENTORY_VALUE',
   'OPEN_PO_COMMITMENT','LC_EXPOSURE','SHIPMENT_MILESTONE','TAX_LIABILITY',
   'ACTUAL_REVENUE','ACTUAL_COST','ACTUAL_CONTRIBUTION_COST',
   'FORECAST_REVENUE','FORECAST_COST','FORECAST_CONTRIBUTION_COST'
 )),
 CONSTRAINT chk_financial_fact_currency CHECK(currency ~ '^[A-Z]{3}$'),
 CONSTRAINT chk_financial_fact_refs CHECK(
   length(btrim(external_fact_id))>0 AND length(btrim(source_fact_key))>0
   AND length(btrim(source_record_type))>0 AND length(btrim(source_record_ref))>0
 ),
 CONSTRAINT chk_financial_fact_balance_nonnegative CHECK(
   fact_type IN ('BANK_BALANCE','GL_BALANCE','ACTUAL_REVENUE','ACTUAL_COST',
     'ACTUAL_CONTRIBUTION_COST','FORECAST_REVENUE','FORECAST_COST','FORECAST_CONTRIBUTION_COST')
   OR amount >= 0
 ),
 CONSTRAINT chk_financial_fact_source_qty CHECK(source_quantity IS NULL OR source_quantity >= 0),
 CONSTRAINT chk_financial_fact_source_rate CHECK(source_rate IS NULL OR source_rate >= 0),
 CONSTRAINT chk_financial_fact_source_evidence CHECK(
   (source_quantity IS NULL AND source_rate IS NULL AND source_uom_code IS NULL)
   OR (source_quantity IS NOT NULL AND source_rate IS NOT NULL AND source_uom_code IS NOT NULL)
 ),
 CONSTRAINT chk_financial_fact_metadata CHECK(jsonb_typeof(metadata_snapshot)='object' AND NOT factoryos_finance_json_has_sensitive_key(metadata_snapshot)),
 CONSTRAINT chk_financial_fact_hash CHECK(fact_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_financial_facts_scope_type_time
 ON financial_facts(tenant_id,factory_id,fact_type,effective_at DESC,currency);
CREATE INDEX idx_financial_facts_margin_dims
 ON financial_facts(tenant_id,factory_id,order_id,product_id,customer_ref,effective_at DESC);
CREATE INDEX idx_financial_facts_position_key
 ON financial_facts(tenant_id,factory_id,connector_id,fact_type,source_fact_key,effective_at DESC);
CREATE INDEX idx_financial_facts_due_date
 ON financial_facts(tenant_id,factory_id,fact_type,due_at,currency)
 WHERE due_at IS NOT NULL;

CREATE TABLE finance_fact_reconciliations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 factory_id uuid NOT NULL,
 fact_id uuid NOT NULL,
 expected_source_type varchar(80) NOT NULL,
 expected_source_ref varchar(240) NOT NULL,
 source_quantity numeric(24,8) NOT NULL,
 expected_quantity numeric(24,8) NOT NULL,
 quantity_tolerance numeric(24,8) NOT NULL DEFAULT 0,
 quantity_delta numeric(24,8) GENERATED ALWAYS AS (source_quantity-expected_quantity) STORED,
 source_rate numeric(24,8) NOT NULL,
 expected_rate numeric(24,8) NOT NULL,
 rate_tolerance numeric(24,8) NOT NULL DEFAULT 0,
 rate_delta numeric(24,8) GENERATED ALWAYS AS (source_rate-expected_rate) STORED,
 uom_code varchar(24) NOT NULL,
 match_status varchar(16) NOT NULL,
 review_status varchar(16) NOT NULL DEFAULT 'OPEN',
 review_reason text,
 reviewed_by_user_id uuid,
 reviewed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT uq_finance_fact_reconciliation UNIQUE(tenant_id,factory_id,fact_id),
 CONSTRAINT uq_finance_reconciliation_scope UNIQUE(id,tenant_id,factory_id),
 CONSTRAINT fk_finance_reconciliation_fact FOREIGN KEY(fact_id,tenant_id,factory_id)
   REFERENCES financial_facts(id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_finance_reconciliation_reviewer FOREIGN KEY(reviewed_by_user_id)
   REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_finance_reconciliation_values CHECK(
   source_quantity>=0 AND expected_quantity>=0 AND source_rate>=0 AND expected_rate>=0
   AND quantity_tolerance>=0 AND rate_tolerance>=0
 ),
 CONSTRAINT chk_finance_reconciliation_status CHECK(match_status IN ('MATCHED','MISMATCH')),
 CONSTRAINT chk_finance_reconciliation_review CHECK(
   (review_status='OPEN' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND review_reason IS NULL)
   OR (review_status IN ('RESOLVED','WAIVED') AND reviewed_by_user_id IS NOT NULL
       AND reviewed_at IS NOT NULL AND length(btrim(COALESCE(review_reason,'')))>=8)
 )
);
CREATE INDEX idx_finance_reconciliation_open
 ON finance_fact_reconciliations(tenant_id,factory_id,created_at DESC)
 WHERE match_status='MISMATCH' AND review_status='OPEN';

CREATE TABLE finance_connector_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 factory_id uuid NOT NULL,
 connector_id uuid NOT NULL,
 action varchar(40) NOT NULL,
 actor_user_id uuid NOT NULL,
 reason text NOT NULL,
 request_id uuid,
 trace_id uuid,
 details jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT fk_finance_connector_history_connector FOREIGN KEY(connector_id,tenant_id,factory_id)
   REFERENCES finance_connectors(id,tenant_id,factory_id) ON DELETE RESTRICT,
 CONSTRAINT fk_finance_connector_history_actor FOREIGN KEY(actor_user_id)
   REFERENCES users(id) ON DELETE RESTRICT,
 CONSTRAINT chk_finance_connector_history_action CHECK(action IN ('CREATED','APPROVED','REJECTED','PAUSED')),
 CONSTRAINT chk_finance_connector_history_details CHECK(jsonb_typeof(details)='object')
);
CREATE INDEX idx_finance_connector_history_scope_time
 ON finance_connector_history(tenant_id,factory_id,connector_id,created_at DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_finance_connector()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Finance connector configuration is immutable; pause it instead'
     USING ERRCODE='55000';
 END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.status<>'PENDING_APPROVAL'
      OR NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
      OR NEW.row_version<>1 THEN
     RAISE EXCEPTION 'Finance connectors must be created pending independent approval'
       USING ERRCODE='23514';
   END IF;
   RETURN NEW;
 END IF;
 IF ROW(NEW.tenant_id,NEW.factory_id,NEW.connector_code,NEW.display_name,NEW.source_system,
        NEW.domain,NEW.integration_mode,NEW.endpoint_url,NEW.secret_reference,NEW.configuration,
        NEW.idempotency_key,NEW.request_hash,NEW.created_by_user_id,NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.tenant_id,OLD.factory_id,OLD.connector_code,OLD.display_name,OLD.source_system,
        OLD.domain,OLD.integration_mode,OLD.endpoint_url,OLD.secret_reference,OLD.configuration,
        OLD.idempotency_key,OLD.request_hash,OLD.created_by_user_id,OLD.created_at) THEN
   RAISE EXCEPTION 'Finance connector configuration is immutable; create a new connector code'
     USING ERRCODE='55000';
 END IF;
 IF NEW.row_version<>OLD.row_version+1 THEN
   RAISE EXCEPTION 'Finance connector row version must advance exactly once'
     USING ERRCODE='40001';
 END IF;
 IF OLD.status='PENDING_APPROVAL' AND NEW.status IN ('ACTIVE','REJECTED') THEN
   IF NEW.reviewed_by_user_id IS DISTINCT FROM factoryos_current_user_id()
      OR NEW.reviewed_by_user_id IS NULL
      OR NEW.reviewed_by_user_id=OLD.created_by_user_id
      OR NEW.reviewed_at IS NULL THEN
     RAISE EXCEPTION 'Finance connector approval requires a different reviewer'
       USING ERRCODE='42501';
   END IF;
 ELSIF OLD.status='ACTIVE' AND NEW.status='PAUSED' THEN
   IF NEW.reviewed_by_user_id IS DISTINCT FROM factoryos_current_user_id()
      OR NEW.reviewed_by_user_id IS NULL OR NEW.paused_at IS NULL THEN
     RAISE EXCEPTION 'Pausing a finance connector requires the authenticated actor'
       USING ERRCODE='42501';
   END IF;
 ELSE
   RAISE EXCEPTION 'Invalid finance connector status transition: % -> %',OLD.status,NEW.status
     USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_finance_connectors_guard
 BEFORE INSERT OR UPDATE OR DELETE ON finance_connectors
 FOR EACH ROW EXECUTE FUNCTION factoryos_guard_finance_connector();

CREATE OR REPLACE FUNCTION factoryos_guard_finance_connector_run()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
 IF TG_OP<>'INSERT' THEN
   RAISE EXCEPTION 'Finance connector run ledger is append-only' USING ERRCODE='55000';
 END IF;
 SELECT status INTO s FROM finance_connectors
 WHERE id=NEW.connector_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id
 FOR SHARE;
 IF s IS DISTINCT FROM 'ACTIVE' OR NEW.actor_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
   RAISE EXCEPTION 'Only the authenticated actor can ingest through an active scoped connector'
     USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_finance_connector_runs_guard
 BEFORE INSERT OR UPDATE OR DELETE ON finance_connector_runs
 FOR EACH ROW EXECUTE FUNCTION factoryos_guard_finance_connector_run();

CREATE OR REPLACE FUNCTION factoryos_guard_financial_fact()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE connector_status text;
DECLARE connector_domain text;
BEGIN
 IF TG_OP<>'INSERT' THEN
   RAISE EXCEPTION 'Governed financial facts are immutable; ingest a new source revision'
     USING ERRCODE='55000';
 END IF;
 SELECT status,domain INTO connector_status,connector_domain FROM finance_connectors
 WHERE id=NEW.connector_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
 IF connector_status IS DISTINCT FROM 'ACTIVE'
    OR NEW.ingested_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
   RAISE EXCEPTION 'Financial facts require an active connector and authenticated ingester'
     USING ERRCODE='42501';
 END IF;
 IF connector_domain<>'CUSTOM' AND NOT (
   (connector_domain='GL' AND NEW.fact_type IN (
     'GL_BALANCE','INVENTORY_VALUE','ACTUAL_REVENUE','ACTUAL_COST','ACTUAL_CONTRIBUTION_COST',
     'FORECAST_REVENUE','FORECAST_COST','FORECAST_CONTRIBUTION_COST'))
   OR (connector_domain='AP' AND NEW.fact_type IN ('AP_OPEN','OPEN_PO_COMMITMENT','LC_EXPOSURE','TAX_LIABILITY'))
   OR (connector_domain='AR' AND NEW.fact_type IN ('AR_OPEN','SHIPMENT_MILESTONE','ACTUAL_REVENUE','FORECAST_REVENUE'))
   OR (connector_domain='BANK_RECONCILIATION' AND NEW.fact_type='BANK_BALANCE')
   OR (connector_domain='TAX_EINVOICE' AND NEW.fact_type IN ('TAX_LIABILITY','ACTUAL_REVENUE'))
 ) THEN
   RAISE EXCEPTION 'Financial fact type % is not permitted for connector domain %',NEW.fact_type,connector_domain
     USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $;
CREATE TRIGGER trg_financial_facts_guard
 BEFORE INSERT OR UPDATE OR DELETE ON financial_facts
 FOR EACH ROW EXECUTE FUNCTION factoryos_guard_financial_fact();

CREATE OR REPLACE FUNCTION factoryos_guard_finance_fact_reconciliation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fact_actor uuid;
DECLARE fact_quantity numeric(24,8);
DECLARE fact_rate numeric(24,8);
DECLARE fact_uom varchar(24);
DECLARE computed_status text;
BEGIN
 IF TG_OP='INSERT' THEN
   SELECT ingested_by_user_id,source_quantity,source_rate,source_uom_code
     INTO fact_actor,fact_quantity,fact_rate,fact_uom
   FROM financial_facts
   WHERE id=NEW.fact_id AND tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id;
   IF fact_actor IS NULL THEN
     RAISE EXCEPTION 'Reconciliation fact must exist in the same tenant and factory'
       USING ERRCODE='23503';
   END IF;
   IF fact_quantity IS NULL OR fact_rate IS NULL OR fact_uom IS NULL
      OR NEW.source_quantity IS DISTINCT FROM fact_quantity
      OR NEW.source_rate IS DISTINCT FROM fact_rate
      OR NEW.uom_code IS DISTINCT FROM fact_uom THEN
     RAISE EXCEPTION 'Reconciliation quantities, rates and UOM must match the immutable fact evidence'
       USING ERRCODE='23514';
   END IF;
   -- Generated columns are not populated until after BEFORE triggers execute.
   -- Derive the decision from their immutable base inputs instead.
   computed_status := CASE
     WHEN abs(NEW.source_quantity-NEW.expected_quantity)<=NEW.quantity_tolerance
      AND abs(NEW.source_rate-NEW.expected_rate)<=NEW.rate_tolerance THEN 'MATCHED'
     ELSE 'MISMATCH' END;
   IF NEW.match_status IS DISTINCT FROM computed_status
      OR NEW.review_status<>'OPEN'
      OR NEW.reviewed_by_user_id IS NOT NULL
      OR NEW.reviewed_at IS NOT NULL THEN
     RAISE EXCEPTION 'Reconciliation match status must be derived from source evidence'
       USING ERRCODE='23514';
   END IF;
   RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Finance reconciliation evidence cannot be deleted' USING ERRCODE='55000';
 END IF;
 IF ROW(NEW.tenant_id,NEW.factory_id,NEW.fact_id,NEW.expected_source_type,NEW.expected_source_ref,
        NEW.source_quantity,NEW.expected_quantity,NEW.quantity_tolerance,
        NEW.source_rate,NEW.expected_rate,NEW.rate_tolerance,NEW.uom_code,
        NEW.match_status,NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.tenant_id,OLD.factory_id,OLD.fact_id,OLD.expected_source_type,OLD.expected_source_ref,
        OLD.source_quantity,OLD.expected_quantity,OLD.quantity_tolerance,
        OLD.source_rate,OLD.expected_rate,OLD.rate_tolerance,OLD.uom_code,
        OLD.match_status,OLD.created_at) THEN
   RAISE EXCEPTION 'Finance reconciliation evidence is immutable' USING ERRCODE='55000';
 END IF;
 SELECT ingested_by_user_id INTO fact_actor FROM financial_facts
 WHERE id=OLD.fact_id AND tenant_id=OLD.tenant_id AND factory_id=OLD.factory_id;
 IF OLD.match_status<>'MISMATCH' OR OLD.review_status<>'OPEN'
    OR NEW.review_status NOT IN ('RESOLVED','WAIVED')
    OR NEW.reviewed_by_user_id IS DISTINCT FROM factoryos_current_user_id()
    OR NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id=fact_actor
    OR length(btrim(COALESCE(NEW.review_reason,'')))<8 OR NEW.reviewed_at IS NULL THEN
   RAISE EXCEPTION 'Only a different authorized reviewer may resolve an open mismatch with a reason'
     USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_finance_fact_reconciliations_guard
 BEFORE INSERT OR UPDATE OR DELETE ON finance_fact_reconciliations
 FOR EACH ROW EXECUTE FUNCTION factoryos_guard_finance_fact_reconciliation();

CREATE OR REPLACE FUNCTION factoryos_guard_finance_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Finance connector history is append-only' USING ERRCODE='55000';
END $$;
CREATE TRIGGER trg_finance_connector_history_append_only
 BEFORE UPDATE OR DELETE ON finance_connector_history
 FOR EACH ROW EXECUTE FUNCTION factoryos_guard_finance_append_only();

DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY[
  'finance_connectors','finance_connector_runs','financial_facts',
  'finance_fact_reconciliations','finance_connector_history'
 ] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I',t||'_tenant_isolation',t);
  EXECUTE format(
   'CREATE POLICY %I ON %I USING (tenant_id=factoryos_current_tenant_id()) WITH CHECK (tenant_id=factoryos_current_tenant_id())',
   t||'_tenant_isolation',t
  );
 END LOOP;
END $$;

INSERT INTO schema_migrations(version,checksum)
VALUES('114_finance_integration_contract',NULL)
ON CONFLICT(version) DO NOTHING;

COMMIT;
