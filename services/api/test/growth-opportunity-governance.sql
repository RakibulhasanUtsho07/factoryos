-- PostgreSQL contract for auditable growth-opportunity governance.
DO $$
DECLARE
  table_name TEXT;
  required_constraint TEXT;
  required_trigger TEXT;
  definition TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'growth_opportunity_assumptions',
    'growth_opportunity_assumption_decisions',
    'growth_opportunity_constraints',
    'growth_opportunity_evidence_gaps',
    'growth_opportunity_evidence_gap_events',
    'growth_opportunity_decision_owners',
    'growth_opportunity_decision_history'
  ] LOOP
    IF to_regclass('public.' || table_name) IS NULL THEN
      RAISE EXCEPTION 'GROWTH_GOVERNANCE_REQUIRED_TABLE_MISSING: %', table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
       WHERE oid = to_regclass('public.' || table_name)
         AND relrowsecurity AND relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'GROWTH_GOVERNANCE_RLS_NOT_FORCED: %', table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = table_name
         AND policyname = table_name || '_tenant_isolation'
         AND qual LIKE '%factoryos_current_tenant_id%'
         AND with_check LIKE '%factoryos_current_tenant_id%'
    ) THEN
      RAISE EXCEPTION 'GROWTH_GOVERNANCE_TENANT_POLICY_MISSING: %', table_name;
    END IF;
  END LOOP;

  FOREACH required_constraint IN ARRAY ARRAY[
    'fk_growth_assumption_decision_assumption',
    'chk_growth_assumption_decision_evidence',
    'chk_growth_constraint_evaluation',
    'uq_growth_decision_owner_current_role',
    'fk_growth_opportunity_decision_history_owner',
    'chk_growth_opportunity_decision_history_decision',
    'chk_growth_gap_event_resolution_evidence'
  ] LOOP
    IF required_constraint = 'uq_growth_decision_owner_current_role' THEN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = required_constraint
      ) THEN
        RAISE EXCEPTION 'GROWTH_GOVERNANCE_REQUIRED_INDEX_MISSING: %', required_constraint;
      END IF;
    ELSIF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = required_constraint
    ) THEN
      RAISE EXCEPTION 'GROWTH_GOVERNANCE_REQUIRED_CONSTRAINT_MISSING: %', required_constraint;
    END IF;
  END LOOP;

  FOREACH required_trigger IN ARRAY ARRAY[
    'growth_opportunity_assumptions_seed',
    'growth_opportunity_assumptions_payload_guard',
    'growth_opportunity_assumptions_immutable',
    'growth_opportunity_assumption_decisions_append_only',
    'growth_opportunity_constraints_immutable',
    'growth_opportunity_evidence_gaps_immutable',
    'growth_opportunity_evidence_gap_events_append_only',
    'growth_opportunity_decision_owner_guard',
    'growth_opportunity_decision_history_append_only'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgname = required_trigger AND NOT tgisinternal
    ) THEN
      RAISE EXCEPTION 'GROWTH_GOVERNANCE_REQUIRED_TRIGGER_MISSING: %', required_trigger;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE version = '143_growth_opportunity_governance'
  ) THEN
    RAISE EXCEPTION 'GROWTH_GOVERNANCE_MIGRATION_NOT_REGISTERED';
  END IF;

  definition := pg_get_functiondef('public.factoryos_growth_opportunity_governance_ready(uuid,uuid,uuid)'::regprocedure);
  IF position('c.observed_value <= c.threshold_value' IN definition) = 0
     OR position('c.observed_value >= c.threshold_value' IN definition) = 0
     OR position('c.observed_value = c.threshold_value' IN definition) = 0 THEN
    RAISE EXCEPTION 'GROWTH_GOVERNANCE_NUMERIC_CONSTRAINT_CHECK_MISSING';
  END IF;
  IF position('tenant_memberships' IN definition) = 0
     OR position('owner_user_id IS DISTINCT FROM o.created_by' IN definition) = 0 THEN
    RAISE EXCEPTION 'GROWTH_GOVERNANCE_ACTIVE_INDEPENDENT_OWNER_CHECK_MISSING';
  END IF;
  IF position('growth_opportunity_assumption_decisions' IN definition) = 0
     OR position('growth_opportunity_constraints' IN definition) = 0
     OR position('growth_opportunity_evidence_gaps' IN definition) = 0 THEN
    RAISE EXCEPTION 'GROWTH_GOVERNANCE_READINESS_GUARD_INCOMPLETE';
  END IF;

  definition := pg_get_functiondef('public.factoryos_guard_growth_opportunity_lifecycle()'::regprocedure);
  IF position('GROWTH_OPPORTUNITY_REQUIRES_THE_ASSIGNED_DECISION_OWNER' IN definition) = 0
     OR position('GROWTH_OPPORTUNITY_GOVERNANCE_INCOMPLETE' IN definition) = 0 THEN
    RAISE EXCEPTION 'GROWTH_GOVERNANCE_OPPORTUNITY_DECISION_GUARD_MISSING';
  END IF;

  IF position('BEFORE INSERT OR UPDATE OR DELETE' IN pg_get_triggerdef((
       SELECT oid FROM pg_trigger
        WHERE tgname = 'growth_opportunity_assumptions_immutable' AND NOT tgisinternal
     ))) = 0 THEN
    RAISE EXCEPTION 'GROWTH_GOVERNANCE_ASSUMPTION_OWNER_INSERT_GUARD_MISSING';
  END IF;

  definition := pg_get_functiondef('public.factoryos_guard_growth_assumption_decision()'::regprocedure);
  IF position('NEW.actor_user_id' IN definition) > 0
     OR position('NEW.decided_by' IN definition) = 0 THEN
    RAISE EXCEPTION 'GROWTH_GOVERNANCE_ASSUMPTION_ACTOR_GUARD_INVALID';
  END IF;

  RAISE NOTICE 'Growth opportunity assumptions, constraints, missing evidence and decision ownership contract passed';
END;
$$;
