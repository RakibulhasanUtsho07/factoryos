-- Schema/security contract for energy meter, reading and utility-event capture.
BEGIN;
DO $$
DECLARE t TEXT; enabled BOOLEAN; forced BOOLEAN;
DECLARE required_tables TEXT[]:=ARRAY['utility_meters','utility_meter_readings','utility_events','utility_audit_events'];
DECLARE required_triggers TEXT[]:=ARRAY[
 'trg_utility_meter_guard','trg_utility_reading_guard','trg_utility_event_guard',
 'trg_utility_meter_audit','trg_utility_reading_audit','trg_utility_event_audit',
 'trg_utility_reading_immutable','trg_utility_audit_immutable',
 'trg_utility_meter_delete_guard','trg_utility_event_delete_guard','trg_utility_audit_delete_guard'
];
BEGIN
  IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='108_energy_utility_events')
     OR NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='109_utility_lifecycle_cost_and_audit_guards') THEN
    RAISE EXCEPTION 'Energy/utility migrations must both be applied';
  END IF;
  FOREACH t IN ARRAY required_tables LOOP
    SELECT c.relrowsecurity,c.relforcerowsecurity INTO enabled,forced FROM pg_class c WHERE c.oid=to_regclass(t);
    IF NOT COALESCE(enabled,FALSE) OR NOT COALESCE(forced,FALSE) THEN
      RAISE EXCEPTION 'Utility table % must force tenant row-level security',t;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=to_regclass(t) AND p.polname=t||'_tenant_isolation') THEN
      RAISE EXCEPTION 'Utility tenant isolation policy missing for %',t;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM permissions WHERE code IN (
    'utilities.meters.read','utilities.meters.manage','utilities.readings.read','utilities.readings.capture',
    'utilities.events.read','utilities.events.manage'))<>6 THEN
    RAISE EXCEPTION 'Utility permissions are incomplete';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'D' AND tgname=ANY(required_triggers))<>cardinality(required_triggers) THEN
    RAISE EXCEPTION 'Utility hierarchy, cost, immutable evidence or audit guard is missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='uq_utility_reading_source_event')
     OR NOT EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='uq_utility_meter_code')
     OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='chk_utility_reading_cost') THEN
    RAISE EXCEPTION 'Utility source deduplication, meter identity or cost contract is missing';
  END IF;
  IF EXISTS(SELECT 1 FROM roles r WHERE r.code IN ('ORG_ADMIN','FACTORY_MANAGER')
    AND (SELECT count(*) FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
         WHERE rp.role_id=r.id AND p.code LIKE 'utilities.%')<>6) THEN
    RAISE EXCEPTION 'Demo administrator/factory-manager utility grants are incomplete';
  END IF;
END $$;
ROLLBACK;
