-- CI-only deterministic fixtures are written before backup. This SQL runs against
-- the independently restored database and must emit all three acceptance markers.
DO $$
DECLARE
  schema_count integer;
  fixture_tenants integer;
  fixture_factories integer;
  audit_rows integer;
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL
     OR to_regclass('public.tenants') IS NULL
     OR to_regclass('public.factories') IS NULL
     OR to_regclass('public.audit_events') IS NULL THEN
    RAISE EXCEPTION 'restored application schema is incomplete';
  END IF;
  SELECT count(*) INTO schema_count FROM schema_migrations;
  IF schema_count < 100 THEN RAISE EXCEPTION 'restored schema migration history is incomplete: % rows', schema_count; END IF;
  SELECT count(*) INTO fixture_tenants FROM tenants
   WHERE id IN ('e7110000-0000-4000-8000-000000000001','e7110000-0000-4000-8000-000000000002');
  SELECT count(*) INTO fixture_factories FROM factories
   WHERE id IN ('e7130000-0000-4000-8000-000000000001','e7130000-0000-4000-8000-000000000002');
  IF fixture_tenants <> 2 OR fixture_factories <> 2 THEN
    RAISE EXCEPTION 'application fixture data was not fully restored (tenants %, factories %)', fixture_tenants, fixture_factories;
  END IF;
  RAISE NOTICE 'RECOVERY_APPLICATION_SMOKE=PASS';
END $$;

DO $$
DECLARE audit_rows integer;
BEGIN
  SELECT count(*) INTO audit_rows FROM audit_events
   WHERE id IN ('e7140000-0000-4000-8000-000000000001','e7140000-0000-4000-8000-000000000002')
     AND event_type='RECOVERY_REHEARSAL' AND action='RESTORE_CONTINUITY'
     AND payload->>'fixture'='backup-restore-audit-continuity';
  IF audit_rows <> 2 THEN RAISE EXCEPTION 'restored audit continuity fixture mismatch: % rows', audit_rows; END IF;
  RAISE NOTICE 'RECOVERY_AUDIT_CONTINUITY=PASS';
END $$;

-- A restored custom-format archive is imported with --no-acl. Provision only the
-- narrow grant needed to prove that the real non-bypass-RLS application role is
-- filtered by tenant context; transaction rollback removes this CI-only grant.
BEGIN;
GRANT SELECT, INSERT ON public.factories TO factoryos_app;
SET LOCAL ROLE factoryos_app;
SELECT set_config('app.tenant_id','e7110000-0000-4000-8000-000000000001',true);
DO $$
DECLARE visible_factories integer;
BEGIN
  SELECT count(*) INTO visible_factories FROM public.factories
   WHERE id IN ('e7130000-0000-4000-8000-000000000001','e7130000-0000-4000-8000-000000000002');
  IF visible_factories <> 1 THEN
    RAISE EXCEPTION 'RLS tenant read isolation failed after restore: visible % fixture factories', visible_factories;
  END IF;
  BEGIN
    INSERT INTO public.factories (id,tenant_id,code,name,status,timezone)
    VALUES ('e7130000-0000-4000-8000-000000000099',
      'e7110000-0000-4000-8000-000000000002',
      'DR-CROSS-TENANT-WRITE','must be rejected by RLS','ACTIVE','Asia/Dhaka');
    RAISE EXCEPTION 'cross-tenant factory write unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'cross-tenant write rejected by PostgreSQL policy';
  END;
  RAISE NOTICE 'RECOVERY_TENANT_ISOLATION=PASS';
END $$;
ROLLBACK;
RESET ROLE;
