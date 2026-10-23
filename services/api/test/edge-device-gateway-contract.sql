-- Schema contract for the edge-device registry and credential-bound telemetry slice.
BEGIN;

DO $$
DECLARE
  v_enabled BOOLEAN;
  v_forced BOOLEAN;
  v_relation TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '191_edge_ot_device_gateway')
    OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '192_edge_device_credentials')
  THEN
    RAISE EXCEPTION 'edge gateway migrations 191/192 are not recorded';
  END IF;

  IF to_regclass('public.edge_devices') IS NULL
    OR to_regclass('public.edge_observations') IS NULL
    OR to_regclass('public.edge_sync_batches') IS NULL
    OR to_regclass('public.edge_device_credentials') IS NULL
    OR to_regclass('public.edge_device_credential_events') IS NULL
  THEN
    RAISE EXCEPTION 'edge gateway registry, observation, batch or credential table is missing';
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    'edge_devices',
    'edge_observations',
    'edge_sync_batches',
    'edge_device_credentials',
    'edge_device_credential_events'
  ]
  LOOP
    SELECT c.relrowsecurity, c.relforcerowsecurity INTO v_enabled, v_forced
    FROM pg_class c WHERE c.oid = to_regclass('public.' || v_relation);
    IF v_enabled IS DISTINCT FROM TRUE OR v_forced IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'edge relation % must enable and force row-level security', v_relation;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.edge_devices'::regclass AND polname = 'edge_devices_tenant_isolation'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.edge_observations'::regclass AND polname = 'edge_observations_tenant_isolation'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.edge_sync_batches'::regclass AND polname = 'edge_sync_batches_tenant_isolation'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.edge_device_credentials'::regclass AND polname = 'edge_device_credentials_tenant_isolation'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.edge_device_credential_events'::regclass AND polname = 'edge_device_credential_events_tenant_isolation'
  ) THEN
    RAISE EXCEPTION 'edge gateway tenant isolation policy is missing';
  END IF;

  IF to_regclass('public.uq_edge_observation_event') IS NULL
    OR to_regclass('public.uq_edge_sync_batch') IS NULL
    OR to_regclass('public.uq_edge_credential_token_hash') IS NULL
    OR to_regclass('public.uq_edge_credential_active_device') IS NULL
  THEN
    RAISE EXCEPTION 'edge event idempotency or active credential uniqueness index is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.edge_observations'::regclass
      AND tgname = 'edge_observations_immutable' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.edge_sync_batches'::regclass
      AND tgname = 'edge_sync_batches_immutable' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.edge_device_credential_events'::regclass
      AND tgname = 'edge_device_credential_events_immutable' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'edge telemetry and credential lifecycle ledgers must be append-only';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.edge_observations'::regclass
      AND attname = 'unit' AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.edge_observations'::regclass
      AND attname = 'sampling_interval_ms' AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'edge observation unit and sampling metadata are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.edge_observations'::regclass
      AND conname = 'fk_edge_observation_credential_scope' AND contype = 'f'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.edge_observations'::regclass
      AND conname = 'chk_edge_observation_recorder_identity' AND contype = 'c'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.edge_sync_batches'::regclass
      AND conname = 'fk_edge_sync_credential_scope' AND contype = 'f'
  ) THEN
    RAISE EXCEPTION 'machine-ingest rows must retain credential-bound device identity';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM factoryos_governance.tenant_relation_inventory
    WHERE schema_name = 'public' AND relation_name = 'edge_devices'
  ) OR NOT EXISTS (
    SELECT 1 FROM factoryos_governance.tenant_relation_ownership_reviews
    WHERE schema_name = 'public' AND relation_name = 'edge_device_credentials'
      AND review_status = 'VERIFIED'
  ) THEN
    RAISE EXCEPTION 'edge gateway tenant privacy/governance classification is missing';
  END IF;
END $$;

ROLLBACK;
