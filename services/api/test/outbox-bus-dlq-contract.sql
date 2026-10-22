-- Schema-level acceptance for Kafka consumer DLQ, redrive receipts and audit history.
DO $event_bus_dlq_contract$
DECLARE
  v_table TEXT;
  v_enabled BOOLEAN;
  v_forced BOOLEAN;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'outbox_bus_dead_letters',
    'outbox_bus_dlq_redrive_requests',
    'outbox_bus_dlq_audit_events'
  ] LOOP
    IF to_regclass('public.'||v_table) IS NULL THEN
      RAISE EXCEPTION 'Kafka event-bus DLQ table % is missing',v_table;
    END IF;
    SELECT c.relrowsecurity,c.relforcerowsecurity
      INTO v_enabled,v_forced FROM pg_class c
      WHERE c.oid=('public.'||v_table)::regclass;
    IF NOT v_enabled OR NOT v_forced THEN
      RAISE EXCEPTION 'Kafka event-bus table % must force row-level security',v_table;
    END IF;
    IF NOT EXISTS(
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname='public' AND p.tablename=v_table
        AND p.policyname=v_table||'_tenant_isolation'
    ) THEN
      RAISE EXCEPTION 'Kafka event-bus table % tenant policy is missing',v_table;
    END IF;
  END LOOP;

  IF NOT EXISTS(
    SELECT 1 FROM pg_constraint WHERE conrelid='public.outbox_bus_dead_letters'::regclass
      AND conname='uq_outbox_bus_dead_letter_consumer_event'
  ) THEN RAISE EXCEPTION 'Consumer/event deduplication uniqueness is missing'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_constraint WHERE conrelid='public.outbox_bus_dlq_redrive_requests'::regclass
      AND conname='uq_outbox_bus_dlq_redrive_key'
  ) THEN RAISE EXCEPTION 'Broker DLQ redrive idempotency constraint is missing'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.outbox_bus_dead_letters'::regclass
      AND tgname='trg_outbox_bus_dead_letter_guard' AND NOT tgisinternal
  ) OR NOT EXISTS(
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.outbox_bus_dlq_redrive_requests'::regclass
      AND tgname='trg_outbox_bus_dlq_redrive_guard' AND NOT tgisinternal
  ) OR NOT EXISTS(
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.outbox_bus_dlq_audit_events'::regclass
      AND tgname='trg_outbox_bus_dlq_audit_immutable' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Kafka DLQ lifecycle/immutability trigger is missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='169_kafka_event_bus_transport') THEN
    RAISE EXCEPTION 'Kafka event-bus migration is not registered';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='factoryos_app') THEN
    IF NOT has_table_privilege('factoryos_app','public.outbox_bus_dead_letters','SELECT')
      OR NOT has_table_privilege('factoryos_app','public.outbox_bus_dead_letters','INSERT')
      OR NOT has_table_privilege('factoryos_app','public.outbox_bus_dlq_redrive_requests','UPDATE')
      OR NOT has_table_privilege('factoryos_app','public.outbox_bus_dlq_audit_events','INSERT') THEN
      RAISE EXCEPTION 'factoryos_app is missing least-privilege Kafka DLQ access required by the runtime';
    END IF;
  END IF;
END;
$event_bus_dlq_contract$;

SELECT 'Kafka event-bus DLQ schema and RLS contract passed' AS result;
