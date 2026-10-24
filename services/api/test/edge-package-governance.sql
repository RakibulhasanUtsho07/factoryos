-- PostgreSQL schema/RLS/lifecycle contract for edge package governance.
BEGIN;

DO $$
DECLARE
  v_enabled BOOLEAN;
  v_forced BOOLEAN;
  v_relation TEXT;
  v_policy TEXT;
  v_trigger TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '196_edge_package_governance'
  ) THEN
    RAISE EXCEPTION 'edge package governance migration marker is missing';
  END IF;

  FOR v_relation, v_policy IN
    SELECT * FROM (VALUES
      ('edge_package_signing_keys', 'edge_package_signing_keys_tenant_isolation'),
      ('edge_package_signing_key_events', 'edge_package_signing_key_events_tenant_isolation'),
      ('edge_package_controls', 'edge_package_controls_tenant_isolation'),
      ('edge_package_control_events', 'edge_package_control_events_tenant_isolation')
    ) AS r(relation_name, policy_name)
  LOOP
    IF to_regclass('public.' || v_relation) IS NULL THEN
      RAISE EXCEPTION 'required edge package governance relation % is missing', v_relation;
    END IF;
    SELECT c.relrowsecurity, c.relforcerowsecurity
      INTO v_enabled, v_forced
    FROM pg_class c WHERE c.oid = to_regclass('public.' || v_relation);
    IF v_enabled IS DISTINCT FROM TRUE OR v_forced IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'edge package relation % must enable and force RLS', v_relation;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy
      WHERE polrelid = to_regclass('public.' || v_relation) AND polname = v_policy
    ) THEN
      RAISE EXCEPTION 'edge package relation % is missing tenant policy %', v_relation, v_policy;
    END IF;
  END LOOP;

  FOR v_trigger IN
    SELECT unnest(ARRAY[
      'edge_package_signing_key_events_immutable',
      'edge_package_control_events_immutable',
      'edge_package_signing_key_guard',
      'edge_package_control_guard'
    ])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = v_trigger AND NOT tgisinternal
        AND tgrelid IN (
          'public.edge_package_signing_keys'::regclass,
          'public.edge_package_signing_key_events'::regclass,
          'public.edge_package_controls'::regclass,
          'public.edge_package_control_events'::regclass
        )
    ) THEN
      RAISE EXCEPTION 'required edge package trigger % is missing', v_trigger;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.edge_package_signing_keys'::regclass
      AND conname = 'uq_edge_package_key_id_scope'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.edge_package_controls'::regclass
      AND conname = 'uq_edge_package_control_scope'
  ) THEN
    RAISE EXCEPTION 'package key and package control scopes must be unique';
  END IF;

  IF (
    SELECT count(*) FROM permissions
    WHERE code IN (
      'edge.packages.keys.read',
      'edge.packages.keys.manage',
      'edge.packages.controls.read',
      'edge.packages.controls.manage'
    )
  ) <> 4 THEN
    RAISE EXCEPTION 'edge package governance permissions are incomplete';
  END IF;
END
$$;

ROLLBACK;
