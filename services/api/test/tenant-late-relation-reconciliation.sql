-- Explicit regression gate for tenant-owned source/AI/control-plane tables
-- introduced after migration 156. These records are not portable or erasable
-- through the generic tenant transfer path until a dedicated adapter is reviewed.
DO $$
DECLARE
  invalid_relations text;
BEGIN
  WITH expected(relation_name, expected_category) AS (
    VALUES
      ('research_source_authenticity_checks','AI_CONTEXT'),
      ('research_source_authenticity_reviews','AI_CONTEXT'),
      ('research_source_documents','AI_CONTEXT'),
      ('research_source_document_content','AI_CONTEXT'),
      ('research_source_document_purges','AI_CONTEXT'),
      ('growth_kpi_source_sync_runs','AI_CONTEXT'),
      ('growth_kpi_source_observations','AI_CONTEXT'),
      ('growth_kpi_source_sync_items','AI_CONTEXT'),
      ('growth_forecast_calibration_policies','AI_CONTEXT'),
      ('ai_agent_live_evaluation_results','AI_CONTEXT'),
      ('ai_artifact_trusted_sources','AI_CONTEXT'),
      ('ai_artifact_registry','AI_CONTEXT'),
      ('ai_artifact_provenance_events','AI_CONTEXT'),
      ('ai_artifact_admission_events','AI_CONTEXT'),
      ('research_source_freshness_policies','AI_CONTEXT'),
      ('saas_tenant_external_data_targets','SAAS_CONTROL_PLANE'),
      ('saas_tenant_external_propagation_runs','SAAS_CONTROL_PLANE'),
      ('saas_tenant_external_propagation_receipts','SAAS_CONTROL_PLANE'),
      ('saas_tenant_finance_retention_policies','SAAS_CONTROL_PLANE'),
      ('saas_tenant_finance_retention_runs','SAAS_CONTROL_PLANE'),
      ('saas_billing_provider_accounts','SAAS_CONTROL_PLANE'),
      ('saas_billing_provider_account_events','SAAS_CONTROL_PLANE'),
      ('saas_billing_close_runs','SAAS_CONTROL_PLANE'),
      ('saas_billing_close_events','SAAS_CONTROL_PLANE'),
      ('saas_billing_provider_webhook_events','SAAS_CONTROL_PLANE'),
      ('saas_billing_reconciliation_results','SAAS_CONTROL_PLANE'),
      ('saas_physical_provisioning_runs','SAAS_CONTROL_PLANE'),
      ('saas_physical_provisioning_events','SAAS_CONTROL_PLANE')
  )
  SELECT string_agg(e.relation_name, ', ' ORDER BY e.relation_name)
    INTO invalid_relations
  FROM expected e
  LEFT JOIN pg_catalog.pg_class c ON c.relname=e.relation_name
  LEFT JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
  LEFT JOIN factoryos_governance.tenant_relation_inventory i
    ON i.schema_name='public' AND i.relation_name=e.relation_name
  LEFT JOIN factoryos_governance.tenant_relation_ownership_reviews r
    ON r.schema_name='public' AND r.relation_name=e.relation_name
  WHERE c.oid IS NULL OR n.oid IS NULL OR c.relkind NOT IN ('r','p')
    OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid
        AND a.attname='tenant_id' AND a.attnum>0 AND NOT a.attisdropped
    )
    OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity
    OR i.relation_name IS NULL OR r.relation_name IS NULL
    OR i.scope_model <> 'DIRECT_TENANT_ID'
    OR i.data_category <> e.expected_category
    OR i.export_disposition <> 'EXCLUDED'
    OR i.erasure_disposition <> 'BLOCKED_UNREVIEWED'
    OR r.ownership_class <> 'DIRECT_TENANT'
    OR r.review_status <> 'VERIFIED'
    OR r.export_disposition <> 'EXCLUDED'
    OR r.erasure_disposition <> 'BLOCKED_UNREVIEWED'
    OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy p
      WHERE p.polrelid=c.oid AND p.polname='fo_privacy_scope_enforce'
        AND NOT p.polpermissive
        AND COALESCE(pg_catalog.pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%factoryos_current_tenant_id%'
        AND COALESCE(pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%factoryos_current_tenant_id%'
        AND COALESCE(pg_catalog.pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%tenant_id%'
        AND COALESCE(pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%tenant_id%'
    );

  IF invalid_relations IS NOT NULL THEN
    RAISE EXCEPTION 'Late-created tenant data relation(s) are missing explicit fail-closed inventory/RLS: %', invalid_relations;
  END IF;
END
$$;
