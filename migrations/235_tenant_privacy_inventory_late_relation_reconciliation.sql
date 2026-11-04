BEGIN;

-- Discover relations created after migration 156. New rows are always excluded
-- from generic export and blocked from erasure unless an earlier migration has
-- already registered an explicit adapter decision.
DO $inventory$
DECLARE item record; category text;
BEGIN
  FOR item IN
    SELECT c.relname,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid
             AND a.attname='tenant_id' AND a.attnum>0 AND NOT a.attisdropped) AS direct_scope
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
    ORDER BY c.relname
  LOOP
    IF EXISTS (SELECT 1 FROM factoryos_governance.tenant_relation_inventory i
      WHERE i.schema_name='public' AND i.relation_name=item.relname) THEN
      CONTINUE;
    END IF;
    category := CASE
      WHEN NOT item.direct_scope THEN 'UNREVIEWED'
      WHEN item.relname ~* '(integration|connector|webhook)' THEN 'INTEGRATION_METADATA'
      WHEN item.relname ~* '(file|attachment|blob|object_reference)' THEN 'FILE_REFERENCES'
      WHEN item.relname LIKE 'saas_%' OR item.relname LIKE '%tenant_data_%'
        OR item.relname LIKE '%tenant_import_%' THEN 'SAAS_CONTROL_PLANE'
      WHEN item.relname LIKE 'ai_%' OR item.relname LIKE 'research_%'
        OR item.relname LIKE 'growth_%' THEN 'AI_CONTEXT'
      WHEN item.relname ~* 'evidence' THEN 'EVIDENCE'
      WHEN item.relname ~* 'approval' THEN 'APPROVALS'
      ELSE 'UNREVIEWED'
    END;
    INSERT INTO factoryos_governance.tenant_relation_inventory (
      schema_name,relation_name,scope_model,data_category,export_disposition,
      erasure_disposition,audit_requirement,rationale
    ) VALUES (
      'public',item.relname,
      CASE WHEN item.direct_scope THEN 'DIRECT_TENANT_ID' ELSE 'NO_DIRECT_TENANT_ID' END,
      category,'EXCLUDED','BLOCKED_UNREVIEWED','REVIEW_REQUIRED',
      'Migration 235 discovered a relation created after the original privacy inventory. Export is excluded and erasure blocked until scope, adapter and owner review are recorded.'
    ) ON CONFLICT (schema_name,relation_name) DO NOTHING;
  END LOOP;
END
$inventory$;

DO $ownership$
DECLARE
  item record; scope_predicate text; global_reason text;
  has_permissive boolean; using_predicate text; check_predicate text;
  export_status text; erasure_status text;
BEGIN
  FOR item IN
    SELECT c.oid,c.relname,
      tenant_column.attname IS NOT NULL AS direct_scope,
      tenant_column.atttypid='uuid'::regtype AS uuid_scope,
      tenant_column.attnotnull AS required_scope
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attribute tenant_column ON tenant_column.attrelid=c.oid
      AND tenant_column.attname='tenant_id' AND tenant_column.attnum>0
      AND NOT tenant_column.attisdropped
    LEFT JOIN factoryos_governance.tenant_relation_ownership_reviews r
      ON r.schema_name=n.nspname AND r.relation_name=c.relname
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND r.relation_name IS NULL
    ORDER BY c.relname
  LOOP
    SELECT export_disposition,erasure_disposition INTO export_status,erasure_status
      FROM factoryos_governance.tenant_relation_inventory
      WHERE schema_name='public' AND relation_name=item.relname;
    IF NOT FOUND THEN RAISE EXCEPTION 'Missing privacy inventory for public.%',item.relname; END IF;

    IF item.direct_scope THEN
      check_predicate := CASE WHEN item.uuid_scope
        THEN 'tenant_id=public.factoryos_current_tenant_id()'
        ELSE 'tenant_id::text=public.factoryos_current_tenant_id()::text' END;
      using_predicate := CASE WHEN item.required_scope THEN check_predicate
        WHEN item.uuid_scope THEN '(tenant_id IS NULL OR tenant_id=public.factoryos_current_tenant_id())'
        ELSE '(tenant_id IS NULL OR tenant_id::text=public.factoryos_current_tenant_id()::text)' END;
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',item.relname);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',item.relname);
      SELECT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=item.oid AND p.polpermissive)
        INTO has_permissive;
      IF NOT has_permissive THEN
        EXECUTE format('CREATE POLICY fo_privacy_scope_allow ON public.%I AS PERMISSIVE FOR ALL USING (%s) WITH CHECK (%s)',
          item.relname,using_predicate,check_predicate);
      END IF;
      EXECUTE format('CREATE POLICY fo_privacy_scope_enforce ON public.%I AS RESTRICTIVE FOR ALL USING (%s) WITH CHECK (%s)',
        item.relname,using_predicate,check_predicate);
      INSERT INTO factoryos_governance.tenant_relation_ownership_reviews (
        schema_name,relation_name,ownership_class,evidence_type,evidence_detail,
        scope_predicate,export_disposition,erasure_disposition,review_status
      ) VALUES ('public',item.relname,'DIRECT_TENANT','DIRECT_TENANT_COLUMN_AND_RLS',
        'Migration 235 discovered direct tenant_id scope and installed forced RLS. Technical scope verification does not approve export or erasure.',
        'tenant_id=public.factoryos_current_tenant_id()',export_status,erasure_status,'VERIFIED');
      CONTINUE;
    END IF;

    global_reason := CASE item.relname
      WHEN 'tenants' THEN 'Global tenant registry; excluded from tenant export and erasure.'
      WHEN 'users' THEN 'Shared identity principals; generic tenant export and erasure are excluded.'
      WHEN 'permissions' THEN 'Global permission catalogue; excluded from tenant export and generic erasure.'
      WHEN 'auth_identities' THEN 'Global OIDC identity mapping; handled by identity governance only.'
      WHEN 'schema_migrations' THEN 'Internal schema migration ledger; outside tenant export and erasure.'
      ELSE NULL END;
    IF global_reason IS NOT NULL THEN
      INSERT INTO factoryos_governance.tenant_relation_ownership_reviews (
        schema_name,relation_name,ownership_class,evidence_type,evidence_detail,
        scope_predicate,export_disposition,erasure_disposition,review_status
      ) VALUES ('public',item.relname,'GLOBAL_SHARED','EXPLICIT_GLOBAL_REGISTRY',
        global_reason,NULL,'EXCLUDED','PROTECTED','REVIEWED_POLICY');
      CONTINUE;
    END IF;

    scope_predicate := factoryos_governance.build_tenant_scope_predicate(
      item.oid,format('%I.%I','public',item.relname));
    IF scope_predicate <> 'FALSE' THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',item.relname);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',item.relname);
      SELECT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=item.oid AND p.polpermissive)
        INTO has_permissive;
      IF NOT has_permissive THEN
        EXECUTE format('CREATE POLICY fo_tenant_ownership_scope_allow ON public.%I AS PERMISSIVE FOR ALL USING (%s) WITH CHECK (%s)',
          item.relname,scope_predicate,scope_predicate);
      END IF;
      EXECUTE format('CREATE POLICY fo_tenant_ownership_scope_enforce ON public.%I AS RESTRICTIVE FOR ALL USING (%s) WITH CHECK (%s)',
        item.relname,scope_predicate,scope_predicate);
      INSERT INTO factoryos_governance.tenant_relation_ownership_reviews (
        schema_name,relation_name,ownership_class,evidence_type,evidence_detail,
        scope_predicate,export_disposition,erasure_disposition,review_status
      ) VALUES ('public',item.relname,'DERIVED_TENANT','FOREIGN_KEY_LINEAGE',
        'Migration 235 discovered FK-derived tenant scope and installed forced RLS. Export remains excluded and erasure blocked pending a category-specific adapter.',
        scope_predicate,'EXCLUDED','BLOCKED_UNREVIEWED','VERIFIED');
    ELSE
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',item.relname);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',item.relname);
      EXECUTE format('CREATE POLICY fo_tenant_ownership_unresolved_deny ON public.%I AS RESTRICTIVE FOR ALL USING (FALSE) WITH CHECK (FALSE)',
        item.relname);
      INSERT INTO factoryos_governance.tenant_relation_ownership_reviews (
        schema_name,relation_name,ownership_class,evidence_type,evidence_detail,
        scope_predicate,export_disposition,erasure_disposition,review_status
      ) VALUES ('public',item.relname,'UNRESOLVED','NO_TENANT_FK_PATH',
        'No direct tenant_id, no declared FK path and no approved global/shared decision. Runtime access is denied; export and erasure are blocked pending owner review.',
        'FALSE','EXCLUDED','BLOCKED_UNREVIEWED','REVIEW_REQUIRED');
    END IF;
  END LOOP;
END
$ownership$;

DO $assertions$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN factoryos_governance.tenant_relation_inventory i
      ON i.schema_name=n.nspname AND i.relation_name=c.relname
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND i.relation_name IS NULL
  ) OR EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN factoryos_governance.tenant_relation_ownership_reviews r
      ON r.schema_name=n.nspname AND r.relation_name=c.relname
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND r.relation_name IS NULL
  ) THEN
    RAISE EXCEPTION 'Late tenant relation reconciliation did not cover every public base/partition relation';
  END IF;
END
$assertions$;

INSERT INTO schema_migrations(version,checksum)
VALUES ('235_tenant_privacy_inventory_late_relation_reconciliation',NULL)
ON CONFLICT (version) DO NOTHING;
COMMIT;
