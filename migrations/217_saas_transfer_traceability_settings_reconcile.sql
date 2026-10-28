BEGIN;

-- traceability_settings has no synthetic id and is auto-created with each
-- factory. A governed exact-schema transfer may restore its source policy and
-- timestamps onto that newly seeded row only when the transaction-local flag
-- is set and the database session belongs to the dedicated transfer role.
-- Ordinary API updates retain the authenticated-actor/version transition guard.
CREATE OR REPLACE FUNCTION public.factoryos_guard_traceability_settings()
RETURNS trigger
LANGUAGE plpgsql
AS $trace_settings_guard$
DECLARE
  transfer_import boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Preserve settings during normal operation but allow parent-factory lifecycle cascade.
    IF EXISTS (
      SELECT 1 FROM public.factories f
      WHERE f.id = OLD.factory_id AND f.tenant_id = OLD.tenant_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'traceability settings cannot be deleted independently of their factory';
    END IF;
    RETURN OLD;
  END IF;

  transfer_import :=
    COALESCE(current_setting('app.saas_tenant_transfer_import', TRUE), '') = 'on'
    AND pg_catalog.pg_has_role(
      session_user,
      'factoryos_transfer_importer',
      'member'
    );

  IF transfer_import THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.factory_id IS DISTINCT FROM OLD.factory_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'traceability settings transfer cannot change tenant/factory scope';
    END IF;
    -- CHECK/FK constraints still validate retention, allocation policy and actor.
    -- This exception is narrowly limited to the newly seeded row for the same
    -- factory; it does not bypass row-level security or scope constraints.
    RETURN NEW;
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.factory_id IS DISTINCT FROM OLD.factory_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.version <> OLD.version + 1
     OR NEW.updated_by_user_id IS DISTINCT FROM public.factoryos_current_user_id()
     OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'traceability settings updates require the authenticated actor and the next version';
  END IF;
  RETURN NEW;
END;
$trace_settings_guard$;

COMMENT ON FUNCTION public.factoryos_guard_traceability_settings() IS
  'Enforces authenticated version increments for traceability settings; permits only the dedicated transfer-import role to reconcile the source configuration onto a same-tenant/factory auto-seeded row during an exact-schema transfer.';

INSERT INTO schema_migrations(version, checksum)
VALUES ('217_saas_transfer_traceability_settings_reconcile', NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
