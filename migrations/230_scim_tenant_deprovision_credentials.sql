BEGIN;
CREATE TABLE IF NOT EXISTS public.scim_provisioning_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  issuer varchar(500) NOT NULL,
  token_sha256 varchar(64) NOT NULL,
  scopes text[] NOT NULL DEFAULT ARRAY['Users:write']::text[],
  status varchar(16) NOT NULL DEFAULT 'ACTIVE',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT uq_scim_provisioning_credentials_hash UNIQUE (token_sha256),
  CONSTRAINT chk_scim_provisioning_credentials_digest CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_scim_provisioning_credentials_status CHECK (
    (status = 'ACTIVE' AND revoked_at IS NULL)
    OR (status = 'REVOKED' AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT chk_scim_provisioning_credentials_scopes CHECK (
    cardinality(scopes) BETWEEN 1 AND 2
    AND scopes <@ ARRAY['Users:read','Users:write']::text[]
  ),
  CONSTRAINT chk_scim_provisioning_credentials_issuer CHECK (
    issuer ~ '^https://[^[:space:]]+$'
    AND issuer !~* 'https://[^/]*@'
    AND length(issuer) <= 500
  )
);
CREATE INDEX IF NOT EXISTS idx_scim_provisioning_credentials_tenant_status
  ON public.scim_provisioning_credentials (tenant_id, status, expires_at);
ALTER TABLE public.scim_provisioning_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scim_provisioning_credentials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scim_provisioning_credentials_tenant_allow
  ON public.scim_provisioning_credentials;
CREATE POLICY scim_provisioning_credentials_tenant_allow
  ON public.scim_provisioning_credentials
  AS PERMISSIVE FOR ALL
  USING (tenant_id = public.factoryos_current_tenant_id())
  WITH CHECK (tenant_id = public.factoryos_current_tenant_id());
DROP POLICY IF EXISTS scim_provisioning_credentials_tenant_enforce
  ON public.scim_provisioning_credentials;
CREATE POLICY scim_provisioning_credentials_tenant_enforce
  ON public.scim_provisioning_credentials
  AS RESTRICTIVE FOR ALL
  USING (tenant_id = public.factoryos_current_tenant_id())
  WITH CHECK (tenant_id = public.factoryos_current_tenant_id());
REVOKE ALL ON public.scim_provisioning_credentials FROM PUBLIC;
COMMENT ON TABLE public.scim_provisioning_credentials IS
  'Per-tenant SCIM bearer credentials. Only token SHA-256 is stored. Forced RLS scopes API lookup to the credential tenant; this adapter only deactivates pre-linked users.';
INSERT INTO schema_migrations(version, checksum)
VALUES ('230_scim_tenant_deprovision_credentials', NULL)
ON CONFLICT (version) DO NOTHING;
COMMIT;
