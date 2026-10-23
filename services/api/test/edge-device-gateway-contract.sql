-- PostgreSQL schema/RLS contract for the Edge device registry and telemetry slice.
BEGIN;

DO $$
DECLARE
  v_enabled BOOLEAN;
  v_forced BOOLEAN;
  v_relation TEXT;
  v_policy TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '191_edge_ot_device_gateway')
    OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '192_edge_device_credentials')
    OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '193_edge_device_health_and_stream_metadata')
  THEN
    RAISE EXCEPTION 'one or more Edge device gateway migration markers are missing';
  END IF;

  FOR v_relation, v_policy IN
    SELECT * FROM (VALUES
      ('edge_devices', 'edge_devices_tenant_isolation'),
      ('edge_observations', 'edge_observations_tenant_isolation'),
      ('edge_sync_batches', 'edge_sync_batches_tenant_isolation'),
      ('edge_device_credentials', 'edge_device_credentials_tenant_isolation'),
      ('edge_device_credential_events', 'edge_device_credential_events_tenant_isolation'),
      ('edge_device_health_reports', 'edge_device_health_tenant_isolation')
    ) AS r(relation_name, policy_name)
  LOOP
    IF to_regclass('public.' || v_relation) IS NULL THEN
      RAISE EXCEPTION 'required Edge relation % is missing', v_relation;
    END IF;
    SELECT c.relrowsecurity, c.relforcerowsecurity
      INTO v_enabled, v_forced
    FROM pg_class c WHERE c.oid = to_regclass('public.' || v_relation);
    IF v_enabled IS DISTINCT FROM TRUE OR v_forced IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'Edge relation % must enable and force RLS', v_relation;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy
      WHERE polrelid = to_regclass('public.' || v_relation) AND polname = v_policy
    ) THEN
      RAISE EXCEPTION 'Edge relation % is missing tenant policy %', v_relation, v_policy;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM factoryos_governance.tenant_relation_inventory i
      WHERE i.schema_name = 'public' AND i.relation_name = v_relation
        AND i.scope_model = 'DIRECT_TENANT_ID' AND i.data_category = 'BUSINESS_DATA'
    ) OR NOT EXISTS (
      SELECT 1 FROM factoryos_governance.tenant_relation_ownership_reviews o
      WHERE o.schema_name = 'public' AND o.relation_name = v_relation
        AND o.ownership_class = 'DIRECT_TENANT'
        AND o.evidence_type = 'DIRECT_TENANT_COLUMN_AND_RLS'
        AND o.review_status = 'VERIFIED'
    ) THEN
      RAISE EXCEPTION 'Edge relation % is missing governance classification/review', v_relation;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.edge_observations'::regclass AND tgname='edge_observations_immutable' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.edge_sync_batches'::regclass AND tgname='edge_sync_batches_immutable' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.edge_device_credential_events'::regclass AND tgname='edge_device_credential_events_immutable' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.edge_device_health_reports'::regclass AND tgname='edge_device_health_reports_immutable' AND NOT tgisinternal)
  THEN
    RAISE EXCEPTION 'Edge observation, batch, credential and health history must be immutable';
  END IF;

  IF to_regclass('public.uq_edge_credential_active_device') IS NULL
    OR to_regclass('public.uq_edge_credential_token_hash') IS NULL THEN
    RAISE EXCEPTION 'Edge credentials require unique hashes and one active credential per device';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.edge_observations'::regclass AND attname='recorded_by_credential_id' AND attnum>0 AND NOT attisdropped)
    OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.edge_observations'::regclass AND attname='unit' AND attnum>0 AND NOT attisdropped)
    OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.edge_observations'::regclass AND attname='sampling_interval_ms' AND attnum>0 AND NOT attisdropped)
  THEN
    RAISE EXCEPTION 'Edge observations must bind credential identity and stream metadata';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.edge_device_credentials'::regclass AND conname='fk_edge_credential_device_scope' AND contype='f')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.edge_observations'::regclass AND conname='fk_edge_observation_device_scope' AND contype='f')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.edge_device_credential_events'::regclass AND conname='fk_edge_credential_event_credential_scope' AND contype='f')
  THEN
    RAISE EXCEPTION 'Edge device and credential foreign keys must preserve tenant/factory scope';
  END IF;
END $$;

ROLLBACK;
