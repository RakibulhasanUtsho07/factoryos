DO $$
BEGIN
  IF to_regclass('public.wms_traceability_recall_notification_intents') IS NULL
     OR to_regclass('public.wms_traceability_recall_notification_acknowledgements') IS NULL THEN
    RAISE EXCEPTION 'Recall notification intent or acknowledgement table is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid='public.wms_traceability_recall_notification_intents'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid='public.wms_traceability_recall_notification_acknowledgements'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'Recall notifications and acknowledgements must FORCE tenant RLS';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='wms_traceability_recall_notification_intents'
      AND policyname='wms_traceability_recall_notification_intents_tenant_isolation'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='wms_traceability_recall_notification_acknowledgements'
      AND policyname='wms_traceability_recall_notification_ack_tenant_isolation'
  ) THEN
    RAISE EXCEPTION 'Recall notification tenant policies are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.wms_traceability_recall_notification_intents'::regclass
      AND conname='uq_wms_recall_notification_intent_idempotency'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.wms_traceability_recall_notification_acknowledgements'::regclass
      AND conname='uq_wms_recall_notification_ack_intent'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.wms_traceability_recall_notification_acknowledgements'::regclass
      AND conname='fk_wms_recall_notification_ack_intent_recipient'
  ) THEN
    RAISE EXCEPTION 'Recall notification idempotency and recipient-binding constraints are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.wms_traceability_recall_notification_intents'::regclass
      AND tgname='trg_wms_recall_notification_intent_guard' AND tgenabled='O'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.wms_traceability_recall_notification_acknowledgements'::regclass
      AND tgname='trg_wms_recall_notification_ack_guard' AND tgenabled='O'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.wms_traceability_recall_notification_intents'::regclass
      AND tgname='ctr_wms_recall_notification_intent_evidence' AND tgenabled='O'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.wms_traceability_recall_notification_acknowledgements'::regclass
      AND tgname='ctr_wms_recall_notification_ack_evidence' AND tgenabled='O'
  ) THEN
    RAISE EXCEPTION 'Recall append-only or audit/outbox trigger is missing or disabled';
  END IF;

  IF to_regprocedure('public.factoryos_guard_wms_recall_notification_intent()') IS NULL
     OR to_regprocedure('public.factoryos_guard_wms_recall_notification_acknowledgement()') IS NULL
     OR to_regprocedure('public.factoryos_assert_wms_recall_notification_intent_evidence()') IS NULL
     OR to_regprocedure('public.factoryos_assert_wms_recall_notification_ack_evidence()') IS NULL THEN
    RAISE EXCEPTION 'Recall notification guard functions are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version='206_wms_recall_notification_acknowledgements'
  ) THEN
    RAISE EXCEPTION 'Recall notification migration version is not registered';
  END IF;
END;
$$;
