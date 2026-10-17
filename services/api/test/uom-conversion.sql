-- UoM regression: factory scope, immutable units/rules, two-person approval,
-- exact rational factors, pair uniqueness and atomic audit/outbox history.
BEGIN;
DO $$
DECLARE
  v_tenant UUID := gen_random_uuid();
  v_factory UUID := gen_random_uuid();
  v_submitter UUID := gen_random_uuid();
  v_reviewer UUID := gen_random_uuid();
  v_kg UUID := gen_random_uuid();
  v_g UUID := gen_random_uuid();
  v_pcs UUID := gen_random_uuid();
  v_kg_g_rule UUID := gen_random_uuid();
  v_hash CHAR(64) := repeat('a', 64);
  v_request UUID := gen_random_uuid();
  v_trace UUID := gen_random_uuid();
  v_quantity NUMERIC;
  v_reverse NUMERIC;
  v_self_approval_rejected BOOLEAN := FALSE;
  v_dimension_rejected BOOLEAN := FALSE;
  v_duplicate_pair_rejected BOOLEAN := FALSE;
  v_immutable_rejected BOOLEAN := FALSE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '075_uom_conversion_controls') THEN
    RAISE EXCEPTION 'UoM migration marker is missing';
  END IF;
  IF to_regclass('uom_units') IS NULL OR to_regclass('uom_conversion_rules') IS NULL
     OR to_regclass('uom_conversion_events') IS NULL THEN
    RAISE EXCEPTION 'UoM master, rules or approval history table is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c WHERE c.oid = 'uom_units'::regclass AND c.relrowsecurity AND c.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class c WHERE c.oid = 'uom_conversion_rules'::regclass AND c.relrowsecurity AND c.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class c WHERE c.oid = 'uom_conversion_events'::regclass AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN RAISE EXCEPTION 'all UoM tables must force tenant RLS'; END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE code = 'uom.read')
     OR NOT EXISTS (SELECT 1 FROM permissions WHERE code = 'uom.write')
     OR NOT EXISTS (SELECT 1 FROM permissions WHERE code = 'uom.approve') THEN
    RAISE EXCEPTION 'UoM permissions are missing';
  END IF;

  INSERT INTO tenants (id, slug, name)
  VALUES (v_tenant, 'uom-test-' || v_tenant::text, 'UoM Integration Test');
  INSERT INTO users (id, display_name) VALUES
    (v_submitter, 'UoM Rule Submitter'), (v_reviewer, 'UoM Independent Reviewer');
  INSERT INTO factories (id, tenant_id, code, name, status)
  VALUES (v_factory, v_tenant, 'UOM-' || upper(substr(v_factory::text, 1, 8)), 'UoM Test Factory', 'ACTIVE');

  PERFORM set_config('app.tenant_id', v_tenant::text, TRUE);
  PERFORM set_config('app.user_id', v_submitter::text, TRUE);
  PERFORM set_config('app.request_id', v_request::text, TRUE);
  PERFORM set_config('app.trace_id', v_trace::text, TRUE);

  INSERT INTO uom_units (
    id, tenant_id, factory_id, unit_code, name, dimension_code, decimal_precision,
    idempotency_key, request_hash, created_by_user_id, correlation_id
  ) VALUES
    (v_kg, v_tenant, v_factory, 'KG', 'Kilogram', 'MASS', 6, 'uom-unit-kg', v_hash, v_submitter, v_trace),
    (v_g, v_tenant, v_factory, 'G', 'Gram', 'MASS', 3, 'uom-unit-g', v_hash, v_submitter, v_trace),
    (v_pcs, v_tenant, v_factory, 'PCS', 'Piece', 'COUNT', 0, 'uom-unit-pcs', v_hash, v_submitter, v_trace);

  INSERT INTO audit_events (
    tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
    correlation_id, request_id, data_class, payload
  )
  SELECT u.tenant_id, u.factory_id, u.created_by_user_id, 'UOM', 'CREATED', 'UOM_UNIT', u.id,
    u.correlation_id, v_request, 'INTERNAL',
    jsonb_build_object('unit_code',u.unit_code,'dimension_code',u.dimension_code,'decimal_precision',u.decimal_precision)
  FROM uom_units u WHERE u.tenant_id = v_tenant AND u.factory_id = v_factory;
  INSERT INTO outbox_events (
    tenant_id, factory_id, aggregate_type, aggregate_id, event_type, event_version, occurred_at,
    correlation_id, causation_id, actor, source, payload
  )
  SELECT u.tenant_id, u.factory_id, 'UOM_UNIT', u.id, 'UOM.UNIT_CREATED', 1, clock_timestamp(),
    u.correlation_id, NULL, jsonb_build_object('type','user','id',u.created_by_user_id),
    jsonb_build_object('system','FactoryOS','connector','uom-test','version','test'),
    jsonb_build_object('unit_id',u.id,'unit_code',u.unit_code,'dimension_code',u.dimension_code)
  FROM uom_units u WHERE u.tenant_id = v_tenant AND u.factory_id = v_factory;

  INSERT INTO uom_conversion_rules (
    id, tenant_id, factory_id, from_unit_id, to_unit_id, factor_numerator, factor_denominator,
    rounding_mode, status, submitted_by_user_id, idempotency_key, request_hash, correlation_id
  ) VALUES (
    v_kg_g_rule, v_tenant, v_factory, v_kg, v_g, 1000, 1,
    'REJECT', 'PENDING_APPROVAL', v_submitter, 'uom-rule-kg-g', v_hash, v_trace
  );
  INSERT INTO uom_conversion_events (
    tenant_id, factory_id, conversion_rule_id, event_type, from_status, to_status, reason,
    idempotency_key, request_hash, changed_by_user_id, correlation_id
  ) VALUES (
    v_tenant, v_factory, v_kg_g_rule, 'SUBMITTED', NULL, 'PENDING_APPROVAL',
    'Initial exact KG to G factor', 'uom-event-submit-kg-g', v_hash, v_submitter, v_trace
  );
  INSERT INTO audit_events (
    tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
    correlation_id, request_id, data_class, payload
  ) VALUES (
    v_tenant, v_factory, v_submitter, 'UOM', 'SUBMITTED', 'UOM_CONVERSION', v_kg_g_rule,
    v_trace, v_request, 'INTERNAL', jsonb_build_object('from','KG','to','G','numerator',1000,'denominator',1)
  );
  INSERT INTO outbox_events (
    tenant_id, factory_id, aggregate_type, aggregate_id, event_type, event_version, occurred_at,
    correlation_id, causation_id, actor, source, payload
  ) VALUES (
    v_tenant, v_factory, 'UOM_CONVERSION', v_kg_g_rule, 'UOM.CONVERSION_SUBMITTED', 1, clock_timestamp(),
    v_trace, NULL, jsonb_build_object('type','user','id',v_submitter),
    jsonb_build_object('system','FactoryOS','connector','uom-test','version','test'),
    jsonb_build_object('conversion_rule_id',v_kg_g_rule,'from_unit_code','KG','to_unit_code','G','status','PENDING_APPROVAL')
  );

  BEGIN
    UPDATE uom_conversion_rules
    SET status = 'APPROVED', decided_by_user_id = v_submitter, decided_at = clock_timestamp(),
        decision_reason = 'Self approval must fail', version = version + 1, updated_at = clock_timestamp()
    WHERE id = v_kg_g_rule AND tenant_id = v_tenant AND factory_id = v_factory;
  EXCEPTION WHEN check_violation THEN v_self_approval_rejected := TRUE;
  END;
  IF NOT v_self_approval_rejected THEN RAISE EXCEPTION 'UoM submitter self-approval was not blocked'; END IF;

  PERFORM set_config('app.user_id', v_reviewer::text, TRUE);
  UPDATE uom_conversion_rules
  SET status = 'APPROVED', decided_by_user_id = v_reviewer, decided_at = clock_timestamp(),
      decision_reason = 'Verified against approved exact factor', version = version + 1, updated_at = clock_timestamp()
  WHERE id = v_kg_g_rule AND tenant_id = v_tenant AND factory_id = v_factory;
  INSERT INTO uom_conversion_events (
    tenant_id, factory_id, conversion_rule_id, event_type, from_status, to_status, reason,
    idempotency_key, request_hash, changed_by_user_id, correlation_id
  ) VALUES (
    v_tenant, v_factory, v_kg_g_rule, 'APPROVED', 'PENDING_APPROVAL', 'APPROVED',
    'Verified against approved exact factor', 'uom-event-approve-kg-g', repeat('b',64), v_reviewer, v_trace
  );
  INSERT INTO audit_events (
    tenant_id, factory_id, actor_user_id, event_type, action, resource_type, resource_id,
    correlation_id, request_id, data_class, payload
  ) VALUES (
    v_tenant, v_factory, v_reviewer, 'UOM', 'APPROVED', 'UOM_CONVERSION', v_kg_g_rule,
    v_trace, v_request, 'INTERNAL', jsonb_build_object('status','APPROVED','reason','Verified against approved exact factor')
  );
  INSERT INTO outbox_events (
    tenant_id, factory_id, aggregate_type, aggregate_id, event_type, event_version, occurred_at,
    correlation_id, causation_id, actor, source, payload
  ) VALUES (
    v_tenant, v_factory, 'UOM_CONVERSION', v_kg_g_rule, 'UOM.CONVERSION_APPROVED', 1, clock_timestamp(),
    v_trace, NULL, jsonb_build_object('type','user','id',v_reviewer),
    jsonb_build_object('system','FactoryOS','connector','uom-test','version','test'),
    jsonb_build_object('conversion_rule_id',v_kg_g_rule,'status','APPROVED')
  );

  SELECT 1.234::numeric * factor_numerator / factor_denominator INTO v_quantity
  FROM uom_conversion_rules WHERE id = v_kg_g_rule AND status = 'APPROVED';
  SELECT 1234::numeric * factor_denominator / factor_numerator INTO v_reverse
  FROM uom_conversion_rules WHERE id = v_kg_g_rule AND status = 'APPROVED';
  IF v_quantity <> 1234 OR v_reverse <> 1.234 THEN
    RAISE EXCEPTION 'exact UoM conversion/inverse failed: forward %, reverse %', v_quantity, v_reverse;
  END IF;

  -- Expected negative insert cases must use their declared submitter so the
  -- test exercises dimension and active-pair guards instead of the actor guard first.
  PERFORM set_config('app.user_id', v_submitter::text, TRUE);

  BEGIN
    INSERT INTO uom_conversion_rules (
      tenant_id, factory_id, from_unit_id, to_unit_id, factor_numerator, factor_denominator,
      rounding_mode, submitted_by_user_id, idempotency_key, request_hash, correlation_id
    ) VALUES (v_tenant, v_factory, v_kg, v_pcs, 1, 1, 'REJECT', v_submitter,
      'uom-rule-dimension-mismatch', v_hash, v_trace);
  EXCEPTION WHEN check_violation THEN v_dimension_rejected := TRUE;
  END;
  IF NOT v_dimension_rejected THEN RAISE EXCEPTION 'UoM conversion allowed incompatible dimensions'; END IF;

  BEGIN
    INSERT INTO uom_conversion_rules (
      tenant_id, factory_id, from_unit_id, to_unit_id, factor_numerator, factor_denominator,
      rounding_mode, submitted_by_user_id, idempotency_key, request_hash, correlation_id
    ) VALUES (v_tenant, v_factory, v_g, v_kg, 1, 1000, 'REJECT', v_submitter,
      'uom-rule-duplicate-reverse', v_hash, v_trace);
  EXCEPTION WHEN unique_violation THEN v_duplicate_pair_rejected := TRUE;
  END;
  IF NOT v_duplicate_pair_rejected THEN RAISE EXCEPTION 'duplicate active reverse conversion pair was not rejected'; END IF;

  BEGIN
    UPDATE uom_units SET decimal_precision = 8
    WHERE id = v_kg AND tenant_id = v_tenant AND factory_id = v_factory;
  EXCEPTION WHEN SQLSTATE '55000' THEN v_immutable_rejected := TRUE;
  END;
  IF NOT v_immutable_rejected THEN RAISE EXCEPTION 'UoM unit definition mutation was not rejected'; END IF;

  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE NOTICE 'UoM scope/RLS, exact forward/inverse factors, independent approval, dimension guard, active-pair uniqueness, immutable units and audit/outbox evidence passed';
END;
$$;
ROLLBACK;
