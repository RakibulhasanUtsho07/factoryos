BEGIN;

-- Re-check the exact scenario grid at commit time. The API produces the plan,
-- but the database must not accept a set that substitutes, omits, or reorders
-- sensitivity points when rows are inserted through another code path.
CREATE OR REPLACE FUNCTION factoryos_guard_growth_scenario_set_completeness()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_inputs JSONB;
  expected_count INTEGER;
  expected_sensitivity_count INTEGER := 0;
  actual_count INTEGER;
  actual_standard_count INTEGER;
  actual_custom_count INTEGER;
  axis_entry RECORD;
  axis_parameter TEXT;
  axis_low NUMERIC;
  axis_high NUMERIC;
  axis_points_numeric NUMERIC;
  axis_point_count INTEGER;
  distinct_point_count INTEGER;
  point_index INTEGER;
  expected_value NUMERIC;
  expected_position INTEGER := 5;
  axis_count INTEGER;
  seen_parameters TEXT[] := ARRAY[]::TEXT[];
BEGIN
  SELECT s.expected_scenario_count, s.inputs
    INTO expected_count, parent_inputs
    FROM growth_scenario_sets s
   WHERE s.id = NEW.id
     AND s.tenant_id = NEW.tenant_id
     AND s.factory_id = NEW.factory_id
     AND s.opportunity_id = NEW.opportunity_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROWTH_SCENARIO_SET_PARENT_SNAPSHOT_MISSING'
      USING ERRCODE = '23503';
  END IF;

  IF jsonb_typeof(parent_inputs -> 'sensitivity') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'GROWTH_SCENARIO_SET_SENSITIVITY_GRID_CONFIG_INVALID'
      USING ERRCODE = '23514';
  END IF;

  axis_count := jsonb_array_length(parent_inputs -> 'sensitivity');
  IF axis_count < 1 OR axis_count > 6 THEN
    RAISE EXCEPTION 'GROWTH_SCENARIO_SET_SENSITIVITY_AXIS_COUNT_INVALID'
      USING ERRCODE = '23514';
  END IF;

  FOR axis_entry IN
    SELECT value AS config
      FROM jsonb_array_elements(parent_inputs -> 'sensitivity') WITH ORDINALITY AS axis(value, ordinal)
     ORDER BY ordinal
  LOOP
    IF jsonb_typeof(axis_entry.config) IS DISTINCT FROM 'object'
       OR jsonb_typeof(axis_entry.config -> 'parameter') IS DISTINCT FROM 'string'
       OR jsonb_typeof(axis_entry.config -> 'low_value') IS DISTINCT FROM 'number'
       OR jsonb_typeof(axis_entry.config -> 'high_value') IS DISTINCT FROM 'number'
       OR jsonb_typeof(axis_entry.config -> 'points') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'GROWTH_SCENARIO_SET_SENSITIVITY_GRID_CONFIG_INVALID'
        USING ERRCODE = '23514';
    END IF;

    axis_parameter := axis_entry.config ->> 'parameter';
    IF axis_parameter NOT IN (
      'price_change_pct', 'volume_change_pct', 'variable_cost_change_pct',
      'fixed_cost_change_pct', 'investment', 'uncertainty_pct'
    ) OR axis_parameter = ANY(seen_parameters) THEN
      RAISE EXCEPTION 'GROWTH_SCENARIO_SET_SENSITIVITY_PARAMETER_INVALID_OR_DUPLICATED'
        USING ERRCODE = '23514';
    END IF;
    seen_parameters := array_append(seen_parameters, axis_parameter);

    axis_low := (axis_entry.config ->> 'low_value')::NUMERIC;
    axis_high := (axis_entry.config ->> 'high_value')::NUMERIC;
    axis_points_numeric := (axis_entry.config ->> 'points')::NUMERIC;

    IF axis_low >= axis_high
       OR axis_points_numeric <> trunc(axis_points_numeric)
       OR axis_points_numeric < 2
       OR axis_points_numeric > 11 THEN
      RAISE EXCEPTION 'GROWTH_SCENARIO_SET_SENSITIVITY_RANGE_OR_COUNT_INVALID'
        USING ERRCODE = '23514';
    END IF;
    axis_point_count := axis_points_numeric::INTEGER;

    IF (axis_parameter IN ('price_change_pct', 'volume_change_pct')
        AND (axis_low < -90 OR axis_high > 500))
       OR (axis_parameter IN ('variable_cost_change_pct', 'fixed_cost_change_pct')
        AND (axis_low < -100 OR axis_high > 500))
       OR (axis_parameter = 'investment'
        AND (axis_low < 0 OR axis_high > 1000000000000))
       OR (axis_parameter = 'uncertainty_pct'
        AND (axis_low < 0 OR axis_high > 100)) THEN
      RAISE EXCEPTION 'GROWTH_SCENARIO_SET_SENSITIVITY_RANGE_OUT_OF_BOUNDS'
        USING ERRCODE = '23514';
    END IF;

    IF axis_entry.config ? 'projected_constraint_metrics'
       AND jsonb_typeof(axis_entry.config -> 'projected_constraint_metrics') IS DISTINCT FROM 'null' THEN
      IF jsonb_typeof(axis_entry.config -> 'projected_constraint_metrics') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'GROWTH_SCENARIO_SET_SENSITIVITY_PROJECTION_COUNT_MISMATCH'
          USING ERRCODE = '23514';
      END IF;
      IF jsonb_array_length(axis_entry.config -> 'projected_constraint_metrics') <> axis_point_count THEN
        RAISE EXCEPTION 'GROWTH_SCENARIO_SET_SENSITIVITY_PROJECTION_COUNT_MISMATCH'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    SELECT COUNT(DISTINCT ROUND(
      axis_low + (axis_high - axis_low) * generated.point_index / (axis_point_count - 1),
      4
    ))::INTEGER
      INTO distinct_point_count
      FROM generate_series(0, axis_point_count - 1) AS generated(point_index);

    IF distinct_point_count <> axis_point_count THEN
      RAISE EXCEPTION 'GROWTH_SCENARIO_SET_SENSITIVITY_RESOLUTION_TOO_FINE'
        USING ERRCODE = '23514';
    END IF;

    expected_sensitivity_count := expected_sensitivity_count + axis_point_count;

    FOR point_index IN 1..axis_point_count LOOP
      expected_value := ROUND(
        axis_low + (axis_high - axis_low) * (point_index - 1) / (axis_point_count - 1),
        4
      );

      IF NOT EXISTS (
        SELECT 1
          FROM growth_scenario_set_members m
          JOIN growth_scenarios sc
            ON sc.id = m.scenario_id
           AND sc.tenant_id = m.tenant_id
           AND sc.factory_id = m.factory_id
           AND sc.opportunity_id = m.opportunity_id
         WHERE m.scenario_set_id = NEW.id
           AND m.tenant_id = NEW.tenant_id
           AND m.factory_id = NEW.factory_id
           AND m.opportunity_id = NEW.opportunity_id
           AND m.scenario_type = 'CUSTOM'
           AND m.sensitivity_parameter = axis_parameter
           AND m.sensitivity_value = expected_value
           AND m.position = expected_position
           AND m.scenario_key LIKE ('SENSITIVITY:' || axis_parameter || ':' || point_index || ':%')
           AND sc.inputs #>> '{sensitivity,parameter}' = axis_parameter
           AND (sc.inputs #>> '{sensitivity,value}')::NUMERIC = expected_value
      ) THEN
        RAISE EXCEPTION 'GROWTH_SCENARIO_SET_SENSITIVITY_GRID_POINT_MISMATCH: %:%',
          axis_parameter, point_index
          USING ERRCODE = '23514';
      END IF;

      expected_position := expected_position + 1;
    END LOOP;
  END LOOP;

  IF expected_count <> 4 + expected_sensitivity_count THEN
    RAISE EXCEPTION 'GROWTH_SCENARIO_SET_EXPECTED_COUNT_DOES_NOT_MATCH_INPUTS'
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*)::INTEGER,
         COUNT(*) FILTER (WHERE m.scenario_type IN ('BASE','UPSIDE','DOWNSIDE','STRESS'))::INTEGER,
         COUNT(*) FILTER (WHERE m.scenario_type = 'CUSTOM')::INTEGER
    INTO actual_count, actual_standard_count, actual_custom_count
    FROM growth_scenario_set_members m
   WHERE m.scenario_set_id = NEW.id
     AND m.tenant_id = NEW.tenant_id
     AND m.factory_id = NEW.factory_id
     AND m.opportunity_id = NEW.opportunity_id;

  IF actual_count <> expected_count
     OR actual_standard_count <> 4
     OR actual_custom_count <> expected_sensitivity_count
     OR NOT EXISTS (
       SELECT 1 FROM growth_scenario_set_members m
        WHERE m.scenario_set_id = NEW.id
          AND m.tenant_id = NEW.tenant_id
          AND m.factory_id = NEW.factory_id
          AND m.opportunity_id = NEW.opportunity_id
          AND m.scenario_type = 'BASE' AND m.position = 1
     )
     OR NOT EXISTS (
       SELECT 1 FROM growth_scenario_set_members m
        WHERE m.scenario_set_id = NEW.id
          AND m.tenant_id = NEW.tenant_id
          AND m.factory_id = NEW.factory_id
          AND m.opportunity_id = NEW.opportunity_id
          AND m.scenario_type = 'UPSIDE' AND m.position = 2
     )
     OR NOT EXISTS (
       SELECT 1 FROM growth_scenario_set_members m
        WHERE m.scenario_set_id = NEW.id
          AND m.tenant_id = NEW.tenant_id
          AND m.factory_id = NEW.factory_id
          AND m.opportunity_id = NEW.opportunity_id
          AND m.scenario_type = 'DOWNSIDE' AND m.position = 3
     )
     OR NOT EXISTS (
       SELECT 1 FROM growth_scenario_set_members m
        WHERE m.scenario_set_id = NEW.id
          AND m.tenant_id = NEW.tenant_id
          AND m.factory_id = NEW.factory_id
          AND m.opportunity_id = NEW.opportunity_id
          AND m.scenario_type = 'STRESS' AND m.position = 4
     ) THEN
    RAISE EXCEPTION 'GROWTH_SCENARIO_SET_MUST_COMMIT_COMPLETE_ORDERED_STANDARD_CASES_AND_SENSITIVITY_GRID'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('145_growth_scenario_set_grid_integrity', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
