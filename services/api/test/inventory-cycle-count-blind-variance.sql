-- Acceptance contract for blind count and independently reviewed variance escalation.
BEGIN;

DO $$
DECLARE
  v_rls_enabled BOOLEAN;
  v_rls_forced BOOLEAN;
  v_definition TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version = '188_inventory_blind_count_variance_escalation'
  ) THEN
    RAISE EXCEPTION 'blind-count/variance escalation migration marker is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.inventory_cycle_count_tasks'::regclass
      AND attname = 'blind_count' AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.inventory_cycle_count_tasks'::regclass
      AND attname = 'variance_escalation_threshold' AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'cycle-count task blind-count/variance policy columns are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.inventory_cycle_count_proposals'::regclass
      AND attname = 'blind_count_snapshot' AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'proposal blind-count snapshot is missing';
  END IF;

  IF to_regclass('public.inventory_cycle_count_variance_escalations') IS NULL THEN
    RAISE EXCEPTION 'variance escalation evidence table is missing';
  END IF;

  SELECT c.relrowsecurity, c.relforcerowsecurity INTO v_rls_enabled, v_rls_forced
  FROM pg_class c
  WHERE c.oid = 'public.inventory_cycle_count_variance_escalations'::regclass;
  IF v_rls_enabled IS DISTINCT FROM TRUE OR v_rls_forced IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'variance escalation evidence must enable and force RLS';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.inventory_cycle_count_variance_escalations'::regclass
      AND polname = 'inventory_cycle_count_variance_escalations_tenant_isolation'
  ) THEN
    RAISE EXCEPTION 'variance escalation tenant policy is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_cycle_count_tasks'::regclass
      AND tgname = 'inventory_cycle_count_task_policy_guard' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'task blind-count/threshold immutability trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_cycle_count_proposals'::regclass
      AND tgname = 'inventory_cycle_count_variance_decision_guard' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'approval/rejection variance escalation guard is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.inventory_cycle_count_variance_escalations'::regclass
      AND tgname = 'inventory_cycle_count_variance_escalation_guard' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'variance escalation lifecycle evidence guard is missing';
  END IF;

  SELECT pg_get_functiondef('public.factoryos_validate_inventory_cycle_count_task_proposal()'::regprocedure)
    INTO v_definition;
  IF position('NEW.blind_count_snapshot := task_row.blind_count' IN v_definition) = 0
    OR position('blind-count snapshot are immutable' IN v_definition) = 0
  THEN
    RAISE EXCEPTION 'blind-count proposal snapshot guard is incomplete';
  END IF;

  SELECT pg_get_functiondef('public.factoryos_guard_cycle_count_variance_decision()'::regprocedure)
    INTO v_definition;
  IF position('must be resolved before approval or rejection' IN v_definition) = 0
    OR position('a different reviewer must decide the escalated cycle count' IN v_definition) = 0
  THEN
    RAISE EXCEPTION 'variance escalation decision gate is incomplete';
  END IF;

  SELECT pg_get_functiondef('public.factoryos_guard_inventory_cycle_count_variance_escalation()'::regprocedure)
    INTO v_definition;
  IF position('variance escalation evidence is immutable' IN v_definition) = 0
    OR position('must be resolved by a reviewer other than the counter' IN v_definition) = 0
  THEN
    RAISE EXCEPTION 'variance escalation evidence guard is incomplete';
  END IF;
END $$;

ROLLBACK;
