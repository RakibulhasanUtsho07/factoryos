-- PostgreSQL contract for real planner/executor trace evaluation.
BEGIN;
DO $$
DECLARE
  case_kind_constraint TEXT;
  case_expectation_constraint TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='agent_tasks' AND column_name='agent_definition_id'
  ) THEN
    RAISE EXCEPTION 'AI_LIVE_EVALUATION_AGENT_DEFINITION_PIN_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.agent_tasks'::regclass
      AND conname='fk_agent_task_agent_definition_scope'
      AND contype='f'
  ) THEN
    RAISE EXCEPTION 'AI_LIVE_EVALUATION_AGENT_DEFINITION_SCOPE_FK_MISSING';
  END IF;

  IF to_regclass('public.ai_agent_live_evaluation_results') IS NULL THEN
    RAISE EXCEPTION 'AI_LIVE_EVALUATION_RESULTS_TABLE_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid='public.ai_agent_live_evaluation_results'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'AI_LIVE_EVALUATION_RLS_NOT_FORCED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='ai_agent_live_evaluation_results'
      AND policyname='ai_agent_live_evaluation_results_tenant_isolation'
      AND COALESCE(qual,'') LIKE '%factoryos_current_tenant_id%'
      AND COALESCE(with_check,qual,'') LIKE '%factoryos_current_tenant_id%'
  ) THEN
    RAISE EXCEPTION 'AI_LIVE_EVALUATION_TENANT_POLICY_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.ai_agent_live_evaluation_results'::regclass
      AND conname='uq_ai_agent_live_evaluation_case_task'
  ) THEN
    RAISE EXCEPTION 'AI_LIVE_EVALUATION_CASE_TASK_IDEMPOTENCY_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.ai_agent_live_evaluation_results'::regclass
      AND conname='fk_ai_agent_live_evaluation_task'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.ai_agent_live_evaluation_results'::regclass
      AND conname='fk_ai_agent_live_evaluation_case'
  ) THEN
    RAISE EXCEPTION 'AI_LIVE_EVALUATION_SCOPE_FOREIGN_KEYS_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.ai_agent_live_evaluation_results'::regclass
      AND tgname='ai_agent_live_evaluation_results_immutable' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'AI_LIVE_EVALUATION_IMMUTABILITY_TRIGGER_MISSING';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO case_kind_constraint
  FROM pg_constraint
  WHERE conrelid='public.ai_agent_evaluation_cases'::regclass
    AND conname='chk_ai_agent_evaluation_case_kind';
  IF case_kind_constraint IS NULL
     OR case_kind_constraint NOT LIKE '%PRIVACY_NO_SECRET_LEAKAGE%'
     OR case_kind_constraint NOT LIKE '%RED_TEAM_POLICY_BYPASS%'
     OR case_kind_constraint NOT LIKE '%EXPECTED_COMPENSATION%' THEN
    RAISE EXCEPTION 'AI_REFUSAL_PRIVACY_REDTEAM_COMPENSATION_CASE_KINDS_NOT_ALLOWED';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO case_expectation_constraint
  FROM pg_constraint
  WHERE conrelid='public.ai_agent_evaluation_cases'::regclass
    AND conname='chk_ai_agent_evaluation_case_expectation';
  IF case_expectation_constraint IS NULL
     OR case_expectation_constraint NOT LIKE '%RED_TEAM_POLICY_BYPASS%'
     OR case_expectation_constraint NOT LIKE '%EXPECTED_COMPENSATION%' THEN
    RAISE EXCEPTION 'AI_RED_TEAM_COMPENSATION_EXPECTATION_CONSTRAINT_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version='180_ai_agent_live_execution_evaluation'
  ) THEN
    RAISE EXCEPTION 'AI_LIVE_EVALUATION_MIGRATION_MARKER_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version='182_ai_agent_red_team_compensation_evaluation'
  ) THEN
    RAISE EXCEPTION 'AI_RED_TEAM_COMPENSATION_EVALUATION_MIGRATION_MARKER_MISSING';
  END IF;
END $$;
ROLLBACK;
SELECT 'AI live execution evaluation PostgreSQL contract passed' AS result;
