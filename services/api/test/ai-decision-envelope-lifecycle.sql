-- Canonical AI decision envelope, lifecycle, context evidence references and replay.
BEGIN;
DO $$
DECLARE
  v_tenant UUID := gen_random_uuid();
  v_factory UUID := gen_random_uuid();
  v_actor UUID := gen_random_uuid();
  v_decision UUID := gen_random_uuid();
  v_context UUID := gen_random_uuid();
  v_verification UUID := gen_random_uuid();
  v_evidence UUID := gen_random_uuid();
  v_request UUID := gen_random_uuid();
  v_trace UUID := gen_random_uuid();
  v_context_refs INTEGER;
  v_event_count INTEGER;
  v_current_state TEXT;
  v_current_version INTEGER;
  v_illegal_transition_rejected BOOLEAN := FALSE;
  v_bad_hash_rejected BOOLEAN := FALSE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '147_ai_decision_envelope_lifecycle_replay') THEN
    RAISE EXCEPTION 'AI decision lifecycle migration marker is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'ai_decision_envelopes' AND column_name = 'request_hash') THEN
    RAISE EXCEPTION 'Canonical request fingerprint is missing';
  END IF;
  IF to_regclass('ai_decision_lifecycle_states') IS NULL
     OR to_regclass('ai_decision_lifecycle_events') IS NULL
     OR to_regclass('ai_context_evidence_refs') IS NULL THEN
    RAISE EXCEPTION 'AI lifecycle/evidence reference tables are missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='ai_decision_lifecycle_states'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='ai_decision_lifecycle_events'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='ai_context_evidence_refs'::regclass AND c.relrowsecurity AND c.relforcerowsecurity) THEN
    RAISE EXCEPTION 'AI lifecycle/evidence tables must force tenant RLS';
  END IF;

  INSERT INTO tenants (id, slug, name)
  VALUES (v_tenant, 'ai-lifecycle-' || substr(v_tenant::text,1,8), 'AI Lifecycle Test');
  INSERT INTO users (id, display_name) VALUES (v_actor, 'AI Lifecycle Test Actor');
  INSERT INTO factories (id, tenant_id, code, name, status)
  VALUES (v_factory, v_tenant, 'AIL-' || upper(substr(v_factory::text,1,8)), 'AI Lifecycle Test Factory', 'ACTIVE');
  PERFORM set_config('app.tenant_id', v_tenant::text, TRUE);
  PERFORM set_config('app.user_id', v_actor::text, TRUE);
  PERFORM set_config('app.request_id', v_request::text, TRUE);
  PERFORM set_config('app.trace_id', v_trace::text, TRUE);

  INSERT INTO ai_decision_envelopes (
    id, tenant_id, factory_id, request_id, trace_id, actor_id,
    objective, reasoning_mode, context_version, risk_class, output_state,
    metadata, envelope_version, request_hash
  ) VALUES (
    v_decision, v_tenant, v_factory, v_request, v_trace, v_actor,
    'Validate canonical decision', 'FACT', 'ctx-v1', 'L0', 'ANSWER',
    '{}'::jsonb, '1.0.0', repeat('a',64)
  );

  IF NOT EXISTS (SELECT 1 FROM ai_decision_lifecycle_states
                 WHERE decision_id=v_decision AND current_state='CREATED' AND version=1) THEN
    RAISE EXCEPTION 'Decision insert did not create version-one CREATED lifecycle state';
  END IF;

  BEGIN
    INSERT INTO ai_decision_envelopes (
      tenant_id, factory_id, request_id, trace_id, actor_id, objective,
      reasoning_mode, output_state, metadata, envelope_version, request_hash
    ) VALUES (
      v_tenant, v_factory, gen_random_uuid(), gen_random_uuid(), v_actor,
      'Reject invalid fingerprint', 'FACT', 'ANSWER', '{}'::jsonb, '1.0.0', 'not-a-sha256'
    );
  EXCEPTION WHEN check_violation THEN
    v_bad_hash_rejected := TRUE;
  END;
  IF NOT v_bad_hash_rejected THEN
    RAISE EXCEPTION 'Malformed canonical request fingerprints must be rejected';
  END IF;

  INSERT INTO ai_context_packages (
    id, tenant_id, factory_id, decision_id, context_version,
    sources, permissions, freshness, evidence_states, package_hash
  ) VALUES (
    v_context, v_tenant, v_factory, v_decision, 'ctx-v1',
    jsonb_build_array(jsonb_build_object(
      'type','BUSINESS_EVIDENCE','id',v_evidence::text,'sourceType','SOP',
      'sourceRef','SOP-42','sourceTimestamp',clock_timestamp()::text,
      'contentHash',repeat('b',64),'state','VERIFIED'
    )),
    '["ai.context.read"]'::jsonb, '{}'::jsonb, '["VERIFIED"]'::jsonb, repeat('c',64)
  );

  SELECT count(*) INTO v_context_refs FROM ai_context_evidence_refs
  WHERE decision_id=v_decision AND context_package_id=v_context AND evidence_id=v_evidence;
  IF v_context_refs <> 1 THEN RAISE EXCEPTION 'Context evidence reference was not normalized'; END IF;

  INSERT INTO ai_verification_runs (
    id, tenant_id, factory_id, decision_id, context_package_id,
    checks, contradictions, calc_validation, policy_checks, reviewer_result, status
  ) VALUES (
    v_verification, v_tenant, v_factory, v_decision, v_context,
    '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'PASSED'
  );

  SELECT current_state, version INTO v_current_state, v_current_version
  FROM ai_decision_lifecycle_states WHERE decision_id=v_decision;
  SELECT count(*) INTO v_event_count FROM ai_decision_lifecycle_events WHERE decision_id=v_decision;
  IF v_current_state <> 'VERIFIED' OR v_current_version <> 3 OR v_event_count <> 3 THEN
    RAISE EXCEPTION 'Lifecycle did not persist ordered CREATED -> CONTEXT_READY -> VERIFIED transitions';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ai_decision_lifecycle_events
                 WHERE decision_id=v_decision AND sequence_no=3
                   AND from_state='CONTEXT_READY' AND to_state='VERIFIED'
                   AND verification_run_id=v_verification AND context_package_id=v_context) THEN
    RAISE EXCEPTION 'Verification transition is missing context/evidence linkage';
  END IF;

  BEGIN
    UPDATE ai_decision_lifecycle_states
    SET current_state='CREATED', version=version+1, updated_at=clock_timestamp()
    WHERE decision_id=v_decision;
  EXCEPTION WHEN OTHERS THEN
    v_illegal_transition_rejected := TRUE;
  END;
  IF NOT v_illegal_transition_rejected THEN
    RAISE EXCEPTION 'Lifecycle trigger allowed an unrecorded/invalid direct state transition';
  END IF;

  BEGIN
    UPDATE ai_decision_lifecycle_events SET transition_reason='tampered'
    WHERE decision_id=v_decision AND sequence_no=1;
    RAISE EXCEPTION 'Lifecycle event immutability trigger did not reject update';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%immutable%' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
