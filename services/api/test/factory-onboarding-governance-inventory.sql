DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM factoryos_governance.tenant_relation_inventory
     WHERE schema_name = 'public'
       AND relation_name = 'factory_onboarding_step_drafts'
       AND export_disposition = 'EXCLUDED'
       AND erasure_disposition = 'BLOCKED_UNREVIEWED'
  ) THEN
    RAISE EXCEPTION 'Onboarding drafts are missing their fail-closed tenant data inventory entry';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM factoryos_governance.tenant_relation_ownership_reviews
     WHERE schema_name = 'public'
       AND relation_name = 'factory_onboarding_step_drafts'
       AND ownership_class = 'DIRECT_TENANT'
       AND review_status = 'VERIFIED'
  ) THEN
    RAISE EXCEPTION 'Onboarding drafts are missing direct tenant ownership review evidence';
  END IF;
END;
$$;
