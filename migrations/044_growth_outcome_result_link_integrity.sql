BEGIN;

-- A measured experiment result is a single source record: it may back at most
-- one realized outcome/learning signal, and that outcome must reference the
-- exact opportunity the experiment was created for.
DO $$
BEGIN
  IF EXISTS (
    SELECT experiment_result_id
    FROM growth_opportunity_outcomes
    WHERE experiment_result_id IS NOT NULL
    GROUP BY experiment_result_id, tenant_id, factory_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate growth outcomes already reference an experiment result; reconcile historical duplicates before migration 044';
  END IF;
END;
$$;

CREATE UNIQUE INDEX uq_growth_outcome_experiment_result
  ON growth_opportunity_outcomes (experiment_result_id, tenant_id, factory_id)
  WHERE experiment_result_id IS NOT NULL;

CREATE OR REPLACE FUNCTION factoryos_guard_growth_outcome_experiment_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_opportunity_id UUID;
BEGIN
  IF NEW.experiment_result_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT e.opportunity_id
  INTO source_opportunity_id
  FROM growth_experiment_results r
  JOIN growth_experiments e
    ON e.id = r.experiment_id
   AND e.tenant_id = r.tenant_id
   AND e.factory_id = r.factory_id
  WHERE r.id = NEW.experiment_result_id
    AND r.tenant_id = NEW.tenant_id
    AND r.factory_id = NEW.factory_id
  FOR KEY SHARE OF r, e;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Experiment result is not visible in the supplied tenant/factory scope'
      USING ERRCODE = '23503';
  END IF;

  IF source_opportunity_id IS DISTINCT FROM NEW.opportunity_id THEN
    RAISE EXCEPTION 'Experiment result must be linked to the same growth opportunity that owns the experiment'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER growth_outcome_experiment_link_guard
BEFORE INSERT ON growth_opportunity_outcomes
FOR EACH ROW EXECUTE FUNCTION factoryos_guard_growth_outcome_experiment_link();

INSERT INTO schema_migrations (version, checksum)
VALUES ('044_growth_outcome_result_link_integrity', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
