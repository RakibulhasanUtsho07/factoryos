BEGIN;

-- FactoryOS Commercial-to-Cash / FR-FIN-01
-- Versioned quotation terms, pricing policies, FX-rate provenance,
-- maker-checker approval history and an atomic quotation-to-order bridge.

INSERT INTO permissions (code, description)
VALUES
  ('quotations.read', 'Read customer quotations within the authorized tenant and factory'),
  ('quotations.write', 'Create and revise customer quotations within the authorized tenant and factory'),
  ('quotations.approve', 'Independently approve or reject submitted customer quotations'),
  ('quotations.send', 'Record that an approved customer quotation was sent'),
  ('quotations.accept', 'Record customer acceptance of a sent quotation'),
  ('quotations.convert', 'Convert an accepted quotation into a manufacturing order'),
  ('quotation_rules.read', 'Read versioned commercial pricing and approval rules'),
  ('quotation_rules.write', 'Create a new version of commercial pricing and approval rules'),
  ('exchange_rates.read', 'Read tenant and factory scoped commercial exchange-rate history'),
  ('exchange_rates.write', 'Record a sourced commercial exchange rate')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
  AND p.code IN (
    'quotations.read', 'quotations.write', 'quotations.approve',
    'quotations.send', 'quotations.accept', 'quotations.convert',
    'quotation_rules.read', 'quotation_rules.write',
    'exchange_rates.read', 'exchange_rates.write'
  )
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'FACTORY_MANAGER'
  AND r.is_system = false
  AND p.code IN (
    'quotations.read', 'quotations.write', 'quotations.send',
    'quotations.accept', 'quotations.convert',
    'quotation_rules.read', 'exchange_rates.read'
  )
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE TABLE commercial_pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  rule_code varchar(80) NOT NULL,
  customer_reference varchar(255),
  version integer NOT NULL,
  base_currency varchar(3) NOT NULL DEFAULT 'BDT',
  allowed_currencies varchar(3)[] NOT NULL DEFAULT ARRAY['BDT']::varchar(3)[],
  default_tax_percent numeric(5,2) NOT NULL DEFAULT 0,
  max_discount_percent numeric(5,2) NOT NULL DEFAULT 0,
  approval_required boolean NOT NULL DEFAULT true,
  approval_total_threshold numeric(18,4),
  approval_discount_threshold_percent numeric(5,2) NOT NULL DEFAULT 0,
  incoterms_required boolean NOT NULL DEFAULT false,
  payment_terms_required boolean NOT NULL DEFAULT false,
  is_current boolean NOT NULL DEFAULT true,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_commercial_pricing_rules_id_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT fk_commercial_pricing_rules_factory FOREIGN KEY (factory_id, tenant_id)
    REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_commercial_pricing_rules_creator FOREIGN KEY (created_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT uq_commercial_pricing_rules_version UNIQUE (tenant_id, factory_id, rule_code, version),
  CONSTRAINT chk_commercial_pricing_rules_version CHECK (version > 0),
  CONSTRAINT chk_commercial_pricing_rules_code CHECK (length(btrim(rule_code)) > 0),
  CONSTRAINT chk_commercial_pricing_rules_base_currency CHECK (base_currency = upper(base_currency) AND base_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_commercial_pricing_rules_allowed_currencies CHECK (
    cardinality(allowed_currencies) > 0
    AND array_position(allowed_currencies, NULL) IS NULL
    AND NOT EXISTS (SELECT 1 FROM unnest(allowed_currencies) c WHERE c !~ '^[A-Z]{3}$')
  ),
  CONSTRAINT chk_commercial_pricing_rules_tax CHECK (default_tax_percent BETWEEN 0 AND 100),
  CONSTRAINT chk_commercial_pricing_rules_discount CHECK (max_discount_percent BETWEEN 0 AND 100),
  CONSTRAINT chk_commercial_pricing_rules_approval_discount CHECK (approval_discount_threshold_percent BETWEEN 0 AND 100),
  CONSTRAINT chk_commercial_pricing_rules_approval_total CHECK (approval_total_threshold IS NULL OR approval_total_threshold >= 0)
);

CREATE UNIQUE INDEX uq_commercial_pricing_rules_current_scope
  ON commercial_pricing_rules (
    tenant_id, factory_id, COALESCE(lower(customer_reference), '')
  )
  WHERE is_current = true;

CREATE INDEX idx_commercial_pricing_rules_lookup
  ON commercial_pricing_rules (
    tenant_id, factory_id, is_current, lower(customer_reference), created_at DESC
  );

CREATE TABLE commercial_exchange_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  base_currency varchar(3) NOT NULL,
  quote_currency varchar(3) NOT NULL,
  rate_to_base numeric(20,10) NOT NULL,
  effective_on date NOT NULL,
  source varchar(120) NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_commercial_exchange_rates_id_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT fk_commercial_exchange_rates_factory FOREIGN KEY (factory_id, tenant_id)
    REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_commercial_exchange_rates_creator FOREIGN KEY (created_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT uq_commercial_exchange_rates_effective_source
    UNIQUE (tenant_id, factory_id, base_currency, quote_currency, effective_on, source),
  CONSTRAINT chk_commercial_exchange_rates_codes CHECK (
    base_currency = upper(base_currency) AND base_currency ~ '^[A-Z]{3}$'
    AND quote_currency = upper(quote_currency) AND quote_currency ~ '^[A-Z]{3}$'
    AND base_currency <> quote_currency
  ),
  CONSTRAINT chk_commercial_exchange_rates_positive CHECK (rate_to_base > 0),
  CONSTRAINT chk_commercial_exchange_rates_source CHECK (length(btrim(source)) > 0)
);

CREATE INDEX idx_commercial_exchange_rates_latest
  ON commercial_exchange_rates (
    tenant_id, factory_id, base_currency, quote_currency, effective_on DESC, created_at DESC
  );

CREATE TABLE sales_quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  quote_number varchar(100) NOT NULL,
  customer_name varchar(255) NOT NULL,
  customer_reference varchar(255),
  status varchar(30) NOT NULL DEFAULT 'DRAFT',
  current_revision integer NOT NULL DEFAULT 1,
  version bigint NOT NULL DEFAULT 1,
  converted_order_id uuid REFERENCES orders(id) ON DELETE RESTRICT,
  idempotency_key varchar(255),
  request_hash char(64),
  created_by_user_id uuid NOT NULL,
  updated_by_user_id uuid NOT NULL,
  last_change_reason text NOT NULL DEFAULT 'Draft quotation created',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_sales_quotations_id_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_sales_quotations_scope_number UNIQUE (tenant_id, factory_id, quote_number),
  CONSTRAINT uq_sales_quotations_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_sales_quotations_factory FOREIGN KEY (factory_id, tenant_id)
    REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_quotations_creator FOREIGN KEY (created_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_quotations_updater FOREIGN KEY (updated_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_sales_quotations_status CHECK (
    status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SENT', 'ACCEPTED', 'CONVERTED', 'CANCELLED', 'EXPIRED')
  ),
  CONSTRAINT chk_sales_quotations_revision CHECK (current_revision > 0),
  CONSTRAINT chk_sales_quotations_version CHECK (version > 0),
  CONSTRAINT chk_sales_quotations_number CHECK (length(btrim(quote_number)) > 0),
  CONSTRAINT chk_sales_quotations_customer CHECK (length(btrim(customer_name)) > 0),
  CONSTRAINT chk_sales_quotations_idempotency_pair CHECK ((idempotency_key IS NULL) = (request_hash IS NULL))
);

CREATE INDEX idx_sales_quotations_scope_status_created
  ON sales_quotations (tenant_id, factory_id, status, created_at DESC, id DESC);

CREATE INDEX idx_sales_quotations_customer_reference
  ON sales_quotations (tenant_id, factory_id, lower(customer_reference));

CREATE TABLE quotation_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  quotation_id uuid NOT NULL,
  revision_number integer NOT NULL,
  currency varchar(3) NOT NULL,
  base_currency varchar(3) NOT NULL,
  exchange_rate_to_base numeric(20,10) NOT NULL,
  exchange_rate_as_of date NOT NULL,
  exchange_rate_source varchar(120) NOT NULL,
  requested_delivery_date date,
  valid_until date,
  incoterms varchar(80),
  payment_terms varchar(255),
  notes text,
  subtotal numeric(18,4) NOT NULL,
  discount_total numeric(18,4) NOT NULL,
  tax_total numeric(18,4) NOT NULL,
  total numeric(18,4) NOT NULL,
  total_base numeric(18,4) NOT NULL,
  default_tax_percent numeric(5,2) NOT NULL,
  max_discount_percent numeric(5,2) NOT NULL,
  approval_required boolean NOT NULL,
  approval_total_threshold numeric(18,4),
  approval_discount_threshold_percent numeric(5,2) NOT NULL,
  pricing_rule_id uuid,
  pricing_rule_version integer,
  pricing_rule_code varchar(80) NOT NULL,
  pricing_rule_snapshot jsonb NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_quotation_versions_id_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_quotation_versions_revision UNIQUE (quotation_id, revision_number),
  CONSTRAINT fk_quotation_versions_quote_scope FOREIGN KEY (quotation_id, tenant_id, factory_id)
    REFERENCES sales_quotations(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quotation_versions_rule_scope FOREIGN KEY (pricing_rule_id, tenant_id, factory_id)
    REFERENCES commercial_pricing_rules(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quotation_versions_creator FOREIGN KEY (created_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quotation_versions_revision CHECK (revision_number > 0),
  CONSTRAINT chk_quotation_versions_currency CHECK (
    currency = upper(currency) AND currency ~ '^[A-Z]{3}$'
    AND base_currency = upper(base_currency) AND base_currency ~ '^[A-Z]{3}$'
  ),
  CONSTRAINT chk_quotation_versions_fx CHECK (exchange_rate_to_base > 0 AND length(btrim(exchange_rate_source)) > 0),
  CONSTRAINT chk_quotation_versions_money CHECK (subtotal >= 0 AND discount_total >= 0 AND tax_total >= 0 AND total >= 0 AND total_base >= 0),
  CONSTRAINT chk_quotation_versions_discount CHECK (max_discount_percent BETWEEN 0 AND 100 AND approval_discount_threshold_percent BETWEEN 0 AND 100),
  CONSTRAINT chk_quotation_versions_tax CHECK (default_tax_percent BETWEEN 0 AND 100),
  CONSTRAINT chk_quotation_versions_rule_pair CHECK ((pricing_rule_id IS NULL) = (pricing_rule_version IS NULL))
);

CREATE INDEX idx_quotation_versions_quote_revision
  ON quotation_versions (tenant_id, factory_id, quotation_id, revision_number DESC);

CREATE TABLE quotation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  quotation_id uuid NOT NULL,
  quotation_version_id uuid NOT NULL,
  line_number integer NOT NULL,
  product_code varchar(100) NOT NULL,
  product_name varchar(255) NOT NULL,
  quantity numeric(18,4) NOT NULL,
  unit varchar(50) NOT NULL,
  unit_price numeric(18,4) NOT NULL,
  discount_percent numeric(5,2) NOT NULL,
  tax_percent numeric(5,2) NOT NULL,
  line_subtotal numeric(18,4) NOT NULL,
  line_discount numeric(18,4) NOT NULL,
  line_tax numeric(18,4) NOT NULL,
  line_total numeric(18,4) NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_quotation_lines_id_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_quotation_lines_version_line UNIQUE (quotation_version_id, line_number),
  CONSTRAINT fk_quotation_lines_quote_scope FOREIGN KEY (quotation_id, tenant_id, factory_id)
    REFERENCES sales_quotations(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quotation_lines_version_scope FOREIGN KEY (quotation_version_id, tenant_id, factory_id)
    REFERENCES quotation_versions(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT chk_quotation_lines_number CHECK (line_number > 0),
  CONSTRAINT chk_quotation_lines_product CHECK (length(btrim(product_code)) > 0 AND length(btrim(product_name)) > 0),
  CONSTRAINT chk_quotation_lines_quantity CHECK (quantity > 0),
  CONSTRAINT chk_quotation_lines_unit CHECK (length(btrim(unit)) > 0),
  CONSTRAINT chk_quotation_lines_price CHECK (unit_price >= 0),
  CONSTRAINT chk_quotation_lines_percentages CHECK (discount_percent BETWEEN 0 AND 100 AND tax_percent BETWEEN 0 AND 100),
  CONSTRAINT chk_quotation_lines_money CHECK (line_subtotal >= 0 AND line_discount >= 0 AND line_tax >= 0 AND line_total >= 0)
);

CREATE INDEX idx_quotation_lines_quote_revision
  ON quotation_lines (tenant_id, factory_id, quotation_id, quotation_version_id, line_number);

CREATE TABLE quotation_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  quotation_id uuid NOT NULL,
  revision_number integer NOT NULL,
  from_status varchar(30),
  to_status varchar(30) NOT NULL,
  action varchar(30) NOT NULL,
  actor_user_id uuid NOT NULL,
  reason text NOT NULL,
  request_id uuid,
  trace_id uuid,
  order_id uuid REFERENCES orders(id) ON DELETE RESTRICT,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_quotation_history_quote_scope FOREIGN KEY (quotation_id, tenant_id, factory_id)
    REFERENCES sales_quotations(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_quotation_history_actor FOREIGN KEY (actor_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_quotation_history_revision CHECK (revision_number > 0),
  CONSTRAINT chk_quotation_history_action CHECK (
    action IN ('CREATED', 'REVISED', 'SUBMITTED', 'AUTO_APPROVED', 'APPROVED', 'REJECTED', 'SENT', 'ACCEPTED', 'CONVERTED', 'CANCELLED', 'EXPIRED')
  ),
  CONSTRAINT chk_quotation_history_reason CHECK (length(btrim(reason)) > 0)
);

CREATE INDEX idx_quotation_history_quote_timeline
  ON quotation_history (tenant_id, factory_id, quotation_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_commercial_pricing_rule()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Commercial pricing rule versions are retained; create a new version instead'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
     OR NEW.rule_code IS DISTINCT FROM OLD.rule_code
     OR NEW.customer_reference IS DISTINCT FROM OLD.customer_reference
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.base_currency IS DISTINCT FROM OLD.base_currency
     OR NEW.allowed_currencies IS DISTINCT FROM OLD.allowed_currencies
     OR NEW.default_tax_percent IS DISTINCT FROM OLD.default_tax_percent
     OR NEW.max_discount_percent IS DISTINCT FROM OLD.max_discount_percent
     OR NEW.approval_required IS DISTINCT FROM OLD.approval_required
     OR NEW.approval_total_threshold IS DISTINCT FROM OLD.approval_total_threshold
     OR NEW.approval_discount_threshold_percent IS DISTINCT FROM OLD.approval_discount_threshold_percent
     OR NEW.incoterms_required IS DISTINCT FROM OLD.incoterms_required
     OR NEW.payment_terms_required IS DISTINCT FROM OLD.payment_terms_required
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Commercial rule terms are immutable; create a new version'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.is_current = false AND NEW.is_current = true THEN
    RAISE EXCEPTION 'A superseded commercial rule version cannot be reactivated'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_commercial_pricing_rules_guard
BEFORE UPDATE OR DELETE ON commercial_pricing_rules
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_commercial_pricing_rule();

CREATE OR REPLACE FUNCTION factoryos_prevent_commercial_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Commercial rate, quotation revision, quotation line and history records are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_commercial_exchange_rates_append_only
BEFORE UPDATE OR DELETE ON commercial_exchange_rates
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_commercial_evidence_mutation();

CREATE TRIGGER trg_quotation_versions_append_only
BEFORE UPDATE OR DELETE ON quotation_versions
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_commercial_evidence_mutation();

CREATE TRIGGER trg_quotation_lines_append_only
BEFORE UPDATE OR DELETE ON quotation_lines
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_commercial_evidence_mutation();

CREATE TRIGGER trg_quotation_history_append_only
BEFORE UPDATE OR DELETE ON quotation_history
FOR EACH ROW EXECUTE FUNCTION factoryos_prevent_commercial_evidence_mutation();

CREATE OR REPLACE FUNCTION factoryos_guard_sales_quotation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_order_scope_ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Quotations cannot be deleted; use a lifecycle transition'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.version <> 1 OR NEW.current_revision <> 1
       OR NEW.converted_order_id IS NOT NULL
       OR NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'Quotations must begin as version-one drafts under the authenticated creator'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
     OR NEW.quote_number IS DISTINCT FROM OLD.quote_number
     OR NEW.customer_name IS DISTINCT FROM OLD.customer_name
     OR NEW.customer_reference IS DISTINCT FROM OLD.customer_reference
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash THEN
    RAISE EXCEPTION 'Quotation identity, customer and creator provenance are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.version <> OLD.version + 1
     OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
     OR length(btrim(COALESCE(NEW.last_change_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'Quotation changes require the authenticated actor, a reason and exactly one version increment'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.current_revision < OLD.current_revision
     OR NEW.current_revision > OLD.current_revision + 1 THEN
    RAISE EXCEPTION 'Quotation revision must stay the same or increment by exactly one'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.current_revision = OLD.current_revision + 1
     AND NOT (OLD.status IN ('DRAFT', 'REJECTED') AND NEW.status = 'DRAFT') THEN
    RAISE EXCEPTION 'A quotation can be revised only while draft or rejected, and revision returns to draft'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'DRAFT' AND NEW.status IN ('PENDING_APPROVAL', 'APPROVED', 'CANCELLED')) OR
    (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('APPROVED', 'REJECTED', 'CANCELLED')) OR
    (OLD.status = 'REJECTED' AND NEW.status IN ('DRAFT', 'CANCELLED')) OR
    (OLD.status = 'APPROVED' AND NEW.status IN ('SENT', 'CANCELLED')) OR
    (OLD.status = 'SENT' AND NEW.status IN ('ACCEPTED', 'CANCELLED', 'EXPIRED')) OR
    (OLD.status = 'ACCEPTED' AND NEW.status IN ('CONVERTED', 'EXPIRED'))
  ) THEN
    RAISE EXCEPTION 'Invalid quotation lifecycle transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF OLD.converted_order_id IS NOT NULL
     AND NEW.converted_order_id IS DISTINCT FROM OLD.converted_order_id THEN
    RAISE EXCEPTION 'A converted order link is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'CONVERTED' THEN
    IF OLD.status <> 'ACCEPTED' OR OLD.converted_order_id IS NOT NULL OR NEW.converted_order_id IS NULL THEN
      RAISE EXCEPTION 'Only an accepted quotation can be converted once'
        USING ERRCODE = '23514';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = NEW.converted_order_id
        AND o.tenant_id = NEW.tenant_id
        AND o.factory_id = NEW.factory_id
    ) INTO v_order_scope_ok;
    IF NOT v_order_scope_ok THEN
      RAISE EXCEPTION 'Converted order must belong to the same tenant and factory'
        USING ERRCODE = '23503';
    END IF;
  ELSIF NEW.converted_order_id IS DISTINCT FROM OLD.converted_order_id THEN
    RAISE EXCEPTION 'An order link may only be set during conversion'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sales_quotations_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON sales_quotations
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_sales_quotation();

CREATE OR REPLACE FUNCTION factoryos_guard_quotation_history_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_creator uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Quotation history is append-only' USING ERRCODE = '55000';
  END IF;
  IF NEW.actor_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Quotation history actor must match authenticated database context' USING ERRCODE = '42501';
  END IF;
  SELECT created_by_user_id INTO v_creator
  FROM sales_quotations
  WHERE id = NEW.quotation_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
  IF NEW.action IN ('APPROVED', 'REJECTED') AND NEW.actor_user_id = v_creator THEN
    RAISE EXCEPTION 'Quotation creator cannot approve or reject their own quotation' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_quotation_history_actor
BEFORE INSERT OR UPDATE OR DELETE ON quotation_history
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quotation_history_actor();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'commercial_pricing_rules',
    'commercial_exchange_rates',
    'sales_quotations',
    'quotation_versions',
    'quotation_lines',
    'quotation_history'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = factoryos_current_tenant_id()) WITH CHECK (tenant_id = factoryos_current_tenant_id())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END;
$$;

COMMIT;