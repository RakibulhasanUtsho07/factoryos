BEGIN;

CREATE TABLE IF NOT EXISTS factory_onboarding_step_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  factory_id UUID NOT NULL REFERENCES factories(id) ON DELETE RESTRICT,
  step_key VARCHAR(40) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  saved_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_factory_onboarding_step_scope UNIQUE (tenant_id, factory_id, step_key),
  CONSTRAINT chk_factory_onboarding_step_key CHECK (
    step_key IN ('factory_profile','sites','lines','shifts','holiday_calendar','energy_sources','role_set')
  ),
  CONSTRAINT chk_factory_onboarding_payload_object CHECK (
    jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 65536
  ),
  CONSTRAINT chk_factory_onboarding_version CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS idx_factory_onboarding_step_drafts_scope
  ON factory_onboarding_step_drafts (tenant_id, factory_id, updated_at DESC);

CREATE OR REPLACE FUNCTION factoryos_guard_onboarding_step_draft()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_factory_tenant_id UUID;
BEGIN
  SELECT tenant_id INTO v_factory_tenant_id
    FROM factories
   WHERE id = NEW.factory_id
   FOR SHARE;

  IF NOT FOUND OR v_factory_tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Onboarding factory must belong to the authenticated tenant'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.saved_by_user_id IS DISTINCT FROM factoryos_current_user_id() THEN
    RAISE EXCEPTION 'Onboarding draft actor must match authenticated database context'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
    NEW.factory_id IS DISTINCT FROM OLD.factory_id OR
    NEW.step_key IS DISTINCT FROM OLD.step_key OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Onboarding draft scope and identity are immutable'
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_factory_onboarding_step_draft_guard
  ON factory_onboarding_step_drafts;
CREATE TRIGGER trg_factory_onboarding_step_draft_guard
  BEFORE INSERT OR UPDATE ON factory_onboarding_step_drafts
  FOR EACH ROW EXECUTE FUNCTION factoryos_guard_onboarding_step_draft();

ALTER TABLE factory_onboarding_step_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE factory_onboarding_step_drafts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS factory_onboarding_step_drafts_tenant_isolation
  ON factory_onboarding_step_drafts;
CREATE POLICY factory_onboarding_step_drafts_tenant_isolation
  ON factory_onboarding_step_drafts
  USING (tenant_id = factoryos_current_tenant_id())
  WITH CHECK (tenant_id = factoryos_current_tenant_id());

-- Register this late-created tenant relation explicitly. Technical RLS scope
-- verification does not approve generic export or erasure.
INSERT INTO factoryos_governance.tenant_relation_inventory (
  schema_name, relation_name, scope_model, data_category, export_disposition,
  erasure_disposition, audit_requirement, rationale
) VALUES (
  'public', 'factory_onboarding_step_drafts', 'DIRECT_TENANT_ID', 'UNREVIEWED',
  'EXCLUDED', 'BLOCKED_UNREVIEWED', 'REVIEW_REQUIRED',
  'Onboarding drafts contain tenant factory-configuration data; generic export and erasure remain blocked pending a category-specific adapter review.'
) ON CONFLICT (schema_name, relation_name) DO NOTHING;

INSERT INTO factoryos_governance.tenant_relation_ownership_reviews (
  schema_name, relation_name, ownership_class, evidence_type, evidence_detail,
  scope_predicate, export_disposition, erasure_disposition, review_status
) VALUES (
  'public', 'factory_onboarding_step_drafts', 'DIRECT_TENANT', 'DIRECT_TENANT_COLUMN_AND_RLS',
  'Migration 244 enforces direct tenant_id scope with forced RLS and a factory-tenant binding trigger. Technical scope verification does not approve generic export or erasure.',
  'tenant_id=public.factoryos_current_tenant_id()', 'EXCLUDED', 'BLOCKED_UNREVIEWED', 'VERIFIED'
) ON CONFLICT (schema_name, relation_name) DO NOTHING;

INSERT INTO permissions (code, description)
VALUES (
  'factory.onboarding.manage',
  'Read and save factory onboarding configuration drafts'
)
ON CONFLICT (code) DO UPDATE
SET description = EXCLUDED.description;

-- Keep the initial development organization administrator able to exercise
-- the onboarding draft workflow. Production role grants remain explicit.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code = 'ORG_ADMIN'
   AND r.is_system = TRUE
   AND p.code = 'factory.onboarding.manage'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO schema_migrations (version, checksum)
VALUES ('244_factory_onboarding_step_drafts', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
