-- Factory onboarding draft persistence: tenant/factory scope and actor binding.
-- Run after migration 244_factory_onboarding_step_drafts.sql.
BEGIN;

DO $$
DECLARE
  v_tenant_id UUID := gen_random_uuid();
  v_other_tenant_id UUID := gen_random_uuid();
  v_user_id UUID := gen_random_uuid();
  v_factory_id UUID := gen_random_uuid();
  v_visible_count INTEGER;
BEGIN
  INSERT INTO tenants (id, slug, name, status, timezone, default_locale)
  VALUES
    (v_tenant_id, 'onboarding-test-' || replace(v_tenant_id::text, '-', ''), 'Onboarding Test', 'ACTIVE', 'Asia/Dhaka', 'en-BD'),
    (v_other_tenant_id, 'onboarding-other-' || replace(v_other_tenant_id::text, '-', ''), 'Other Tenant', 'ACTIVE', 'Asia/Dhaka', 'en-BD');

  INSERT INTO users (id, display_name, status)
  VALUES (v_user_id, 'Onboarding Test User', 'ACTIVE');

  PERFORM set_config('app.tenant_id', v_tenant_id::text, true);
  PERFORM set_config('app.user_id', v_user_id::text, true);

  INSERT INTO factories (id, tenant_id, code, name, status, timezone)
  VALUES (v_factory_id, v_tenant_id, 'ONB-TEST', 'Onboarding Test Factory', 'ACTIVE', 'Asia/Dhaka');

  INSERT INTO factory_onboarding_step_drafts (
    tenant_id, factory_id, step_key, payload, saved_by_user_id
  )
  VALUES (
    v_tenant_id, v_factory_id, 'factory_profile',
    '{"name":"Onboarding Test Factory"}'::jsonb, v_user_id
  );

  SELECT COUNT(*) INTO v_visible_count
    FROM factory_onboarding_step_drafts
   WHERE tenant_id = v_tenant_id AND factory_id = v_factory_id;

  IF v_visible_count <> 1 THEN
    RAISE EXCEPTION 'Expected tenant to read its own onboarding draft';
  END IF;

  PERFORM set_config('app.tenant_id', v_other_tenant_id::text, true);

  SELECT COUNT(*) INTO v_visible_count
    FROM factory_onboarding_step_drafts
   WHERE tenant_id = v_tenant_id AND factory_id = v_factory_id;

  IF v_visible_count <> 0 THEN
    RAISE EXCEPTION 'Cross-tenant onboarding draft visibility was not blocked';
  END IF;

  BEGIN
    INSERT INTO factory_onboarding_step_drafts (
      tenant_id, factory_id, step_key, payload, saved_by_user_id
    )
    VALUES (
      v_other_tenant_id, v_factory_id, 'sites',
      '{"items":"SITE-01"}'::jsonb, v_user_id
    );
    RAISE EXCEPTION 'Cross-tenant factory binding unexpectedly succeeded';
  EXCEPTION
    WHEN foreign_key_violation THEN
      NULL;
  END;
END;
$$;

ROLLBACK;
