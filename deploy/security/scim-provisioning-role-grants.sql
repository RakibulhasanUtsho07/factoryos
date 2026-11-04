-- Narrow SCIM credential grants. Execute as an authorized DBA only after migration
-- 230_scim_tenant_deprovision_credentials has been applied.
-- Example:
-- psql "$ADMIN_DSN" \
--   -v application_role=factoryos_runtime \
--   -v provisioning_role=factoryos_scim_provisioner \
--   -f deploy/security/scim-provisioning-role-grants.sql
--
-- The API role may authenticate and mark last_used_at only.
-- The provisioning role may inspect the requested tenant and create/rotate its
-- tenant-scoped credential; it is not granted BYPASSRLS, table ownership,
-- TRUNCATE, broad tenant/user access, or database/role administration.
\set ON_ERROR_STOP on

\if :{?application_role}
\else
  \echo 'application_role is required'
  \quit 3
\endif
\if :{?provisioning_role}
\else
  \echo 'provisioning_role is required'
  \quit 3
\endif

GRANT USAGE ON SCHEMA public TO :"application_role";
GRANT SELECT (tenant_id, issuer, token_sha256, scopes, status, expires_at),
      UPDATE (last_used_at)
ON TABLE public.scim_provisioning_credentials
TO :"application_role";

GRANT USAGE ON SCHEMA public TO :"provisioning_role";
GRANT SELECT (id, status)
ON TABLE public.tenants
TO :"provisioning_role";
GRANT SELECT (id, tenant_id, token_sha256, status)
ON TABLE public.scim_provisioning_credentials
TO :"provisioning_role";
GRANT INSERT (tenant_id, issuer, token_sha256, scopes, status, expires_at)
ON TABLE public.scim_provisioning_credentials
TO :"provisioning_role";
GRANT UPDATE (status, revoked_at)
ON TABLE public.scim_provisioning_credentials
TO :"provisioning_role";

\echo 'SCIM runtime and provisioning column grants applied; verify effective privileges and inherited memberships with postgres-role-audit.sql'
