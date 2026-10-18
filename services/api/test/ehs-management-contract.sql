-- Schema/security contract for permit-to-work, incidents and corrective actions.
BEGIN;
DO $$
DECLARE t TEXT; enabled BOOLEAN; forced BOOLEAN;
DECLARE required_tables TEXT[]:=ARRAY['ehs_safety_permits','ehs_incidents','ehs_corrective_actions','ehs_audit_events'];
DECLARE required_triggers TEXT[]:=ARRAY[
 'trg_ehs_permit_guard','trg_ehs_incident_guard','trg_ehs_corrective_action_guard',
 'trg_ehs_permit_audit','trg_ehs_incident_audit','trg_ehs_action_audit','trg_ehs_audit_immutable',
 'trg_ehs_safety_permits_delete_guard','trg_ehs_incidents_delete_guard',
 'trg_ehs_corrective_actions_delete_guard','trg_ehs_audit_events_delete_guard'
];
BEGIN
  IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='110_ehs_safety_permits_incidents_actions')
     OR NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='111_ehs_lifecycle_safety_guards') THEN
    RAISE EXCEPTION 'EHS permit and lifecycle migrations must both be applied';
  END IF;
  FOREACH t IN ARRAY required_tables LOOP
    SELECT c.relrowsecurity,c.relforcerowsecurity INTO enabled,forced FROM pg_class c WHERE c.oid=to_regclass(t);
    IF NOT COALESCE(enabled,FALSE) OR NOT COALESCE(forced,FALSE) THEN
      RAISE EXCEPTION 'EHS table % must force tenant row-level security',t;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=to_regclass(t) AND p.polname=t||'_tenant_isolation') THEN
      RAISE EXCEPTION 'EHS tenant isolation policy missing for %',t;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM permissions WHERE code IN (
    'ehs.permits.read','ehs.permits.manage','ehs.permits.approve','ehs.permits.execute',
    'ehs.incidents.read','ehs.incidents.report','ehs.incidents.manage','ehs.corrective_actions.verify'))<>8 THEN
    RAISE EXCEPTION 'EHS permissions are incomplete';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'D' AND tgname=ANY(required_triggers))<>cardinality(required_triggers) THEN
    RAISE EXCEPTION 'EHS independent approval, closure or audit guard is missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='chk_ehs_permit_high_risk_isolation')
     OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='chk_ehs_action_verification')
     OR NOT EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='idx_ehs_incident_queue') THEN
    RAISE EXCEPTION 'EHS isolation, corrective verification or incident queue contract is missing';
  END IF;
  IF EXISTS(SELECT 1 FROM roles r WHERE r.code IN ('ORG_ADMIN','FACTORY_MANAGER')
    AND (SELECT count(*) FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
         WHERE rp.role_id=r.id AND p.code LIKE 'ehs.%')<>8) THEN
    RAISE EXCEPTION 'Demo administrator/factory-manager EHS grants are incomplete';
  END IF;
END $$;
ROLLBACK;
