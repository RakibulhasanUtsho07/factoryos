-- Task 37 / explicit tenant migration out of legacy entitlement compatibility.
DO $$
BEGIN
  IF to_regclass('saas_entitlement_enforcement_modes') IS NULL THEN
    RAISE EXCEPTION 'SaaS entitlement enforcement mode table is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema()
      AND c.relname='saas_entitlement_enforcement_modes'
      AND c.relrowsecurity
      AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'SaaS entitlement modes must have forced row-level security';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname=current_schema()
      AND tablename='saas_entitlement_enforcement_modes'
      AND policyname='saas_entitlement_enforcement_modes_tenant_isolation'
  ) THEN
    RAISE EXCEPTION 'SaaS entitlement mode tenant policy is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='saas_entitlement_enforcement_modes'::regclass
      AND tgname='saas_entitlement_mode_insert_guard'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='saas_entitlement_enforcement_modes'::regclass
      AND tgname='saas_entitlement_mode_immutable'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'SaaS entitlement mode version/immutability guards are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM permissions
    WHERE code='saas.entitlement_modes.read'
  ) OR NOT EXISTS (
    SELECT 1 FROM permissions
    WHERE code='saas.entitlement_modes.write'
  ) THEN
    RAISE EXCEPTION 'SaaS entitlement mode permissions are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version='154_saas_entitlement_enforcement_modes'
  ) THEN
    RAISE EXCEPTION 'SaaS entitlement enforcement migration registration is missing';
  END IF;
END
$$;
