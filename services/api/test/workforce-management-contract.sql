-- Workforce schema, security, source-evidence and productivity formula contract.
BEGIN;

DO $workforce_contract$
DECLARE
  t TEXT;
  enabled BOOLEAN;
  forced BOOLEAN;
  required_tables TEXT[] := ARRAY[
    'workforce_workers','workforce_skills','workforce_worker_skills','workforce_shift_templates',
    'workforce_shift_assignments','workforce_attendance_events','workforce_overtime_requests',
    'workforce_productivity_reports','workforce_biometric_consent_events','workforce_audit_events',
    'workforce_command_receipts'
  ];
  required_triggers TEXT[] := ARRAY[
    'trg_workforce_worker_version_guard','trg_workforce_skill_version_guard',
    'trg_workforce_worker_skill_version_guard','trg_workforce_shift_template_version_guard',
    'trg_workforce_assignment_version_guard','trg_workforce_assignment_scope_guard',
    'trg_workforce_attendance_event_guard','trg_workforce_overtime_guard','trg_workforce_productivity_guard',
    'trg_workforce_workers_audit','trg_workforce_skills_audit','trg_workforce_worker_skills_audit',
    'trg_workforce_shifts_audit','trg_workforce_assignments_audit','trg_workforce_attendance_audit',
    'trg_workforce_overtime_audit','trg_workforce_productivity_audit','trg_workforce_biometric_consent_audit','trg_workforce_biometric_consent_actor_guard','trg_workforce_consent_projection',
    'trg_workforce_attendance_evidence_immutable','trg_workforce_productivity_evidence_immutable',
    'trg_workforce_biometric_consent_immutable','trg_workforce_audit_evidence_immutable',
    'trg_workforce_command_receipt_immutable','trg_tenants_seed_workforce_worker_role',
    'trg_workforce_workers_delete_guard','trg_workforce_skills_delete_guard',
    'trg_workforce_worker_skills_delete_guard','trg_workforce_shift_templates_delete_guard',
    'trg_workforce_shift_assignments_delete_guard','trg_workforce_attendance_events_delete_guard',
    'trg_workforce_overtime_requests_delete_guard','trg_workforce_productivity_reports_delete_guard',
    'trg_workforce_biometric_consent_events_delete_guard','trg_workforce_audit_events_delete_guard'
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='102_workforce_shift_attendance_productivity')
    OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='103_workforce_lifecycle_audit_guards')
    OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='104_workforce_command_idempotency')
    OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='105_workforce_self_service_role')
    OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='106_workforce_consent_timeline_and_output_attribution') THEN
    RAISE EXCEPTION 'All Workforce schema and lifecycle migrations must be applied';
  END IF;

  FOREACH t IN ARRAY required_tables LOOP
    SELECT c.relrowsecurity,c.relforcerowsecurity INTO enabled,forced
    FROM pg_class c WHERE c.oid=to_regclass(t);
    IF COALESCE(enabled,FALSE) IS NOT TRUE OR COALESCE(forced,FALSE) IS NOT TRUE THEN
      RAISE EXCEPTION 'Workforce table % must FORCE tenant row-level security',t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=to_regclass(t) AND p.polname=t||'_tenant_isolation') THEN
      RAISE EXCEPTION 'Workforce tenant isolation policy is missing for %',t;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM permissions WHERE code LIKE 'workforce.%') <> 16 THEN
    RAISE EXCEPTION 'Workforce IAM permission catalogue must include the full permission set';
  END IF;
  IF EXISTS (
    SELECT 1 FROM roles r
    WHERE r.code IN ('ORG_ADMIN','FACTORY_MANAGER')
      AND (SELECT count(*) FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
           WHERE rp.role_id=r.id AND p.code LIKE 'workforce.%') <> 16
  ) THEN
    RAISE EXCEPTION 'Seeded admin/factory-manager roles must receive the full Workforce permission set';
  END IF;

  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'D'
      AND tgname=ANY(required_triggers)) <> cardinality(required_triggers) THEN
    RAISE EXCEPTION 'A Workforce actor, lifecycle, privacy or immutable-evidence trigger is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='uq_workforce_attendance_source_event')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='uq_workforce_worker_skill_active')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='uq_workforce_command_receipt_key')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='uq_workforce_productivity_source_event_worker') THEN
    RAISE EXCEPTION 'Workforce source-event, active-skill or command idempotency uniqueness is missing';
  END IF;

  IF (SELECT count(*) FROM pg_attribute a
      WHERE a.attrelid='workforce_productivity_reports'::regclass
        AND a.attname IN ('earned_minutes','efficiency_percent') AND a.attgenerated='s') <> 2 THEN
    RAISE EXCEPTION 'Productivity earned minutes and efficiency must be database-generated values';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_workforce_productivity_source_event')
     OR (SELECT count(*) FROM pg_attribute a
         WHERE a.attrelid='workforce_biometric_consent_events'::regclass
           AND a.attname='effective_at' AND a.attnotnull) <> 1
     OR (SELECT count(*) FROM pg_attribute a
         WHERE a.attrelid='workforce_productivity_reports'::regclass
           AND a.attname='source_operation_event_id') <> 1 THEN
    RAISE EXCEPTION 'Workforce consent effective-time and canonical productivity event links are required';
  END IF;

  IF EXISTS (
    SELECT 1 FROM tenants t
    WHERE NOT EXISTS (
      SELECT 1 FROM roles r
      JOIN role_permissions rp ON rp.role_id=r.id
      JOIN permissions p ON p.id=rp.permission_id AND p.code='workforce.self.read'
      WHERE r.tenant_id=t.id AND r.code='WORKER_SELF_SERVICE'
    )
  ) THEN
    RAISE EXCEPTION 'Every tenant must have the dedicated least-privilege worker self-service role';
  END IF;
END;
$workforce_contract$;

ROLLBACK;
