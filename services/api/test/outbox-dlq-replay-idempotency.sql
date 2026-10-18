DO $$
DECLARE v_rls_enabled boolean; v_rls_forced boolean;
BEGIN
  IF to_regclass('public.outbox_dlq_replay_requests') IS NULL THEN
    RAISE EXCEPTION 'DLQ replay idempotency ledger table is missing';
  END IF;
  SELECT c.relrowsecurity, c.relforcerowsecurity INTO v_rls_enabled, v_rls_forced
  FROM pg_class c WHERE c.oid='public.outbox_dlq_replay_requests'::regclass;
  IF NOT v_rls_enabled OR NOT v_rls_forced THEN
    RAISE EXCEPTION 'DLQ replay idempotency ledger must enforce row-level security';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.outbox_dlq_replay_requests'::regclass AND conname='uq_outbox_dlq_replay_idempotency') THEN
    RAISE EXCEPTION 'DLQ replay idempotency key uniqueness constraint is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='outbox_dlq_replay_requests' AND policyname='outbox_dlq_replay_requests_tenant_isolation') THEN
    RAISE EXCEPTION 'DLQ replay ledger tenant policy is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='117_outbox_dlq_replay_idempotency') THEN
    RAISE EXCEPTION 'DLQ replay idempotency migration is not registered';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='118_outbox_dlq_replay_receipt_guards') THEN
    RAISE EXCEPTION 'DLQ replay receipt guard migration is not registered';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.outbox_dlq_replay_requests'::regclass AND tgname='trg_outbox_dlq_replay_receipt_immutable' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'DLQ replay receipt immutability trigger is missing';
  END IF;
END $$;
SELECT 'outbox DLQ replay idempotency schema verification passed' AS result;
