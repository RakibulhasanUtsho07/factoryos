-- Intentional failure fixture for the disposable PostgreSQL CI database.
-- The workflow expects this file to fail and then asserts the DDL was rolled back.
BEGIN;
CREATE TABLE public.factoryos_migration_recovery_probe (
  id integer PRIMARY KEY,
  note text NOT NULL
);
INSERT INTO public.factoryos_migration_recovery_probe (id, note)
VALUES (1, 'must not persist after a failed migration');
SELECT 1 / 0;
COMMIT;
