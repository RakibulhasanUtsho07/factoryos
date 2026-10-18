BEGIN;

-- FR-FIN-02 / AS-61: deterministic, evidence-backed should-cost calculations.
INSERT INTO permissions (code, description)
VALUES
  ('should_cost.profiles.read', 'Read factory-scoped should-cost profile versions and component formulas'),
  ('should_cost.profiles.write', 'Create new versioned should-cost profiles and their component policies'),
  ('should_cost.profiles.submit', 'Submit a complete should-cost profile for independent approval'),
  ('should_cost.profiles.approve', 'Independently approve or reject a should-cost profile version'),
  ('should_cost.assessments.read', 'Read should-cost assessments and immutable calculation evidence'),
  ('should_cost.assessments.calculate', 'Calculate and record evidence-backed should-cost assessments')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
  AND p.code IN (
    'should_cost.profiles.read', 'should_cost.profiles.write',
    'should_cost.profiles.submit', 'should_cost.profiles.approve',
    'should_cost.assessments.read', 'should_cost.assessments.calculate'
  )
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'FACTORY_MANAGER'
  AND r.is_system = false
  AND p.code IN (
    'should_cost.profiles.read', 'should_cost.profiles.write',
    'should_cost.profiles.submit', 'should_cost.assessments.read',
    'should_cost.assessments.calculate'
  )
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE OR REPLACE FUNCTION factoryos_should_cost_category_order(p_category text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_category
    WHEN 'MATERIAL' THEN 1
    WHEN 'LABOUR' THEN 2
    WHEN 'ENERGY' THEN 3
    WHEN 'FREIGHT' THEN 4
    WHEN 'DUTY' THEN 5
    WHEN 'OVERHEAD' THEN 6
    WHEN 'SCRAP' THEN 7
    ELSE 0
  END;
$$;

CREATE OR REPLACE FUNCTION factoryos_should_cost_profile_component_valid(
  p_category text,
  p_method text,
  p_base_categories text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    factoryos_should_cost_category_order(p_category) > 0
    AND CASE p_category
      WHEN 'MATERIAL' THEN p_method = 'DIRECT_RATE'
      WHEN 'LABOUR' THEN p_method = 'DIRECT_RATE'
      WHEN 'ENERGY' THEN p_method = 'DIRECT_RATE'
      WHEN 'FREIGHT' THEN p_method IN ('DIRECT_RATE', 'FIXED_PER_BATCH')
      WHEN 'DUTY' THEN p_method IN ('DIRECT_RATE', 'PERCENT_OF_BASE')
      WHEN 'OVERHEAD' THEN p_method IN ('DIRECT_RATE', 'FIXED_PER_BATCH', 'PERCENT_OF_BASE')
      WHEN 'SCRAP' THEN p_method IN ('DIRECT_RATE', 'SCRAP_GROSS_UP')
      ELSE false
    END
    AND p_base_categories IS NOT NULL
    AND array_position(p_base_categories, NULL) IS NULL
    AND cardinality(p_base_categories) = cardinality(ARRAY(SELECT DISTINCT x FROM unnest(p_base_categories) x))
    AND (
      (p_method IN ('PERCENT_OF_BASE', 'SCRAP_GROSS_UP')
        AND cardinality(p_base_categories) > 0
        AND NOT EXISTS (
          SELECT 1 FROM unnest(p_base_categories) b
          WHERE factoryos_should_cost_category_order(b) = 0
             OR factoryos_should_cost_category_order(b) >= factoryos_should_cost_category_order(p_category)
        ))
      OR
      (p_method NOT IN ('PERCENT_OF_BASE', 'SCRAP_GROSS_UP') AND cardinality(p_base_categories) = 0)
    );
$$;

CREATE TABLE should_cost_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  product_id uuid,
  profile_code varchar(100) NOT NULL,
  version integer NOT NULL,
  currency varchar(3) NOT NULL,
  output_unit varchar(50) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'DRAFT',
  is_current boolean NOT NULL DEFAULT false,
  row_version bigint NOT NULL DEFAULT 1,
  idempotency_key varchar(255) NOT NULL,
  request_hash char(64) NOT NULL,
  created_by_user_id uuid NOT NULL,
  updated_by_user_id uuid NOT NULL,
  submitted_by_user_id uuid,
  approved_by_user_id uuid,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_at timestamptz,
  approved_at timestamptz,
  CONSTRAINT uq_should_cost_profile_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_should_cost_profile_version UNIQUE (tenant_id, factory_id, profile_code, product_id, version),
  CONSTRAINT uq_should_cost_profile_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_should_cost_profile_factory FOREIGN KEY (factory_id, tenant_id)
    REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_should_cost_profile_product FOREIGN KEY (product_id, tenant_id, factory_id)
    REFERENCES product_definitions(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_should_cost_profile_creator FOREIGN KEY (created_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_should_cost_profile_updater FOREIGN KEY (updated_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_should_cost_profile_submitter FOREIGN KEY (submitted_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_should_cost_profile_approver FOREIGN KEY (approved_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_should_cost_profile_code CHECK (length(btrim(profile_code)) > 0),
  CONSTRAINT chk_should_cost_profile_version CHECK (version > 0 AND row_version > 0),
  CONSTRAINT chk_should_cost_profile_currency CHECK (currency = upper(currency) AND currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_should_cost_profile_unit CHECK (length(btrim(output_unit)) > 0),
  CONSTRAINT chk_should_cost_profile_status CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED')),
  CONSTRAINT chk_should_cost_profile_decision CHECK (
    (status <> 'APPROVED' OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL AND length(btrim(COALESCE(decision_reason,''))) > 0))
    AND (status <> 'PENDING_APPROVAL' OR (submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL))
    AND (status <> 'REJECTED' OR length(btrim(COALESCE(decision_reason,''))) > 0)
  ),
  CONSTRAINT chk_should_cost_profile_idempotency CHECK (
    length(btrim(idempotency_key)) > 0 AND request_hash ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX uq_should_cost_profile_current_scope
  ON should_cost_profiles (tenant_id, factory_id, lower(profile_code), COALESCE(product_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_current = true;

CREATE UNIQUE INDEX uq_should_cost_profile_version_null_safe
  ON should_cost_profiles (tenant_id, factory_id, lower(profile_code), COALESCE(product_id, '00000000-0000-0000-0000-000000000000'::uuid), version);

CREATE INDEX idx_should_cost_profiles_scope_status
  ON should_cost_profiles (tenant_id, factory_id, status, profile_code, version DESC);

CREATE TABLE should_cost_profile_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  category varchar(20) NOT NULL,
  calculation_method varchar(24) NOT NULL,
  is_required boolean NOT NULL DEFAULT true,
  base_categories varchar(20)[] NOT NULL DEFAULT ARRAY[]::varchar(20)[],
  guidance text NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_should_cost_profile_component_category UNIQUE (profile_id, category),
  CONSTRAINT uq_should_cost_profile_component_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT fk_should_cost_profile_component_profile FOREIGN KEY (profile_id, tenant_id, factory_id)
    REFERENCES should_cost_profiles(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_should_cost_profile_component_creator FOREIGN KEY (created_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_should_cost_profile_component_config CHECK (
    factoryos_should_cost_profile_component_valid(category, calculation_method, base_categories)
  ),
  CONSTRAINT chk_should_cost_profile_component_guidance CHECK (length(btrim(guidance)) > 0)
);

CREATE INDEX idx_should_cost_profile_components_profile
  ON should_cost_profile_components (tenant_id, factory_id, profile_id, category);

CREATE TABLE should_cost_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  scope_type varchar(24) NOT NULL,
  scope_id uuid NOT NULL,
  product_id uuid,
  product_version_id uuid,
  order_id uuid,
  quotation_id uuid,
  quotation_revision_number integer,
  profile_id uuid NOT NULL,
  profile_version integer NOT NULL,
  profile_code varchar(100) NOT NULL,
  target_quantity numeric(18,4) NOT NULL,
  target_unit varchar(50) NOT NULL,
  currency varchar(3) NOT NULL,
  total_cost numeric(20,4) NOT NULL,
  cost_per_unit numeric(20,8) NOT NULL,
  component_totals jsonb NOT NULL,
  revenue_source_currency varchar(3),
  revenue_amount numeric(20,4),
  revenue_fx_snapshot jsonb,
  gross_margin_amount numeric(20,4),
  gross_margin_percent numeric(12,6),
  request_snapshot jsonb NOT NULL,
  request_hash char(64) NOT NULL,
  idempotency_key varchar(255) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'READY',
  calculated_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_should_cost_assessment_scope UNIQUE (id, tenant_id, factory_id),
  CONSTRAINT uq_should_cost_assessment_idempotency UNIQUE (tenant_id, factory_id, idempotency_key),
  CONSTRAINT fk_should_cost_assessment_factory FOREIGN KEY (factory_id, tenant_id)
    REFERENCES factories(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_should_cost_assessment_profile FOREIGN KEY (profile_id, tenant_id, factory_id)
    REFERENCES should_cost_profiles(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_should_cost_assessment_product_version FOREIGN KEY (product_version_id, tenant_id, factory_id, product_id)
    REFERENCES product_versions(id, tenant_id, factory_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT fk_should_cost_assessment_order FOREIGN KEY (order_id, tenant_id, factory_id)
    REFERENCES orders(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_should_cost_assessment_quotation FOREIGN KEY (quotation_id, tenant_id, factory_id)
    REFERENCES sales_quotations(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_should_cost_assessment_calculator FOREIGN KEY (calculated_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_should_cost_assessment_scope CHECK (
    (scope_type = 'PRODUCT_VERSION' AND scope_id = product_version_id AND product_id IS NOT NULL
      AND product_version_id IS NOT NULL AND order_id IS NULL AND quotation_id IS NULL AND quotation_revision_number IS NULL)
    OR
    (scope_type = 'ORDER' AND scope_id = order_id AND order_id IS NOT NULL
      AND product_version_id IS NULL AND product_id IS NULL AND quotation_id IS NULL AND quotation_revision_number IS NULL)
    OR
    (scope_type = 'QUOTATION' AND scope_id = quotation_id AND quotation_id IS NOT NULL
      AND product_version_id IS NULL AND product_id IS NULL AND order_id IS NULL
      AND quotation_revision_number > 0)
  ),
  CONSTRAINT chk_should_cost_assessment_quantity CHECK (target_quantity > 0 AND length(btrim(target_unit)) > 0),
  CONSTRAINT chk_should_cost_assessment_currency CHECK (currency = upper(currency) AND currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_should_cost_assessment_money CHECK (
    total_cost >= 0 AND cost_per_unit >= 0
    AND ((revenue_amount IS NULL AND gross_margin_amount IS NULL AND gross_margin_percent IS NULL)
      OR (revenue_amount >= 0 AND gross_margin_amount IS NOT NULL))
  ),
  CONSTRAINT chk_should_cost_assessment_status CHECK (status = 'READY'),
  CONSTRAINT chk_should_cost_assessment_hash CHECK (
    request_hash ~ '^[a-f0-9]{64}$' AND length(btrim(idempotency_key)) > 0
  )
);

CREATE INDEX idx_should_cost_assessments_scope
  ON should_cost_assessments (tenant_id, factory_id, scope_type, scope_id, created_at DESC, id DESC);
CREATE INDEX idx_should_cost_assessments_quote_gate
  ON should_cost_assessments (tenant_id, factory_id, quotation_id, quotation_revision_number, created_at DESC)
  WHERE status = 'READY';

CREATE TABLE should_cost_component_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  assessment_id uuid NOT NULL,
  category varchar(20) NOT NULL,
  line_number integer NOT NULL,
  applicable boolean NOT NULL DEFAULT true,
  calculation_method varchar(24) NOT NULL,
  input_quantity numeric(20,6),
  unit_code varchar(50),
  unit_rate numeric(20,8),
  fixed_amount numeric(20,4),
  percentage_rate numeric(9,4),
  source_currency varchar(3),
  fx_rate_to_cost_currency numeric(20,10),
  fx_rate_effective_on date,
  fx_rate_source varchar(160),
  source_amount numeric(20,4),
  cost_amount numeric(20,4) NOT NULL,
  base_categories varchar(20)[] NOT NULL DEFAULT ARRAY[]::varchar(20)[],
  base_amount numeric(20,4),
  source_type varchar(32) NOT NULL,
  source_reference varchar(500),
  source_as_of date,
  notes text NOT NULL,
  source_snapshot jsonb NOT NULL,
  evidence_hash char(64) NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_should_cost_component_evidence_line UNIQUE (assessment_id, category, line_number),
  CONSTRAINT fk_should_cost_component_evidence_assessment FOREIGN KEY (assessment_id, tenant_id, factory_id)
    REFERENCES should_cost_assessments(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_should_cost_component_evidence_creator FOREIGN KEY (created_by_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_should_cost_component_evidence_category CHECK (factoryos_should_cost_category_order(category) > 0),
  CONSTRAINT chk_should_cost_component_evidence_line CHECK (line_number > 0),
  CONSTRAINT chk_should_cost_component_evidence_method CHECK (
    calculation_method IN ('DIRECT_RATE', 'FIXED_PER_BATCH', 'PERCENT_OF_BASE', 'SCRAP_GROSS_UP')
  ),
  CONSTRAINT chk_should_cost_component_evidence_money CHECK (cost_amount >= 0 AND (source_amount IS NULL OR source_amount >= 0)),
  CONSTRAINT chk_should_cost_component_evidence_hash CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_should_cost_component_evidence_notes CHECK (length(btrim(notes)) > 0),
  CONSTRAINT chk_should_cost_component_evidence_source CHECK (
    (applicable = false AND source_type = 'NOT_APPLICABLE' AND source_reference IS NULL
      AND input_quantity IS NULL AND unit_rate IS NULL AND fixed_amount IS NULL AND percentage_rate IS NULL
      AND source_currency IS NULL AND fx_rate_to_cost_currency IS NULL AND source_as_of IS NULL)
    OR
    (applicable = true AND source_type <> 'NOT_APPLICABLE' AND source_reference IS NOT NULL
      AND length(btrim(source_reference)) > 0 AND source_as_of IS NOT NULL)
  ),
  CONSTRAINT chk_should_cost_component_evidence_fx CHECK (
    (source_currency IS NULL AND fx_rate_to_cost_currency IS NULL AND fx_rate_effective_on IS NULL AND fx_rate_source IS NULL)
    OR
    (source_currency = upper(source_currency) AND source_currency ~ '^[A-Z]{3}$'
      AND fx_rate_to_cost_currency > 0 AND fx_rate_effective_on IS NOT NULL
      AND length(btrim(COALESCE(fx_rate_source,''))) > 0)
  )
);

CREATE INDEX idx_should_cost_evidence_assessment
  ON should_cost_component_evidence (tenant_id, factory_id, assessment_id, category, line_number);

CREATE TABLE should_cost_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  factory_id uuid NOT NULL,
  profile_id uuid,
  assessment_id uuid,
  action varchar(32) NOT NULL,
  actor_user_id uuid NOT NULL,
  reason text NOT NULL,
  request_id uuid,
  trace_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_should_cost_history_profile FOREIGN KEY (profile_id, tenant_id, factory_id)
    REFERENCES should_cost_profiles(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_should_cost_history_assessment FOREIGN KEY (assessment_id, tenant_id, factory_id)
    REFERENCES should_cost_assessments(id, tenant_id, factory_id) ON DELETE RESTRICT,
  CONSTRAINT fk_should_cost_history_actor FOREIGN KEY (actor_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_should_cost_history_subject CHECK ((profile_id IS NOT NULL) <> (assessment_id IS NOT NULL)),
  CONSTRAINT chk_should_cost_history_action CHECK (action IN (
    'PROFILE_CREATED','PROFILE_SUBMITTED','PROFILE_APPROVED','PROFILE_REJECTED','ASSESSMENT_CREATED'
  )),
  CONSTRAINT chk_should_cost_history_reason CHECK (length(btrim(reason)) > 0)
);
CREATE INDEX idx_should_cost_history_profile
  ON should_cost_history (tenant_id, factory_id, profile_id, created_at DESC)
  WHERE profile_id IS NOT NULL;
CREATE INDEX idx_should_cost_history_assessment
  ON should_cost_history (tenant_id, factory_id, assessment_id, created_at DESC)
  WHERE assessment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION factoryos_guard_should_cost_profile()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_categories integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Should-cost profile versions are retained; create a new version instead'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.is_current OR NEW.row_version <> 1
       OR NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
      RAISE EXCEPTION 'Should-cost profiles must begin as draft versions under the authenticated creator'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.profile_code IS DISTINCT FROM OLD.profile_code
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.output_unit IS DISTINCT FROM OLD.output_unit
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Should-cost profile definition fields are immutable; create a new version'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.updated_by_user_id IS DISTINCT FROM factoryos_current_user_id()
     OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'Profile transitions require the authenticated actor and one row-version increment'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.is_current AND NOT NEW.is_current THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id
       OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
       OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason THEN
      RAISE EXCEPTION 'Superseding a should-cost profile only retires its current pointer'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.is_current AND NOT OLD.is_current AND OLD.status <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'Only an approved transition can publish a current should-cost profile'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'DRAFT' AND NEW.status = 'PENDING_APPROVAL') OR
    (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('APPROVED','REJECTED'))
  ) THEN
    RAISE EXCEPTION 'Invalid should-cost profile transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'PENDING_APPROVAL' AND OLD.status <> 'PENDING_APPROVAL' THEN
    IF NEW.submitted_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.submitted_at IS NULL OR length(btrim(COALESCE(NEW.decision_reason,''))) = 0 THEN
      RAISE EXCEPTION 'Profile submission requires the authenticated submitter and reason'
        USING ERRCODE = '42501';
    END IF;
    SELECT count(*) INTO v_categories
    FROM should_cost_profile_components
    WHERE profile_id = NEW.id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
    IF v_categories <> 7 THEN
      RAISE EXCEPTION 'A should-cost profile must configure all seven cost categories before submission'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status IN ('APPROVED','REJECTED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.approved_by_user_id IS DISTINCT FROM factoryos_current_user_id()
       OR NEW.approved_by_user_id = OLD.created_by_user_id
       OR NEW.approved_at IS NULL
       OR length(btrim(COALESCE(NEW.decision_reason,''))) = 0 THEN
      RAISE EXCEPTION 'Profile decisions require independent approval or rejection and a reason'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'APPROVED' AND NEW.is_current IS NOT TRUE THEN
      RAISE EXCEPTION 'An approved should-cost profile must be published as the current version'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'REJECTED' AND NEW.is_current THEN
      RAISE EXCEPTION 'A rejected should-cost profile cannot be current'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_should_cost_profiles_guard
BEFORE INSERT OR UPDATE OR DELETE ON should_cost_profiles
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_should_cost_profile();

CREATE OR REPLACE FUNCTION factoryos_guard_should_cost_profile_component()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Should-cost profile component formulas are immutable'
      USING ERRCODE = '55000';
  END IF;
  SELECT status INTO v_status FROM should_cost_profiles
  WHERE id = NEW.profile_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
  IF v_status <> 'DRAFT' OR NEW.created_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Component formulas can only be added to a draft profile by its authenticated actor'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_should_cost_profile_components_guard
BEFORE INSERT OR UPDATE OR DELETE ON should_cost_profile_components
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_should_cost_profile_component();

CREATE OR REPLACE FUNCTION factoryos_guard_should_cost_assessment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_profile_status text;
  v_profile_current boolean;
  v_quote_revision integer;
  v_quote_status text;
  v_order_status text;
  v_product_state text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Should-cost assessments are immutable evidence; recalculate into a new assessment instead'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.calculated_by_user_id IS DISTINCT FROM factoryos_current_user_id() OR NEW.status <> 'READY' THEN
    RAISE EXCEPTION 'Assessment actor and ready status must be set by the authenticated calculation'
      USING ERRCODE = '42501';
  END IF;

  SELECT status, is_current INTO v_profile_status, v_profile_current
  FROM should_cost_profiles
  WHERE id = NEW.profile_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
  IF v_profile_status <> 'APPROVED' OR v_profile_current IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Only the currently approved should-cost profile can be used'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.scope_type = 'PRODUCT_VERSION' THEN
    SELECT state INTO v_product_state FROM product_versions
    WHERE id = NEW.product_version_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
    IF v_product_state <> 'APPROVED' THEN
      RAISE EXCEPTION 'Product should-cost requires an approved product version'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.scope_type = 'ORDER' THEN
    SELECT status INTO v_order_status FROM orders
    WHERE id = NEW.order_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
    IF v_order_status IS NULL OR v_order_status IN ('CANCELLED','CLOSED') THEN
      RAISE EXCEPTION 'Order should-cost requires a non-cancelled order in the same factory'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.scope_type = 'QUOTATION' THEN
    SELECT current_revision, status INTO v_quote_revision, v_quote_status
    FROM sales_quotations
    WHERE id = NEW.quotation_id AND tenant_id = NEW.tenant_id AND factory_id = NEW.factory_id;
    IF v_quote_revision IS DISTINCT FROM NEW.quotation_revision_number
       OR v_quote_status IN ('CANCELLED','EXPIRED','CONVERTED') THEN
      RAISE EXCEPTION 'Quotation costing must refer to its current, live revision'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported should-cost scope type'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_should_cost_assessments_guard
BEFORE INSERT OR UPDATE OR DELETE ON should_cost_assessments
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_should_cost_assessment();

CREATE OR REPLACE FUNCTION factoryos_guard_should_cost_component_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_actor uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Should-cost calculation evidence is append-only'
      USING ERRCODE = '55000';
  END IF;
  v_actor := factoryos_current_user_id();
  IF NEW.created_by_user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Should-cost evidence actor must match authenticated database context'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_should_cost_component_evidence_guard
BEFORE INSERT OR UPDATE OR DELETE ON should_cost_component_evidence
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_should_cost_component_evidence();

CREATE OR REPLACE FUNCTION factoryos_assert_should_cost_assessment_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $
DECLARE
  v_category_count integer;
BEGIN
  SELECT count(DISTINCT e.category) INTO v_category_count
  FROM should_cost_component_evidence e
  WHERE e.assessment_id=NEW.id AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id;
  IF v_category_count <> 7 THEN
    RAISE EXCEPTION 'A READY should-cost assessment must contain evidence for all seven cost categories'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM should_cost_profile_components c
    LEFT JOIN should_cost_component_evidence e
      ON e.assessment_id=NEW.id AND e.tenant_id=NEW.tenant_id AND e.factory_id=NEW.factory_id
      AND e.category=c.category
    WHERE c.profile_id=NEW.profile_id AND c.tenant_id=NEW.tenant_id AND c.factory_id=NEW.factory_id
      AND (e.id IS NULL OR (c.is_required AND e.applicable=false))
  ) THEN
    RAISE EXCEPTION 'Required should-cost evidence is missing or marked not applicable'
      USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$;
CREATE CONSTRAINT TRIGGER trg_should_cost_assessment_evidence_complete
AFTER INSERT ON should_cost_assessments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION factoryos_assert_should_cost_assessment_evidence();

CREATE OR REPLACE FUNCTION factoryos_guard_should_cost_evidence_profile_match()
RETURNS trigger
LANGUAGE plpgsql
AS $
DECLARE
  v_method text;
  v_required boolean;
  v_base_categories varchar(20)[];
BEGIN
  SELECT c.calculation_method,c.is_required,c.base_categories
    INTO v_method,v_required,v_base_categories
  FROM should_cost_assessments a
  JOIN should_cost_profile_components c
    ON c.profile_id=a.profile_id AND c.tenant_id=a.tenant_id AND c.factory_id=a.factory_id
  WHERE a.id=NEW.assessment_id AND a.tenant_id=NEW.tenant_id AND a.factory_id=NEW.factory_id
    AND c.category=NEW.category;
  IF v_method IS NULL OR NEW.calculation_method<>v_method OR NEW.base_categories<>v_base_categories THEN
    RAISE EXCEPTION 'Cost evidence method/base must match the approved profile formula'
      USING ERRCODE='23514';
  END IF;
  IF v_required AND NEW.applicable=false THEN
    RAISE EXCEPTION 'A required should-cost category cannot be marked NOT_APPLICABLE'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$;
CREATE TRIGGER trg_should_cost_evidence_profile_match
BEFORE INSERT ON should_cost_component_evidence
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_should_cost_evidence_profile_match();

CREATE OR REPLACE FUNCTION factoryos_guard_should_cost_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Should-cost history is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.actor_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Should-cost history actor must match authenticated database context'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_should_cost_history_guard
BEFORE INSERT OR UPDATE OR DELETE ON should_cost_history
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_should_cost_history();

CREATE OR REPLACE FUNCTION factoryos_guard_quotation_should_cost_approval()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM should_cost_assessments a
      WHERE a.tenant_id = NEW.tenant_id
        AND a.factory_id = NEW.factory_id
        AND a.quotation_id = NEW.id
        AND a.quotation_revision_number = NEW.current_revision
        AND a.status = 'READY'
    ) THEN
      RAISE EXCEPTION 'Quotation approval is blocked until a complete should-cost assessment exists for the current revision'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_sales_quotations_should_cost_gate
BEFORE UPDATE OF status ON sales_quotations
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_quotation_should_cost_approval();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'should_cost_profiles',
    'should_cost_profile_components',
    'should_cost_assessments',
    'should_cost_component_evidence',
    'should_cost_history'
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

INSERT INTO schema_migrations (version, checksum)
VALUES ('113_deterministic_should_cost_engine', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
