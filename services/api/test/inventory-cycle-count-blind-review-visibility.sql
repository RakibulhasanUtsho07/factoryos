-- PostgreSQL acceptance for the WP02 blind-count reviewer visibility boundary.
-- API projection and route permission are asserted in the cycle-count unit specs;
-- this contract proves the reviewer permission and immutable DB-side gates exist.
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_definition TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM schema_migrations
    WHERE version = '062_inventory_cycle_count_approval'
  ) THEN
    RAISE EXCEPTION 'cycle-count review permission migration marker is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM permissions
    WHERE code = 'inventory.cycle-count.review'
  ) THEN
    RAISE EXCEPTION 'dedicated inventory.cycle-count.review permission is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
    JOIN roles r ON r.id = rp.role_id
    WHERE p.code = 'inventory.cycle-count.review' AND r.code = 'ORG_ADMIN'
  ) OR NOT EXISTS (
    SELECT 1
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
    JOIN roles r ON r.id = rp.role_id
    WHERE p.code = 'inventory.cycle-count.review' AND r.code = 'FACTORY_MANAGER'
  ) THEN
    RAISE EXCEPTION 'configured org-admin and factory-manager reviewer permissions must remain present';
  END IF;

  SELECT pg_get_functiondef(
    'public.factoryos_validate_inventory_cycle_count_task_proposal()'::regprocedure
  ) INTO v_definition;
  IF position('NEW.blind_count_snapshot := task_row.blind_count' IN v_definition) = 0
    OR position('blind-count snapshot are immutable' IN v_definition) = 0
  THEN
    RAISE EXCEPTION 'database must freeze blind-count mode on each proposal';
  END IF;

  SELECT pg_get_functiondef(
    'public.factoryos_guard_cycle_count_variance_decision()'::regprocedure
  ) INTO v_definition;
  IF position('must be resolved before approval or rejection' IN v_definition) = 0
    OR position('a different reviewer must decide the escalated cycle count' IN v_definition) = 0
  THEN
    RAISE EXCEPTION 'database independent-review gate must still guard approval and rejection';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.inventory_cycle_count_proposals'::regclass
      AND tgname = 'inventory_cycle_count_task_proposal_guard'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'proposal snapshot guard trigger is missing';
  END IF;
END $$;

ROLLBACK;
