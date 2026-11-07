-- SRS v2.1 FR-WMS-02 / FR-WMS-04 / FR-WMS-09:
-- A genealogy edge is not a physical stock transformation. Do not permit
-- SPLIT_INTO or MERGED_INTO until a dedicated command conserves every ledger.
BEGIN;

-- Stop concurrent writers while validating the historical state and installing
-- the barrier. This keeps a generic edge from racing the guard installation.
LOCK TABLE product_genealogy_events IN SHARE ROW EXCLUSIVE MODE;

DO $transformation_preflight$
DECLARE
  v_unbacked_count BIGINT;
BEGIN
  SELECT count(*)
    INTO v_unbacked_count
  FROM product_genealogy_events
  WHERE relationship_type IN ('SPLIT_INTO', 'MERGED_INTO');

  IF v_unbacked_count > 0 THEN
    RAISE EXCEPTION
      'genealogy transformation guard blocked: % historical SPLIT_INTO/MERGED_INTO rows require owner-audited reconciliation before deployment',
      v_unbacked_count
      USING ERRCODE = '23514';
  END IF;
END;
$transformation_preflight$;

CREATE OR REPLACE FUNCTION factoryos_require_stock_conserving_genealogy_transformation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.relationship_type IN ('SPLIT_INTO', 'MERGED_INTO') THEN
    RAISE EXCEPTION
      'SPLIT_INTO and MERGED_INTO require a dedicated stock-conserving transformation command; generic genealogy writes are blocked'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS b_product_genealogy_transformation_command_required
  ON product_genealogy_events;
CREATE TRIGGER b_product_genealogy_transformation_command_required
BEFORE INSERT ON product_genealogy_events
FOR EACH ROW
EXECUTE FUNCTION factoryos_require_stock_conserving_genealogy_transformation();

COMMENT ON FUNCTION factoryos_require_stock_conserving_genealogy_transformation() IS
  'Fail closed on generic split/merge genealogy writes until a dedicated command atomically conserves aggregate, location, identity and reservation stock with audit/outbox evidence.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('238_wms_genealogy_transformations_require_commands', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
