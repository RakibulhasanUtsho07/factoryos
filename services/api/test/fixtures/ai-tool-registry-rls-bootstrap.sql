-- Focused baseline for the AI Tool Registry PostgreSQL RLS integration test.
-- Production migrations 018 and 026 contain the full table and policy setup.
-- This fixture creates only the columns and pre-026 policy shape needed to
-- apply the real migration 026 and test its tenant/global behavior in CI.

BEGIN;

CREATE OR REPLACE FUNCTION public.factoryos_current_tenant_id()
RETURNS UUID
LANGUAGE SQL
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::UUID;
$$;

CREATE TABLE public.schema_migrations (
  version VARCHAR(255) PRIMARY KEY,
  checksum TEXT
);

CREATE TABLE public.ai_tool_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  factory_id UUID,
  tool_id VARCHAR(200) NOT NULL,
  version VARCHAR(100) NOT NULL,
  input_schema JSONB NOT NULL,
  output_schema JSONB NOT NULL,
  risk_class VARCHAR(20) NOT NULL,
  required_scopes TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  approval_mode VARCHAR(20) NOT NULL DEFAULT 'none',
  write_capable BOOLEAN NOT NULL DEFAULT false,
  idempotency_required BOOLEAN NOT NULL DEFAULT false,
  timeout_ms INTEGER NOT NULL DEFAULT 1000,
  audit_mode VARCHAR(30) NOT NULL DEFAULT 'REDACTED',
  rollback JSONB NOT NULL DEFAULT '{"type":"NONE"}'::JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_test_ai_tool_factory_requires_tenant
    CHECK (factory_id IS NULL OR tenant_id IS NOT NULL)
);

CREATE UNIQUE INDEX uq_test_ai_tool_registry_global
ON public.ai_tool_registry (tool_id, version)
WHERE tenant_id IS NULL AND factory_id IS NULL;

ALTER TABLE public.ai_tool_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_tool_registry FORCE ROW LEVEL SECURITY;

-- Reproduce the permissive policy from the original registry migration.
-- Migration 026 must replace this with separate SELECT and INSERT policies.
CREATE POLICY ai_tool_registry_tenant_isolation
ON public.ai_tool_registry
FOR ALL
USING (
  tenant_id IS NULL
  OR tenant_id = public.factoryos_current_tenant_id()
)
WITH CHECK (
  tenant_id IS NULL
  OR tenant_id = public.factoryos_current_tenant_id()
);

INSERT INTO public.ai_tool_registry (
  tenant_id,
  factory_id,
  tool_id,
  version,
  input_schema,
  output_schema,
  risk_class,
  required_scopes,
  approval_mode,
  status
)
VALUES (
  NULL,
  NULL,
  'AI.RUNTIME.NOOP',
  '1.0.0',
  '{"type":"object","additionalProperties":true}'::JSONB,
  '{"type":"object","additionalProperties":true}'::JSONB,
  'L0',
  ARRAY['ai.actions.execute']::TEXT[],
  'none',
  'ACTIVE'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'factoryos_test_app'
  ) THEN
    CREATE ROLE factoryos_test_app
      LOGIN PASSWORD 'factoryos_test_app'
      NOSUPERUSER NOBYPASSRLS;
  ELSE
    ALTER ROLE factoryos_test_app
      WITH LOGIN PASSWORD 'factoryos_test_app'
      NOSUPERUSER NOBYPASSRLS;
  END IF;
END;
$$;

GRANT CONNECT ON DATABASE factoryos_test TO factoryos_test_app;
GRANT USAGE ON SCHEMA public TO factoryos_test_app;
GRANT SELECT, INSERT ON public.ai_tool_registry TO factoryos_test_app;
GRANT EXECUTE ON FUNCTION public.factoryos_current_tenant_id() TO factoryos_test_app;

COMMIT;
